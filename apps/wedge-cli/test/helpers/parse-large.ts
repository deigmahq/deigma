// Run in a child process by reader-2.test.ts: parses one transcript and reports the process's
// PEAK resident memory, so the budget is measured on the reader alone and not on the test runner.
import { parseTranscript } from "../../src/journals/claude-code";

const file = process.argv[2];
if (!file) throw new Error("usage: parse-large <transcript>");
const sessions = parseTranscript(file);
// maxRSS is in kilobytes on every platform Node supports.
const peakMb = process.resourceUsage().maxRSS / 1024;
process.stdout.write(
  JSON.stringify({ sessions: sessions.length, humanPrompts: sessions.reduce((a, s) => a + s.humanPrompts, 0), peakMb }),
);
