import { z } from "zod";

import {
  ACCEPTED_SCHEMA_VERSIONS,
  CarrierHint,
  CarrierRef,
  ModelInfo,
  Source,
  ToolInfo,
  nonNegativeInt,
  rfc3339,
  sha256Hex,
  unitInterval,
  uuid,
} from "./common";
import { Agent } from "./agents";

// ---------------------------------------------------------------- payloads (collector §3.2)

export const PromptFeatures = z
  .strictObject({
    h_struct: z.number().min(0),
    content_mass: z.number().min(0),
    length: nonNegativeInt,
    categories: z.array(z.string().min(1)),
  })
  .meta({ id: "PromptFeatures", title: "PromptFeatures" });

/** The six components of environment equipping (E-1.1, retired in Core 7 — kept so older clients'
 * events still parse). A closed vocabulary: each name is a fact
 * about a project, and the list of names is the whole thing that travels — never a hook's command,
 * a skill's body, a subagent's prompt or an instruction file's text. */
export const E11Component = z.enum([
  "project_instructions",
  "hook",
  "reviewer_subagent",
  "skill",
  "mcp",
  "security_reviewed",
]);
export type E11Component = z.infer<typeof E11Component>;

/** Categories of a verification run before landing (PtL-1.0). Closed for the same reason as the
 * prompt categories: a fixed enum is metadata, an open list is a channel for text. The command
 * and its arguments are classified on the device and are never sent. */
export const VerificationCategory = z.enum(["test", "build", "lint", "review"]);
export type VerificationCategory = z.infer<typeof VerificationCategory>;

/** Environment features (collector §4). Facts about the environment, never content.
 *
 * E-1.0 describes a SESSION by how much tool surface it touched. E-1.1 (a PROJECT's six
 * configured-and-used components) was retired in Core 7: current clients send E-1.0 only, and
 * the server reads nothing of E-1.1. The E-1.1 fields below are still ACCEPTED, with their
 * defaults, because older clients send them; they are no longer read or sent. */
export const EnvFeatures = z
  .strictObject({
    e_definition_version: z.enum(["E-1.0", "E-1.1"]),
    // --- E-1.0. Emitted and read by the server's facts.
    mcp_tool_diversity: unitInterval,
    /** How many distinct MCP tools the session used. A count, never the names. */
    mcp_tool_count: nonNegativeInt.default(0),
    mcp_tool_calls: nonNegativeInt,
    project_instructions_loaded: z.boolean(),
    reusable_skill_calls: nonNegativeInt,
    // --- E-1.1 (retired in Core 7). Accepted from older clients, no longer read or sent by
    // current ones. The hash was salted with the device salt, like a non-built-in tool name.
    project_hash: z.string().regex(/^$|^[0-9a-f]{12}$/).default(""),
    /** Components this project has SET UP, read from its files on the device. */
    components_configured: z.array(E11Component).default([]),
    /** Components this session actually USED. Configured-and-unused equips nothing: a repository
     * with six things installed that never fire is what a metric of installs would reward. */
    components_used: z.array(E11Component).default([]),
  })
  .meta({ id: "EnvFeatures", title: "EnvFeatures" });

/** Verification runs a session made before its work landed (PtL-1.0), by category.
 *
 * Counts only. Which test file, which linter, which arguments — none of that leaves the machine.
 * The field is carried from schema 2.2 onward and nothing reads it yet: the claim it is for is
 * behind DEIGMA_FEATURE_VERIFY_BEFORE_LANDING, which is off. Collecting first is deliberate —
 * a claim switched on with no history behind it publishes nothing for months. */
export const VerificationRuns = z
  .strictObject({
    test: nonNegativeInt.default(0),
    build: nonNegativeInt.default(0),
    lint: nonNegativeInt.default(0),
    review: nonNegativeInt.default(0),
  })
  .meta({ id: "VerificationRuns", title: "VerificationRuns" });

/** Which reader produced a `session.summary` from a journal file (schema 2.5). Ordered: a higher
 *  version re-reading the same transcript replaces the lower one on the server. Absent on a live
 *  event (nothing was read from a file) and on a backfill written before 2.5 (read as
 *  `cc-reader-1`). `codex-reader-1` (schema 2.10) reads Codex's session journal; ranks compare only
 *  readings of the same transcript, and a transcript belongs to one agent. */
export const READER_VERSIONS = ["cc-reader-1", "cc-reader-2", "cc-reader-3", "cc-reader-4", "codex-reader-1"] as const;
export const ReaderVersion = z.enum(READER_VERSIONS);
export type ReaderVersion = z.infer<typeof ReaderVersion>;

/** A transcript id: the agent's own random uuid for the session, lower case (Claude Code's
 *  `sessionId`; since 2.10 also Codex's thread id from `session_meta`). It is the base `session_id`
 *  has carried since 2.0; the field makes it explicit so a re-read can name what it replaces. The
 *  server keys a reading by (agent, transcript), so two agents' ids never meet. */
export const TranscriptId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** Built-in Claude Code slash commands, by name: a fixed public list. Anything else — a command
 *  or skill somebody wrote and named themselves — travels as `other`, because a name a person
 *  chose can say what they work on. Shared with the device rules (apps/wedge-cli). */
export const SLASH_COMMANDS = [
  "add-dir",
  "agents",
  "bug",
  "clear",
  "compact",
  "config",
  "context",
  "cost",
  "doctor",
  "exit",
  "export",
  "help",
  "hooks",
  "ide",
  "init",
  "install-github-app",
  "login",
  "logout",
  "mcp",
  "memory",
  "model",
  "output-style",
  "permissions",
  "plan",
  "pr-comments",
  "release-notes",
  "resume",
  "review",
  "rewind",
  "security-review",
  "status",
  "statusline",
  "terminal-setup",
  "todos",
  "upgrade",
  "usage",
  "vim",
] as const;
export const SlashCommand = z.enum([...SLASH_COMMANDS, "other"]);
export type SlashCommand = z.infer<typeof SlashCommand>;

/**
 * What the person's prompt history says about a session (schema 2.5, rules `ph-1.0`).
 *
 * Computed on the device from Claude Code's `~/.claude/history.jsonl` — the prompts as the person
 * typed them — by fixed public rules (apps/wedge-cli/src/journals/prompt-history.ts). What
 * travels is counts, buckets and names from `SlashCommand`; never a prompt, never a pasted text,
 * never a hash of either (a short text's hash is its text to anyone who guesses it).
 *
 * Descriptive. No claim reads any of it, and none may by count: every field here grows with how
 * much somebody types, and volume is not skill.
 */
export const PromptHistoryFeatures = z
  .strictObject({
    rules_version: z.enum(["ph-1.0"]),
    /** Prompts typed to the agent — slash commands and `!` shell lines excluded. */
    typed_prompts: nonNegativeInt,
    /** Slash commands by name from the fixed list; a name not on it counts as `other`. */
    slash_commands: z
      .array(z.strictObject({ name: SlashCommand, count: z.number().int().positive() }))
      .max(64),
    /** Lines the person ran in the tool's shell mode (`!`). */
    shell_commands: nonNegativeInt,
    /** Pasted blocks by size in lines; `text_unknown` when the tool kept only a reference. */
    pastes: z.strictObject({
      text_small: nonNegativeInt,
      text_medium: nonNegativeInt,
      text_large: nonNegativeInt,
      text_unknown: nonNegativeInt,
      images: nonNegativeInt,
    }),
    /** Typed prompts by length bucket. */
    prompt_length: z.strictObject({ short: nonNegativeInt, medium: nonNegativeInt, long: nonNegativeInt }),
    /** Seconds between consecutive typed prompts: median and 90th percentile. Null with fewer
     *  than two typed prompts — there is no gap to measure, which is not a gap of zero. */
    gap_seconds: z.strictObject({ p50: nonNegativeInt, p90: nonNegativeInt }).nullable(),
    /** Short typed prompts that follow the previous one within minutes and open with a word of
     *  correction from a fixed public list ("no", "wrong", "instead", "нет", …). A count. */
    corrective_followups: nonNegativeInt,
  })
  .meta({ id: "PromptHistoryFeatures", title: "PromptHistoryFeatures" });
export type PromptHistoryFeatures = z.infer<typeof PromptHistoryFeatures>;

/** How the person steered a session (schema 2.5). Counts of the tool's own records. */
export const Steering = z
  .strictObject({
    /** Times the person stopped the agent mid-answer, each counted once. */
    interrupts: nonNegativeInt,
    /** Typed turns that came right after an interruption. */
    followups_after_interrupt: nonNegativeInt,
  })
  .meta({ id: "Steering", title: "Steering" });

/** Commits the agent made in a session, and how many came after a check that followed its last
 *  edit (schema 2.5). The commands are classified on the device and never sent. */
export const CommitChecks = z
  .strictObject({
    commits: nonNegativeInt,
    verified_after_last_edit: nonNegativeInt,
  })
  .meta({ id: "CommitChecks", title: "CommitChecks" });

/** One habit trace (Core 7 §4): how many times the session offered the occasion, and in how many
 *  of them the person did the thing. Counted on the device by the rules `hb-1.0`
 *  (apps/wedge-cli/src/journals/habits.ts); `hits <= opportunities`. */
export const HabitCount = z
  .strictObject({ opportunities: nonNegativeInt, hits: nonNegativeInt })
  .meta({ id: "HabitCount", title: "HabitCount" });

/** Habit traces of one session (schema 2.6). Counts only: the prompt text, file names and paths the
 *  rules look at stay on the device. A trace with no occasion in the session is null, never 0 of 0. */
export const Habits = z
  .strictObject({
    rules_version: z.enum(["hb-1.0", "hb-2.0", "hb-2.1", "hb-2.2", "hb-2.3"]),
    /** T1: a typed prompt names a file the agent then reads or edits before the next prompt.
     *  Occasion: a typed prompt followed by at least one agent file operation. */
    names_files: HabitCount.nullable(),
    /** T3: plan mode or an explicit plan request before the agent's first edit. Occasion: a
     *  session in which the agent edited something (at most one per session). */
    plan_before_edit: HabitCount.nullable(),
    /** T4: the person asks to see or explain the changes before a commit command. Occasion: a
     *  commit command the agent ran. */
    diff_before_commit: HabitCount.nullable(),
    /** T7: a correction prompt names a location (a file, a function, a line). Occasion: a typed
     *  correction. */
    located_corrections: HabitCount.nullable(),
    // --- Schema 2.7, rules `hb-2.0`: the practices the labs
    // recommend, each counted from what HAPPENED in the session (tool calls, exit codes, git on the
    // device), never from the wording of a prompt. Absent (null) on older clients and when the
    // session offered no occasion. Inputs of the practice index (pi-1.0), owner and public.
    /** 1. A security review ran: /security-review or a security-named subagent. Occasion: a session
     *  in which the agent edited code. */
    security_review: HabitCount.nullable().default(null),
    /** 2. A dependency audit ran (npm/pnpm/yarn audit, pip-audit, cargo audit, osv-scanner, …).
     *  Occasion: a session in which a lock or manifest file changed. */
    dependency_audit: HabitCount.nullable().default(null),
    /** 3. No secret in what the agent committed (the device's own secret patterns over the added
     *  lines). Occasion: a commit the agent ran. */
    no_secrets: HabitCount.nullable().default(null),
    /** 4. The agent asked before acting: the session did not run in bypass-permissions mode (or ran
     *  inside a container/sandbox). Occasion: every session with a tool call. */
    permissions_on: HabitCount.nullable().default(null),
    /** 5. A risky command (rm -rf, git push --force, git reset --hard, DROP/TRUNCATE, …) ran with
     *  permissions on. Occasion: a risky command the agent ran. */
    risky_confirmed: HabitCount.nullable().default(null),
    /** 6. Tests or a build ran after the agent's last edit. Occasion: a session with edits that
     *  ended in a commit. */
    tests_after_edit: HabitCount.nullable().default(null),
    /** 7. A commit that changes code also changes tests. Occasion: an agent commit touching code. */
    tests_with_code: HabitCount.nullable().default(null),
    /** 8. The changes were shown before a commit: the agent ran git diff/show/status -v, or the
     *  person asked for them. Occasion: a commit the agent ran. */
    saw_diff_before_commit: HabitCount.nullable().default(null),
    /** 9. An independent review ran: a reviewer subagent or /review. Occasion: a session whose
     *  edits changed 200 lines or more. */
    independent_review: HabitCount.nullable().default(null),
    /** 10. The agent read the project (Read/Grep/Glob/LS) before its first edit. Occasion: a
     *  session with edits. */
    explore_before_edit: HabitCount.nullable().default(null),
    /** 11. Plan mode or a plan before the first edit, on a task that edited 3+ files. Occasion: a
     *  session that edited 3 files or more. */
    plan_complex: HabitCount.nullable().default(null),
    /** 13. The project memory (CLAUDE.md / AGENTS.md) exists and changed by more than 20 characters
     *  in the last 30 days (git on the device). Occasion: a session in a project. */
    memory_alive: HabitCount.nullable().default(null),
    // --- Schema 2.8, rules `hb-2.1` (practice index pi-1.2): how the person writes, counted on the
    // device from their OWN typed prompts (text read in memory, never sent). Null: no occasion.
    /** 14. The first prompt asking for work in a session (and after each /clear) says what done
     *  looks like: a test, an expected behaviour or output, an example, a concrete check. */
    clear_goal: HabitCount.nullable().default(null),
    /** 15. A work prompt of 15 words or more does not bundle several unrelated asks. */
    one_task: HabitCount.nullable().default(null),
    /** 16. A work prompt names a file, path or symbol, quotes an error, or states expected versus
     *  actual. */
    gives_context: HabitCount.nullable().default(null),
  })
  .meta({ id: "Habits", title: "Habits" });

export const SessionSummaryPayload = z
  .strictObject({
    session_id: z.string().min(1),
    duration_ms: nonNegativeInt,
    /** API calls the session made. This counts the machine's own retries and continuations, so it
     * is a measure of traffic and never of work — `human_prompts` is the one a claim may read. */
    requests: nonNegativeInt,
    /** Turns the PERSON typed. The unit of path-to-result from PtR-1.1 (6.1 §8): what somebody
     * asked for, not how many calls the tool needed to answer. */
    human_prompts: nonNegativeInt.default(0),
    iterations: nonNegativeInt,
    tool_calls: z.record(z.string(), nonNegativeInt),
    tokens_in: nonNegativeInt,
    tokens_out: nonNegativeInt,
    prompt_features: z.array(PromptFeatures),
    env_features: EnvFeatures,
    verification_runs: VerificationRuns.default({ test: 0, build: 0, lint: 0, review: 0 }),
    carrier_hint: CarrierHint.optional(),
    // --- 2.5. Every field below is null when the producer did not observe it — never zero.
    /** Which reader read this session from a journal file; null on a live event. */
    reader_version: ReaderVersion.nullable().default(null),
    /** The transcript this session was read from; null on a live event. */
    transcript_id: TranscriptId.nullable().default(null),
    /** Prompts the person accepted from the tool's own suggestion — not typed, so not in
     *  `human_prompts`. */
    suggestions_accepted: nonNegativeInt.nullable().default(null),
    steering: Steering.nullable().default(null),
    commit_checks: CommitChecks.nullable().default(null),
    prompt_history: PromptHistoryFeatures.nullable().default(null),
    // --- 2.6.
    /** Habit traces, counted on the device; null when this producer did not read them. */
    habits: Habits.nullable().default(null),
    // --- 2.10.
    /** The coding agent whose journal this session was read from. Every producer before 2.10 read
     *  Claude Code only (or proxied an MCP server for any client), so the default is
     *  `claude_code`. Decides which practices the session can be an occasion of
     *  (`NOT_EXPRESSIBLE`, ./agents.ts). */
    agent: Agent.default("claude_code"),
  })
  .meta({ id: "SessionSummaryPayload", title: "SessionSummaryPayload" });

/**
 * A session known only from the person's prompt history (schema 2.5): its transcript is gone —
 * Claude Code deletes transcripts after about thirty days and keeps the prompt history for
 * months. Descriptive, and deliberately a type of its own rather than a `session.summary` with
 * zeros: nothing of the tool's side (requests, tokens, tool calls, the model) was observed, and a
 * zero there would be a measurement nobody made. It binds to no carrier and is read by no claim.
 */
export const PromptHistoryPayload = z
  .strictObject({
    /** The transcript id the history names, when it names one; null for old history records
     *  that carry none, which are grouped by project and day instead. */
    transcript_id: TranscriptId.nullable(),
    grouping: z.enum(["session", "project_day"]),
    /** From the first prompt to the last. */
    duration_ms: nonNegativeInt,
    /** The salted project hash, as in `env_features.project_hash`; "" when the history names no
     *  project directory. */
    project_hash: z.string().regex(/^$|^[0-9a-f]{12}$/),
    /** The numeric id of the repository the project directory belongs to — only when it is one
     *  the person connected; null otherwise. */
    repo_id: z.number().int().positive().nullable(),
    features: PromptHistoryFeatures,
  })
  .meta({ id: "PromptHistoryPayload", title: "PromptHistoryPayload" });

export const EditKind = z.enum(["accept", "light", "deep", "rewrite"]);

export const DraftCurationPayload = z
  .strictObject({
    draft_hash: sha256Hex,
    final_hash: sha256Hex,
    kc_value: unitInterval,
    kc_algo_version: z.string().min(1),
    size_draft: nonNegativeInt,
    size_final: nonNegativeInt,
    t_validation_ms: nonNegativeInt,
    n_scroll: nonNegativeInt,
    n_edits: nonNegativeInt,
    edit_kind: EditKind,
    carrier_hint: CarrierHint.optional(),
  })
  .meta({ id: "DraftCurationPayload", title: "DraftCurationPayload" });

// Collector §3.2 list + `closed` (PR closed without merge): the carrier ends without an outcome
// and the segmentation needs to know it.
export const CarrierEventKind = z.enum([
  // Carriers v2: a commit that landed on a branch. One per commit; the pipeline groups them into
  // runs by the carrier key, which already encodes the branch and the author's day.
  "commit",
  "pr_opened",
  "review_requested",
  "review_approved",
  "changes_requested",
  "ci_passed",
  "ci_failed",
  "merged",
  "closed",
  "reverted",
  /**
   * §2.5, live path: a LATER push wrote over lines an EARLIER run of the same branch had written,
   * inside that run's outcome window.
   *
   * It exists because the two halves of the rewrite measurement are separated in time. A run's
   * own lines are known the moment it lands; what happens to them is knowable only afterwards,
   * and the backfill can look back while the live path cannot look forward. So each push reports
   * what it overwrote, against the carriers it overwrote it in — the same comparison, read
   * against a different carrier, with no extra request and nothing scheduled.
   *
   * Server-derived and carrier-bound: the wedge has no part in it, and no new field was needed —
   * `later_line_ranges` was already on the wire for the backfill. Kept as its own kind rather
   * than as another `commit` because it is NOT one of the run's commits: counting it as one
   * would extend the run's `closed_at` to the day of the push that rewrote it, moving the window
   * that decides its outcome.
   */
  "rewrite_observed",
  /**
   * outcome-2.0 (review 2026-10-08 #2): what CI said about a run's BASE — the parent of its first
   * commit, whoever made it — recorded against the run. "A check already red on the base is not
   * charged to the day" needs the base's own word, and the user's previous run is not the base
   * when a colleague's push or a pull request's merge sits in between. Its own kinds rather than
   * `ci_*` so no reader can take it for the run's CI: it happened before the run, it neither
   * witnesses nor opens it. `ci_check_name` carries the check run's name.
   */
  "base_ci_passed",
  "base_ci_failed",
]);
export type CarrierEventKind = z.infer<typeof CarrierEventKind>;

/** What a commit contributes to its run: identifiers, counts, paths, and the trailers that say
 * an agent co-authored it. Never the message body, never a diff (carriers v2, B2.3, B2.5). */
export const CommitMeta = z
  .strictObject({
    sha: z.string().min(7),
    /** The AUTHOR timestamp — when the work was done, not when a rebase applied it. */
    authored_at: rfc3339,
    additions: nonNegativeInt,
    deletions: nonNegativeInt,
    changed_paths: z.array(z.string().min(1)),
    /** Two or more parents means a merge commit, which is an integration and not work. */
    parent_count: nonNegativeInt,
    /** Agents that co-authored this commit, by the names in ai_markers.v1. Read from trailers
     *  in memory; the message itself is never stored. */
    ai_agents: z.array(z.string().min(1)),
    /** Set when this commit belongs to a pull request, so it is not counted twice. */
    pr_number: z.number().int().positive().nullable(),
    /** The branch head at the end of this run's OUTCOME WINDOW — fourteen days after the run
     *  ended — which is what its rewriting is measured against. A single comparison spanning the
     *  whole branch would answer a different question: hunk ranges carry no dates, so rewriting
     *  that happened months later could not be told from rewriting inside the window. */
    rewrite_edge_sha: z.string().min(7).nullable(),
    /** False when the listing that found that edge was truncated, so the measurement is a lower
     *  bound rather than a share (B1.4's interval rule). */
    rewrite_edge_complete: z.boolean(),
    /** Which LINES this run wrote, per file — the hunk headers of its own aggregate diff, with
     *  the patch text dropped in memory (B2.1). Carried on the run's last commit and nowhere
     *  else, like the run's size and paths.
     *
     *  On the wire rather than measured at the edge for one reason: the rule that turns two sets
     *  of ranges into a share lives in the data plane, is tested there, and a second
     *  implementation of it in TypeScript would be the same defect this block has been finding
     *  all along. Line numbers are metadata — the promise is about content, and no content is
     *  read, kept or sent. */
    run_line_ranges: z.record(z.string().min(1), z.array(z.tuple([nonNegativeInt, nonNegativeInt]))).default({}),
    /** Which lines were written OVER afterwards, inside this run's outcome window, restricted to
     *  the files the run itself touched — somebody else's work elsewhere is not a rewrite of
     *  this one, and sending it would be sending data with no use here. */
    later_line_ranges: z.record(z.string().min(1), z.array(z.tuple([nonNegativeInt, nonNegativeInt]))).default({}),
    /** outcome-2.0 (schema 2.3): the EXACT line numbers this run added, per file, in the file
     *  as the run left it — read from the hunk BODIES by each line's first character ('+' added,
     *  '-' removed, ' ' context) and nothing else; the text is dropped in memory, as before.
     *  Compact [start, end) runs of consecutive numbers. Context lines are not in it, which is
     *  the difference from `run_line_ranges`: a hunk header spans up to six lines of context, so
     *  an edit near the run's work read as an edit OF it (audit 2026-10-08 #6).
     *
     *  Null means this event does not speak the exact definition; `{}` means it does and the run
     *  added nothing. The pipeline measures a carrier by one definition or the other, never by a
     *  mix of the two, so the null is what keeps old and new events apart. */
    run_added_lines: z
      .record(z.string().min(1), z.array(z.tuple([nonNegativeInt, nonNegativeInt])))
      .nullable()
      .default(null),
    /** outcome-2.0: the line numbers the window's later diff REMOVED or replaced in the run's
     *  files, numbered on that diff's OLD side — which is the file as the run left it, the same
     *  coordinates as `run_added_lines`. `later_line_ranges` took the NEW side of the later
     *  diff, in the window-end file, so any insertion above the run's lines shifted the two
     *  apart. A line the run wrote and somebody changed shows up here; a line inserted next to
     *  it does not. Null as above. */
    later_removed_lines: z
      .record(z.string().min(1), z.array(z.tuple([nonNegativeInt, nonNegativeInt])))
      .nullable()
      .default(null),
    /** True when the window's comparison came back complete. False makes the share a LOWER BOUND
     *  and the outcome an interval — never a value (T20). */
    rewrite_window_complete: z.boolean().default(false),
    /** When GITHUB first saw this work — a check run's start. Both git dates are written by the
     *  author (`--date`, GIT_COMMITTER_DATE), so neither can anchor a rule the author is being
     *  measured by; this one they cannot set. Null when nothing on the server witnessed it, in
     *  which case the evidence is W0 and does not enter the claim. */
    landed_at: rfc3339.nullable(),
    /** True when the author date sits further from that witness than the tolerance allows. The
     *  run is then counted on the server's day: fifty commits made in one evening with author
     *  dates spread over fifty days are one carrier, not fifty. */
    dates_inconsistent: z.boolean(),
  })
  .meta({ id: "CommitMeta", title: "CommitMeta" });

/** Pull-request metadata by the exhaustive list (Playbook §2): identifiers, statuses, counts,
 * commit hashes, changed paths (revert detection). Never file contents. */
export const PullRequestMeta = z
  .strictObject({
    head_sha: z.string().regex(/^[0-9a-f]{7,40}$/),
    base_ref: z.string().min(1),
    additions: nonNegativeInt,
    deletions: nonNegativeInt,
    changed_files: nonNegativeInt,
    changed_paths: z.array(z.string().min(1)),
    language: z.string().min(1).nullable(),
    ticket_ref: z.string().min(1).nullable(),
    /** The shas this pull request owns (§2.2). The dedup rule is by sha, and the mark on a
     *  commit event can only carry what was known when that event was emitted: on the live path
     *  a branch is pushed before its pull request exists, so the commits arrive unmarked and the
     *  pull request that claims them shows up afterwards. Carried by the pull request itself,
     *  the fact does not depend on which of the two arrived first — which is what re-entrant
     *  segmentation means. Empty when the connector could not ask. */
    commit_shas: z.array(z.string().regex(/^[0-9a-f]{7,40}$/)).default([]),
    /** Schema 2.6: this pull request is its author's n-th in the repository, counted by
     *  GitHub's own search when the pull request was read. Feeds the newcomer correction of
     *  "decisions by others". Null when the connector could not ask — never guessed as 1. */
    author_ordinal: z.number().int().positive().nullable().default(null),
  })
  .meta({ id: "PullRequestMeta", title: "PullRequestMeta" });

export const CarrierEventPayload = z
  .strictObject({
    kind: CarrierEventKind,
    carrier: CarrierRef,
    /** GitHub user id of the actor; null for system events (CI). */
    actor_github_user_id: z.number().int().positive().nullable(),
    actor_is_owner: z.boolean(),
    /** Present on `commit` events only. */
    commit: CommitMeta.nullable(),
    /** Present on pr_opened / merged / closed (size, paths, language); null on review and CI
     * events, which only carry the carrier reference. */
    pr: PullRequestMeta.nullable(),
    /** For `merged`: was the merge a squash/rebase (does not affect the outcome). */
    merge_method: z.enum(["merge", "squash", "rebase"]).nullable(),
    /** For `ci_passed` / `ci_failed` / `base_ci_*`: which check reported. */
    ci_check_name: z.string().min(1).nullable(),
    /** For `reverted`: the PR that performed the revert. */
    reverted_by_pr_number: z.number().int().positive().nullable(),
    /**
     * For `merged` (schema 2.5): WHO pressed merge, as a class and never as an identity —
     * `author` (the person whose passport this is), `another_person` (a human account other than
     * the author: somebody else accepted the work) or `bot` (an app or a merge queue). Null on
     * every other kind, and on a `merged` event written before 2.5, which did not ask: "not
     * recorded" is its own state and never reads as "the author merged it".
     *
     * Why it exists: a pull request its author merged in their own repository was presented as
     * witnessed by a third party. CI and the absence of a revert ARE decided by machines, but by
     * machines the person configured; acceptance by another human is a different, stronger fact,
     * and the passport has to be able to tell the two apart (evidence class, 2026-10-10).
     */
    merged_by: z.enum(["author", "another_person", "bot"]).nullable().default(null),
    /**
     * For `closed` (schema 2.6): who closed an unmerged pull request, as a class and
     * never as an identity, on the same three words as `merged_by`. A pull request another
     * person closed is a decision against the work; one its author closed is nobody's decision.
     * Null on every other kind and on a `closed` event written before 2.6 ("not recorded").
     */
    closed_by: z.enum(["author", "another_person", "bot"]).nullable().default(null),
  })
  .meta({ id: "CarrierEventPayload", title: "CarrierEventPayload" });

/**
 * Collector §3.2: "an accepted draft -> a defect confirmed by the carrier -> fixed in the same
 * episode" -> ifix_candidate. The two halves of that pattern are seen by different parties, and
 * the payload says which is which:
 *
 *  - the wedge reports only what it can see on the device — an accepted draft that was corrected
 *    later in the same carrier context, with the timing and how much of the draft survived;
 *  - the episode pipeline resolves the carrier link, the defect kind and the final I_fix (the
 *    spec is explicit: "итоговое I_fix присваивает пайплайн эпизодов, не wedge"), and fills the
 *    nullable fields below. A wedge that filled them would be guessing.
 *
 * The consumer is the deferred EM detection module; the input is collected from Phase 1 because
 * an interception history cannot be reconstructed after the fact.
 */
export const ErrorInterceptionPayload = z
  .strictObject({
    /** The accepted draft, as hashed in its `draft.curation` event (same salt, same device). */
    draft_hash: sha256Hex,
    /** The text that replaced it. */
    fix_hash: sha256Hex,
    /** How long the accepted draft survived before it was corrected. */
    t_since_accept_ms: nonNegativeInt,
    /** How much of the accepted draft survived the correction, on the Kc scale. */
    kc_to_fix: unitInterval,
    kc_algo_version: z.string().min(1),
    size_fix: nonNegativeInt,
    /** The correction landed in the same file region as the draft, on the same branch. */
    same_region: z.boolean(),
    carrier_hint: CarrierHint.optional(),
    /** Resolved by the episode pipeline, never by the wedge — null on the wire. */
    defect_confirmed_by: CarrierRef.nullable(),
    defect_kind: CarrierEventKind.nullable(),
    fixed_in_same_episode: z.boolean().nullable(),
    ifix_candidate: z.boolean().nullable(),
  })
  .meta({ id: "ErrorInterceptionPayload", title: "ErrorInterceptionPayload" });

export const WedgeStatusPayload = z
  .strictObject({
    kind: z.enum(["heartbeat", "paused", "resumed", "error", "updated"]),
    wedge_version: z.string().min(1),
    error_code: z.string().min(1).nullable(),
  })
  .meta({ id: "WedgeStatusPayload", title: "WedgeStatusPayload" });

// ------------------------------------------------------------------ envelope 2.0 (collector §3.1)

/**
 * Where the observation came from (6.1 §12). `live` = it was produced while the work happened;
 * `backfill` = it was reconstructed from history, by the server connector or by the local backfill
 * at install. Evidence from a historical backfill is the easiest kind to forge — a journal is a
 * file — so it is labelled at the envelope. The flag is cheap now and impossible later: it lets
 * flagged history be excluded or down-weighted retroactively instead of discarding everyone's
 * past. It can only ever make an observation count for less, never for more.
 */
export const EventOrigin = z.enum(["live", "backfill"]);

const envelopeBase = {
  event_id: uuid,
  // Accepts what the fleet can be running, not only what this build emits. See
  // ACCEPTED_SCHEMA_VERSIONS: an unupdated wedge must keep being measured, not be answered 400.
  schema_version: z.enum(ACCEPTED_SCHEMA_VERSIONS),
  user_id: uuid,
  source: Source,
  origin: EventOrigin,
  occurred_at: rfc3339,
  sent_at: rfc3339,
  tool: ToolInfo,
};

const wedgeSource = z.enum(["wedge_vscode", "wedge_cursor", "wedge_cli"]);

export const SessionSummaryEvent = z
  .strictObject({
    ...envelopeBase,
    source: wedgeSource,
    type: z.literal("session.summary"),
    model: ModelInfo,
    payload: SessionSummaryPayload,
  })
  .meta({ id: "SessionSummaryEvent", title: "SessionSummaryEvent" });

export const DraftCurationEvent = z
  .strictObject({
    ...envelopeBase,
    source: wedgeSource,
    type: z.literal("draft.curation"),
    model: ModelInfo,
    payload: DraftCurationPayload,
  })
  .meta({ id: "DraftCurationEvent", title: "DraftCurationEvent" });

export const CarrierEvent = z
  .strictObject({
    ...envelopeBase,
    source: z.literal("connector_github"),
    type: z.literal("carrier.event"),
    model: ModelInfo.optional(),
    payload: CarrierEventPayload,
  })
  .meta({ id: "CarrierEvent", title: "CarrierEvent" });

export const ErrorInterceptionEvent = z
  .strictObject({
    ...envelopeBase,
    source: wedgeSource,
    type: z.literal("error.interception"),
    model: ModelInfo,
    payload: ErrorInterceptionPayload,
  })
  .meta({ id: "ErrorInterceptionEvent", title: "ErrorInterceptionEvent" });

export const WedgeStatusEvent = z
  .strictObject({
    ...envelopeBase,
    source: wedgeSource,
    type: z.literal("wedge.status"),
    model: ModelInfo.optional(),
    payload: WedgeStatusPayload,
  })
  .meta({ id: "WedgeStatusEvent", title: "WedgeStatusEvent" });

/** Schema 2.5: a session known only from the prompt history. The model is never known here — the
 *  history names none — and says so in the not-known shape. */
export const PromptHistoryEvent = z
  .strictObject({
    ...envelopeBase,
    source: wedgeSource,
    type: z.literal("prompt.history"),
    model: ModelInfo,
    payload: PromptHistoryPayload,
  })
  .meta({ id: "PromptHistoryEvent", title: "PromptHistoryEvent" });

/** Any wire event: envelope 2.0 discriminated by `type`. */
export const Event = z
  .discriminatedUnion("type", [
    SessionSummaryEvent,
    DraftCurationEvent,
    CarrierEvent,
    ErrorInterceptionEvent,
    WedgeStatusEvent,
    PromptHistoryEvent,
  ])
  .meta({ id: "Event", title: "Event" });
export type Event = z.infer<typeof Event>;
export type CarrierEvent = z.infer<typeof CarrierEvent>;
export type SessionSummaryEvent = z.infer<typeof SessionSummaryEvent>;
export type DraftCurationEvent = z.infer<typeof DraftCurationEvent>;
export type ErrorInterceptionEvent = z.infer<typeof ErrorInterceptionEvent>;
export type WedgeStatusEvent = z.infer<typeof WedgeStatusEvent>;
export type PromptHistoryEvent = z.infer<typeof PromptHistoryEvent>;

export const EventType = z.enum([
  "session.summary",
  "draft.curation",
  "carrier.event",
  "error.interception",
  "wedge.status",
  "prompt.history",
]);
export type EventType = z.infer<typeof EventType>;

/** Ingestion request body: a batch of events (collector §8: <= 500 per batch). */
export const EventBatch = z
  .strictObject({ events: z.array(Event).min(1).max(500) })
  .meta({ id: "EventBatch", title: "EventBatch" });
export type EventBatch = z.infer<typeof EventBatch>;
