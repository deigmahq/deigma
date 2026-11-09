// Bundles the CLI into one file, so the published package needs nothing from this workspace.
//
// `deigma` depends on three workspace packages. Publishing it with `workspace:*` dependencies
// would give everyone who ran `npx deigma` a package whose dependencies do not exist on npm; the
// alternative to bundling is publishing four packages and keeping their versions in step forever,
// for a CLI that is one file's worth of code.
import { build } from "esbuild";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// `node build.mjs [outdir]`: the bundle goes to <outdir>/deigma.js, `dist/` unless said otherwise.
// A test builds into a temporary directory so that it reads exactly the file `npm publish` packs
// and never touches `dist/`.
const outdir = process.argv[2] ?? "dist";
const out = join(outdir, "deigma.js");
await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: out,
  // Node built-ins stay external; everything of ours is inlined.
  packages: "bundle",
  // No banner: src/main.ts already carries the shebang and esbuild keeps it. Adding one gave the
  // bundle two, and the second is a syntax error on line 2 — which the build reported as success.
  logLevel: "warning",
});
chmodSync(out, 0o755);
const size = readFileSync(out).length;
writeFileSync(join(outdir, ".size"), String(size));
console.log(`deigma: ${out}, ${(size / 1024).toFixed(0)} KB`);
