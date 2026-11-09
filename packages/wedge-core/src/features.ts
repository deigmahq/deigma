// Local feature extraction: everything the wedge is allowed to send is computed here, from text
// that never leaves the machine (collector §2, §3.2, §4).

import { createHash } from "node:crypto";

import { scrubPii } from "./secrets";

/** Structural entropy of a prompt: token-distribution entropy, bounded and content-free. */
export function hStruct(text: string): number {
  const tokens = scrubPii(text)
    .toLowerCase()
    .match(/[a-z_$][\w$]*|\d+|\S/g);
  if (!tokens || tokens.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / tokens.length;
    h -= p * Math.log2(p);
  }
  return Math.round(h * 1e4) / 1e4;
}

/** Content mass: share of tokens that carry meaning rather than filler, in [0, 1]. */
export function contentMass(text: string): number {
  const tokens = scrubPii(text).toLowerCase().match(/[a-z_$][\w$]*|\d+/g) ?? [];
  if (tokens.length === 0) return 0;
  const filler = new Set([
    "the", "a", "an", "please", "can", "you", "i", "we", "it", "this", "that", "and", "or", "to",
    "of", "for", "in", "on", "is", "be", "do", "just", "some", "thanks",
  ]);
  const meaningful = tokens.filter((t) => !filler.has(t) && t.length > 2).length;
  return Math.round((meaningful / tokens.length) * 1e4) / 1e4;
}

/** The closed vocabulary of prompt category flags. Closed on purpose: a fixed enum is metadata,
 * an open list would be a channel for text (collector §3.2 "флаги категорий — без текста"). */
export const PROMPT_CATEGORIES = [
  "refactor",
  "test",
  "fix",
  "feature",
  "explain",
  "constraints",
  "other",
] as const;
export type PromptCategory = (typeof PROMPT_CATEGORIES)[number];

/** Coarse categories of a prompt — flags from the closed vocabulary, never text. */
export function promptCategories(text: string): PromptCategory[] {
  const t = scrubPii(text).toLowerCase();
  const categories: PromptCategory[] = [];
  if (/\b(refactor|rename|extract|simplif)/.test(t)) categories.push("refactor");
  if (/\b(test|spec|assert|coverage)/.test(t)) categories.push("test");
  if (/\b(fix|bug|error|fail|crash|regression)/.test(t)) categories.push("fix");
  if (/\b(add|implement|create|build|support)/.test(t)) categories.push("feature");
  if (/\b(explain|why|how|understand|document)/.test(t)) categories.push("explain");
  if (/\b(must|should|constraint|requirement|keep|do not|never)/.test(t)) categories.push("constraints");
  return categories.length > 0 ? categories : ["other"];
}

export type PromptFeatures = {
  h_struct: number;
  content_mass: number;
  length: number;
  categories: PromptCategory[];
};

export function promptFeatures(text: string): PromptFeatures {
  return {
    h_struct: hStruct(text),
    content_mass: contentMass(text),
    length: text.length,
    categories: promptCategories(text),
  };
}

/** Salted content hash used to link events (collector §2: salt stays on the device). */
export function contentHash(text: string, salt: string): string {
  return createHash("sha256").update(salt).update(text, "utf8").digest("hex");
}

export type EnvInputs = {
  /** Distinct MCP tools seen in the session. */
  mcpTools: string[];
  /** Total MCP tool calls. */
  mcpToolCalls?: number | undefined;
  /** Whether project instructions (CLAUDE.md, .cursorrules, …) were loaded — the fact, not the text. */
  projectInstructionsLoaded: boolean;
  /** Calls to reusable skills/commands. */
  reusableSkillCalls: number;
};

/**
 * Environment features (collector §4), definition E-1.0: how much tool surface a session touched.
 * Core 7: E-1.1 (project equipping — project hash and component lists) was retired and nothing
 * reads it any more, so the wedge neither computes nor sends it. The schema still accepts those
 * fields from older clients; this function never emits them.
 */
export function envFeatures(inputs: EnvInputs) {
  // Saturating scale: the third distinct tool already says "this person equips their environment";
  // beyond that the signal flattens instead of rewarding tool sprawl.
  const diversity = 1 - Math.exp(-inputs.mcpTools.length / 3);
  return {
    e_definition_version: "E-1.0" as const,
    mcp_tool_diversity: Math.round(Math.min(1, diversity) * 1e4) / 1e4,
    // The COUNT as well as the saturating share. E uses the share; a person reading their own
    // History panel wants "ten tools", and inverting the share to recover it is both lossy near
    // saturation and the kind of arithmetic nobody should have to do to read a page. A count is
    // not a name — the names stay on the device either way.
    mcp_tool_count: inputs.mcpTools.length,
    mcp_tool_calls: inputs.mcpToolCalls ?? 0,
    project_instructions_loaded: inputs.projectInstructionsLoaded,
    reusable_skill_calls: inputs.reusableSkillCalls,
  };
}

/** Edit kind from the measured similarity (collector §3.2). */
export function editKind(kc: number): "accept" | "light" | "deep" | "rewrite" {
  if (kc >= 0.995) return "accept";
  if (kc >= 0.85) return "light";
  if (kc >= 0.4) return "deep";
  return "rewrite";
}
