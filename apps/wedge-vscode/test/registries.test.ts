/**
 * Two registries, one source — and the publisher is a parameter, not a line somebody edits.
 *
 * Cursor cannot install from Microsoft's Marketplace (its terms do not allow it), so an extension
 * published only there is invisible to half the people this product is for. Open VSX is what
 * Cursor reads, and the namespace we hold there is `deigma-net` because `deigma` was taken.
 *
 * What this guards is the pair staying a pair: two ids, two install lines on the onboarding, and
 * a build that cannot quietly ship one of them under the other's name.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { REGISTRIES } from "../build-vsix.mjs";

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8"));

describe("the two registries", () => {
  it("names a distinct publisher for each, and they are the ones the onboarding prints", () => {
    expect(REGISTRIES.vscode.publisher).toBe("deigma");
    expect(REGISTRIES.openvsx.publisher).toBe("deigma-net");
    expect(REGISTRIES.vscode.publisher).not.toBe(REGISTRIES.openvsx.publisher);
  });

  it("keeps the extension NAME the same, so the two are one extension and not two products", () => {
    expect(manifest.name).toBe("passport");
  });

  it("leaves the committed manifest on the Marketplace publisher", () => {
    // The build rewrites this field and restores it in a `finally`. A tree left on `deigma-net`
    // after a failed package would publish the wrong id the next time somebody ran `vsce` by hand.
    expect(manifest.publisher).toBe(REGISTRIES.vscode.publisher);
  });

  it("gives each registry the tool that can actually publish to it", () => {
    expect(REGISTRIES.vscode.tool).toBe("@vscode/vsce");
    expect(REGISTRIES.openvsx.tool).toBe("ovsx");
  });

  it("packages nothing when it is merely imported", () => {
    // This file reads a constant out of the build module, and for a while that import PACKAGED
    // both extensions: the script ran `vsce` at the top level, so every `pnpm test` shelled out
    // for ten seconds and rewrote two binaries that were tracked in git — leaving the working
    // tree dirty, which is a state a release refuses to ship.
    //
    // Importing it in a child process is what makes the assertion honest: by the time this file's
    // own `import` has run, any side effect has already happened and cannot be observed here.
    const dir = join(import.meta.dirname, "..");
    const vsix = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".vsix")) : []);
    const before = new Set(vsix());
    // The path goes INSIDE the script, not after it: `node -e "..." <path>` puts the path in
    // argv[1], which is exactly what the module reads to decide it is being run — the first
    // version of this test defeated the guard it was testing and packaged both extensions.
    const url = pathToFileURL(join(dir, "build-vsix.mjs")).href;
    execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`], {
      cwd: dir,
      stdio: "pipe",
      timeout: 60_000,
    });
    expect(vsix().filter((f) => !before.has(f)), "importing the build module wrote a package").toEqual([]);
  });
});

/**
 * The listing a person reads in the Marketplace and Open VSX, and the names the palette shows
 * (copy v4, "VS Code extension"). The name `passport` is the extension's IDENTITY — both
 * registries hold it — and stays; what a person reads says "Deigma" and never "passport", and
 * gives no setup orders. Held by mutation: the word put back must fail this.
 */
describe("the listing (copy v4)", () => {
  const readme = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");

  it("names the extension Deigma and says what it shows, and that it never reads code", () => {
    expect(manifest.displayName).toBe("Deigma");
    expect(manifest.description).toBe(
      "Shows whether you review AI's code before accepting it: whether you read and change a suggestion first. Never your code.",
    );
    const titles = manifest.contributes.commands.map((c: { command: string; title: string }) => [c.command, c.title]);
    expect(Object.fromEntries(titles)["deigma.status"]).toBe("Deigma: what it reads");
  });

  it("says no 'passport', no inside word, and no setup order anywhere a person reads", () => {
    const visible: string[] = [
      manifest.displayName,
      manifest.description,
      ...manifest.contributes.commands.map((c: { title: string }) => c.title),
      manifest.contributes.configuration.title,
      ...Object.values(manifest.contributes.configuration.properties).map(
        (p) => (p as { description: string }).description,
      ),
      readme,
    ];
    // a rule checked over nothing passes: the listing is there and carries every command
    expect(visible.filter((t) => typeof t === "string" && t.length > 0).length).toBeGreaterThan(8);
    for (const text of visible) {
      expect(text, text).not.toMatch(/\bpassports?\b/i);
      expect(text, text).not.toMatch(/\b(wedge|landings?|carriers?|witness\w*|applicable set)\b/i);
      expect(text, text).not.toMatch(/\b(install|required|set up|configure)\b/i);
    }
  });
});
