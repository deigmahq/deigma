// Emits packages/schemas/json/mentat.schema.json: one JSON Schema (draft 2020-12) document whose
// $defs hold every named wire type (Event, EventBatch, Episode, Snapshot, PassportView and their
// parts). The Python models of the data plane are generated from this file with
// datamodel-code-generator; CI regenerates both and fails on any diff (drift-check).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { Episode } from "./episode";
import { Event, EventBatch } from "./events";
import { PassportView, Snapshot } from "./snapshot";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "json");
mkdirSync(outDir, { recursive: true });

// A root object referencing every top-level type forces all of them (and everything they use)
// into $defs exactly once, so the generated Python module has a single class per wire type.
const Root = z
  .strictObject({
    event: Event,
    event_batch: EventBatch,
    episode: Episode,
    snapshot: Snapshot,
    passport_view: PassportView,
  })
  .meta({ id: "MentatSchemas", title: "MentatSchemas" });

const json = z.toJSONSchema(Root, {
  target: "draft-2020-12",
  io: "input",
  unrepresentable: "throw",
});
json.$id = "https://mentat.local/schemas/mentat.schema.json";

// zod emits `format` + a `pattern` for uuid / date-time strings; datamodel-code-generator maps the
// format to UUID / AwareDatetime and would then attach the string pattern to a non-string type,
// which Pydantic rejects at validation time. The formats carry the same semantics on the Python
// side (RFC 4122 UUID, timezone-aware datetime), so the redundant patterns are dropped here.
function dropFormatPatterns(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) dropFormatPatterns(item);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if ((obj.format === "uuid" || obj.format === "date-time") && typeof obj.pattern === "string") {
      delete obj.pattern;
    }
    for (const value of Object.values(obj)) dropFormatPatterns(value);
  }
}
dropFormatPatterns(json);

const path = join(outDir, "mentat.schema.json");
writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
console.log(`wrote ${path}`);
