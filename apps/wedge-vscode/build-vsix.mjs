// One source, two registries, two publishers — and the publisher is a PARAMETER rather than a
// line somebody edits before each release.
//
//   node build-vsix.mjs vscode     -> deigma.passport      (Microsoft Marketplace)
//   node build-vsix.mjs openvsx    -> deigma-net.passport  (Open VSX, which is what Cursor reads)
//   node build-vsix.mjs both
//
// Why two at all: Cursor cannot install from Microsoft's Marketplace — its terms do not allow it
// — so an extension that exists only there is invisible to half the people this product is for.
// Open VSX is the registry Cursor reads, and the namespace we hold there is `deigma-net` because
// `deigma` was taken. The extension is byte-identical apart from that one field.
//
// Editing package.json in place and putting it back is deliberate: `vsce` reads the manifest from
// disk and there is no flag for the publisher. The original is restored in a `finally`, so a
// failed package leaves the tree as it found it.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, "package.json");

export const REGISTRIES = {
  vscode: { publisher: "deigma", tool: "@vscode/vsce", note: "Microsoft Marketplace — VS Code" },
  openvsx: { publisher: "deigma-net", tool: "ovsx", note: "Open VSX — Cursor" },
};

function packageFor(which) {
  const registry = REGISTRIES[which];
  if (!registry) throw new Error(`unknown registry ${which}; expected ${Object.keys(REGISTRIES).join(" | ")}`);
  const original = readFileSync(MANIFEST, "utf8");
  const manifest = JSON.parse(original);
  const out = `${manifest.name}-${registry.publisher}-${manifest.version}.vsix`;
  try {
    writeFileSync(MANIFEST, `${JSON.stringify({ ...manifest, publisher: registry.publisher }, null, 2)}\n`);
    execFileSync("npx", ["--yes", "@vscode/vsce", "package", "--no-dependencies", "--out", out], {
      cwd: HERE,
      stdio: "inherit",
    });
  } finally {
    writeFileSync(MANIFEST, original);
  }
  console.log(`built ${out} — ${registry.publisher}.${manifest.name} (${registry.note})`);
  return out;
}

export function packageAll(which = "both") {
  return (which === "both" ? Object.keys(REGISTRIES) : [which]).map(packageFor);
}

// Only when RUN, never when imported. This file exports the registry table, and importing it used
// to package two extensions as a side effect: `vsce` shelled out on every `pnpm test`, took ten
// seconds, and rewrote two binaries that were tracked in git — so the working tree was dirty after
// any test run, which is a state a release refuses to ship. A module that does
// work when you import it is a module you cannot read a constant out of.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageAll(process.argv[2] ?? "both");
}
