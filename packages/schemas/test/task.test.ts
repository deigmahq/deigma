/**
 * The agent task: the shapes between the terminal and the API.
 *
 * Held here: the repository name a person types is the one shape the server and the page read; the
 * session a terminal uploads is bounded and strict (a field nobody named is a parse error, so a
 * prompt cannot ride in a place that was not made for it); the attempt the terminal reads names
 * exactly what the terminal needs and leaves `results` untyped, so the public client carries no
 * shape of an outcome; a task's key and language are names, not a list the terminal knows.
 * Every table first asserts that its input is not empty.
 */
import { describe, expect, it } from "vitest";

import {
  CandidateTask,
  CandidateTaskItem,
  CandidateTaskList,
  TASK_ERROR_CODES,
  TASK_EVENT_KINDS,
  TASK_LIMITS,
  TASK_REPO_PATTERN,
  TASK_SESSION_STATES,
  TASK_SHARED_KEYS,
  TASK_STATES,
  TaskError,
  TaskKeyName,
  TaskLanguageName,
  TaskPullNumber,
  TaskRedaction,
  TaskRepoName,
  TaskSession,
  TaskSessionEvent,
  TaskSessionReceipt,
  TaskSessionUpload,
  taskPullUrl,
  taskRepoUrl,
} from "../src/task";

// --- fixtures ---------------------------------------------------------------------------------------

const ID = "0191b7a1-0000-7aaa-8bbb-000000000001";
const AT = "2026-11-08T10:00:00.000Z";

const event = { at: AT, kind: "prompt", text: "Find why the paging skips invoices." };
const session = { agent: "claude_code", events: [event, { at: AT, kind: "tool_call", tool: "Bash", text: "pytest -q" }] };

const candidateTask = {
  grant_id: ID,
  company: "Northwind",
  role_title: "Senior Backend Engineer",
  task: {
    key: "invoices",
    title: "Invoices API: pagination skips records",
    summary: "Find why the paging skips invoices, fix it, submit a pull request.",
    bug_report: "Customers report missing invoices from page 3 onward.",
    language: "python",
  },
  template: { repository: "deigmahq/task-invoices-api-python", url: "https://github.com/deigmahq/task-invoices-api-python" },
  shared: [
    { key: "pull_request", line: "The address of your copy and your pull request." },
    { key: "session", line: "Your session goes only if you attach it when you submit." },
  ],
  state: "started",
  repo: null,
  pull: null,
  started_at: AT,
  submitted_at: null,
  session_state: null,
  session_open_until: null,
  release_at: null,
  results: null,
  redact: [{ text: "a-made-up-value", replace_with: "[redacted]" }],
};

// --- the vocabulary ---------------------------------------------------------------------------------

describe("the vocabulary", () => {
  it("is the one the contract names", () => {
    expect([...TASK_STATES]).toEqual(["started", "submitted", "checked"]);
    expect([...TASK_SESSION_STATES]).toEqual(["attached", "not_available"]);
    expect([...TASK_EVENT_KINDS]).toEqual(["prompt", "reply", "tool_call", "tool_result"]);
    expect([...TASK_SHARED_KEYS]).toEqual(["pull_request", "checks", "session", "card"]);
  });

  it("states the limits the contract states", () => {
    expect(TASK_LIMITS.sessionBytes).toBe(10 * 1024 * 1024);
    expect(TASK_LIMITS.lateSessionMinutes).toBe(10);
    expect(TASK_LIMITS.releaseDays).toBe(14);
    // The body a session may arrive in holds the session and a little more, never less.
    expect(TASK_LIMITS.sessionBodyBytes).toBeGreaterThan(TASK_LIMITS.sessionBytes);
  });
});

// --- the repository ---------------------------------------------------------------------------------

describe("the name of a repository", () => {
  it.each([
    "deigmahq/task-invoices-api-python",
    "a/b",
    "Maya-Chen/invoices_api.v2",
    "x".repeat(39) + "/" + "y".repeat(100),
    "maya/.github",
    "maya/a.b-c_d",
  ])("accepts %s", (repo) => {
    expect(TaskRepoName.safeParse(repo).success).toBe(true);
    expect(TASK_REPO_PATTERN.test(repo)).toBe(true);
  });

  it.each([
    ["only an owner", "maya"],
    ["no name", "maya/"],
    ["no owner", "/invoices"],
    ["a third segment", "maya/invoices/extra"],
    ["an address", "https://github.com/maya/invoices"],
    ["an address without a scheme", "github.com/maya/invoices"],
    ["an owner that starts with a hyphen", "-maya/invoices"],
    ["an owner that ends with a hyphen", "maya-/invoices"],
    ["an owner with two hyphens in a row", "ma--ya/invoices"],
    ["an owner of forty characters", "x".repeat(40) + "/invoices"],
    ["a name of a hundred and one", "maya/" + "y".repeat(101)],
    ["a name that is a dot", "maya/."],
    ["a name that is two dots", "maya/.."],
    ["a space", "maya/my invoices"],
    ["a trailing newline", "maya/invoices\n"],
    ["a query", "maya/invoices?x=1"],
    ["an at sign", "maya/inv@ices"],
    ["empty", ""],
  ])("refuses %s", (_name, repo) => {
    expect(TaskRepoName.safeParse(repo).success).toBe(false);
  });

  it("builds the two addresses a page links to", () => {
    expect(taskRepoUrl("maya/invoices")).toBe("https://github.com/maya/invoices");
    expect(taskPullUrl("maya/invoices", 12)).toBe("https://github.com/maya/invoices/pull/12");
  });

  it("numbers a pull request by a whole number from 1 to the cap", () => {
    for (const number of [1, 12, TASK_LIMITS.pullNumberMax]) expect(TaskPullNumber.safeParse(number).success).toBe(true);
    for (const number of [0, -1, 1.5, TASK_LIMITS.pullNumberMax + 1, "12", null]) {
      expect(TaskPullNumber.safeParse(number).success, String(number)).toBe(false);
    }
  });
});

// --- the session ------------------------------------------------------------------------------------

describe("the normalized session", () => {
  it("is events of four kinds, a tool name where there is one, and capped text", () => {
    expect(TaskSessionEvent.safeParse(event).success).toBe(true);
    expect(TaskSessionEvent.safeParse({ ...event, kind: "tool_result", tool: "Bash", text: "" }).success).toBe(true);
    expect(TaskSessionEvent.safeParse({ ...event, text: "x".repeat(TASK_LIMITS.eventText) }).success).toBe(true);
  });

  it.each([
    ["a kind nobody named", { ...event, kind: "thought" }],
    ["text over the cap", { ...event, text: "x".repeat(TASK_LIMITS.eventText + 1) }],
    ["no text", { at: AT, kind: "prompt" }],
    ["a time that is not one", { ...event, at: "yesterday" }],
    ["a time without a zone", { ...event, at: "2026-11-08T10:00:00" }],
    ["an empty tool name", { ...event, tool: "" }],
    ["a tool name over the cap", { ...event, tool: "t".repeat(TASK_LIMITS.toolName + 1) }],
    ["a path riding along", { ...event, path: "/Users/maya/invoices/app.py" }],
    ["a duration riding along", { ...event, duration_ms: 1200 }],
    ["a model riding along", { ...event, model: "claude" }],
  ])("refuses an event with %s", (_name, body) => {
    expect(TaskSessionEvent.safeParse(body).success).toBe(false);
  });

  it("is a session of one agent, with at least one event and no more than the cap", () => {
    expect(TaskSession.safeParse(session).success).toBe(true);
    expect(TaskSession.safeParse({ events: [event] }).success).toBe(true);
    expect(TaskSession.safeParse({ agent: "codex", events: [event] }).success).toBe(true);
    expect(TaskSession.safeParse({ agent: "cursor", events: [event] }).success).toBe(false);
    expect(TaskSession.safeParse({ ...session, events: [] }).success).toBe(false);
    expect(TaskSession.safeParse({ ...session, cwd: "/tmp/x" }).success).toBe(false);
  });

  it("is uploaded as attached (with the person's yes) or as not available", () => {
    expect(TaskSessionUpload.safeParse({ state: "attached", consent: true, sessions: [session] }).success).toBe(true);
    expect(TaskSessionUpload.safeParse({ state: "not_available" }).success).toBe(true);
    for (const [name, body] of [
      ["attached with no consent", { state: "attached", sessions: [session] }],
      ["attached with consent false", { state: "attached", consent: false, sessions: [session] }],
      ["attached with no session", { state: "attached", consent: true, sessions: [] }],
      ["attached with too many sessions", { state: "attached", consent: true, sessions: Array.from({ length: TASK_LIMITS.sessions + 1 }, () => session) }],
      ["not available with sessions riding along", { state: "not_available", sessions: [session] }],
      ["not available with a reason", { state: "not_available", reason: "other agent" }],
      ["a state nobody named", { state: "partial", consent: true, sessions: [session] }],
      ["no state", { consent: true, sessions: [session] }],
    ] as const) {
      expect(TaskSessionUpload.safeParse(body).success, name).toBe(false);
    }
  });

  it("answers with what is held", () => {
    expect(TaskSessionReceipt.safeParse({ state: "attached", sessions: 1, events: 2, bytes: 140 }).success).toBe(true);
    expect(TaskSessionReceipt.safeParse({ state: "not_available", sessions: 0, events: 0, bytes: 0 }).success).toBe(true);
    expect(TaskSessionReceipt.safeParse({ state: "attached", sessions: -1, events: 2, bytes: 140 }).success).toBe(false);
  });
});

// --- the attempt, as the terminal reads it ---------------------------------------------------------

describe("what the terminal reads of the candidate's own attempt", () => {
  it("is the task, the template, what is shared, where the attempt stands and the strings to replace", () => {
    expect(CandidateTask.safeParse(candidateTask).success).toBe(true);
  });

  it("leaves the outcome untyped: null, or a value of any shape, but never missing", () => {
    expect(CandidateTask.safeParse({ ...candidateTask, results: null }).success).toBe(true);
    expect(CandidateTask.safeParse({ ...candidateTask, state: "checked", results: { anything: ["at", "all"] } }).success).toBe(true);
    const { results: _results, ...without } = candidateTask;
    expect(CandidateTask.safeParse(without).success).toBe(false);
  });

  it("reads a task's key and language as names: a task this version has never heard of is still readable", () => {
    const newer = { ...candidateTask, task: { ...candidateTask.task, key: "somenewtask", language: "ruby" } };
    expect(CandidateTask.safeParse(newer).success).toBe(true);
    for (const key of ["invoices", "somenewtask", "t2", "a"]) expect(TaskKeyName.safeParse(key).success, key).toBe(true);
    for (const language of ["python", "go", "typescript", "ruby"]) {
      expect(TaskLanguageName.safeParse(language).success, language).toBe(true);
    }
  });

  it.each([
    ["empty", ""],
    ["in capitals", "Invoices"],
    ["hyphenated", "new-task"],
    ["two words", "new task"],
    ["started by a digit", "2fast"],
    ["over forty characters", "x".repeat(41)],
    ["split by a line break", "a\nb"],
  ])("refuses a key or a language that is %s", (_what, word) => {
    expect(TaskKeyName.safeParse(word).success).toBe(false);
    expect(TaskLanguageName.safeParse(word).success).toBe(false);
    expect(CandidateTask.safeParse({ ...candidateTask, task: { ...candidateTask.task, key: word } }).success).toBe(false);
    expect(CandidateTask.safeParse({ ...candidateTask, task: { ...candidateTask.task, language: word } }).success).toBe(false);
  });

  it("holds a submitted attempt: the copy, the pull request, the session state, the moments", () => {
    const submitted = {
      ...candidateTask,
      state: "submitted",
      repo: "maya/invoices",
      pull: { number: 1, url: "https://github.com/maya/invoices/pull/1" },
      submitted_at: "2026-11-05T14:05:00.000Z",
      session_state: "not_available",
      session_open_until: "2026-11-05T14:15:00.000Z",
      release_at: "2026-11-19T14:05:00.000Z",
    };
    expect(CandidateTask.safeParse(submitted).success).toBe(true);
  });

  it.each([
    ["a field nobody named", { ...candidateTask, findings: [] }],
    ["the company's id", { ...candidateTask, company_id: ID }],
    ["the role's id", { ...candidateTask, role_id: ID }],
    ["the head sha before the check", { ...candidateTask, head_sha: "0123456789abcdef0123456789abcdef01234567" }],
    ["a redaction that replaces with nothing", { ...candidateTask, redact: [{ text: "a-made-up-value", replace_with: "" }] }],
    ["a redaction of a short string", { ...candidateTask, redact: [{ text: "key", replace_with: "[redacted]" }] }],
    ["a redaction with a field riding along", { ...candidateTask, redact: [{ text: "a-made-up-value", replace_with: "[redacted]", why: "x" }] }],
    ["a state nobody named", { ...candidateTask, state: "done" }],
    ["a repository that is an address", { ...candidateTask, repo: "https://github.com/maya/invoices" }],
    ["a session state nobody named", { ...candidateTask, session_state: "partial" }],
    ["a shared item nobody named", { ...candidateTask, shared: [{ key: "everything", line: "All of it." }] }],
    ["no redaction list", { ...candidateTask, redact: undefined }],
  ])("refuses %s", (_name, body) => {
    expect(CandidateTask.safeParse(body).success).toBe(false);
  });

  it("replaces a string of eight characters or more, with a short word", () => {
    expect(TaskRedaction.safeParse({ text: "12345678", replace_with: "[redacted]" }).success).toBe(true);
    expect(TaskRedaction.safeParse({ text: "1234567", replace_with: "[redacted]" }).success).toBe(false);
    expect(TaskRedaction.safeParse({ text: "x".repeat(201), replace_with: "[redacted]" }).success).toBe(false);
    expect(TaskRedaction.safeParse({ text: "12345678", replace_with: "x".repeat(33) }).success).toBe(false);
  });

  it("lists the attempts with enough for a terminal to find one by the folder's remote", () => {
    const item = {
      grant_id: ID,
      company: "Northwind",
      role_title: "Senior Backend Engineer",
      task: { key: "invoices", title: "Invoices API: pagination skips records", language: "python" },
      state: "started",
      repo: "maya/invoices",
      pr_number: null,
      submitted_at: null,
    };
    expect(CandidateTaskItem.safeParse(item).success).toBe(true);
    expect(CandidateTaskList.safeParse({ items: [item] }).success).toBe(true);
    expect(CandidateTaskList.safeParse({ items: [] }).success).toBe(true);
    expect(CandidateTaskItem.safeParse({ ...item, results: null }).success).toBe(false);
    expect(CandidateTaskList.safeParse({ items: [item], total: 1 }).success).toBe(false);
  });
});

// --- refusals ---------------------------------------------------------------------------------------

describe("the refusals", () => {
  it("name every code the routes give, and say how long to wait", () => {
    expect([...TASK_ERROR_CODES].sort()).toEqual(
      [
        "already_started",
        "already_submitted",
        "github_unavailable",
        "invalid_request",
        "no_repo",
        "no_task",
        "not_found",
        "pull_not_found",
        "rate_limited",
        "repo_not_found",
        "repo_not_from_template",
        "secret_found",
        "session_too_large",
        "session_window_closed",
      ].sort(),
    );
    for (const code of TASK_ERROR_CODES) expect(TaskError.safeParse({ error: code }).success, code).toBe(true);
    expect(TaskError.safeParse({ error: "rate_limited", retry_after_s: 30 }).success).toBe(true);
    expect(TaskError.safeParse({ error: "repo_not_found", message: "We couldn't find a public repository by that name." }).success).toBe(true);
  });

  it.each([
    ["a code nobody gives", { error: "teapot" }],
    ["no code", {}],
    ["a wait that is zero", { error: "rate_limited", retry_after_s: 0 }],
    ["an empty message", { error: "invalid_request", message: "" }],
    ["a body riding along", { error: "invalid_request", body: "{}" }],
  ])("refuses %s", (_name, body) => {
    expect(TaskError.safeParse(body).success).toBe(false);
  });
});
