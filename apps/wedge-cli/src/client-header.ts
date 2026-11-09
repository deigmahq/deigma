// Which of our clients is calling, and which version: `x-deigma-client: cli/0.4.1` on every request
// to the API (the server counts it per version per day, never per person; "What it reads"
// lists it). Without it the server cannot tell an old CLI that keeps failing from a new one.
import { createRequire } from "node:module";

export const CLIENT_HEADER = "x-deigma-client";

/** The version of this package, read from its own package.json — next to src/ in the workspace and
 *  next to dist/ in the published package, so one relative path serves both. */
export function cliVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function cliClientHeader(version: string = cliVersion()): string {
  return `cli/${version}`;
}

/** The network with the header on every request. `send` is read at call time, so a stub put in
 *  place after start-up is the one used. */
export function withClientHeader(send: () => typeof fetch, value: string): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set(CLIENT_HEADER, value);
    return send()(input, { ...init, headers });
  }) as typeof fetch;
}
