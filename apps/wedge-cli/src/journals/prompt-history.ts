/**
 * Claude Code's prompt history, `~/.claude/history.jsonl`, read on the device (schema 2.5).
 *
 * Why it is read at all. Claude Code deletes session transcripts after about thirty days and keeps
 * this file for months (measured 2026-10-09: 44 sessions in the history since 2026-01-15 against 5
 * transcripts left). For everything older than a month it is the only record of how somebody
 * worked with the agent — and for a session that still has its transcript, it says what the
 * transcript does not: how big the pastes were, how long the prompts were, how the person paced
 * and corrected the work.
 *
 * The record, as the tool writes it: `{display, pastedContents: {<n>: {id, type, content?,
 * contentHash?}}, timestamp, project, sessionId}`. `display` is the prompt as typed — with a
 * `[Pasted text #n +L lines]` placeholder where a paste went — and `content` is the pasted text.
 * BOTH ARE CONTENT. They are read here, on this machine, only to compute the numbers below by the
 * public rules in `PH_RULES`; no prompt, no paste, no hash of either, and no path leaves. What
 * leaves is `PromptHistoryFeatures`: counts, buckets, and slash-command names from a fixed list.
 *
 * Read a line at a time (./lines.ts): the file holds every paste the person ever made.
 */
import { SLASH_COMMANDS, type PromptHistoryFeatures, type SlashCommand } from "@mentat/schemas";

import { forEachLine } from "./lines";
import { TRANSCRIPT_ID } from "./claude-code";

/**
 * The rules, versioned. A change to any number or word here changes what the features MEAN and
 * moves `version` — which travels on the wire as `rules_version`, so a reading made under one set
 * of rules is never compared with one made under another. Public by design: the person can check
 * from this file exactly what was counted.
 */
export const PH_RULES = Object.freeze({
  version: "ph-1.0" as const,
  /** Prompt length buckets, in characters of what was typed (paste placeholders included). */
  shortBelowChars: 80,
  longFromChars: 500,
  /** Paste size buckets, in lines. */
  pasteMediumFromLines: 20,
  pasteLargeFromLines: 200,
  /** A corrective follow-up: a typed prompt no longer than this … */
  correctiveMaxChars: 160,
  /** … that came within this long of the previous typed prompt in the same session … */
  correctiveMaxGapMs: 10 * 60_000,
  /** … and whose first word is one of these (lower-cased, punctuation stripped). English, Russian
   *  and Ukrainian, because those are the languages of the people the product launches with. */
  correctiveWords: Object.freeze([
    "no", "nope", "wrong", "not", "don't", "dont", "stop", "wait", "actually", "instead", "undo", "revert", "rollback",
    "нет", "не", "стоп", "неправильно", "неверно", "отмени", "отмена", "верни", "откати", "погоди", "ні",
  ]),
});

const SLASH = new Set<string>(SLASH_COMMANDS);
const CORRECTIVE = new Set<string>(PH_RULES.correctiveWords);
const SLASH_NAME = /^\/([A-Za-z0-9:_-]+)/;
const PASTE_PLACEHOLDER = /\[Pasted text #(\d+) \+(\d+) lines?\]/g;

type PasteTally = { text_small: number; text_medium: number; text_large: number; text_unknown: number; images: number };

/** One history record reduced to what the rules read. No string of the record survives. */
export type HistoryPrompt = {
  at: number;
  kind: "typed" | "slash" | "shell";
  slash: SlashCommand | null;
  chars: number;
  /** First word is a correction word and the prompt is short; the timing half is decided later,
   *  once the session's prompts are in order. */
  correctiveWord: boolean;
  pastes: PasteTally;
};

/** Prompts of one session (by the transcript id the history names) or, for old records that name
 *  none, of one project on one day. `project` stays on the device: it is hashed with the device
 *  salt and matched against connected repositories, never sent. */
export type HistoryGroup = {
  key: string;
  transcriptId: string | null;
  project: string | null;
  prompts: HistoryPrompt[];
};

function emptyPastes(): PasteTally {
  return { text_small: 0, text_medium: 0, text_large: 0, text_unknown: 0, images: 0 };
}

function lineBucket(lines: number): keyof PasteTally {
  if (lines >= PH_RULES.pasteLargeFromLines) return "text_large";
  if (lines >= PH_RULES.pasteMediumFromLines) return "text_medium";
  return "text_small";
}

function firstWord(text: string): string {
  const word = text.trim().split(/\s+/, 1)[0] ?? "";
  return word.toLowerCase().replace(/[.,!?:;…"'«»()]+$/u, "").replace(/^[«"'(]+/u, "");
}

function timestampOf(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return NaN;
}

/** One record of history.jsonl as the rules see it, or null when it is not a prompt. Exported for
 *  the test that watches which keys of a record are ever read. */
export function historyPrompt(rec: Record<string, unknown>): { prompt: HistoryPrompt; transcriptId: string | null; project: string | null } | null {
  const at = timestampOf(rec.timestamp);
  if (!Number.isFinite(at)) return null;
  const display = typeof rec.display === "string" ? rec.display : "";
  const pasted = rec.pastedContents && typeof rec.pastedContents === "object" ? (rec.pastedContents as Record<string, unknown>) : {};
  const pasteEntries = Object.values(pasted).filter((p): p is Record<string, unknown> => !!p && typeof p === "object");
  const text = display.trimStart();
  if (!text && pasteEntries.length === 0) return null;

  // Lines a placeholder announces, by paste id: the size of a paste the tool kept only by reference.
  const announced = new Map<string, number>();
  for (const m of display.matchAll(PASTE_PLACEHOLDER)) announced.set(m[1]!, Number(m[2]));

  const pastes = emptyPastes();
  for (const p of pasteEntries) {
    if (p.type === "image") {
      pastes.images += 1;
      continue;
    }
    if (p.type !== "text") continue;
    if (typeof p.content === "string") {
      let lines = 1;
      for (let i = p.content.indexOf("\n"); i !== -1; i = p.content.indexOf("\n", i + 1)) lines += 1;
      pastes[lineBucket(lines)] += 1;
    } else {
      const lines = announced.get(String(p.id));
      if (lines !== undefined && Number.isFinite(lines)) pastes[lineBucket(lines)] += 1;
      else pastes.text_unknown += 1;
    }
  }

  let kind: HistoryPrompt["kind"] = "typed";
  let slash: SlashCommand | null = null;
  const name = SLASH_NAME.exec(text)?.[1];
  if (name) {
    kind = "slash";
    const low = name.toLowerCase();
    slash = SLASH.has(low) ? (low as SlashCommand) : "other";
  } else if (text.startsWith("!")) {
    kind = "shell";
  }
  const chars = [...display].length;
  const transcriptId =
    typeof rec.sessionId === "string" && TRANSCRIPT_ID.test(rec.sessionId) ? rec.sessionId.toLowerCase() : null;
  const project = typeof rec.project === "string" && rec.project ? rec.project : null;
  return {
    prompt: {
      at,
      kind,
      slash,
      chars,
      correctiveWord: kind === "typed" && chars <= PH_RULES.correctiveMaxChars && CORRECTIVE.has(firstWord(text)),
      pastes,
    },
    transcriptId,
    project,
  };
}

/** Every prompt of the history file, grouped. Empty when there is no file — no Claude Code here,
 *  or no history yet: not an error. */
export function readPromptHistory(file: string): Map<string, HistoryGroup> {
  const groups = new Map<string, HistoryGroup>();
  forEachLine(file, (line) => {
    if (!line.trim()) return;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return; // a half-written last line, as in any journal
    }
    if (!rec || typeof rec !== "object") return;
    const read = historyPrompt(rec as Record<string, unknown>);
    if (!read) return;
    const day = new Date(read.prompt.at).toISOString().slice(0, 10);
    const key = read.transcriptId ?? `project-day:${read.project ?? ""}:${day}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, transcriptId: read.transcriptId, project: read.project, prompts: [] };
      groups.set(key, g);
    }
    if (!g.project && read.project) g.project = read.project;
    g.prompts.push(read.prompt);
  });
  for (const g of groups.values()) g.prompts.sort((a, b) => a.at - b.at);
  return groups;
}

/** Splits a group's prompts where the person stopped for longer than the idle gap — the ONE
 *  definition of a session the transcript reader uses too (../measurement). */
export function splitByIdleGap(prompts: HistoryPrompt[], gapMs: number): HistoryPrompt[][] {
  const out: HistoryPrompt[][] = [];
  for (const p of prompts) {
    const current = out[out.length - 1];
    if (current && p.at - current[current.length - 1]!.at <= gapMs) current.push(p);
    else out.push([p]);
  }
  return out;
}

/** Nearest-rank percentile of a sorted, non-empty list. */
function percentile(sorted: number[], q: number): number {
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

/** The features of a run of prompts (sorted by time), by `PH_RULES`. */
export function historyFeatures(prompts: HistoryPrompt[]): PromptHistoryFeatures {
  const slash = new Map<SlashCommand, number>();
  const pastes = emptyPastes();
  const length = { short: 0, medium: 0, long: 0 };
  let typed = 0;
  let shell = 0;
  let corrective = 0;
  const gaps: number[] = [];
  let lastTyped: number | null = null;
  for (const p of prompts) {
    for (const k of Object.keys(pastes) as (keyof PasteTally)[]) pastes[k] += p.pastes[k];
    if (p.kind === "slash") {
      slash.set(p.slash!, (slash.get(p.slash!) ?? 0) + 1);
      continue;
    }
    if (p.kind === "shell") {
      shell += 1;
      continue;
    }
    typed += 1;
    if (p.chars < PH_RULES.shortBelowChars) length.short += 1;
    else if (p.chars >= PH_RULES.longFromChars) length.long += 1;
    else length.medium += 1;
    if (lastTyped !== null) {
      const gap = p.at - lastTyped;
      gaps.push(Math.max(0, Math.round(gap / 1000)));
      if (p.correctiveWord && gap <= PH_RULES.correctiveMaxGapMs) corrective += 1;
    }
    lastTyped = p.at;
  }
  gaps.sort((a, b) => a - b);
  return {
    rules_version: PH_RULES.version,
    typed_prompts: typed,
    slash_commands: [...slash.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({ name, count })),
    shell_commands: shell,
    pastes,
    prompt_length: length,
    gap_seconds: gaps.length > 0 ? { p50: percentile(gaps, 0.5), p90: percentile(gaps, 0.9) } : null,
    corrective_followups: corrective,
  };
}

/** The prompts of a group that fall inside a transcript stretch, with a minute of slack either
 *  side: the history stamps a prompt when it is submitted, the transcript when it is recorded. */
export function promptsWithin(prompts: HistoryPrompt[], startedAt: string, endedAt: string): HistoryPrompt[] {
  const from = Date.parse(startedAt) - 60_000;
  const to = Date.parse(endedAt) + 60_000;
  return prompts.filter((p) => p.at >= from && p.at <= to);
}
