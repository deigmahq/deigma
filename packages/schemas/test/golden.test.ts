// Acceptance test (schema contract, TypeScript side): every golden fixture under fixtures/valid
// validates against its zod schema, every fixture under fixtures/invalid is rejected. The Python
// side of the monorepo runs the same fixtures through the generated Pydantic models; its CI runs both.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { Episode, Event, EventBatch, PassportView, Snapshot } from "../src/index.js";

const fixturesRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));

const schemasByDir: Record<string, z.ZodType> = {
  event: Event,
  event_batch: EventBatch,
  episode: Episode,
  snapshot: Snapshot,
  passport_view: PassportView,
};

function fixtures(kind: "valid" | "invalid"): Array<[string, string, unknown]> {
  const out: Array<[string, string, unknown]> = [];
  for (const dir of readdirSync(join(fixturesRoot, kind))) {
    for (const file of readdirSync(join(fixturesRoot, kind, dir)).sort()) {
      const raw = readFileSync(join(fixturesRoot, kind, dir, file), "utf8");
      out.push([dir, file, JSON.parse(raw)]);
    }
  }
  return out;
}

describe("golden fixtures: valid", () => {
  const valid = fixtures("valid");
  it("covers every top-level schema", () => {
    expect(new Set(valid.map(([dir]) => dir))).toEqual(new Set(Object.keys(schemasByDir)));
  });
  it("covers every event type", () => {
    const types = valid.filter(([dir]) => dir === "event").map(([, , v]) => (v as { type: string }).type);
    expect(new Set(types)).toEqual(
      new Set(["session.summary", "draft.curation", "carrier.event", "error.interception", "wedge.status", "prompt.history"]),
    );
  });
  it.each(valid.map(([dir, file, value]) => [`${dir}/${file}`, dir, value]))(
    "%s validates",
    (_name, dir, value) => {
      const schema = schemasByDir[dir];
      expect(schema, `no schema for fixture dir ${dir}`).toBeDefined();
      const result = schema!.safeParse(value);
      expect(result.success, result.success ? "" : JSON.stringify(result.error.issues, null, 2)).toBe(true);
    },
  );
});

describe("golden fixtures: invalid", () => {
  it.each(fixtures("invalid").map(([dir, file, value]) => [`${dir}/${file}`, dir, value]))(
    "%s is rejected",
    (_name, dir, value) => {
      const schema = schemasByDir[dir];
      expect(schema, `no schema for fixture dir ${dir}`).toBeDefined();
      expect(schema!.safeParse(value).success).toBe(false);
    },
  );
  // Review 2026-10-10: an invalid fixture isolates ONE fault. One that fails for several reasons
  // keeps failing when the rule it was written for is broken, so it guards nothing — the two
  // snapshot fixtures were rejected on five missing blocks besides their own fault.
  it.each(fixtures("invalid").map(([dir, file, value]) => [`${dir}/${file}`, dir, value]))(
    "%s fails at exactly one place",
    (_name, dir, value) => {
      const r = schemasByDir[dir]!.safeParse(value);
      expect(r.success, "input: the fixture is rejected").toBe(false);
      const places = new Set(r.error!.issues.map((i) => i.path.join(".")));
      expect([...places]).toHaveLength(1);
    },
  );
  // A fixture of a type that exists only from schema 2.5 carries 2.5: at 2.4 it would also be an
  // event of a type that did not exist yet, a second fault the schema cannot see.
  it.each(
    [...fixtures("valid"), ...fixtures("invalid")]
      .filter(([dir, , v]) => dir === "event" && (v as { type?: string }).type === "prompt.history")
      .map(([dir, file, value]) => [`${dir}/${file}`, value]),
  )("%s is a 2.5 event", (_name, value) => {
    expect((value as { schema_version: string }).schema_version).toBe("2.5");
  });
});

describe("a wedge that has not updated keeps being measured", () => {
  /**
   * The envelope pinned ONE schema version until 2.2, and that was a defect waiting for its first
   * upgrade: the day the server moved, every wedge still running the old build would have been
   * answered 400. The wedge fails open, so nobody's tool would have broken — their telemetry would
   * simply have stopped, silently, until they happened to reinstall.
   *
   * So ingestion accepts the versions the fleet can be running, and an older payload has to parse
   * into the current shape MEANING WHAT IT MEANT: absent counts read as "this session did not
   * count them", never as zero facts asserted.
   */
  it("accepts a 2.1 session.summary and reads its silence as silence", () => {
    const legacy = {
      event_id: "0191b7a1-0001-7aaa-8bbb-000000000009",
      schema_version: "2.1",
      user_id: "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c",
      source: "wedge_cli",
      origin: "live",
      occurred_at: "2026-08-01T10:15:30.250Z",
      sent_at: "2026-08-01T10:15:31Z",
      tool: { name: "deigma-cli", version: "0.3.1" },
      model: { family: "claude", name: "claude-sonnet-5", generation_tag: "2026H2" },
      type: "session.summary",
      payload: {
        session_id: "s_legacy",
        duration_ms: 1000,
        requests: 4,
        iterations: 2,
        tool_calls: { read_file: 1 },
        tokens_in: 10,
        tokens_out: 5,
        prompt_features: [],
        env_features: {
          e_definition_version: "E-1.0",
          mcp_tool_diversity: 0.6,
          mcp_tool_calls: 3,
          project_instructions_loaded: true,
          reusable_skill_calls: 0,
        },
      },
    };
    const parsed = Event.parse(legacy);
    expect(parsed.type).toBe("session.summary");
    if (parsed.type !== "session.summary") throw new Error("unreachable");
    // The fields 2.2 added are absent, and they read as "not counted" rather than as facts.
    expect(parsed.payload.human_prompts).toBe(0);
    expect(parsed.payload.verification_runs).toEqual({ test: 0, build: 0, lint: 0, review: 0 });
    expect(parsed.payload.env_features.e_definition_version).toBe("E-1.0");
    expect(parsed.payload.env_features.project_hash).toBe("");
    expect(parsed.payload.env_features.components_configured).toEqual([]);
    expect(parsed.payload.env_features.components_used).toEqual([]);
  });

  it("still refuses a version nobody in the fleet speaks", () => {
    const ancient = { schema_version: "1.9" };
    expect(() => Event.parse(ancient)).toThrow();
  });
});
