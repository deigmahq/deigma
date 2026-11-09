// Building the wedge's wire events. Every builder validates against the shared zod schema before
// returning, so an event that cannot be ingested cannot even be queued, and every builder runs the
// secret scanner first: a hit blocks the whole event (collector §2).

import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  Agent,
  DraftCurationEvent,
  ErrorInterceptionEvent,
  ModelInfo,
  PromptHistoryEvent,
  PromptHistoryFeatures,
  ReaderVersion,
  SessionSummaryEvent,
  WedgeStatusEvent,
} from "@mentat/schemas";
import { SCHEMA_VERSION,
  DraftCurationEvent as DraftCurationSchema,
  ErrorInterceptionEvent as ErrorInterceptionSchema,
  PromptHistoryEvent as PromptHistorySchema,
  SessionSummaryEvent as SessionSummarySchema,
  WedgeStatusEvent as WedgeStatusSchema,
} from "@mentat/schemas";

import { computeKc, type KcResult } from "./kc";
import { MODEL_NOT_KNOWN } from "./model";
import { contentHash, editKind, envFeatures, type EnvInputs, promptFeatures } from "./features";
import { assertNoSecrets, SecretFoundError } from "./secrets";

export type WedgeSource = "wedge_vscode" | "wedge_cursor" | "wedge_cli";

export type Identity = {
  userId: string;
  /** 6.1 §12: `backfill` for anything reconstructed from a journal at install time. */
  origin?: "live" | "backfill" | undefined;
  source?: WedgeSource | undefined;
  tool?: { name: string; version: string } | undefined;
  /** Schema 2.4: a model read from an observation (`modelFromId`), or `MODEL_NOT_KNOWN`. The
   *  three model-touching builders REQUIRE it — there is no placeholder to fall back to. */
  model?: ModelInfo | undefined;
  /** Per-device salt for content hashes; stays on the device (collector §2). */
  salt?: string | undefined;
  now?: (() => Date) | undefined;
};

const DEFAULT_TOOL = { name: "deigma-wedge", version: "0.1.0" };

/**
 * The shortest salt a content hash accepts. A device salt is 32 random bytes (44 base64
 * characters); anything far shorter is not a device salt but a word somebody typed.
 */
export const MIN_DEVICE_SALT_LENGTH = 32;

/** A content hash was asked for without the device's own salt. */
export class MissingSaltError extends Error {
  constructor() {
    super("content hashes need the device's own salt; none was given");
    this.name = "MissingSaltError";
  }
}

/**
 * A new device salt: 32 random bytes, made once per device and kept on it (collector §2).
 *
 * The salt is what makes `draft_hash` unusable to anyone but the device. A salt that is the same
 * everywhere — the extension hashed every draft with the literal "device-salt" until 2026-10-09 —
 * turns the hash of a short fragment into something anyone can confirm by hashing guesses: a
 * one-line suggestion has few plausible spellings. With a per-device secret, the same guess has
 * to be made against a salt nobody else holds.
 */
export function newDeviceSalt(): string {
  return randomBytes(32).toString("base64");
}

/**
 * The salt a content hash is made with, or a refusal. There is deliberately NO fallback: a
 * builder that quietly used a constant when the caller forgot the salt is exactly the defect this
 * replaces, and it looked correct in every test because the tests forgot it too.
 */
export function requireDeviceSalt(salt: string | undefined): string {
  if (typeof salt !== "string" || salt.length < MIN_DEVICE_SALT_LENGTH) throw new MissingSaltError();
  return salt;
}

/**
 * The id of a backfilled observation, derived from what it IS rather than when it was read.
 *
 * A live event happens once and gets a fresh id, kept in the wedge's on-disk queue so a retry does
 * not duplicate it. A backfill has no queue: it re-reads the same journals every time it runs, and
 * with a random id each run added another copy of every past session. Three runs of
 * `deigma history` on one machine produced 96 events for 33 sessions — and every claim measured in
 * sessions counted the copies, which is both wrong and a way to inflate a passport by typing one
 * command twice.
 *
 * So the id is a hash of the user, the source and the thing itself. Re-reading the same journal
 * yields the same id, and the ingestion's uniqueness constraint makes the second run a no-op.
 *
 * 2026-10-09: the same holds for a LIVE session read from a journal by the incremental sync
 * (apps/wedge-cli/src/journal-sync.ts) — it is re-read too, and the same session may first travel
 * as live and later be re-read by `deigma history`. So the id depends on what the observation is
 * and never on its origin: any event built with a subject gets the derived id, whichever pass
 * read it, and the second arrival is a duplicate the server drops. Events with no subject (the
 * editor's drafts, status) keep a fresh id, persisted in their on-disk queue.
 */
function backfillEventId(userId: string, source: string, subject: string): string {
  const h = createHash("sha256").update(`${userId}\u0000${source}\u0000${subject}`).digest("hex");
  // Shaped as a UUID because the wire and the database both expect one.
  return [h.slice(0, 8), h.slice(8, 12), `5${h.slice(13, 16)}`, `8${h.slice(17, 20)}`, h.slice(20, 32)].join("-");
}

function envelope(id: Identity, source: WedgeSource, subject?: string) {
  const at = (id.now?.() ?? new Date()).toISOString();
  return {
    event_id:
      subject
        ? backfillEventId(id.userId, id.source ?? source, subject)
        : randomUUID(),
    schema_version: SCHEMA_VERSION,
    user_id: id.userId,
    source: id.source ?? source,
    origin: id.origin ?? "live",
    occurred_at: at,
    sent_at: at,
    tool: id.tool ?? DEFAULT_TOOL,
  };
}

export type DraftCurationInput = Identity & {
  model: ModelInfo;
  /** The device's own salt (`newDeviceSalt`). Required: there is no default to fall back to. */
  salt: string;
  draft: string;
  final: string;
  /** Only its length and hash are used; the path never leaves the device. */
  filePath: string;
  tValidationMs: number;
  nScroll: number;
  nEdits: number;
  branch?: string | undefined;
  repoId?: number | undefined;
  prNumber?: number | undefined;
  kc?: KcResult | undefined;
};

export function buildDraftCuration(input: DraftCurationInput): DraftCurationEvent {
  // The scanner sees the raw text; if it fires, no event exists at all — not even a scrubbed one,
  // because the metrics of a draft that contained a secret can still encode it.
  assertNoSecrets(input.draft, input.final);
  const salt = requireDeviceSalt(input.salt);
  const kc = input.kc ?? computeKc({ draft: input.draft, final: input.final });
  const event = {
    ...envelope(input, "wedge_vscode"),
    model: input.model,
    type: "draft.curation" as const,
    payload: {
      draft_hash: contentHash(input.draft, salt),
      final_hash: contentHash(input.final, salt),
      kc_value: kc.value,
      kc_algo_version: kc.algoVersion,
      size_draft: input.draft.length,
      size_final: input.final.length,
      t_validation_ms: input.tValidationMs,
      n_scroll: input.nScroll,
      n_edits: input.nEdits,
      edit_kind: editKind(kc.value),
      ...(input.branch || input.repoId || input.prNumber
        ? {
            carrier_hint: {
              provider: "github" as const,
              ...(input.repoId ? { repo_id: input.repoId } : {}),
              ...(input.branch ? { branch: input.branch } : {}),
              ...(input.prNumber ? { pr_number: input.prNumber } : {}),
            },
          }
        : {}),
    },
  };
  return DraftCurationSchema.parse(event);
}

export type ErrorInterceptionInput = Identity & {
  model: ModelInfo;
  /** The same device salt as the accepted draft's `draft.curation`. Required. */
  salt: string;
  /** The draft as it was accepted — hashed with the same device salt as its draft.curation. */
  accepted: string;
  /** The text that replaced it. */
  fix: string;
  /** Milliseconds between the acceptance and the correction. */
  tSinceAcceptMs: number;
  /** The correction landed in the same region of the same file on the same branch. */
  sameRegion: boolean;
  branch?: string | undefined;
  repoId?: number | undefined;
  prNumber?: number | undefined;
  kc?: KcResult | undefined;
};

/**
 * "An accepted draft, corrected later in the same carrier context" — the wedge's half of the
 * interception pattern (collector §3.2). The other half (was a defect confirmed by the carrier?
 * is this an I_fix?) belongs to the episode pipeline, so those fields go out null: a wedge that
 * filled them would be guessing about facts it cannot see.
 */
export function buildErrorInterception(input: ErrorInterceptionInput): ErrorInterceptionEvent {
  assertNoSecrets(input.accepted, input.fix);
  const salt = requireDeviceSalt(input.salt);
  const kc = input.kc ?? computeKc({ draft: input.accepted, final: input.fix });
  const event = {
    ...envelope(input, "wedge_vscode"),
    model: input.model,
    type: "error.interception" as const,
    payload: {
      draft_hash: contentHash(input.accepted, salt),
      fix_hash: contentHash(input.fix, salt),
      t_since_accept_ms: Math.max(0, Math.round(input.tSinceAcceptMs)),
      kc_to_fix: kc.value,
      kc_algo_version: kc.algoVersion,
      size_fix: input.fix.length,
      same_region: input.sameRegion,
      ...(input.branch || input.repoId || input.prNumber
        ? {
            carrier_hint: {
              provider: "github" as const,
              ...(input.repoId ? { repo_id: input.repoId } : {}),
              ...(input.branch ? { branch: input.branch } : {}),
              ...(input.prNumber ? { pr_number: input.prNumber } : {}),
            },
          }
        : {}),
      // resolved by the pipeline, never here
      defect_confirmed_by: null,
      defect_kind: null,
      fixed_in_same_episode: null,
      ifix_candidate: null,
    },
  };
  return ErrorInterceptionSchema.parse(event);
}

export type SessionSummaryInput = Identity & {
  model: ModelInfo;
  sessionId: string;
  prompts: string[];
  toolCalls: Record<string, number>;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  iterations: number;
  /**
   * How many requests the session made. Live this is exactly `prompts.length` — the proxy counts a
   * prompt and an iteration in the same breath — so it is derived by default. A backfill knows the
   * count from the journal but holds no prompt text, and reporting 0 requests next to a non-zero
   * iteration count would be a measurement that contradicts itself.
   */
  requests?: number | undefined;
  /**
   * How many turns the PERSON typed (PtR-1.1). Distinct from `requests`, which counts API calls
   * and therefore counts the tool's own retries and continuations: on a real machine the median
   * session had 6 typed turns against a requests total in the thousands. A claim built on the
   * latter would rise with how chatty the tool is, which is a volume, not a skill.
   */
  humanPrompts?: number | undefined;
  /** Verification runs before landing, by category (PtL-1.0). Counts only. */
  verificationRuns?: { test: number; build: number; lint: number; review: number } | undefined;
  env: EnvInputs;
  branch?: string | undefined;
  repoId?: number | undefined;
  /**
   * The pull request the session was working towards, when the proxy can see one. It is what binds
   * the session to an episode: a hint carrying only a branch cannot be resolved, because a carrier
   * event carries the base branch and never the head one. Without it a session belongs to no work,
   * and the path-to-result claim — whose unit is a session that reached a result — has nothing to
   * count.
   */
  prNumber?: number | undefined;
  // --- schema 2.5. Each is left null on the wire when absent: "not observed", never zero.
  /** The reader that read this session from a journal file. Absent for a live session. It also
   *  moves the event into the reader's own id namespace, so a re-read by a corrected reader is
   *  stored beside the old reading (which the server then supersedes) instead of being dropped as
   *  its duplicate. */
  readerVersion?: ReaderVersion | undefined;
  /** What identifies the reading inside the reader's namespace — for a journal, the transcript
   *  and the stretch's start, which do not change as the transcript grows (the session NAME
   *  does: `<id>` becomes `<id>-1` once a second stretch appears). Defaults to `sessionId`. */
  subjectKey?: string | undefined;
  transcriptId?: string | null | undefined;
  suggestionsAccepted?: number | undefined;
  steering?: { interrupts: number; followups_after_interrupt: number } | undefined;
  commitChecks?: { commits: number; verified_after_last_edit: number } | undefined;
  /** Schema 2.6/2.7: habit traces counted on the device (rules hb-1.0, hb-2.0). Counts only. */
  habits?: SessionSummaryEvent["payload"]["habits"] | undefined;
  promptHistory?: PromptHistoryFeatures | null | undefined;
  /** Schema 2.10: the agent whose journal the session was read from. Defaults to Claude Code,
   *  which is what every producer before 2.10 read. */
  agent?: Agent | undefined;
};

export function buildSessionSummary(input: SessionSummaryInput): SessionSummaryEvent {
  assertNoSecrets(...input.prompts);
  // The session id is what the observation IS: the same journal read twice is one session. A
  // reading by a versioned reader lives in that version's namespace; the unversioned subject is
  // what every event before 2.5 was built with, and keeps building the live proxy's.
  const subject = input.readerVersion
    ? `session.summary/${input.readerVersion}:${input.subjectKey ?? input.sessionId}`
    : `session.summary:${input.sessionId}`;
  const event = {
    ...envelope(input, "wedge_cli", subject),
    model: input.model,
    type: "session.summary" as const,
    payload: {
      session_id: input.sessionId,
      duration_ms: input.durationMs,
      requests: input.requests ?? input.prompts.length,
      // PtR-1.1's unit. Defaults to the prompts actually carried, which is right for a live
      // session; a backfill carries no prompt text and states the count it read instead.
      human_prompts: input.humanPrompts ?? input.prompts.length,
      iterations: input.iterations,
      tool_calls: input.toolCalls,
      tokens_in: input.tokensIn,
      tokens_out: input.tokensOut,
      prompt_features: input.prompts.map(promptFeatures),
      env_features: envFeatures({
        ...input.env,
        mcpToolCalls: input.env.mcpToolCalls ?? Object.values(input.toolCalls).reduce((a, b) => a + b, 0),
      }),
      // PtL-1.0: carried from schema 2.2 onward, scored by nothing yet. A claim switched on with
      // no history behind it publishes nothing for months, so the counting starts first.
      verification_runs: input.verificationRuns ?? { test: 0, build: 0, lint: 0, review: 0 },
      ...(input.branch || input.repoId || input.prNumber
        ? {
            carrier_hint: {
              provider: "github" as const,
              ...(input.repoId ? { repo_id: input.repoId } : {}),
              ...(input.branch ? { branch: input.branch } : {}),
              ...(input.prNumber ? { pr_number: input.prNumber } : {}),
            },
          }
        : {}),
      reader_version: input.readerVersion ?? null,
      transcript_id: input.transcriptId ?? null,
      suggestions_accepted: input.suggestionsAccepted ?? null,
      steering: input.steering ?? null,
      commit_checks: input.commitChecks ?? null,
      prompt_history: input.promptHistory ?? null,
      habits: input.habits ?? null,
      agent: input.agent ?? "claude_code",
    },
  };
  return SessionSummarySchema.parse(event);
}

export type PromptHistoryInput = Identity & {
  /** The id the observation is derived from: the transcript id and the stretch, or the project
   *  hash and the day. Never sent — it only makes a re-read the same event. */
  historyId: string;
  transcriptId: string | null;
  grouping: "session" | "project_day";
  durationMs: number;
  projectHash: string;
  repoId: number | null;
  features: PromptHistoryFeatures;
};

/**
 * A session known only from the prompt history (schema 2.5) — its transcript is already gone.
 * No model is known (the history names none), so the not-known shape is stated, not a guess.
 * The features were computed on the device from text that does not reach this builder.
 */
export function buildPromptHistory(input: PromptHistoryInput): PromptHistoryEvent {
  const event = {
    ...envelope(input, "wedge_cli", `prompt.history/${input.features.rules_version}:${input.historyId}`),
    model: input.model ?? MODEL_NOT_KNOWN,
    type: "prompt.history" as const,
    payload: {
      transcript_id: input.transcriptId,
      grouping: input.grouping,
      duration_ms: Math.max(0, Math.round(input.durationMs)),
      project_hash: input.projectHash,
      repo_id: input.repoId,
      features: input.features,
    },
  };
  return PromptHistorySchema.parse(event);
}

export type WedgeStatusInput = Identity & {
  kind: "heartbeat" | "paused" | "resumed" | "error" | "updated";
  wedgeVersion: string;
  errorCode?: string | null | undefined;
};

export function buildWedgeStatus(input: WedgeStatusInput): WedgeStatusEvent {
  const event = {
    ...envelope(input, "wedge_cli"),
    type: "wedge.status" as const,
    payload: {
      kind: input.kind,
      wedge_version: input.wedgeVersion,
      error_code: input.errorCode ?? null,
    },
  };
  return WedgeStatusSchema.parse(event);
}

/**
 * Everything one editing session would put on the wire — the input of the traffic audit
 * (Playbook §8: the public traffic-audit page is generated from exactly this).
 */
export function outgoingTraffic(input: {
  userId: string;
  prompts: string[];
  draft: string;
  final: string;
  filePath: string;
  branch?: string | undefined;
  /** The device salt the hashes are made with. Required, like every content hash's. */
  salt: string;
  now?: (() => Date) | undefined;
}): Array<
  SessionSummaryEvent | DraftCurationEvent | WedgeStatusEvent | ErrorInterceptionEvent
> {
  // The audit describes the traffic, not a model: it states the not-known shape explicitly.
  const id = { userId: input.userId, salt: input.salt, now: input.now, model: MODEL_NOT_KNOWN };
  const events: Array<
    SessionSummaryEvent | DraftCurationEvent | WedgeStatusEvent | ErrorInterceptionEvent
  > = [
    buildWedgeStatus({ ...id, kind: "heartbeat", wedgeVersion: "0.1.0" }),
    buildSessionSummary({
      ...id,
      sessionId: "audit",
      prompts: input.prompts,
      toolCalls: { read_file: 2, edit_file: 1 },
      tokensIn: 900,
      tokensOut: 220,
      durationMs: 60_000,
      iterations: 1,
      env: { mcpTools: ["read_file", "edit_file"], projectInstructionsLoaded: true, reusableSkillCalls: 0 },
      branch: input.branch,
    }),
  ];
  try {
    events.push(
      buildDraftCuration({
        ...id,
        draft: input.draft,
        final: input.final,
        filePath: input.filePath,
        tValidationMs: 30_000,
        nScroll: 4,
        nEdits: 2,
        branch: input.branch,
      }),
    );
  } catch (err) {
    // a secret in the draft blocks that event; the rest of the traffic is unaffected. Only a
    // secret: a missing salt is a defect of the caller and must not read as "nothing to send".
    if (!(err instanceof SecretFoundError)) throw err;
  }
  try {
    events.push(
      buildErrorInterception({
        ...id,
        accepted: input.final,
        fix: `${input.final}\n`,
        tSinceAcceptMs: 90 * 60_000,
        sameRegion: true,
        branch: input.branch,
      }),
    );
  } catch (err) {
    // same rule: a secret anywhere in the pair blocks the interception, not the whole audit
    if (!(err instanceof SecretFoundError)) throw err;
  }
  return events;
}
