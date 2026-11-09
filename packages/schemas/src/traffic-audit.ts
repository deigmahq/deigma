// The public traffic-audit page (Playbook §8): the exhaustive list of what the wedge sends.
//
// The LIST is generated from the wire schemas — `scripts/gen-traffic-audit` walks the JSON Schema
// and writes `packages/schemas/traffic-audit.json`, and a drift-check fails CI when the two
// disagree. Nobody maintains the list by hand, because a hand-maintained list is exactly how a
// promise like "we never send your code" quietly stops being true.
//
// What IS maintained by hand is one sentence per field, below. Every field the schema produces
// must have one, and a description without a field is just as much a failure: the page has to say
// what each item means, in the words a person can check against their own expectations.

export const WEDGE_EVENT_TYPES = [
  "session.summary",
  "draft.curation",
  "error.interception",
  "wedge.status",
  "prompt.history",
] as const;

/** The prompt-history features (schema 2.5), described once and carried by two event types:
 *  inside a `session.summary` that has a transcript, and as a `prompt.history` for a session
 *  whose transcript the tool has already deleted. */
const PROMPT_HISTORY_NOTES: Record<string, string> = {
  rules_version: "Which version of the public rules turned your prompt history into the counts below.",
  typed_prompts: "How many prompts you typed to the agent — slash commands and shell lines not included. A count; the prompts stay on your machine.",
  "slash_commands[].name": "The name of a built-in slash command you used (\"compact\", \"review\", …), from a fixed list; a command you named yourself is sent only as \"other\".",
  "slash_commands[].count": "How many times you used it.",
  shell_commands: "How many lines you ran in the tool's shell mode (\"!\") — never the commands.",
  "pastes.text_small": "How many blocks of text you pasted that were under 20 lines — never what was in them.",
  "pastes.text_medium": "Pasted blocks of 20 to 199 lines.",
  "pastes.text_large": "Pasted blocks of 200 lines or more.",
  "pastes.text_unknown": "Pasted blocks the tool kept only a reference to, so their size is not known.",
  "pastes.images": "How many images you pasted — never the images.",
  "prompt_length.short": "How many of your prompts were under 80 characters.",
  "prompt_length.medium": "How many were 80 to 499 characters.",
  "prompt_length.long": "How many were 500 characters or more.",
  "gap_seconds.p50": "The typical pause between two of your prompts in the session, in seconds; empty with fewer than two prompts.",
  "gap_seconds.p90": "The longer pauses: nine in ten were shorter than this.",
  corrective_followups: "How many short prompts came right after the previous one and opened with a word of correction from a fixed public list (\"no\", \"wrong\", \"instead\", …) — worked out on your machine; a count, never the words.",
};

function promptHistoryNotes(prefix: string): Record<string, string> {
  return Object.fromEntries(Object.entries(PROMPT_HISTORY_NOTES).map(([k, v]) => [`${prefix}.${k}`, v]));
}

export type WedgeEventType = (typeof WEDGE_EVENT_TYPES)[number];

/** One line per field, keyed by "<event type>.<dotted path>". Envelope fields are shared. */
export const FIELD_NOTES: Record<string, string> = {
  // --- envelope (collector §3.1)
  "envelope.event_id": "Random id of this event, assigned on the device; it makes a retry a duplicate instead of a second observation.",
  "envelope.schema_version": "Version of the wire contract this event was built against.",
  "envelope.user_id": "Your Deigma user id. Not your GitHub login, not your email.",
  "envelope.source": "Which wedge produced it: the VS Code / Cursor extension or the CLI.",
  "envelope.origin": "Whether the observation was made live, by the wedge itself, or read from a file — history at install, or a session read from your agent's own log after it finished; anything read from a log is marked as such.",
  "envelope.occurred_at": "When the thing happened on your machine.",
  "envelope.sent_at": "When it left your machine (they differ when you were offline).",
  "envelope.tool.name": "Editor or CLI name, e.g. \"vscode\".",
  "envelope.tool.version": "The version of that editor or CLI, so behaviour can be compared across releases.",
  "envelope.model.family": "Model family you were working with, e.g. \"claude\" or \"gpt\" — or \"unknown\" when the wedge cannot tell.",
  "envelope.model.name": "Model name as your AI tool's own log records it, e.g. \"claude-opus-5\", and only in a shape on a fixed list — a model name you chose yourself is never sent.",
  "envelope.model.generation_tag": "Coarse generation label derived from the model name (\"claude-opus-5-5\" -> \"claude-5.5\"), used to compare like with like over time.",
  "envelope.model.known": "Present and false when the wedge does not know the model (the editor never does: no editor says which model wrote a suggestion).",
  "envelope.type": "Which of the five event types this is.",

  // --- session.summary
  "session.summary.session_id": "Id of the session, so its events group together.",
  "session.summary.duration_ms": "How long the session lasted.",
  "session.summary.requests": "How many API calls it made — including the retries and continuations the tool does on its own, which is why nothing about your skill is computed from it.",
  "session.summary.human_prompts": "How many turns you typed: what you asked for, not how many calls answering it took. Shown to you as a fact; no claim reads it.",
  "session.summary.iterations": "How many back-and-forth iterations it took.",
  "session.summary.tool_calls": "Counts per tool name (read_file: 4, edit_file: 2) — names and counts, never arguments.",
  "session.summary.tokens_in": "Tokens sent to the model, as the tool reports them.",
  "session.summary.tokens_out": "Tokens received.",
  "session.summary.prompt_features[].h_struct": "Structural entropy of the prompt — a number computed on your machine from text that never leaves it.",
  "session.summary.prompt_features[].content_mass": "How much of the prompt was content rather than boilerplate.",
  "session.summary.prompt_features[].length": "Prompt length in characters.",
  "session.summary.prompt_features[].categories": "Flags from a fixed vocabulary (\"test\", \"refactor\", ...) — a closed enum, not your words.",
  "session.summary.env_features.e_definition_version": "Which version of the environment facts this session reports (E-1.0). No score is computed from it.",
  "session.summary.env_features.mcp_tool_diversity": "How many distinct MCP tools you use, on a saturating scale.",
  "session.summary.env_features.mcp_tool_calls": "How many tool calls the session made.",
  "session.summary.env_features.project_instructions_loaded": "Whether project instructions were loaded — the fact, never their content.",
  "session.summary.env_features.reusable_skill_calls": "How many reusable skills or commands were invoked.",
  "session.summary.env_features.mcp_tool_count": "How many distinct MCP tools the session used, as a count. The names of the tools stay on your machine.",
  // Core 7 retired E-1.1: current clients no longer send these three, the schema still accepts them from older ones.
  "session.summary.env_features.project_hash": "Older clients only (retired, no longer sent or read): a salted hash of the project directory, made on your machine.",
  "session.summary.env_features.components_configured": "Older clients only (retired, no longer sent or read): which of six things the project had set up — names from a fixed list, never their contents.",
  "session.summary.env_features.components_used": "Older clients only (retired, no longer sent or read): which of those six ran in the session.",
  "session.summary.verification_runs.test": "How many times you ran tests in the session. A count — never which tests, never their output.",
  "session.summary.verification_runs.build": "How many times you built.",
  "session.summary.verification_runs.lint": "How many times you ran a linter or type checker.",
  "session.summary.verification_runs.review": "How many times a reviewing subagent was asked to look at the work.",
  "session.summary.carrier_hint.provider": "Which forge the work belongs to (github).",
  "session.summary.carrier_hint.repo_id": "Numeric repository id, so the session can be tied to the right pull request.",
  "session.summary.carrier_hint.branch": "The branch name, which is how a session is tied to the pull request it belongs to.",
  "session.summary.carrier_hint.pr_number": "Pull request number, when your AI tool's own log names exactly one pull request for the session and its repository is one you connected.",
  // --- session.summary, schema 2.5
  "session.summary.habits.rules_version": "Which public rules counted your habits in this session (hb-1.0, hb-2.0 or hb-2.1), so a count is always read under the rules that made it.",
  "session.summary.habits.names_files.opportunities": "How many of your prompts were followed by the agent opening a file. A count; no prompt and no file name.",
  "session.summary.habits.names_files.hits": "How many of those prompts named a file the agent then opened. A count; the names stay on your machine.",
  "session.summary.habits.plan_before_edit.opportunities": "Whether the agent edited anything in this session (1 or 0).",
  "session.summary.habits.plan_before_edit.hits": "Whether plan mode or a request for a plan came before the agent's first edit (1 or 0).",
  "session.summary.habits.diff_before_commit.opportunities": "How many commits the agent made in this session.",
  "session.summary.habits.diff_before_commit.hits": "How many of those came after you asked to see or explain the changes. A count; never the changes.",
  "session.summary.habits.located_corrections.opportunities": "How many of your prompts were short corrections soon after the previous one. A count; never the words.",
  "session.summary.habits.located_corrections.hits": "How many of those corrections pointed at a place: a file, a line, a function. A count; never the place.",
  // --- session.summary, schema 2.7: the practice index's traces (hb-2.0), counted on the device from
  // what happened in the session — tool calls, exit status, git — never from the wording of a prompt.
  "session.summary.habits.security_review.opportunities": "Whether the agent edited code in this session (1 or 0).",
  "session.summary.habits.security_review.hits": "Whether a security review ran after its first edit: the /security-review command, or a subagent whose type is named for security (1 or 0).",
  "session.summary.habits.dependency_audit.opportunities": "Whether a lock or manifest file (package.json, a lock file, requirements, Cargo.toml, \u2026) changed in this session (1 or 0).",
  "session.summary.habits.dependency_audit.hits": "Whether a dependency audit command (npm/pnpm/yarn audit, pip-audit, cargo audit, osv-scanner, \u2026) ran in it (1 or 0). The command stays on your machine.",
  "session.summary.habits.no_secrets.opportunities": "How many commits the agent made whose added lines your machine could read.",
  "session.summary.habits.no_secrets.hits": "How many of those added lines held no key, token or password by the device's own patterns. A count; the lines never leave.",
  "session.summary.habits.permissions_on.opportunities": "Whether the session used the agent's tools at all (1 or 0).",
  "session.summary.habits.permissions_on.hits": "Whether the agent asked before acting \u2014 the session was not in bypass-permissions mode, or ran in a container (1 or 0).",
  "session.summary.habits.risky_confirmed.opportunities": "How many risky commands the agent ran (deleting recursively, force-pushing, hard-resetting, dropping data, \u2026).",
  "session.summary.habits.risky_confirmed.hits": "How many of those ran with permissions on. A count; never the command.",
  "session.summary.habits.tests_after_edit.opportunities": "Whether the session had edits and ended in a commit that went through (1 or 0).",
  "session.summary.habits.tests_after_edit.hits": "Whether tests or a build ran after the last edit before that commit (1 or 0).",
  "session.summary.habits.tests_with_code.opportunities": "How many of the agent's commits followed an edit to code.",
  "session.summary.habits.tests_with_code.hits": "How many of those also changed tests. A count, from path conventions on your machine; never the file names.",
  "session.summary.habits.saw_diff_before_commit.opportunities": "How many commits the agent made that went through.",
  "session.summary.habits.saw_diff_before_commit.hits": "How many came after the changes were shown \u2014 a diff ran, or you asked to see them. A count; never the changes.",
  "session.summary.habits.independent_review.opportunities": "Whether the agent's edits in this session changed 200 lines or more (1 or 0).",
  "session.summary.habits.independent_review.hits": "Whether a reviewing subagent or /review ran after the first edit (1 or 0).",
  "session.summary.habits.explore_before_edit.opportunities": "Whether the agent edited anything in this session (1 or 0).",
  "session.summary.habits.explore_before_edit.hits": "Whether it read the project (read, search, list) before its first edit (1 or 0).",
  "session.summary.habits.plan_complex.opportunities": "Whether the agent edited three files or more in this session (1 or 0).",
  "session.summary.habits.plan_complex.hits": "Whether plan mode or the agent's own task list came before its first edit (1 or 0).",
  "session.summary.habits.memory_alive.opportunities": "Whether the session's project is a git repository on your machine (1 or 0).",
  "session.summary.habits.memory_alive.hits": "Whether CLAUDE.md or AGENTS.md changed by more than 20 characters in the 30 days before the session, read from git on your machine (1 or 0). Never the file.",
  // --- session.summary, schema 2.8: how you write (hb-2.1), counted on the device from your own typed
  // prompts; the words are read in memory and dropped.
  "session.summary.habits.clear_goal.opportunities": "How many times a task started in this session (the first prompt asking for work, and the first after each /clear). A count; never the prompt.",
  "session.summary.habits.clear_goal.hits": "How many of those opening prompts said what done looks like \u2014 a test, an expected result, an example, a check. A count worked out on your machine; the words never leave.",
  "session.summary.habits.one_task.opportunities": "How many of your prompts asking for work were fifteen words or longer. A count; never the words.",
  "session.summary.habits.one_task.hits": "How many of those stayed on one task instead of bundling several unrelated asks. A count worked out on your machine.",
  "session.summary.habits.gives_context.opportunities": "How many of your prompts asked for work. A count; never the words.",
  "session.summary.habits.gives_context.hits": "How many of those named a file or symbol, quoted an error, or said what you expected versus what happened. A count; the names and messages stay on your machine.",
  "session.summary.reader_version": "Which version of the reader read this session from your agent's log, so a re-read with a corrected reader replaces the earlier reading instead of adding to it. Empty for a session watched live.",
  "session.summary.agent": "Which coding agent the session was read from: \"claude_code\" or \"codex\". One word, so a practice an agent cannot show in its own log is not counted as missed. Codex sessions are read from Codex's own log on your machine; Codex tasks run in the cloud are not read.",
  "session.summary.transcript_id": "The random id your AI tool gave the session's log — the same id the session has always been sent under, named on its own so a re-read knows what it replaces.",
  "session.summary.suggestions_accepted": "How many prompts you accepted from the tool's own suggestion, counted apart from the ones you typed.",
  "session.summary.steering.interrupts": "How many times you stopped the agent mid-answer. A count, from the tool's own record of it.",
  "session.summary.steering.followups_after_interrupt": "How many of your prompts came right after such a stop.",
  "session.summary.commit_checks.commits": "How many commits the agent made in the session — never the commit messages or the code.",
  "session.summary.commit_checks.verified_after_last_edit": "How many of those came after a test, build, lint or review that ran after the agent's last edit — classified on your machine.",
  ...promptHistoryNotes("session.summary.prompt_history"),

  // --- draft.curation
  "draft.curation.draft_hash": "Salted SHA-256 of the AI draft. The salt stays on your device, so the hash is unusable to anyone else.",
  "draft.curation.final_hash": "Salted SHA-256 of what you actually kept.",
  "draft.curation.kc_value": "How much of the draft survived your edits, 0..1.",
  "draft.curation.kc_algo_version": "Which algorithm measured that, because thresholds differ per algorithm.",
  "draft.curation.size_draft": "Length of the draft in characters.",
  "draft.curation.size_final": "Length of what you kept.",
  "draft.curation.t_validation_ms": "How long the draft was under review before you accepted it.",
  "draft.curation.n_scroll": "How many times you scrolled through it.",
  "draft.curation.n_edits": "How many edits you made to it.",
  "draft.curation.edit_kind": "A coarse label of that: accept / light / deep / rewrite.",
  "draft.curation.carrier_hint.provider": "Which forge the work belongs to (github).",
  "draft.curation.carrier_hint.repo_id": "Numeric repository id.",
  "draft.curation.carrier_hint.branch": "The branch name, which is how a draft is tied to the pull request it belongs to.",
  "draft.curation.carrier_hint.pr_number": "Pull request number.",

  // --- error.interception
  "error.interception.draft_hash": "Salted hash of the draft you had accepted.",
  "error.interception.fix_hash": "Salted hash of the text that replaced it.",
  "error.interception.t_since_accept_ms": "How long the accepted draft survived before you corrected it.",
  "error.interception.kc_to_fix": "How much of it survived the correction.",
  "error.interception.kc_algo_version": "Which algorithm measured that.",
  "error.interception.size_fix": "Length of the correction in characters.",
  "error.interception.same_region": "Whether the correction was in the same place as the draft.",
  "error.interception.carrier_hint.provider": "Which forge the work belongs to (github).",
  "error.interception.carrier_hint.repo_id": "Numeric repository id.",
  "error.interception.carrier_hint.branch": "The branch name, which is how a correction is tied to the pull request it belongs to.",
  "error.interception.carrier_hint.pr_number": "Pull request number.",
  "error.interception.defect_confirmed_by": "Filled in by the server later, from the pull request — empty when it leaves your machine.",
  "error.interception.defect_kind": "Same: assigned by the pipeline, not by the wedge.",
  "error.interception.fixed_in_same_episode": "Same: assigned by the pipeline.",
  "error.interception.ifix_candidate": "Same: assigned by the pipeline.",

  // --- wedge.status
  "wedge.status.kind": "Heartbeat, paused, resumed, error or updated.",
  "wedge.status.wedge_version": "Version of the wedge.",
  "wedge.status.error_code": "A short code when something went wrong — never a message with your data in it.",

  // --- prompt.history (schema 2.5): a session known only from your prompt history
  "prompt.history.transcript_id": "The random id your AI tool gave the session, when its prompt history names one.",
  "prompt.history.grouping": "Whether the counts are of one session, or — for old history that names none — of one project on one day.",
  "prompt.history.duration_ms": "From your first prompt in it to your last.",
  "prompt.history.project_hash": "The same salted hash of your project's directory as on a session, made on your machine.",
  "prompt.history.repo_id": "The numeric id of the repository, only when it is one you connected.",
  ...promptHistoryNotes("prompt.history.features"),
};

/** What the wedge never sends, stated as flatly as the list itself (collector §2). */
export const NEVER_SENT = [
  "Source code, diffs, file contents",
  "Prompt or completion text",
  "File names and paths (only salted hashes and the branch)",
  "Screenshots, keystrokes, screen recordings",
  "Clipboard, browser history, other applications",
  "Microphone or camera",
  "Time tracking outside episodes",
];
