// The device salt (collector §2), audit 2026-10-09 #1.
//
// The extension hashed every draft with the literal "device-salt": the same on every machine, so
// the hash of a short suggestion could be confirmed by hashing guesses. These tests hold the two
// halves of the fix: a content hash is never made without the device's own salt (no fallback to
// any constant), and two devices hash the same text differently.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildDraftCuration,
  buildErrorInterception,
  MissingSaltError,
  MIN_DEVICE_SALT_LENGTH,
  MODEL_NOT_KNOWN,
  newDeviceSalt,
  outgoingTraffic,
} from "../src";

const USER = "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c";
// Short on purpose: the case the constant salt made confirmable by brute force.
const DRAFT = "return a + b;";
const FINAL = "return a + b + c;";

const draft = (salt: string | undefined) =>
  buildDraftCuration({
    userId: USER,
    salt: salt as string,
    model: MODEL_NOT_KNOWN,
    draft: DRAFT,
    final: FINAL,
    filePath: "x.ts",
    tValidationMs: 1000,
    nScroll: 0,
    nEdits: 1,
  });

/** What anyone could compute for a guess if the salt were a known constant. */
const guessed = (constant: string, text: string) => createHash("sha256").update(constant).update(text, "utf8").digest("hex");

describe("the device salt", () => {
  it("is 32 random bytes, different on every device", () => {
    const a = newDeviceSalt();
    const b = newDeviceSalt();
    expect(a.length).toBeGreaterThanOrEqual(MIN_DEVICE_SALT_LENGTH);
    expect(Buffer.from(a, "base64")).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it("two devices hash the same draft differently", () => {
    const one = draft(newDeviceSalt());
    const two = draft(newDeviceSalt());
    expect(one.payload.draft_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(one.payload.draft_hash).not.toBe(two.payload.draft_hash);
    expect(one.payload.final_hash).not.toBe(two.payload.final_hash);
  });

  it("the same device hashes the same draft the same way (the link a hash exists for)", () => {
    const salt = newDeviceSalt();
    expect(draft(salt).payload.draft_hash).toBe(draft(salt).payload.draft_hash);
  });

  it("no builder hashes without a salt: there is no constant to fall back to", () => {
    // Restoring `input.salt ?? "device-salt"` in either builder turns these green paths into a
    // successful build, and the test fails — which is the mutation this guards.
    expect(() => draft(undefined)).toThrow(MissingSaltError);
    expect(() =>
      buildErrorInterception({
        userId: USER,
        salt: undefined as unknown as string,
        model: MODEL_NOT_KNOWN,
        accepted: DRAFT,
        fix: FINAL,
        tSinceAcceptMs: 1000,
        sameRegion: true,
      }),
    ).toThrow(MissingSaltError);
    expect(() =>
      outgoingTraffic({ userId: USER, prompts: [], draft: DRAFT, final: FINAL, filePath: "x.ts", salt: undefined as unknown as string }),
    ).toThrow(MissingSaltError);
  });

  it("refuses a short word for a salt — 'device-salt' above all", () => {
    expect(() => draft("device-salt")).toThrow(MissingSaltError);
    expect(() => draft("")).toThrow(MissingSaltError);
  });

  it("no hash on the wire is the hash of a guess under the old constant", () => {
    const events = outgoingTraffic({
      userId: USER,
      prompts: ["add c"],
      draft: DRAFT,
      final: FINAL,
      filePath: "x.ts",
      salt: newDeviceSalt(),
    });
    const hashes = events.flatMap((e) =>
      e.type === "draft.curation"
        ? [e.payload.draft_hash, e.payload.final_hash]
        : e.type === "error.interception"
          ? [e.payload.draft_hash, e.payload.fix_hash]
          : [],
    );
    expect(hashes.length, "input: the traffic carries hashes").toBeGreaterThanOrEqual(4);
    for (const text of [DRAFT, FINAL, `${FINAL}\n`]) {
      expect(hashes).not.toContain(guessed("device-salt", text));
    }
  });
});
