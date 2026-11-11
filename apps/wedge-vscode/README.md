# Deigma

Shows whether you review AI's code before accepting it: whether you read and change a suggestion
first. Never your code.

On [your Deigma](https://deigma.net) it shows as your editor habits: how many AI suggestions you
read before accepting, and how many you changed before keeping. They are counts, not a grade, and
only you see them. They start with your next accepted suggestion, because nobody was recording how a
suggestion was read until something started to. Works in VS Code and Cursor.

## What it reads

How long a draft sat before you accepted it, how much you scrolled, how many edits you made, and
how different the accepted text was from what was suggested. Counts and timings. For a repository
you connected on deigma.net, also its numeric id and the branch you are on, read from the
repository's own files, so the suggestion can be tied to the work it belongs to; for any other
repository, neither. Drafts are hashed with a random salt made on this machine and kept in the
editor's secret storage, so a hash means nothing to anyone else.

Never the draft, never your code, never a file path, never the repository's address. A secret scanner runs on the device before
anything is emitted, and a hit blocks the whole event rather than redacting part of it.

`Deigma: pause collection` stops it at any time. The status bar says how many AI suggestions were
read and that no code was sent; `Deigma: what it reads` shows the same, with the secret scanner's
count in the tooltip.

## Source

The code is public: [github.com/deigmahq/deigma](https://github.com/deigmahq/deigma). Read what
it reads and what it sends before you add it.

## Connecting

**Deigma: Connect** from the command palette, or a click on `Deigma: not connected` in the status
bar, connects it. The editor shows a short code and offers to open deigma.net/device with it
filled in; approve it there when the two codes match. The session is kept in the editor's secret
storage (the OS keychain), and the extension reads nothing until it has one.

**Deigma: Disconnect** forgets the session on this machine and revokes the editor's sign-in on
deigma.net. The CLI's sign-in (`npx deigma init`) is separate and stays as it is.
