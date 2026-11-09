/**
 * The task routes of Deigma's API, as the terminal calls them (packages/schemas/src/task.ts):
 *
 *   GET  /v1/me/tasks?repo=owner/name       the person's attempts, the one for this folder's remote
 *   GET  /v1/me/tasks/:grant_id             the attempt: company, template, redact list, state
 *   PUT  /v1/me/tasks/:grant_id/repo        the person's own copy, when the page has not been told yet
 *   POST /v1/me/tasks/:grant_id/session     the sessions of the folder, after a yes
 *   POST /v1/me/tasks/:grant_id/submit      the pull request. Final.
 *
 * Every answer is read through the schema it is written in, so a server that has moved on is
 * "an answer this version does not know", never a field read off by guess. Unlike the proxy this
 * command may fail, and it does: a call that cannot be made says so and the command stops, before
 * anything is submitted.
 */
import {
  CandidateTask,
  CandidateTaskList,
  TaskError,
  TaskSessionReceipt,
  type CandidateTaskItem,
  type TaskSessionUpload,
} from "@mentat/schemas";

export type ApiAccess = { base: string; session: string; fetch: typeof globalThis.fetch };

/** A refusal: the status, the code and plain-words message the API gave, and when to try again. */
export type Refusal = { status: number; code: string | null; message: string | null; retryAfterSeconds: number | null };

/**
 * What a call came to. `ended`: the server no longer knows this sign-in. `unreachable`: it could not
 * be asked (or did not answer in time). `unknown`: it answered something this version cannot read.
 */
export type Call<T> =
  | { kind: "ok"; value: T }
  | { kind: "ended" }
  | { kind: "refused"; refusal: Refusal }
  | { kind: "unreachable" }
  | { kind: "unknown"; status: number };

const SHORT_MS = 20_000;
/** Ten megabytes over a slow line. */
const UPLOAD_MS = 180_000;

function refusalOf(status: number, body: unknown, headers: Headers): Refusal {
  const parsed = TaskError.safeParse(body);
  const retry = Number(headers.get("retry-after"));
  return {
    status,
    code: parsed.success ? parsed.data.error : null,
    message: parsed.success ? (parsed.data.message ?? null) : null,
    retryAfterSeconds: parsed.success && parsed.data.retry_after_s ? parsed.data.retry_after_s : Number.isFinite(retry) && retry > 0 ? retry : null,
  };
}

async function request(
  api: ApiAccess,
  method: "GET" | "PUT" | "POST",
  path: string,
  body?: unknown,
  timeoutMs: number = SHORT_MS,
): Promise<Call<unknown>> {
  try {
    const res = await api.fetch(`${api.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${api.session}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { kind: "ended" };
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (res.ok) return { kind: "ok", value: json };
    return { kind: "refused", refusal: refusalOf(res.status, json, res.headers) };
  } catch {
    return { kind: "unreachable" };
  }
}

/** A successful answer read through its schema; anything else is `unknown`. */
function reading<T>(done: Call<unknown>, parse: (value: unknown) => { success: true; data: T } | { success: false }): Call<T> {
  if (done.kind !== "ok") return done;
  const parsed = parse(done.value);
  return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "unknown", status: 200 };
}

export async function listTasks(api: ApiAccess, repo?: string): Promise<Call<CandidateTaskItem[]>> {
  const query = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  const done = reading(await request(api, "GET", `/v1/me/tasks${query}`), (v) => CandidateTaskList.safeParse(v));
  return done.kind === "ok" ? { kind: "ok", value: done.value.items } : done;
}

export async function getTask(api: ApiAccess, grantId: string): Promise<Call<CandidateTask>> {
  return reading(await request(api, "GET", `/v1/me/tasks/${grantId}`), (v) => CandidateTask.safeParse(v));
}

export async function setRepo(api: ApiAccess, grantId: string, repo: string): Promise<Call<unknown>> {
  return request(api, "PUT", `/v1/me/tasks/${grantId}/repo`, { repo });
}

export async function uploadSession(
  api: ApiAccess,
  grantId: string,
  body: TaskSessionUpload,
): Promise<Call<TaskSessionReceipt>> {
  return reading(
    await request(api, "POST", `/v1/me/tasks/${grantId}/session`, body, UPLOAD_MS),
    (v) => TaskSessionReceipt.safeParse(v),
  );
}

/** What a submit answered: the attempt as it stands now, if the answer is one this version reads. */
export async function submitPull(api: ApiAccess, grantId: string, prNumber: number): Promise<Call<CandidateTask | null>> {
  const done = await request(api, "POST", `/v1/me/tasks/${grantId}/submit`, { pr_number: prNumber });
  if (done.kind !== "ok") return done;
  const parsed = CandidateTask.safeParse(done.value);
  return { kind: "ok", value: parsed.success ? parsed.data : null };
}
