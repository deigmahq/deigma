/**
 * The stamp (Core 7 §5): one sentence for every artifact, and the word Verified never bare.
 *
 * Verified carries who decided ("decided by other people"); a stamp that is not Verified never
 * prints the word at all. The expectations are written out, not read from the module's constants —
 * a test that asserted "contains VERIFIED_BY" would pass against a stamp whose qualifier went empty.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { Snapshot } from "../src/snapshot";
import { publicStampText, snapshotStampText, stampParts, stampText } from "../src/stamp";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/valid/snapshot/draft.json", import.meta.url)), "utf8"),
) as Record<string, unknown>;

describe("stampText", () => {
  it("never prints Verified bare", () => {
    expect(stampText("verified")).toBe("Verified · decided by other people");
    expect(stampParts("verified")).toEqual({ head: "Verified", tail: ["decided by other people"] });
  });

  it("never prints the word for a passport that is not Verified", () => {
    for (const status of ["calibrating", "draft"] as const) {
      const text = stampText(status);
      expect(text).not.toMatch(/verified/i);
      expect(stampParts(status).tail).toEqual([]);
    }
    expect(stampText("calibrating")).toBe("Calibrating");
    expect(stampText("draft")).toBe("Draft");
  });

  it("is the same sentence for the owner and for a stranger", () => {
    const snap = Snapshot.parse(fixture);
    expect(snap.status, "fixture input check").toBeTruthy();
    expect(snapshotStampText(snap)).toBe(publicStampText({ status: snap.status }));
    expect(snapshotStampText({ ...snap, status: "verified" })).toBe("Verified · decided by other people");
  });
});
