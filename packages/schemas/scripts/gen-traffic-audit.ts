// Walks the generated JSON Schema and writes the exhaustive field list of everything the wedge
// sends, with the one-line notes from src/traffic-audit.ts. Run by scripts/gen-traffic-audit; the
// result is committed and drift-checked, so a new field cannot reach the wire without appearing
// on the public page.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FIELD_NOTES, NEVER_SENT, WEDGE_EVENT_TYPES } from "../src/traffic-audit";

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  enum?: unknown[];
  items?: JsonSchema;
  $ref?: string;
  const?: unknown;
};

const root = fileURLToPath(new URL("../", import.meta.url));
const schema = JSON.parse(readFileSync(`${root}json/mentat.schema.json`, "utf8")) as {
  $defs: Record<string, JsonSchema>;
};

const EVENT_DEFS: Record<(typeof WEDGE_EVENT_TYPES)[number], string> = {
  "session.summary": "SessionSummaryEvent",
  "draft.curation": "DraftCurationEvent",
  "error.interception": "ErrorInterceptionEvent",
  "wedge.status": "WedgeStatusEvent",
  "prompt.history": "PromptHistoryEvent",
};

const ENVELOPE_FIELDS = new Set([
  "event_id",
  "schema_version",
  "user_id",
  "source",
  "origin",
  "occurred_at",
  "sent_at",
  "tool",
  "model",
  "type",
]);

function resolve(node: JsonSchema): JsonSchema {
  if (node.$ref) {
    const name = node.$ref.replace("#/$defs/", "");
    return resolve(schema.$defs[name] ?? {});
  }
  return node;
}

function typeName(node: JsonSchema): string {
  const n = resolve(node);
  if (n.enum) return `one of: ${n.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  if (n.const !== undefined) return `constant ${JSON.stringify(n.const)}`;
  if (n.anyOf) {
    return `${n.anyOf.map(typeName).filter((t) => t !== "null").join(" or ")} (nullable)`;
  }
  if (n.type === "array") return `list of ${n.items ? typeName(n.items) : "values"}`;
  if (n.type === "object" && n.properties) return "object";
  return n.type ?? "value";
}

type Field = { path: string; type: string; required: boolean };

function walk(node: JsonSchema, prefix: string, out: Field[]): void {
  const n = resolve(node);
  if (!n.properties) return;
  for (const [key, value] of Object.entries(n.properties)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const resolved = resolve(value);
    const required = (n.required ?? []).includes(key);
    const items = resolved.type === "array" && resolved.items ? resolve(resolved.items) : null;
    // A nullable object (schema 2.5: `steering`, `prompt_history`, …) is its fields on the page,
    // each of them as optional as the object: null is "not observed", not a field of its own.
    const all = (resolved.anyOf ?? []).map(resolve);
    const nullable = all.some((v) => v.type === "null");
    const variants = all.filter((v) => v.type !== "null");
    if (nullable && variants.length === 1 && variants[0]!.type === "object" && variants[0]!.properties) {
      const own: Field[] = [];
      walk(variants[0]!, path, own);
      for (const f of own) out.push({ ...f, required: false });
    } else if (resolved.type === "object" && resolved.properties) {
      walk(resolved, path, out);
    } else if (variants.length > 0 && variants.every((v) => v.type === "object" && v.properties)) {
      // A union of objects (schema 2.4: `model` is a reported model OR the not-known shape) is
      // every field of every variant on the page — a field that only one variant carries is
      // still a field on the wire. Required only where every variant requires it.
      const merged = new Map<string, Field & { seen: number }>();
      for (const v of variants) {
        const own: Field[] = [];
        walk(v, path, own);
        for (const f of own) {
          const prev = merged.get(f.path);
          if (!prev) merged.set(f.path, { ...f, seen: 1 });
          else {
            const types = new Set([...prev.type.split(" or "), f.type]);
            merged.set(f.path, { path: f.path, type: [...types].join(" or "), required: prev.required && f.required, seen: prev.seen + 1 });
          }
        }
      }
      for (const { seen, ...f } of merged.values()) out.push({ ...f, required: f.required && seen === variants.length && required });
    } else if (items?.properties) {
      // A list of objects is a list of fields on the page: "prompt_features[].h_struct".
      walk(items, `${path}[]`, out);
    } else {
      out.push({ path, type: typeName(value), required });
    }
  }
}

const events = WEDGE_EVENT_TYPES.map((type) => {
  const def = schema.$defs[EVENT_DEFS[type]];
  if (!def) throw new Error(`no schema for ${type}`);
  const fields: Field[] = [];
  walk(def, "", fields);
  return {
    type,
    envelope: fields
      .filter((f) => ENVELOPE_FIELDS.has(f.path.split(".")[0] ?? ""))
      .map((f) => ({ ...f, note: FIELD_NOTES[`envelope.${f.path}`] ?? null })),
    payload: fields
      .filter((f) => f.path.startsWith("payload."))
      .map((f) => {
        const path = f.path.replace(/^payload\./, "");
        return { ...f, path, note: FIELD_NOTES[`${type}.${path}`] ?? null };
      }),
  };
});

const missing = events.flatMap((e) =>
  [...e.envelope, ...e.payload].filter((f) => f.note === null).map((f) => `${e.type}: ${f.path}`),
);
const described = new Set(
  events.flatMap((e) => [
    ...e.envelope.map((f) => `envelope.${f.path}`),
    ...e.payload.map((f) => `${e.type}.${f.path}`),
  ]),
);
const orphans = Object.keys(FIELD_NOTES).filter((k) => !described.has(k));

if (missing.length || orphans.length) {
  // A field on the wire without a line on the page is exactly the failure this generator exists
  // to prevent; a line without a field means the page describes something that no longer happens.
  console.error("traffic audit is out of sync with the schemas:");
  for (const m of missing) console.error(`  undescribed field: ${m}`);
  for (const o of orphans) console.error(`  described field that no longer exists: ${o}`);
  process.exit(1);
}

const output = {
  generated_from: "packages/schemas/json/mentat.schema.json",
  note: "Generated by scripts/gen-traffic-audit — do not edit by hand.",
  never_sent: NEVER_SENT,
  events,
};
writeFileSync(`${root}traffic-audit.json`, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `traffic audit: ${events.length} event types, ` +
    `${events.reduce((n, e) => n + e.payload.length, 0)} payload fields`,
);
