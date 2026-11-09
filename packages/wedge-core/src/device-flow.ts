// OAuth device flow for `npx deigma init` (Playbook §8: works over SSH, no local server needed;
// a loopback redirect is the fallback when a browser is available).
//
// The CLI never sees a GitHub token: it authenticates against OUR API, which is the only party
// that talks to GitHub. What the CLI stores is a Mentat session token for ingestion.

export type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  /** RFC 8628: the page with the code already in it. Optional because an API older than RD-16
   *  does not send it, and the CLI in people's hands must keep working against either. */
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
};

export type DeviceTokenResponse =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "denied"; error: string }
  | { status: "ok"; session: string; handle: string | null };

/** Which wedge asks. The kind decides which sessions a disconnect revokes (RD-14), so the editor
 *  names itself; the CLI sends no body, exactly as the CLI already in people's hands does. */
export type DeviceClient = "cli" | "ide";

export type DeviceFlowDeps = {
  apiBaseUrl: string;
  /** Absent means the CLI. */
  client?: DeviceClient;
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Where the user is told to go; stdout in the CLI, a notification in the editor, captured in
   *  tests. */
  print: (line: string) => void;
};

export class DeviceFlowError extends Error {}

/** Starts the flow and prints the code exactly once (Playbook: the token is picked up without
 * the user copying keys by hand — they only type a short code). */
export async function startDeviceFlow(deps: DeviceFlowDeps): Promise<DeviceCodeResponse> {
  const res = await deps.fetch(
    `${deps.apiBaseUrl}/auth/device/start`,
    deps.client && deps.client !== "cli"
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client: deps.client }),
        }
      : { method: "POST" },
  );
  if (!res.ok) throw new DeviceFlowError(`device flow start failed: ${res.status}`);
  const body = (await res.json()) as DeviceCodeResponse;
  // The link carries the code, so the person opens it instead of retyping eight characters. The
  // code is still printed: the page only prefills, and what the person approves is a match
  // between this line and that field — never a link that approves by being opened.
  deps.print(
    body.verification_uri_complete
      ? `Open ${body.verification_uri_complete} and check the code there reads ${body.user_code}`
      : `Open ${body.verification_uri} and enter the code: ${body.user_code}`,
  );
  return body;
}

/** Polls until the user approves, honouring the server's interval and slow_down. */
export async function awaitApproval(
  deps: DeviceFlowDeps,
  device: DeviceCodeResponse,
): Promise<{ session: string; handle: string | null }> {
  const deadline = deps.now() + device.expires_in * 1000;
  let interval = Math.max(1, device.interval) * 1000;
  while (deps.now() < deadline) {
    await deps.sleep(interval);
    const res = await deps.fetch(`${deps.apiBaseUrl}/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: device.device_code }),
    });
    const body = (await res.json()) as DeviceTokenResponse;
    if (body.status === "ok") return { session: body.session, handle: body.handle };
    if (body.status === "denied") throw new DeviceFlowError(`authorisation denied: ${body.error}`);
    if (body.status === "slow_down") interval = Math.max(interval, body.interval * 1000);
  }
  throw new DeviceFlowError("device code expired before it was approved");
}
