// Acceptance test (written before the implementation) for the hard invariant of the whole
// product: Zero Content Leakage (CLAUDE.md; collector §2; данные_и_комплаенс C0).
//
// "Audit of the traffic" means exactly this: take everything the wedge would put on the wire for a
// realistic editing session and prove that no field carries content — not the prompt, not the code,
// not the diff, not a file name. What may travel is the exhaustive metadata list, and a secret hit
// blocks the whole event rather than scrubbing a field out of it.
import { describe, expect, it } from "vitest";

import {
  PROMPT_CATEGORIES,
  buildDraftCuration,
  buildSessionSummary,
  MODEL_NOT_KNOWN,
  newDeviceSalt,
  outgoingTraffic,
  scanForSecrets,
  scrubPii,
  SecretFoundError,
} from "../src";

// A key shaped like the secrets the scanner knows, assembled so this file holds no real-looking one.
const FAKE_TOKEN = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

const DRAFT = `import { readFileSync } from "node:fs";
// TODO(alice@example.com): move the token out of here
const GITHUB_TOKEN = "${FAKE_TOKEN}";
export function loadConfig(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}`;

const FINAL = `import { readFileSync } from "node:fs";
import { env } from "node:process";
export function loadConfig(path: string) {
  const raw = readFileSync(path, "utf8");
  return { ...JSON.parse(raw), token: env.GITHUB_TOKEN };
}`;

const SALT = newDeviceSalt();

const PROMPT = "refactor loadConfig so the token comes from the environment, keep the JSON parse";

describe("zero content leakage", () => {
  it("puts no content of any kind on the wire", () => {
    const events = outgoingTraffic({
      userId: "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c",
      prompts: [PROMPT],
      draft: DRAFT,
      final: FINAL,
      filePath: "src/config/loadConfig.ts",
      branch: "feat/PROJ-140-config",
      salt: SALT,
    });
    expect(events.length).toBeGreaterThan(0);
    // the audit covers every event type the wedge can emit, interceptions included
    expect(new Set(events.map((e) => e.type))).toContain("error.interception");
    const wire = JSON.stringify(events);

    // nothing recognisable from the source, the prompt or the path may appear
    for (const fragment of [
      "readFileSync",
      "loadConfig",
      "GITHUB_TOKEN",
      "JSON.parse",
      "node:fs",
      "environment",
      "src/config",
      ".ts",
      "alice@example.com",
    ]) {
      expect(wire, `content leaked: ${fragment}`).not.toContain(fragment);
    }
    // The only prompt-derived strings allowed on the wire are category flags from a CLOSED
    // vocabulary (collector §3.2 "флаги категорий — без текста"): a fixed enum cannot carry text,
    // but an open one would. This is the assertion that keeps it closed.
    for (const e of events) {
      if (e.type !== "session.summary") continue;
      for (const f of e.payload.prompt_features) {
        for (const c of f.categories) {
          expect(PROMPT_CATEGORIES, `category outside the closed vocabulary: ${c}`).toContain(c);
        }
      }
    }
    // and no long opaque blob that could be encoded content: every string is short metadata
    for (const value of JSON.stringify(events).match(/"[^"]{80,}"/g) ?? []) {
      throw new Error(`suspiciously long field on the wire: ${value.slice(0, 60)}…`);
    }
  });

  it("blocks the whole event when the secret scanner fires (collector §2)", () => {
    expect(scanForSecrets(DRAFT).length).toBeGreaterThan(0);
    expect(() =>
      buildDraftCuration({
        userId: "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c",
        draft: DRAFT,
        final: FINAL,
        filePath: "src/config/loadConfig.ts",
        tValidationMs: 4200,
        nScroll: 3,
        nEdits: 2,
        salt: SALT,
        model: MODEL_NOT_KNOWN,
      }),
    ).toThrow(SecretFoundError);
    // the clean version of the same edit goes through
    expect(
      buildDraftCuration({
        userId: "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c",
        draft: FINAL,
        final: FINAL,
        filePath: "src/config/loadConfig.ts",
        tValidationMs: 4200,
        nScroll: 3,
        nEdits: 2,
        salt: SALT,
        model: MODEL_NOT_KNOWN,
      }).type,
    ).toBe("draft.curation");
  });

  it("blocks a whole session when a prompt the builder reads carries a secret (the MCP proxy's path)", () => {
    // The scanner sits inside every builder that is handed raw text — the editor's draft and
    // final, the proxy's prompt text — so it is on the send path by construction. (The journal
    // reader hands no text to any builder at all: `prompts: []`, local-backfill.ts.)
    const base = {
      userId: "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c",
      sessionId: "s_secret",
      salt: SALT,
      model: MODEL_NOT_KNOWN,
      toolCalls: {},
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
      iterations: 1,
      env: { mcpTools: [], projectInstructionsLoaded: false, reusableSkillCalls: 0 },
    };
    expect(() => buildSessionSummary({ ...base, prompts: [`use ${DRAFT.split("\n")[2]}`] })).toThrow(SecretFoundError);
    expect(buildSessionSummary({ ...base, prompts: [PROMPT] }).type).toBe("session.summary");
  });

  it("scrubs PII locally before anything is measured", () => {
    const text = "ask alice@example.com or +1 555 0100; ssh key AAAAB3NzaC1yc2EAAAADAQABAAABg";
    const scrubbed = scrubPii(text);
    expect(scrubbed).not.toContain("alice@example.com");
    expect(scrubbed).not.toContain("555 0100");
    expect(scrubbed).toContain("[email]");
  });

  it("keeps the prompt features free of the prompt", () => {
    const session = buildSessionSummary({
      userId: "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c",
      sessionId: "s_1",
      model: MODEL_NOT_KNOWN,
      prompts: [PROMPT, "and add a test"],
      toolCalls: { read_file: 3, edit_file: 2 },
      tokensIn: 1200,
      tokensOut: 340,
      durationMs: 90_000,
      iterations: 2,
      env: { mcpTools: ["read_file", "edit_file"], projectInstructionsLoaded: true, reusableSkillCalls: 1 },
    });
    const features = session.payload.prompt_features;
    expect(features).toHaveLength(2);
    for (const f of features) {
      expect(Object.keys(f).sort()).toEqual(["categories", "content_mass", "h_struct", "length"]);
      expect(f.length).toBeGreaterThan(0); // a length, not the text
    }
    expect(JSON.stringify(session)).not.toContain("environment");
    expect(JSON.stringify(session)).not.toContain("keep the JSON parse");
  });
});
