// The CLI names itself on every request (x-deigma-client: cli/<version>); the server counts it per
// version per day. The version is the package's own.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CLIENT_HEADER, cliClientHeader, cliVersion, withClientHeader } from "../src/client-header";

describe("the CLI's client header", () => {
  it("names the CLI and the version in its package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(cliVersion()).toBe(pkg.version);
    expect(cliClientHeader()).toBe(`cli/${pkg.version}`);
    expect(cliClientHeader()).toMatch(/^cli\/\d+\.\d+\.\d+/);
  });

  it("goes on every request, beside the headers the request already had", async () => {
    const seen: Headers[] = [];
    const send = withClientHeader(
      () =>
        (async (_input: unknown, init?: RequestInit) => {
          seen.push(new Headers(init?.headers));
          return new Response("{}");
        }) as typeof fetch,
      "cli/9.9.9",
    );
    await send("https://api.deigma.net/v1/me", { headers: { authorization: "Bearer t" } });
    await send("https://api.deigma.net/v1/events", { method: "POST" });
    expect(seen.map((h) => h.get(CLIENT_HEADER))).toEqual(["cli/9.9.9", "cli/9.9.9"]);
    expect(seen[0]!.get("authorization")).toBe("Bearer t");
  });
});
