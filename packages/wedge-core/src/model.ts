// The model behind a wedge event, and the coarse generation it belongs to (schema 2.4).
//
// Until 2026-10-09 every wedge event carried the constant {unknown, unknown, "2026H2"} in a
// mandatory field: the Claude Code journal parser already read `message.model` and the backfill
// dropped it, and the extension sent nothing. A placeholder in a mandatory field is worse than an
// absent one — it looks like data. Now there are exactly two answers:
//
//   * a REPORTED model, read from an observation (the journal's own `message.model`), whose name
//     passes the allow-list below, with a generation tag DERIVED from the name;
//   * NOT KNOWN — `MODEL_NOT_KNOWN`, a shape the schema keeps apart from any model.
//
// The allow-list. A model id is a vendor's name, but nothing stops a person from routing a tool to
// a model they named themselves (a fine-tune, a proxy alias: `acme-billing-gpt`), and that name
// is an employer travelling in the envelope. So only names in a shape CONFIRMED on real journals
// travel (CLAUDE.md: a format not confirmed on a real file is not implemented). Measured
// 2026-10-09 on this machine's ~/.claude/projects: `claude-opus-5`, `claude-opus-5-5`,
// `claude-fable-5`, plus the journal's own `<synthetic>` marker, which is not a model. Older
// Claude ids (`claude-sonnet-4-5-20250929`, `claude-3-5-sonnet-20241022`) are Anthropic's
// documented naming and parse by the same two rules. Bedrock/Vertex spellings
// (`us.anthropic.claude-…`, `claude-…@date`) and other vendors were not seen on a real journal and
// therefore are NOT KNOWN rather than guessed at.
//
// The generation mapping (documented here, tested in test/model.test.ts):
//   claude-<tier>-<major>[-<minor>][-<yyyymmdd>]   -> claude-<major>[.<minor>]
//       claude-opus-5 -> claude-5;  claude-opus-5-5 -> claude-5.5;
//       claude-sonnet-4-5-20250929 -> claude-4.5;  claude-sonnet-4-20250514 -> claude-4
//   claude-<major>[-<minor>]-<tier>[-<yyyymmdd>]   -> claude-<major>[.<minor>]   (pre-2025 ids)
//       claude-3-5-sonnet-20241022 -> claude-3.5;  claude-3-opus-20240229 -> claude-3
//   anything else, including a claude-… alias        -> NOT KNOWN
// The tier (opus / sonnet / haiku / fable …) is in `name` and deliberately not in the tag: the tag
// groups like with like across a generation, which is what it exists for.
import type { ModelInfo } from "@mentat/schemas";

/** The explicit "we do not know which model", distinct by shape from any model (schema 2.4). */
export const MODEL_NOT_KNOWN = Object.freeze({
  known: false,
  family: "unknown",
  name: "unknown",
  generation_tag: "unknown",
} as const);

/** The longest model id that travels. Real ids are under 40 characters. */
const MAX_NAME = 64;
// The EXACT grammar (review of PR #29, S1). A prefix rule let `claude-acme-billing-migration` — a
// gateway alias, an employer — travel as a model. Only Anthropic's two naming schemes pass:
//   claude-<tier>-<major>[-<minor>][-<yyyymmdd>]   tier from a closed list
const CLAUDE_ID = /^claude-(opus|sonnet|haiku|fable)-\d{1,2}(-\d{1,2})?(-\d{8})?$/;
//   claude-<major>[-<minor>]-<tier>-<yyyymmdd>     (pre-2025 ids)
const CLAUDE_LEGACY_ID = /^claude-\d(-\d)?-(opus|sonnet|haiku)-\d{8}$/;
// OpenAI's naming, for Codex (schema 2.10). Confirmed on a real
// Codex journal on 2026-10-20 (`turn_context.model`, shape only): `gpt-<major>.<minor>-<tier>` with
// the tier `sol`. The other tiers are OpenAI's documented Codex model names (`gpt-5-codex`,
// `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`); a closed list, so a gateway alias (`gpt-5-acme`)
// stays NOT KNOWN like a Claude alias does.
//   gpt-<major>[.<minor>][-<tier>]   -> gpt-<major>[.<minor>]
//       gpt-5.5-sol -> gpt-5.5;  gpt-5-codex -> gpt-5;  gpt-5.1-codex-max -> gpt-5.1
const GPT_ID = /^gpt-(\d{1,2})(?:\.(\d{1,2}))?(?:-(?:sol|codex|codex-max|codex-mini|mini|nano|pro))?$/;
const DATE = /^\d{8}$/;
const NUM = /^\d{1,2}$/;

/** `claude-<major>[.<minor>]` from a Claude id, or null when the id states no version. */
export function claudeGeneration(id: string): string | null {
  const parts = id.split("-").slice(1); // drop "claude"
  const nums = (from: number): string[] => {
    const out: string[] = [];
    for (let i = from; i < parts.length && out.length < 2; i += 1) {
      const p = parts[i]!;
      if (DATE.test(p) || !NUM.test(p)) break;
      out.push(p);
    }
    return out;
  };
  // pre-2025: the version comes first (claude-3-5-sonnet-…)
  let version = nums(0);
  // current: a tier word, then the version (claude-sonnet-4-5-…)
  if (version.length === 0 && parts.length > 1 && /^[a-z]+$/.test(parts[0]!)) version = nums(1);
  if (version.length === 0) return null;
  return `claude-${version.join(".")}`;
}

/**
 * The model an observation names, as it may travel: a reported model for an allow-listed id,
 * `MODEL_NOT_KNOWN` for anything else — including no id at all.
 */
export function modelFromId(id: string | null | undefined): ModelInfo {
  if (typeof id !== "string") return MODEL_NOT_KNOWN;
  const name = id.trim().toLowerCase();
  const gpt = name.length <= MAX_NAME ? GPT_ID.exec(name) : null;
  if (gpt) return { family: "gpt", name, generation_tag: `gpt-${gpt[1]}${gpt[2] !== undefined ? `.${gpt[2]}` : ""}` };
  if (name.length === 0 || name.length > MAX_NAME || !(CLAUDE_ID.test(name) || CLAUDE_LEGACY_ID.test(name))) {
    return MODEL_NOT_KNOWN;
  }
  const generation = claudeGeneration(name);
  return generation ? { family: "claude", name, generation_tag: generation } : MODEL_NOT_KNOWN;
}
