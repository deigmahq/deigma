// Signing the editor in and out (RD-16b).
//
// Until this module the published extension could never connect: `activate()` collected only when
// SecretStorage held a session, and nothing in the product wrote one. `Deigma: Connect` runs the
// same device flow the CLI runs (one implementation, in @mentat/wedge-core), names itself as the
// editor so the session is an `ide` one — disconnecting the editor in Settings leaves the CLI
// signed in, and the other way round (RD-14) — and stores what it gets back in SecretStorage.
//
// Everything here is behind the narrow ConnectionHost below so it runs against a fake editor in
// tests; `extension.ts` only adapts the real API to it. Nothing in this file throws out of a
// command: the wedge fails open (Playbook v1.7 §2), and an editor command that throws is an error
// toast in somebody's working day.
import { awaitApproval, DeviceFlowError, startDeviceFlow, type DeviceCodeResponse } from "@mentat/wedge-core";

export const SESSION_KEY = "deigma.session";
export const USER_KEY = "deigma.userId";

export type Credentials = { session: string; userId: string };

/** What the status bar says about the connection. The collector owns the bar once connected. */
export type ConnectionState =
  | { kind: "not_connected" }
  | { kind: "waiting"; userCode: string }
  | { kind: "connected" };

export type ConnectionHost = {
  secrets: {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Opens a page in the person's browser. Only ever a page of OUR web app, from the API's answer. */
  openExternal(url: string): Promise<boolean>;
  /** A notification; resolves with the action the person picked, if any. Never awaited by the
   *  flow itself — the poll runs while the notification is on screen. */
  notify(text: string, ...actions: string[]): Promise<string | undefined>;
  setState(state: ConnectionState): void;
};

export type ConnectOutcome =
  | { status: "connected"; handle: string | null; credentials: Credentials }
  // The pair another window of this editor stored: SecretStorage is shared between windows, so a
  // window opened before that sign-in still says "not connected" until its Connect is clicked.
  | { status: "already_connected"; credentials: Credentials }
  | { status: "in_progress" }
  | { status: "failed"; reason: string };

export type DisconnectOutcome = { status: "disconnected"; revoked: boolean } | { status: "not_connected" };

export const OPEN_PAGE = "Open the page";

/** The stored pair, or null. Half a pair is not a connection: a session without the account it
 *  belongs to cannot stamp an envelope, and an id without a session cannot send one. */
export async function storedCredentials(host: ConnectionHost): Promise<Credentials | null> {
  const session = await host.secrets.get(SESSION_KEY);
  const userId = await host.secrets.get(USER_KEY);
  return session && userId ? { session, userId } : null;
}

export class Connection {
  private busy = false;

  constructor(
    private readonly host: ConnectionHost,
    private readonly apiBaseUrl: string,
  ) {}

  /**
   * The device flow, from the editor. The page link carries the code and the notification prints
   * it as well: what the person approves is a match between the two, never a link that approves
   * by being opened.
   */
  async connect(): Promise<ConnectOutcome> {
    if (this.busy) return { status: "in_progress" };
    // Taken before the first await: a second click while the secrets are being read must not
    // start a second flow and leave two codes waiting.
    this.busy = true;
    try {
      const stored = await storedCredentials(this.host);
      if (stored) return { status: "already_connected", credentials: stored };
      const deps = {
        apiBaseUrl: this.apiBaseUrl,
        client: "ide" as const,
        fetch: this.host.fetch,
        sleep: this.host.sleep,
        now: this.host.now,
        print: () => undefined, // the editor says it below, with a button instead of a bare URL
      };
      let device: DeviceCodeResponse;
      try {
        device = await startDeviceFlow(deps);
      } catch {
        return this.fail("deigma.net could not be reached, so no code was issued. Nothing was stored.");
      }
      const page = device.verification_uri_complete ?? device.verification_uri;
      this.host.setState({ kind: "waiting", userCode: device.user_code });
      void this.host
        .notify(`Deigma: approve this editor on deigma.net. The code there should read ${device.user_code}.`, OPEN_PAGE)
        .then((picked) => (picked === OPEN_PAGE ? this.host.openExternal(page) : false))
        .catch(() => false);

      let approved: { session: string; handle: string | null };
      try {
        approved = await awaitApproval(deps, device);
      } catch (err) {
        return this.fail(approvalFailure(err, device.user_code));
      }

      // The envelope carries the account it belongs to, and the token exchange does not say which
      // that is — /v1/me does, for the session just issued. Without it nothing can be collected,
      // so nothing is stored either: a session with no account is half a connection.
      const userId = await this.whoAmI(approved.session);
      if (!userId) {
        // The approved session exists on the server even though nothing is stored here. Left
        // there, Settings would show the editor connected while the editor says it is not, and
        // each retry would leave one more behind — so it is ended, and only it (one session, not
        // every editor's: another machine's editor stays signed in). When that cannot be done
        // either, the person is told it still stands and where to end it.
        const ended = await this.endSession(approved.session);
        return this.fail(
          ended
            ? "The code was approved, but deigma.net did not say which account it belongs to. Nothing was stored and the sign-in was ended there; run Deigma: Connect again."
            : "The code was approved, but deigma.net did not say which account it belongs to. Nothing was stored here, but the sign-in still stands on deigma.net until you disconnect the editor under Settings, Sources.",
        );
      }
      await this.host.secrets.store(SESSION_KEY, approved.session);
      await this.host.secrets.store(USER_KEY, userId);
      this.host.setState({ kind: "connected" });
      void this.host
        .notify(`Deigma: connected${approved.handle ? ` as @${approved.handle}` : ""}. Process metadata only; no code leaves this editor.`)
        .catch(() => undefined);
      return { status: "connected", handle: approved.handle, credentials: { session: approved.session, userId } };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Forgets the session on this machine and ends it on deigma.net — that one session
   * (`DELETE /v1/me/session`), not the editor kind: `DELETE /v1/me/sources/wedge_ide` is the
   * Settings row's revocation and would also sign out an editor on another machine, which would
   * go on saying it collects while nothing it sends is accepted. The CLI is never touched. The
   * local half always happens: if the server cannot be reached the person is told the sign-in
   * still stands there and where to end it, rather than being told it is gone.
   */
  async disconnect(): Promise<DisconnectOutcome> {
    const stored = await storedCredentials(this.host);
    if (!stored) {
      this.host.setState({ kind: "not_connected" });
      return { status: "not_connected" };
    }
    const revoked = await this.endSession(stored.session);
    await this.host.secrets.delete(SESSION_KEY);
    await this.host.secrets.delete(USER_KEY);
    this.host.setState({ kind: "not_connected" });
    void this.host
      .notify(
        revoked
          ? "Deigma: disconnected. This editor's sign-in is ended on deigma.net; the CLI and editors on other machines are untouched."
          : "Deigma: disconnected on this machine. deigma.net could not be reached, so this editor's sign-in still stands there until you disconnect the editor under Settings, Sources.",
      )
      .catch(() => undefined);
    return { status: "disconnected", revoked };
  }

  /**
   * The server stopped accepting the stored session (the sender saw 401): it was ended in
   * Settings, by a disconnect elsewhere, or with the account. The editor forgets it and says it is
   * not connected — the bar must not keep saying it collects while every batch bounces.
   */
  async endedElsewhere(): Promise<void> {
    await this.host.secrets.delete(SESSION_KEY);
    await this.host.secrets.delete(USER_KEY);
    this.host.setState({ kind: "not_connected" });
    void this.host
      .notify("Deigma: this editor's sign-in was ended on deigma.net, so it stopped collecting. Nothing was sent after that.")
      .catch(() => undefined);
  }

  /** Ends the one session given, on the server (`DELETE /v1/me/session`). True when it is gone
   *  there — 401 included: a session the server no longer accepts is already ended. */
  private async endSession(session: string): Promise<boolean> {
    try {
      const res = await this.host.fetch(`${this.apiBaseUrl}/v1/me/session`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${session}` },
      });
      return res.ok || res.status === 401;
    } catch {
      return false;
    }
  }

  private async whoAmI(session: string): Promise<string | null> {
    try {
      const res = await this.host.fetch(`${this.apiBaseUrl}/v1/me`, {
        headers: { authorization: `Bearer ${session}` },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { user_id?: unknown };
      return typeof body.user_id === "string" && body.user_id.length > 0 ? body.user_id : null;
    } catch {
      return null;
    }
  }

  private fail(reason: string): ConnectOutcome {
    this.host.setState({ kind: "not_connected" });
    void this.host.notify(`Deigma: ${reason}`).catch(() => undefined);
    return { status: "failed", reason };
  }
}

/** Why a code did not become a session, in the words of what happened to it. */
export function approvalFailure(err: unknown, userCode: string): string {
  if (!(err instanceof DeviceFlowError)) {
    return "deigma.net stopped answering while the code was waiting. Nothing was stored.";
  }
  if (/expired/.test(err.message)) {
    return `The code ${userCode} ran out before it was approved. Run Deigma: Connect for a new one.`;
  }
  if (/access_denied/.test(err.message)) {
    return `The code ${userCode} was refused on deigma.net. Nothing was stored.`;
  }
  return `deigma.net closed the code ${userCode} without a session. Nothing was stored.`;
}

/** The status-bar line for each state. Not connected names the command that changes it — the one
 *  thing the bar can offer, and it is a click on the bar itself, not an instruction. */
export function statusText(state: ConnectionState): string {
  switch (state.kind) {
    case "not_connected":
      return "Deigma: not connected";
    case "waiting":
      return `Deigma: waiting for ${state.userCode}`;
    case "connected":
      return "Deigma: connected";
  }
}
