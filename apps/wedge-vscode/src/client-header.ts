// Which of our clients is calling, which version, and in which editor: `x-deigma-client:
// ide/0.3.1 (Cursor)` on every request to the API (the server counts it per version
// per day, never per person; "What it reads" lists it). VS Code and Cursor run the same extension
// and looked identical to the server until this.
export const CLIENT_HEADER = "x-deigma-client";

/** `ide/<version> (<editor>)`; the editor's name is kept to letters, digits, spaces, dots,
 *  underscores and dashes, 40 characters at most — the rule the server applies. */
export function ideClientHeader(version: string, appName: string): string {
  const host = appName.replace(/[^A-Za-z0-9 ._-]/g, "").trim().slice(0, 40);
  return host ? `ide/${version} (${host})` : `ide/${version}`;
}

/** The network with the header on every request. `send` is read at call time, so a stub put in
 *  place after activation is the one used. */
export function withClientHeader(send: () => typeof fetch, value: string): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set(CLIENT_HEADER, value);
    return send()(input, { ...init, headers });
  }) as typeof fetch;
}
