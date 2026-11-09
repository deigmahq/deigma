# Deigma client

The part of Deigma that runs on your machine: the `deigma` command (`npx deigma init`) and the
editor extension for VS Code and Cursor. It is here so you can read what it reads and what it sends.

**Source available for review only. All rights reserved; see LICENSE.**

## What it reads, what it sends

On your machine it reads the history your coding agents already wrote (Claude Code, Codex) and, in
the editor, how you reviewed an AI suggestion before accepting it: how long it sat, how much you
scrolled, how much you changed. What leaves is counts, timings and tool names (a tool you
configured yourself travels only as a salted hash). Never a prompt, a line of code or a file path.

One exception, and only when you choose it: `deigma task submit` sends the agent session you attach
to a task, after a secret scan and a preview, and only when you confirm.

- Every field that can leave the machine is listed at https://deigma.net/audit. The list is
  generated from `packages/schemas`; `pnpm --filter @mentat/schemas run gen-traffic-audit`
  regenerates it here.
- What is kept, for how long, and who sees it: https://deigma.net/privacy.

## What is here

| Path | What it is |
|---|---|
| `apps/wedge-cli` | the `deigma` command, published on npm as `deigma` |
| `apps/wedge-vscode` | the editor extension (VS Code and Cursor) |
| `packages/wedge-core` | shared by both: reading on the device, secret scanner, PII scrubbing |
| `packages/schemas` | the wire schemas: every event the client can send, and golden fixtures |
| `packages/coach` | the wording rules of the Weekly Pulse the terminal prints |

The workspace packages are named `@mentat/*`, after the project's internal codename. None of them is
published on its own.

## Build and test

Node 22 (see `.node-version`) and pnpm 11 (the `packageManager` field).

```bash
pnpm install --frozen-lockfile
pnpm -r --if-present run typecheck
pnpm test
pnpm --filter deigma run build                # bundles apps/wedge-cli/dist/deigma.js
node apps/wedge-cli/dist/deigma.js --help
pnpm --filter passport run build              # bundles apps/wedge-vscode/dist/extension.js
```

`pnpm deigma help` builds the command and runs it from source. One test reads the Codex sessions on
your own machine when there are any (counts only, nothing is printed); set `CODEX_HOME` to an empty
folder to skip it.

## About this repository

It is synced from a private monorepo, one commit per sync, so its history is the history of syncs
and not of the work behind them. It holds the client only, not the service (the API, the web app,
the scoring). Each sync replaces this tree, so a pull request cannot be merged here as it is. To
report a vulnerability, see [SECURITY.md](SECURITY.md).

Source available for review only. All rights reserved; see LICENSE.
