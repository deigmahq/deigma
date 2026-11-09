// Acceptance tests for the IDE wedge (slice 2).
//
// The gates being defended, in the block's words:
//   * "Kc: scope = draft region not file; every level writes kc_algo_version; computed only on
//     accept/save; fallback on timeout and on regions > 2000 lines";
//   * "Zero Content Leakage: traffic audit shows no content field in outgoing events; a
//     secret-scanner hit blocks the whole event; budget test (<= 2 % CPU, <= 300 MB RAM)".
import { computeKc, KC_ALGO, KC_MAX_REGION_LINES, kcBudget, newDeviceSalt } from "@mentat/wedge-core";
import type { DraftCurationEvent, Event } from "@mentat/schemas";
import { beforeEach, describe, expect, it } from "vitest";

import { BudgetGuard, MAX_RSS_BYTES, MIN_CPU_WINDOW_MS, type ResourceSample } from "../src/budget";
import { Collector, INTERCEPTION_WINDOW_MS } from "../src/collector";
import { FakeDocument, FakeHost } from "./helpers/fake-host";

const USER = "11111111-1111-4111-8111-111111111111";

/** A key shaped like the secrets the scanner knows, assembled so this file holds no real-looking one. */
const FAKE_TOKEN = ["ghp", "_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("");

/** Exactly what would go on the wire: the JSON of every event this wedge produced. */
function wire(events: Event[]): string {
  return JSON.stringify(events);
}

const DRAFT = [
  "export function totalPrice(items: Item[]): number {",
  "  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);",
  "}",
  "",
  "export function withTax(total: number, rate: number): number {",
  "  return Math.round(total * (1 + rate) * 100) / 100;",
  "}",
].join("\n");

function setup(overrides: Partial<Parameters<typeof makeCollector>[1]> = {}) {
  const host = new FakeHost();
  const emitted: Event[] = [];
  let clock = 1_700_000_000_000;
  const collector = makeCollector(host, {
    userId: USER,
    salt: newDeviceSalt(),
    emit: (e: Event) => emitted.push(e),
    now: () => clock,
    ...overrides,
  });
  collector.activate();
  return {
    host,
    collector,
    emitted,
    drafts: () => emitted.filter((e): e is DraftCurationEvent => e.type === "draft.curation"),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function makeCollector(host: FakeHost, opts: ConstructorParameters<typeof Collector>[1]): Collector {
  return new Collector(host, opts);
}

describe("kc is computed on accept/save only", () => {
  let ctx: ReturnType<typeof setup>;
  let doc: FakeDocument;

  beforeEach(() => {
    ctx = setup();
    doc = new FakeDocument("const a = 1;\n");
    ctx.host.active = doc;
  });

  it("a large block put back by undo or redo is not a suggestion (audit 2026-10-09 #6)", () => {
    ctx.host.edit(doc, 1, 1, DRAFT, 1); // undo
    ctx.host.edit(doc, 1, 1, DRAFT, 2); // redo
    ctx.host.save(doc);
    expect(ctx.drafts()).toHaveLength(0);
    // the same insertion with no reason is still read as one — the rule is narrowed by the undo
    // and redo the editor names, and by nothing else
    ctx.host.edit(doc, 1, 1, DRAFT);
    ctx.host.save(doc);
    expect(ctx.drafts()).toHaveLength(1);
  });

  it("emits nothing while the draft sits in the editor and is edited", () => {
    ctx.host.edit(doc, 1, 1, DRAFT);
    ctx.advance(20_000);
    ctx.host.scroll(doc);
    ctx.host.edit(doc, 2, 2, "  // rounding is deliberate");
    expect(ctx.emitted).toHaveLength(0);
  });

  it("emits exactly one event on save, with the attention telemetry of that review", () => {
    ctx.host.edit(doc, 1, 1, DRAFT);
    ctx.advance(18_000);
    ctx.host.scroll(doc);
    ctx.host.scroll(doc);
    ctx.host.edit(doc, 3, 3, "  // reviewed");
    ctx.advance(2_000);
    ctx.host.save(doc);

    const events = ctx.drafts();
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload;
    expect(payload.t_validation_ms).toBe(20_000);
    expect(payload.n_scroll).toBe(2);
    expect(payload.n_edits).toBe(1);
    expect(payload.kc_algo_version).toBe(KC_ALGO.myersToken);
    expect(payload.kc_value).toBeGreaterThan(0);
    expect(payload.kc_value).toBeLessThan(1);

    // a second save produces nothing: the draft was already accounted for
    ctx.host.save(doc);
    expect(ctx.drafts()).toHaveLength(1);
  });

  it("accepts through the command path as well", () => {
    ctx.host.edit(doc, 1, 1, DRAFT);
    ctx.advance(5_000);
    ctx.host.run("deigma.acceptDraft");
    expect(ctx.drafts()).toHaveLength(1);
  });

  it("an untouched draft is kc = 1 and reads as a plain acceptance", () => {
    ctx.host.edit(doc, 1, 1, DRAFT);
    ctx.advance(9_000);
    ctx.host.save(doc);
    const payload = ctx.drafts()[0]!.payload;
    expect(payload.kc_value).toBe(1);
    expect(payload.edit_kind).toBe("accept");
    // accepted untouched in 9 s: OVR is what decides whether that was review or reflex, and it
    // can only decide because the attention telemetry travelled with the event.
    expect(payload.t_validation_ms).toBe(9_000);
  });
});

describe("kc scope is the draft region, not the file", () => {
  it("a huge file around a small draft neither changes the value nor the level", () => {
    const filler = Array.from({ length: 4000 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const small = setup();
    const smallDoc = new FakeDocument("const a = 1;\n");
    small.host.active = smallDoc;
    small.host.edit(smallDoc, 1, 1, DRAFT);
    small.advance(9_000);
    small.host.edit(smallDoc, 2, 2, "  // note");
    small.host.save(smallDoc);

    const big = setup();
    const bigDoc = new FakeDocument(`${filler}\n`);
    big.host.active = bigDoc;
    big.host.edit(bigDoc, 3900, 3900, DRAFT);
    big.advance(9_000);
    big.host.edit(bigDoc, 3901, 3901, "  // note");
    big.host.save(bigDoc);

    const a = small.drafts()[0]!.payload;
    const b = big.drafts()[0]!.payload;
    expect(b.kc_value).toBe(a.kc_value);
    expect(b.kc_algo_version).toBe(KC_ALGO.myersToken);
    // the region, not the file, is what was measured
    expect(b.size_final).toBeLessThan(filler.length / 10);
  });

  it("falls back to the linear level above 2000 lines and on a timeout, tagging the level", () => {
    const huge = Array.from({ length: KC_MAX_REGION_LINES + 5 }, (_, i) => `x${i}`).join("\n");
    const oversized = computeKc({ draft: huge, final: `${huge}\nx` });
    expect(oversized.algoVersion).toBe(KC_ALGO.linearFallback);
    expect(oversized.fallbackReason).toBe("region_too_large");
    expect(oversized.scope).toBe("draft_region");

    const timedOut = computeKc({ draft: DRAFT, final: `${DRAFT}\n// edited`, budgetMs: 0 });
    expect(timedOut.algoVersion).toBe(KC_ALGO.linearFallback);
    expect(timedOut.fallbackReason).toBe("timeout");
  });

  it("every emitted event carries a kc_algo_version from the ladder", () => {
    const ctx = setup({ kcBudgetMs: 0 });
    const doc = new FakeDocument("const a = 1;\n");
    ctx.host.active = doc;
    ctx.host.edit(doc, 1, 1, DRAFT);
    ctx.advance(9_000);
    ctx.host.edit(doc, 2, 2, "  // note");
    ctx.host.save(doc);
    const version = ctx.drafts()[0]!.payload.kc_algo_version;
    expect(Object.values(KC_ALGO)).toContain(version);
    expect(version).toBe(KC_ALGO.linearFallback); // the budget was zero, so the ladder dropped
  });
});

describe("error.interception (collector §3.2)", () => {
  // "An accepted draft -> a defect confirmed by the carrier -> fixed in the same episode." The
  // wedge owns the first and the last part of that sentence; the carrier link and the final I_fix
  // belong to the episode pipeline, so they leave the device as null.
  function acceptThenCorrect(ctx: ReturnType<typeof setup>, doc: FakeDocument) {
    ctx.host.edit(doc, 1, 1, DRAFT);
    ctx.advance(12_000);
    ctx.host.save(doc); // accepted
    ctx.advance(90 * 60_000); // an hour and a half later the person comes back to it
    ctx.host.edit(doc, 2, 2, "  return items.reduce((s, i) => s + i.price * (i.quantity ?? 1), 0);");
    ctx.host.save(doc);
  }

  it("emits one interception when an accepted draft is corrected later", () => {
    const ctx = setup();
    const doc = new FakeDocument("const a = 1;\n");
    ctx.host.active = doc;
    acceptThenCorrect(ctx, doc);

    const interceptions = ctx.emitted.filter((e) => e.type === "error.interception");
    expect(interceptions).toHaveLength(1);
    const payload = (interceptions[0] as { payload: Record<string, unknown> }).payload;
    expect(payload.t_since_accept_ms).toBe(90 * 60_000);
    expect(payload.same_region).toBe(true);
    expect(payload.kc_to_fix).toBeGreaterThan(0);
    expect(payload.kc_to_fix).toBeLessThan(1);
    expect(payload.kc_algo_version).toBe(KC_ALGO.myersToken);
    expect(ctx.collector.stats.interceptions).toBe(1);
    // what the wedge cannot see stays null: the pipeline resolves it
    expect(payload.defect_confirmed_by).toBeNull();
    expect(payload.defect_kind).toBeNull();
    expect(payload.fixed_in_same_episode).toBeNull();
    expect(payload.ifix_candidate).toBeNull();
  });

  it("carries the branch as a carrier hint so the pipeline can bind it to an episode", () => {
    const ctx = setup({ carrier: () => ({ branch: "feat/ATL-317-cache", repoId: 812345678 }) });
    const doc = new FakeDocument("const a = 1;\n");
    ctx.host.active = doc;
    acceptThenCorrect(ctx, doc);
    const payload = (
      ctx.emitted.find((e) => e.type === "error.interception") as { payload: { carrier_hint?: unknown } }
    ).payload;
    expect(payload.carrier_hint).toEqual({
      provider: "github",
      repo_id: 812345678,
      branch: "feat/ATL-317-cache",
    });
  });

  it("says nothing when the accepted draft is left alone, or is touched and restored", () => {
    const quiet = setup();
    const docA = new FakeDocument("const a = 1;\n");
    quiet.host.active = docA;
    quiet.host.edit(docA, 1, 1, DRAFT);
    quiet.advance(12_000);
    quiet.host.save(docA);
    quiet.advance(60_000);
    quiet.host.save(docA); // saved again, nothing changed
    expect(quiet.emitted.filter((e) => e.type === "error.interception")).toHaveLength(0);

    const restored = setup();
    const docB = new FakeDocument("const a = 1;\n");
    restored.host.active = docB;
    restored.host.edit(docB, 1, 1, DRAFT);
    restored.advance(12_000);
    restored.host.save(docB);
    const region = { start: { line: 1, character: 0 }, end: { line: 7, character: 0 } };
    const accepted = docB.getText(region);
    restored.host.edit(docB, 2, 2, "  // typo");
    restored.host.edit(docB, 1, 7, accepted); // put it back exactly as it was
    restored.host.save(docB);
    expect(restored.emitted.filter((e) => e.type === "error.interception")).toHaveLength(0);
  });

  it("emits no content, and a secret in the correction blocks the event", () => {
    const ctx = setup();
    const doc = new FakeDocument("const a = 1;\n");
    ctx.host.active = doc;
    acceptThenCorrect(ctx, doc);
    const traffic = wire(ctx.emitted);
    for (const fragment of ["totalPrice", "reduce", "quantity", "/repo/src/app.ts"]) {
      expect(traffic).not.toContain(fragment);
    }

    const leaky = setup();
    const docB = new FakeDocument("const a = 1;\n");
    leaky.host.active = docB;
    leaky.host.edit(docB, 1, 1, DRAFT);
    leaky.advance(12_000);
    leaky.host.save(docB);
    leaky.advance(60_000);
    leaky.host.edit(docB, 2, 2, `  const key = "${FAKE_TOKEN}";`);
    leaky.host.save(docB);
    expect(leaky.emitted.filter((e) => e.type === "error.interception")).toHaveLength(0);
    expect(leaky.collector.stats.blockedBySecret).toBe(1);
    expect(wire(leaky.emitted)).not.toContain("ghp_");
  });

  it("stops watching an accepted draft after the 72 h window", () => {
    const ctx = setup();
    const doc = new FakeDocument("const a = 1;\n");
    ctx.host.active = doc;
    ctx.host.edit(doc, 1, 1, DRAFT);
    ctx.advance(12_000);
    ctx.host.save(doc);
    ctx.advance(INTERCEPTION_WINDOW_MS + 60_000);
    ctx.host.edit(doc, 2, 2, "  // much later, a different task entirely");
    ctx.host.save(doc);
    expect(ctx.emitted.filter((e) => e.type === "error.interception")).toHaveLength(0);
  });
});

describe("zero content leakage", () => {
  it("no field of an outgoing event carries draft or file text", () => {
    const ctx = setup();
    const doc = new FakeDocument("const secretless = 1;\n");
    ctx.host.active = doc;
    ctx.host.edit(doc, 1, 1, DRAFT);
    ctx.advance(11_000);
    ctx.host.save(doc);

    const traffic = wire(ctx.emitted);
    for (const fragment of ["totalPrice", "reduce", "Math.round", "/repo/src/app.ts", "item.price"]) {
      expect(traffic).not.toContain(fragment);
    }
    const payload = ctx.drafts()[0]!.payload;
    expect(payload.draft_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.final_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a secret anywhere in the draft blocks the whole event, metrics included", () => {
    const ctx = setup();
    const doc = new FakeDocument("const a = 1;\n");
    ctx.host.active = doc;
    const withSecret = `${DRAFT}\nconst key = "${FAKE_TOKEN}";`;
    ctx.host.edit(doc, 1, 1, withSecret);
    ctx.advance(9_000);
    ctx.host.save(doc);

    expect(ctx.drafts()).toHaveLength(0);
    expect(ctx.collector.stats.blockedBySecret).toBe(1);
    expect(wire(ctx.emitted)).not.toContain("ghp_");
  });
});

describe("resource budget", () => {
  it("one Kc computation over a realistic region stays well inside its own budget", () => {
    const region = Array.from({ length: 400 }, (_, i) => `  const value${i} = compute(${i});`).join("\n");
    const edited = region.replace(/compute\(7\)/, "computeSafely(7)");
    const { result, ms } = kcBudget(() => computeKc({ draft: region, final: edited }));
    expect(result.algoVersion).toBe(KC_ALGO.myersToken);
    expect(ms).toBeLessThan(250);
  });

  it("pauses collection and says why when the host exceeds the CPU or RAM budget", () => {
    // 3 % of one core over the window: above the 2 % ceiling.
    let at = 0;
    let cpu = 0;
    const samples: ResourceSample[] = [];
    const sampler = (): ResourceSample => {
      at += 10_000;
      cpu += 300_000; // µs of CPU per 10 s of wall clock = 3 %
      const sample = { cpuMicros: cpu, rssBytes: 120 * 1024 * 1024, atMs: at };
      samples.push(sample);
      return sample;
    };
    const guard = new BudgetGuard(sampler);
    guard.check(); // first sample only establishes the window
    const ctx = setup({ guard });
    const doc = new FakeDocument("const a = 1;\n");
    ctx.host.active = doc;
    ctx.host.edit(doc, 1, 1, DRAFT);
    ctx.advance(9_000);
    ctx.host.save(doc);

    expect(ctx.drafts()).toHaveLength(0);
    expect(ctx.collector.stats.droppedOverBudget).toBe(1);
    const status = ctx.emitted.find((e) => e.type === "wedge.status");
    expect(status).toBeDefined();
    expect(status && "payload" in status ? status.payload : null).toMatchObject({
      kind: "paused",
      error_code: "budget_cpu",
    });
    expect(samples.length).toBeGreaterThan(1);
  });

  it("does not call a millisecond of work a CPU overrun", () => {
    // Two saves 50 ms apart burn ~100 % of that window; averaging over it would pause a wedge
    // that is behaving. The guard needs a real window before it may judge the CPU.
    let at = 0;
    let cpu = 0;
    const guard = new BudgetGuard(() => {
      at += 50;
      cpu += 50_000; // 100 % of the elapsed 50 ms
      return { cpuMicros: cpu, rssBytes: 100 * 1024 * 1024, atMs: at };
    });
    guard.check();
    for (let i = 0; i < 10; i += 1) expect(guard.check().withinBudget).toBe(true);
    expect(MIN_CPU_WINDOW_MS).toBeGreaterThan(1_000);
  });

  it("reports the RAM ceiling separately", () => {
    let at = 0;
    const guard = new BudgetGuard(() => {
      at += 1_000;
      return { cpuMicros: 0, rssBytes: MAX_RSS_BYTES + 1, atMs: at };
    });
    const ctx = setup({ guard });
    const doc = new FakeDocument("const a = 1;\n");
    ctx.host.active = doc;
    ctx.host.edit(doc, 1, 1, DRAFT);
    ctx.advance(9_000);
    ctx.host.save(doc);
    const status = ctx.emitted.find((e) => e.type === "wedge.status");
    expect(status && "payload" in status ? status.payload : null).toMatchObject({
      error_code: "budget_rss",
    });
  });

  it("a paused wedge collects nothing at all until it is resumed", () => {
    const ctx = setup();
    const doc = new FakeDocument("const a = 1;\n");
    ctx.host.active = doc;
    ctx.host.run("deigma.pause");
    ctx.host.edit(doc, 1, 1, DRAFT);
    ctx.advance(9_000);
    ctx.host.save(doc);
    expect(ctx.drafts()).toHaveLength(0);

    ctx.host.run("deigma.resume");
    ctx.host.edit(doc, 1, 1, DRAFT);
    ctx.advance(9_000);
    ctx.host.save(doc);
    expect(ctx.drafts()).toHaveLength(1);
  });
});

describe("the status bar (copy v4)", () => {
  it("says how many AI suggestions were read and that no code was sent; the scanner count is in the tooltip", () => {
    const ctx = setup();
    expect(ctx.host.statusBar).toBe("Deigma: reading AI suggestions · no code sent");
    const doc = new FakeDocument("const a = 1;\n");
    ctx.host.active = doc;
    ctx.host.edit(doc, 1, 1, DRAFT);
    ctx.advance(9_000);
    ctx.host.save(doc);
    expect(ctx.host.statusBar).toBe("Deigma: 1 AI suggestion read · no code sent");

    const withSecret = `${DRAFT}\nconst key = "${FAKE_TOKEN}";`;
    ctx.host.edit(doc, 1, 1, withSecret);
    ctx.advance(9_000);
    ctx.host.save(doc);
    expect(ctx.collector.stats.blockedBySecret, "precondition: the scanner blocked one").toBe(1);
    // the bar does not carry the scanner's count; the tooltip does
    expect(ctx.host.statusBar).not.toMatch(/secret|scanner|blocked/i);
    expect(ctx.host.statusTooltip).toMatch(/^1 blocked by the secret scanner/);
  });

  it("says paused when paused, and the count again when resumed", () => {
    const ctx = setup();
    ctx.host.run("deigma.pause");
    expect(ctx.host.statusBar).toBe("Deigma: paused");
    ctx.host.run("deigma.resume");
    expect(ctx.host.statusBar).toBe("Deigma: reading AI suggestions · no code sent");
  });
});
