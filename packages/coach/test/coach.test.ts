// What the coach and the pulse are allowed to say (Playbook §3), on Engine Core 7.
//
// Two families of sentence are forbidden: causal magnitudes ("saved you 6 hours", "23% faster")
// and comparisons with other people ("top 10%"). A value is printed only for a proven claim and
// only with its interval; a habit is a count of sessions. The test reads the rule off the output.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Snapshot as SnapshotSchema, type Snapshot } from "@mentat/schemas";
import { describe, expect, it } from "vitest";

import { coach, pendingText, provenLines, renderPulse, renderPulseEmail, UNSUBSCRIBE_LABEL, unitWords, violatesSpeechRules, weeklyPulse } from "../src";

const golden = SnapshotSchema.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, "../../schemas/fixtures/valid/snapshot/draft.json"), "utf8")),
) as Snapshot;

function variant(proven: boolean): Snapshot {
  const s = JSON.parse(JSON.stringify(golden)) as Snapshot;
  const c = s.claims.decisions_by_others;
  s.status = proven ? "verified" : "calibrating";
  s.claims_proven = proven ? 1 : 0;
  s.claims.decisions_by_others = proven
    ? { ...c, proven: true, value: 0.87, ci90: { lo: 0.78, hi: 0.93 }, n_observations: 52, blocked_by: null, progress: null, preliminary: null }
    : {
        ...c,
        proven: false,
        value: null,
        ci90: null,
        n_observations: 12,
        blocked_by: "interval",
        progress: { have: 12, need: 30, unit: "pull requests decided by other people", approximate: true },
        preliminary: { value: 0.61, ci90: { lo: 0.48, hi: 0.75 } },
      };
  return s;
}

describe("the input", () => {
  it("is the golden snapshot, with habits to speak about", () => {
    expect(Object.keys(golden.habits.traces).length).toBeGreaterThan(0);
  });
});

describe("coach", () => {
  it("prints the value with its interval once proven, and the stamp says who decided", () => {
    const text = coach(variant(true)).map((l) => l.text).join(" ");
    expect(text).toContain("Accepted by other people: 87%, between 78 and 93");
    expect(text).toContain("Verified · decided by other people");
    expect(text).toContain("not a rank");
  });

  it("never prints the value of an unproven claim, not even the owner's preliminary one", () => {
    const text = coach(variant(false)).map((l) => l.text).join(" ");
    expect(text).toContain("about 18 more pull requests decided by other people to go");
    // The planted preliminary is 61 % between 48 and 75: none of it may reach the coach, in any
    // spelling the passport would use. (Habit lines carry their own counts, e.g. "30 of 48 times",
    // so the check names the claim's numbers as the passport writes them, not bare digits.)
    expect(text).not.toMatch(/\b61\s*%|0\.61|between 48 and 75|\d+\s*%/);
  });

  it("never makes a causal claim and never compares the person to anybody", () => {
    for (const snap of [golden, variant(true), variant(false)]) {
      for (const line of coach(snap)) {
        expect(violatesSpeechRules(line.text), line.text).toBeNull();
        expect(line.text).not.toMatch(/\bpassports?\b/i);
      }
    }
  });

  it("the forbidden patterns actually match the sentences they forbid", () => {
    for (const sentence of [
      "This saved you 6 hours last month",
      "You are 23% faster than before",
      "You are in the top 10% of engineers",
      "Better than 84% of your peers",
      "Your percentile is 91",
      "12 hours saved",
    ]) {
      expect(violatesSpeechRules(sentence), sentence).not.toBeNull();
    }
  });
});

describe("habits", () => {
  it("the old habit counters are printed nowhere — the index's breakdown is what the owner reads (2026-10-18)", () => {
    expect(Object.keys(golden.habits.traces).length, "input: the golden snapshot carries habit traces").toBeGreaterThan(0);
    const view = { status: "calibrating" as const, snapshot: golden, metadata_collected: [] };
    const pulse = renderPulse(weeklyPulse({ view, week: { episodes: 3, finalised: 2, from: "2026-08-10", to: "2026-08-16" }, telemetryDays: 9 }));
    const said = [pulse, ...coach(golden).map((l) => l.text)].join("\n");
    expect(said.length, "input: something was said").toBeGreaterThan(20);
    expect(said).not.toMatch(/A plan before the agent's first edit|Prompts that name the files|Changes looked at before the agent's commit|Corrections that point at a place|Suggestions read in the editor/);
  });
});

describe("words", () => {
  it("a proven line needs its interval; an unproven claim has none", () => {
    const c = variant(true).claims.decisions_by_others;
    expect(provenLines(c)).toEqual(["Accepted by other people: 87%, between 78 and 93"]);
    expect(provenLines({ ...c, ci90: null })).toEqual([]);
    expect(provenLines(variant(false).claims.decisions_by_others)).toEqual([]);
  });

  it("the progress line says how far, never a code", () => {
    const c = variant(false).claims.decisions_by_others;
    expect(pendingText(c)).toBe("not proven yet: about 18 more pull requests decided by other people to go");
    expect(pendingText({ ...c, progress: null })).toBe("not proven yet: nothing counted towards it yet");
    expect(unitWords("pull requests decided by other people", 1)).toBe("pull request decided by another person");
    expect(unitWords("some_new_unit", 2)).toBe("some new unit");
  });
});

const UNSUB = "https://api.deigma.net/v1/email/unsubscribe?t=abc.def";

describe("the pulse", () => {
  const week = { episodes: 4, finalised: 3, from: "2026-08-10", to: "2026-08-16" };

  it("is the same speech as the terminal, wrapped in an email", () => {
    const view = { status: "calibrating" as const, snapshot: variant(false), metadata_collected: [] };
    const pulse = weeklyPulse({ view, week, telemetryDays: 9 });
    const email = renderPulseEmail({
      handle: "octocat",
      email: "octocat@example.com",
      pulse,
      coachLines: coach(view.snapshot),
      webBaseUrl: "https://deigma.net",
      unsubscribeUrl: UNSUB,
    });
    expect(email).not.toBeNull();
    expect(email!.text).toContain("+4 pieces of work");
    expect(email!.text).toContain("Calibrating");
    // The owner's own page: the public profile answers 404 while it is private, the default.
    expect(email!.text).toContain("Your Deigma: https://deigma.net/dashboard");
    expect(email!.text).not.toContain("https://deigma.net/@octocat");
    expect(violatesSpeechRules(email!.text)).toBeNull();
    expect(email!.text).not.toMatch(/passport|61%/i);
  });

  it("carries a one-click way out: the link in both parts and the RFC 8058 headers", () => {
    const view = { status: "calibrating" as const, snapshot: variant(false), metadata_collected: [] };
    const pulse = weeklyPulse({ view, week, telemetryDays: 9 });
    const email = renderPulseEmail({ handle: "octocat", email: "o@example.com", pulse, webBaseUrl: "https://deigma.net", unsubscribeUrl: UNSUB });
    expect(email).not.toBeNull();
    expect(email!.text).toContain(`${UNSUBSCRIBE_LABEL} ${UNSUB}`);
    expect(email!.text.trimEnd().endsWith(UNSUB)).toBe(true);
    expect(email!.html).toContain(`href="${UNSUB}"`);
    expect(email!.headers).toEqual({
      "List-Unsubscribe": `<${UNSUB}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    // The old footer promised a reply-STOP path nothing ever read.
    expect(email!.text).not.toMatch(/Reply STOP/);
    expect(violatesSpeechRules(email!.text)).toBeNull();
  });

  it("prints the proven value with its interval", () => {
    const view = { status: "verified" as const, snapshot: variant(true), metadata_collected: [] };
    const pulse = weeklyPulse({ view, week, telemetryDays: 9 });
    expect(pulse.skipped).toBe(false);
    if (!pulse.skipped) expect(pulse.lines).toContain("Accepted by other people: 87%, between 78 and 93");
  });

  it("skips an empty week instead of sending a zero", () => {
    const snapshot = { ...variant(false), practice_index: null };
    const view = { status: "calibrating" as const, snapshot, metadata_collected: [] };
    const pulse = weeklyPulse({ view, week: { ...week, episodes: 0, finalised: 0 }, telemetryDays: 9 });
    expect(renderPulseEmail({ handle: "octocat", email: "x@example.com", pulse, webBaseUrl: "https://deigma.net", unsubscribeUrl: UNSUB })).toBeNull();
  });

  it("a week of sessions with no shipped work still reports the practice index, without a zero (review)", () => {
    const snapshot = variant(false);
    expect(snapshot.practice_index?.value, "input: the fixture's index has a reading").not.toBeNull();
    const view = { status: "calibrating" as const, snapshot, metadata_collected: [] };
    const pulse = weeklyPulse({ view, week: { ...week, episodes: 0, finalised: 0 }, telemetryDays: 9 });
    const mail = renderPulseEmail({ handle: "octocat", email: "x@example.com", pulse, webBaseUrl: "https://deigma.net", unsubscribeUrl: UNSUB });
    expect(mail).not.toBeNull();
    expect(mail!.text).toContain("Practice index");
    expect(mail!.text).not.toMatch(/\+0 pieces|0 got a confirmed/);
  });
});
