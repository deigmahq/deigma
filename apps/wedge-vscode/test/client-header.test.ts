// The extension names itself and the editor it runs in on every request (x-deigma-client:
// ide/<version> (<editor>)); VS Code and Cursor looked identical to the server before.
import { describe, expect, it } from "vitest";

import { CLIENT_HEADER, ideClientHeader, withClientHeader } from "../src/client-header";

describe("the extension's client header", () => {
  it("names the version and the editor, kept to the characters the server accepts", () => {
    expect(ideClientHeader("0.3.1", "Cursor")).toBe("ide/0.3.1 (Cursor)");
    expect(ideClientHeader("0.3.1", "Visual Studio Code")).toBe("ide/0.3.1 (Visual Studio Code)");
    expect(ideClientHeader("0.3.1", "Code — OSS <x>")).toBe("ide/0.3.1 (Code  OSS x)");
    expect(ideClientHeader("0.3.1", "")).toBe("ide/0.3.1");
    expect(ideClientHeader("0.3.1", "x".repeat(60))).toBe(`ide/0.3.1 (${"x".repeat(40)})`);
  });

  it("goes on every request, and the network is the one in place when the request is made", async () => {
    let calls = 0;
    let current = (async (_i: unknown, init?: RequestInit) => {
      calls += 1;
      return new Response(new Headers(init?.headers).get(CLIENT_HEADER));
    }) as typeof fetch;
    const send = withClientHeader(() => current, "ide/0.3.1 (Cursor)");
    expect(await (await send("https://api.deigma.net/v1/me")).text()).toBe("ide/0.3.1 (Cursor)");
    current = (async () => new Response("replaced")) as typeof fetch;
    expect(await (await send("https://api.deigma.net/v1/me")).text()).toBe("replaced");
    expect(calls).toBe(1);
  });
});
