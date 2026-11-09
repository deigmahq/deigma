// Acceptance test (written before the implementation) for the Kc compute ladder
// (collector §9): scope is the draft region plus context, never the whole file; token-level Myers
// O(nd) first; a structural comparison next; a linear fallback on timeout or on a region larger
// than 2000 lines; every level tags its own kc_algo_version, because thresholds calibrated for one
// level do not transfer to another; and Kc is computed on accept/save only, never on keystrokes.
import { describe, expect, it } from "vitest";

import { KC_ALGO, computeKc, kcBudget } from "../src";

const region = (n: number, body = "const x = 1;") => Array.from({ length: n }, () => body).join("\n");

describe("Kc ladder", () => {
  it("compares the draft region, not the file", () => {
    const draft = "const a = 1;\nconst b = 2;";
    const final = "const a = 1;\nconst b = 3;";
    const bigFile = `${region(5000)}\n${final}\n${region(5000)}`;

    const inRegion = computeKc({ draft, final });
    const inFile = computeKc({ draft, final, fileText: bigFile, regionStartLine: 5000 });
    // the surrounding file must not move the number: the ladder scopes to the region
    expect(inFile.value).toBeCloseTo(inRegion.value, 6);
    expect(inFile.scope).toBe("draft_region");
  });

  it("reports a similarity in [0, 1] with the expected extremes", () => {
    const text = "function f() {\n  return 1;\n}";
    expect(computeKc({ draft: text, final: text }).value).toBe(1);
    expect(computeKc({ draft: text, final: "" }).value).toBe(0);
    const edited = computeKc({ draft: text, final: "function f() {\n  return 2;\n}" });
    expect(edited.value).toBeGreaterThan(0.5);
    expect(edited.value).toBeLessThan(1);
  });

  it("tags every level with its own algorithm version", () => {
    const small = computeKc({ draft: "a b c", final: "a b d" });
    expect(small.algoVersion).toBe(KC_ALGO.myersToken);

    const huge = computeKc({ draft: region(2100), final: region(2100, "const y = 2;") });
    expect(huge.algoVersion).toBe(KC_ALGO.linearFallback);
    expect(huge.fallbackReason).toBe("region_too_large");

    const timedOut = computeKc({
      draft: region(500),
      final: region(500, "const z = 3;"),
      budgetMs: 0, // an impossible budget forces the fallback deterministically
    });
    expect(timedOut.algoVersion).toBe(KC_ALGO.linearFallback);
    expect(timedOut.fallbackReason).toBe("timeout");

    // versions are distinct strings: thresholds are calibrated per level (deferred modules §2)
    expect(new Set(Object.values(KC_ALGO)).size).toBe(Object.values(KC_ALGO).length);
  });

  it("stays inside its CPU budget on a realistic region", () => {
    const draft = region(800, "  const value = compute(input);");
    const final = region(800, "  const value = compute(input, options);");
    const { ms } = kcBudget(() => computeKc({ draft, final }));
    // the wedge budget is <= 2 % CPU on average; a single accept must therefore be
    // milliseconds, not seconds. This is the part that is honestly measurable in a unit test —
    // the average-CPU and RSS budgets are measured by the extension host.
    expect(ms).toBeLessThan(750);
  });

  it("is computed on accept/save only", () => {
    // the ladder exposes no keystroke entry point at all: the only exported trigger is the
    // accept/save one, so "compute only on accept/save" is a property of the API, not of a caller
    expect(Object.keys(KC_ALGO)).not.toContain("keystroke");
    expect(computeKc.length).toBe(1); // one options object; no streaming/incremental variant
  });
});
