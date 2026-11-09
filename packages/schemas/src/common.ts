import { z } from "zod";

// Wire schemas are declarative only (no .transform / .refine) and closed (strictObject: unknown
// keys are rejected, so no content field can travel unnoticed): everything here must survive
// z.toJSONSchema() unchanged so the Pydantic side validates the same contract (plan §5.1).

// 2.1 (carriers v2): CarrierRef became a discriminated union — a carrier is a pull request, a
// run of commits or a release, and `kind` says which. Migration: events written under 2.0 carry a
// carrier without `kind`; the pipeline reads those as `pr`, which is what they were. Nothing is
// rewritten in place — a 2.0 event stays a 2.0 event and means the same thing.
//
// 2.2 (E-1.1, PtL-1.0, PtR-1.1): `session.summary` gained three things, all of them counts or
// closed-vocabulary flags computed on the device.
//   * `env_features` can now speak E-1.1 — six binary components of a PROJECT, each of them
//     `configured AND used`, carried as two lists of component names plus a salted project hash
//     so the server can group sessions by project without learning which project it is. E-1.0
//     events keep their fields and keep their meaning; the two definitions coexist on the wire
//     and the snapshot records which one scored it.
//   * `verification_runs` — how many test / build / lint / review runs a session made, by
//     category from a closed vocabulary. The arguments of those commands never leave the device.
//     Nothing counts it yet (DEIGMA_FEATURE_VERIFY_BEFORE_LANDING is off); the field travels now
//     so that when the claim turns on there is history to compute it from.
//   * `human_prompts` — how many turns the PERSON typed, as distinct from `requests`, which
//     counts API calls and therefore counts the machine's own retries and continuations.
// Migration: every 2.2 field has a default, so a 2.1 producer stays valid and reads as a session
// that used E-1.0, ran no verification and reported no prompt count.
//
// 2.3 (outcome-2.0, audit 2026-10-08): `CommitMeta` gained `run_added_lines` and
// `later_removed_lines` — the exact line numbers a run added and the exact old-side line numbers
// its window later removed, read from the hunk bodies by line prefix with the text dropped in
// memory. They replace the hunk-header spans of `run_line_ranges` / `later_line_ranges` as the
// input of the rewrite share; the old fields stay on the wire and keep their meaning, so an event
// measured under 2.2 goes on saying what it measured. Both new fields are nullable with a default
// of null, which is how the pipeline tells an event that does not speak the exact definition
// from one that does and found nothing. `rewrite_observed` events that carry them are keyed in a
// new id namespace (`rewrite2:`), so a re-backfill can write the exact measurement next to the
// old one instead of being dropped as its duplicate.
// The snapshot moved with it (no wire event involved): `volumes.outcome_categories` counts only
// outcomes pinned to ONE category, `volumes.outcome_ranges` / `n_outcomes_ungraded` hold the
// intervals, `volumes.n_outcomes_pending` counts provisional outcomes not yet final, and episodes
// carry `outcome_definition_version`.
// Review of 2026-10-08, still 2.3 (it had not been released — nothing outside the
// fix/outcome-measurement branch ever produced or accepted it — so the version did not move):
// `CarrierEventKind` gained `base_ci_passed` / `base_ci_failed` (the check runs of a run's base
// commit, bound to the run); episodes carry the VARIANT of the outcome definition that decided
// them (`outcome-2.0`, `-spans`, `-flat-ci`, `-spans-flat-ci`); snapshot provenance gained
// `outcome_definition_mix`, the count of scored episodes per variant.
// Migration: every 2.3 field has a default, so 2.1/2.2 producers stay valid and read as events
// measured by the spans; snapshots and episodes written before 2.3 read as outcome-1.0.
//
// 2.4 (wedge binding, audit 2026-10-09): the envelope's `model` became a union of two shapes.
//   * `ReportedModel` {family, name, generation_tag} — unchanged, and now only ever a model the
//     wedge actually read: the Claude Code journal's own `message.model`, allow-listed by shape,
//     with `generation_tag` DERIVED from the name by the documented mapping in
//     packages/wedge-core/src/model.ts (`claude-sonnet-4-5-20250929` -> `claude-4.5`).
//   * `ModelNotKnown` {known: false, family/name/generation_tag: "unknown"} — the explicit
//     statement that the wedge does not know which model produced the work (the editor: no
//     editor API names the model behind an inline suggestion). Distinct by shape, so no reader
//     can take it for a model.
// Until 2.4 every wedge sent the constant {unknown, unknown, "2026H2"} in a mandatory field — a
// placeholder that looked like data. Migration: an event with schema_version <= 2.3 carries no
// model information at all, whatever its `model` says (no producer before 2.4 ever filled it
// from an observation); readers treat it as not known. Nothing is rewritten in place.
// No payload field changed: the pr-link binding (#4) and the editor's repository id (#3) ride in
// `carrier_hint.pr_number` / `carrier_hint.repo_id`, which have been on the wire since 2.0.
//
// 2.5 (one version, two sprints merged on 2026-10-10 — the terminal reader and the evidence class):
//   Terminal reader cc-reader-2 + the prompt history:
//   * `session.summary` gained `reader_version` and `transcript_id`. A journal re-read by a
//     corrected reader REPLACES the earlier reading of the same transcript — the server keeps,
//     per (user, source, transcript), only the events of the highest reader version. Events
//     without the fields are read as
//     what they were: a `wedge_cli` backfill of `cc-reader-1`, its transcript the uuid at the
//     head of its `session_id`; a live event is no reading of a file and is never replaced.
//     Re-read events travel in a new id namespace (`session.summary/cc-reader-2:`), so the
//     server stores them beside the old ones instead of dropping them as duplicates.
//   * `human_prompts` MEANS something narrower under `cc-reader-2`: turns the person typed, by
//     the tool's own `promptSource` / `origin.kind`, never a background task's notification or a
//     local command (SR2 D1, measured 1.9x inflation). Same field, new definition — which is why
//     the reader version travels beside it, and why PtR-1.1's input change is journalled.
//   * New, all nullable with a default of null, meaning "this producer did not observe it"
//     rather than zero: `suggestions_accepted`, `steering` {interrupts,
//     followups_after_interrupt}, `commit_checks` {commits, verified_after_last_edit} and
//     `prompt_history` — features of the person's prompt history computed on the device by
//     public, versioned rules (`ph-1.0`): counts, buckets and a closed list of slash-command
//     names, never text and never a hash of text.
//   * New event type `prompt.history`: the same features for a session whose transcript the
//     tool has already deleted (Claude Code keeps transcripts ~30 days and its prompt history
//     for months). It carries no claim input and binds to no carrier; a session that has a
//     transcript never travels as one (the transcript wins).
//   Evidence class:
//   * `CarrierEventPayload.merged_by` — for a `merged` event, who pressed merge, as a class
//     (`author` / `another_person` / `bot`), never as an identity. A merged event used to carry
//     the AUTHOR as its actor whoever merged, so "merged by somebody else" was unrecordable and a
//     self-merge read the same as an accepted one. `merged` events that carry the class are keyed
//     in a new id namespace (`merged-by:`), so a re-backfill writes the answer next to the old
//     event instead of being dropped as its duplicate; the pipeline reads the event that knows
//     over the one that does not.
// Migration (one note for the whole of 2.5): every new field has a default, so 2.1–2.4 producers
// stay valid. Their session.summary events read as `cc-reader-1` (backfill) or as no reading (live),
// with nothing observed of the new fields; their `merged` events parse with `merged_by` null, which
// means "merger not recorded" — never "the author merged it".
//
// 2.6 (Core 7, 2026-10-15): the passport's claim became "decisions by others".
//   * `CarrierEventPayload.closed_by` — for a `closed` event, who closed it, as a class.
//   * `PullRequestMeta.author_ordinal` — the pull request is its author's n-th in the repository.
//   * `SessionSummaryPayload.habits` — habit traces T1/T3/T4/T7 as counts (rules `hb-1.0`).
//   `closed` events that carry the class are keyed in a new id namespace (`closed-by:`), the same
//   way 2.5 keyed `merged-by:`, so a re-backfill writes the answer beside the old event.
// Migration: every new field has a default of null meaning "not observed", so 2.1–2.5 producers
// stay valid and an old event never reads as a decision nobody recorded.
//
// 2.7 (2026-10-17, practice index pi-1.0): `Habits` gains the twelve hb-2.0 traces the practice
//   index reads; `rules_version` is "hb-1.0" | "hb-2.0".
// Migration: every new trace defaults to null ("no occasion / not counted"), so 2.6 producers stay
// valid and an old session never reads as a practice skipped.
//
// 2.8 (2026-10-17, practice index pi-1.2): `Habits` gains `clear_goal`, `one_task`, `gives_context`
//   (rules `hb-2.1`), counted on the device from the person's own typed prompts — the text is read
//   in memory and never sent; `rules_version` is "hb-1.0" | "hb-2.0" | "hb-2.1" | "hb-2.2". hb-2.2
//   (solo review wave 2) keeps every key and narrows what each counts (apps/wedge-cli habits.ts):
//   the same field, a stricter definition — which is why the rules version travels beside it.
//   Reader `cc-reader-3` (solo review M14, 2026-10-18): the reading that carries the hb-2.1
//   habits. A transcript read by `cc-reader-2` before the habits existed travelled without them,
//   and the server keeps the first copy of an id — so an upgraded CLI changed nothing for the
//   sessions already sent. The new reader re-reads every transcript once, in its own id namespace,
//   and the server's highest-reader rule replaces the old reading.
// Migration: each new trace defaults to null ("no occasion"), so 2.7 producers stay valid.
// 2.9 (2026-10-18, rules hb-2.3): `Habits.rules_version` gains "hb-2.3" and `reader_version`
//   gains "cc-reader-4" — independent_review recognises a review asked of an agent or a workflow,
//   names_files a file named without its extension, on the first work prompt of a task. Same
//   fields, narrower and fairer definitions; the new reader re-reads every transcript once and the
//   server's highest-reader rule replaces the cc-reader-3 reading.
// Migration: no field added; 2.8 producers stay valid and read as what they were.
// 2.10 (2026-10-20): `SessionSummaryPayload.agent`
//   ("claude_code" | "codex") — which agent's journal a session was read from — and
//   `reader_version` gains "codex-reader-1", the reader of Codex's session journal
//   (~/.codex/sessions, `.jsonl` and `.jsonl.zst`). The server keys a reading by (agent, transcript)
//   and applies the practice x agent table (./agents.ts) to the practice index.
// Migration: `agent` defaults to "claude_code", which is what every earlier producer read, so 2.9
// producers stay valid and an old session means exactly what it meant.
export const SCHEMA_VERSION = "2.10" as const;

/**
 * The versions ingestion ACCEPTS, as opposed to the one producers emit.
 *
 * These were the same thing until 2.2, and that was a defect waiting for its first upgrade: the
 * envelope pinned one literal, so the day the server moved, every wedge that had not yet updated
 * would have been answered 400. The wedge fails open (Playbook v1.7 §2), so nobody's tool would
 * have broken — their telemetry would simply have stopped, silently, until they happened to
 * reinstall. Measurement that quietly stops is worse than measurement that fails loudly.
 *
 * A version is accepted here only while every field 2.2 and 2.3 added has a default, so an older payload
 * parses into the current shape and means exactly what it meant: no `human_prompts` reads as a
 * session that did not count them, and no E-1.1 components read as a session that spoke E-1.0.
 * When a change cannot be expressed that way, the old version leaves this list and the note above
 * says why.
 */
//
// TODO(schema-retirement): a version leaves this list ONLY together with a minimum CLI version the
// API enforces (e.g. a 426 the CLI reads as "update me"). The CLI reads
// `400 unsupported_schema_version` as "the server is behind, try again
// later" — correct while the server lags the wedge, wrong once the server has moved past it: an
// old CLI would then resend the same batch every 15 minutes forever. Retiring a version without
// that gate turns the safety net for one rollout order into an endless loop for the other.
export const ACCEPTED_SCHEMA_VERSIONS = ["2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "2.8", "2.9", "2.10"] as const;

/** Which definition of a carrier's outcome decided an episode. `outcome-2.0`
 *  is the full definition; a suffix names the part that fell back to outcome-1.0's reading for
 *  that episode: `-spans` — its rewrite was measured on hunk-header spans (the live path and the
 *  sweep still send them); `-flat-ci` — some of its CI was read as one stream because it carried
 *  no per-check identity (live suites, pull-request suites). */
export const OutcomeDefinitionVariant = z.enum([
  "outcome-1.0",
  "outcome-2.0",
  "outcome-2.0-spans",
  "outcome-2.0-flat-ci",
  "outcome-2.0-spans-flat-ci",
]);

export const uuid = z.uuid();
export const rfc3339 = z.iso.datetime({ offset: true });
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export const nonNegativeInt = z.number().int().min(0);
export const unitInterval = z.number().min(0).max(1);

/** Where an event came from (collector §1). */
export const Source = z.enum(["wedge_vscode", "wedge_cursor", "wedge_cli", "connector_github"]);
export type Source = z.infer<typeof Source>;

export const ToolInfo = z
  .strictObject({ name: z.string().min(1), version: z.string().min(1) })
  .meta({ id: "ToolInfo", title: "ToolInfo" });

/** A model the wedge actually read (schema 2.4: from an observation, never a placeholder). */
export const ReportedModel = z
  .strictObject({
    family: z.string().min(1),
    name: z.string().min(1),
    /** Derived from `name` by the documented mapping (wedge-core/src/model.ts), never a constant. */
    generation_tag: z.string().min(1),
  })
  .meta({ id: "ReportedModel", title: "ReportedModel" });

/** The wedge does not know which model produced the work, and says so (schema 2.4). Every field
 *  is a literal: this shape cannot carry a model, so it cannot be mistaken for one. */
export const ModelNotKnown = z
  .strictObject({
    known: z.literal(false),
    family: z.literal("unknown"),
    name: z.literal("unknown"),
    generation_tag: z.literal("unknown"),
  })
  .meta({ id: "ModelNotKnown", title: "ModelNotKnown" });

/** Model identity; `generation_tag` is mandatory on every model-touching event (CLAUDE.md) — in
 *  both shapes, so a reader never has to ask whether it is there. */
export const ModelInfo = z.union([ReportedModel, ModelNotKnown]).meta({ id: "ModelInfo", title: "ModelInfo" });
export type ModelInfo = z.infer<typeof ModelInfo>;

/**
 * What a unit of finished work is carried by (carriers v2, B1.1).
 *
 * Phase 1 saw pull requests only, and a person who works on main — solo, or in a team without
 * mandatory review — never left Draft. Three carriers now, because those are the three shapes
 * finished work actually arrives in:
 *
 *   pr           a pull request, as before
 *   commit_run   a run of one author's commits on one branch, closed by a pause (R3)
 *   release      a tag or release, attributed to whoever's work went into it
 *
 * Identifiers only, never content. Each variant carries exactly what identifies it — a run has
 * no number to point at, so it is named by its branch and the author's calendar day, which is
 * also the rule that bounds it (one carrier per branch per day, R3).
 */
export const CarrierKind = z.enum(["pr", "commit_run", "release"]);
export type CarrierKind = z.infer<typeof CarrierKind>;

const PrRef = z
  .strictObject({
    provider: z.literal("github"),
    kind: z.literal("pr"),
    repo_id: z.number().int().positive(),
    pr_number: z.number().int().positive(),
  })
  .meta({ id: "PrCarrierRef", title: "PrCarrierRef" });

const CommitRunRef = z
  .strictObject({
    provider: z.literal("github"),
    kind: z.literal("commit_run"),
    repo_id: z.number().int().positive(),
    /** The branch the run sits on. */
    branch: z.string().min(1),
    /** The author's calendar day, YYYY-MM-DD, by the author timestamp of the commits. One
     *  carrier per branch per day is the boundary rule itself (R3), so the day IS the identity. */
    author_day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .meta({ id: "CommitRunCarrierRef", title: "CommitRunCarrierRef" });

const ReleaseRef = z
  .strictObject({
    provider: z.literal("github"),
    kind: z.literal("release"),
    repo_id: z.number().int().positive(),
    /** The tag. Releases are named by their tag everywhere in the API. */
    tag: z.string().min(1),
  })
  .meta({ id: "ReleaseCarrierRef", title: "ReleaseCarrierRef" });

export const CarrierRef = z
  .discriminatedUnion("kind", [PrRef, CommitRunRef, ReleaseRef])
  .meta({ id: "CarrierRef", title: "CarrierRef" });
export type CarrierRef = z.infer<typeof CarrierRef>;

/** Loose linking hint from wedge events (branch/PR may not be known yet). */
export const CarrierHint = z
  .strictObject({
    provider: z.literal("github"),
    repo_id: z.number().int().positive().optional(),
    branch: z.string().min(1).optional(),
    pr_number: z.number().int().positive().optional(),
  })
  .meta({ id: "CarrierHint", title: "CarrierHint" });
