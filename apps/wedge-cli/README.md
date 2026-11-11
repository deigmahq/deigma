# deigma

Deigma reads what you shipped on GitHub and how you work with agents, and builds your track
record. You choose when to share it. This is its terminal.

```bash
npx deigma init
```

It runs on Node.js 22 or newer (npx comes with it). In Windows PowerShell, type `npx.cmd deigma init`:
PowerShell does not run npx's own script unless scripts are allowed there.

That is the whole thing. Sign in from your terminal; your sessions go to your Deigma. It signs you
in through GitHub's device flow (so it works over SSH, with no local browser needed), and then
reads the history the agents on your machine have already written — how long sessions ran, how
many rounds they took, which tools they called.

Nothing is read, kept or sent before you sign in. Every command run while signed out says how to
sign in and stops; `deigma proxy` runs your MCP server exactly as if Deigma were not there and
records nothing. After sign-in everything is tied to your account: a session that could not be
sent when it ended waits on this machine (for up to 72 hours) and goes with the next command.
`deigma logout` ends the sign-in here and on the server, and drops what had not been sent.

## What leaves your machine

Counts and durations. Never a prompt, never a line of code, never a file path.

Two of those counts deserve naming, because the difference between them is the difference between
a measurement and a vanity number. `requests` counts API calls — including the retries and
continuations your tool makes on its own — and nothing about your skill is computed from it.
`human_prompts` counts the turns you typed, and that is the one shown to you as a fact.

Your habits with agents are counted here, on your machine, by public rules (`hb-1.0`): whether a
plan came before the agent's first edit, whether you looked at the changes before a commit, whether
a prompt named the files, whether a correction pointed at a place. Only pairs of counts leave —
never the prompt, the file name or the change — and only you see them on your Deigma.

Tool names travel as an allow-list: the built-in ones as themselves, and anything you configured —
an MCP server, a tool of your own — only as a salted hash made on your machine, so the name stays
there. The full list of what is collected is on the
[traffic audit page](https://deigma.net/audit), and it is generated from the code rather than
written beside it.

Your branch is sent only for repositories you have connected. Everywhere else neither the branch
nor the repository is sent at all, and the session arrives unattached — a name with nothing to
resolve against is a name with no reason to travel.

## Commands

`npx deigma help` lists every command in a line each. When `init` signs you in, press Enter to open the sign-in page in your browser; the link and the code are printed too.

| | |
|---|---|
| `deigma init` | connect, read your Claude Code and Codex history once, and add one SessionEnd hook (and a Codex `notify` entry where `notify` is free) so new sessions are read as they end |
| `deigma init --no-history` | connect without reading anything local |
| `deigma init --no-hook` | connect without adding the hook or the Codex notify entry |
| `deigma history` | read it again, after connecting more repositories |
| `deigma status` | your Deigma: your practice index, what has been read and what is proven |
| `deigma pulse` | this week, in the terminal: the index, its movement and your next step |
| `deigma proxy -- <mcp-server>` | run an MCP server through Deigma, so new sessions count |
| `deigma sync` | read the Claude Code and Codex sessions that finished since the last read (the hook and the proxy do this by themselves) |
| `deigma whoami` | which account this machine is signed in as |
| `deigma logout` | sign this machine out and remove the hook and the notify entry; nothing more is read or sent |

After you connect, sessions are read as they finish — a session ends when it has been idle for
four hours. `init` adds one entry to `~/.claude/settings.json`: when a Claude Code session ends, it
starts `deigma sync` in the background (nothing else in the file is touched, a file that does not
parse is left alone, `--no-hook` skips it and `logout` removes it). Codex has no such hook, only
one `notify` program in `~/.codex/config.toml`: where that place is free, `init` puts a quiet
background `deigma sync` there, at most once an hour, and says so; where you already run a notify
program it is left alone, and Codex sessions are read by `sync`, `status` and `pulse`.

Codex sessions are read from Codex's own journal on your machine (`~/.codex/sessions`, or
`$CODEX_HOME`, plain `.jsonl` or compressed `.jsonl.zst`) by the same rules as Claude Code's,
into the same practice index. Two practices cannot be seen in a Codex journal — a security review
and a second review of a large change — and a Codex session is simply not an occasion of them,
never a miss. Codex tasks run in the cloud are not on your machine and are not read. `deigma status` and `pulse` start
a sync too, and so does `deigma proxy` while it runs, at most every fifteen minutes; none of them
waits for it. Only sessions that ended after you connected are
read this way; what came before is the history `init` reads, or does not with `--no-history`.
The model a session ran on is sent as your agent's log names it (`claude-opus-5`, `gpt-5.5-sol`), with
its generation (`claude-5`, `gpt-5.5`), and only for names on a fixed list; anything else is sent as "not
known". When the log links the session to exactly one pull request in a repository you
connected, that pull request's number is sent beside the branch, so the session is tied to it rather than guessed
from the branch and the day.

Your tools never wait on Deigma: if anything of ours breaks — ingestion unreachable, a timeout, a
bug — your tool call passes through untouched and the telemetry for it is dropped. Telemetry is
never more important than your tools working.

## Where it talks to

`https://api.deigma.net` by default, and it points you at `https://deigma.net` to see what was
read. `MENTAT_API_URL` and `MENTAT_WEB_URL` override them, which is how the project's own
acceptance stand runs.
