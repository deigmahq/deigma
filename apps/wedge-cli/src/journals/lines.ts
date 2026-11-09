/**
 * Line-by-line reading of a journal file, in bounded memory (SR2 defect D4).
 *
 * The first reader took a transcript with `readFileSync` and split it — the whole file as one
 * string, then an array of every line beside it. Measured 2026-10-09 the largest transcript on a
 * real machine was 111 MB; as a JavaScript string that is up to twice that (UTF-16), plus the
 * array of lines, which is past the wedge's 300 MB budget on ONE file. This reads a fixed-size
 * chunk at a time and hands out whole lines, so what is held at once is one chunk plus the line
 * being assembled — whatever the size of the file.
 *
 * Synchronous on purpose: the readers that use it are synchronous CPU work that already runs in
 * its own low-priority process (`deigma sync`) or behind the person's explicit `deigma history`,
 * and an async rewrite of every caller would buy nothing but a larger diff.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** Bytes read per call. A constant of the reader, not of any measurement. */
export const LINE_CHUNK_BYTES = 1 << 20;

/**
 * Calls `onLine` with every line of `file`, in order, without its newline. `onLine` may return
 * `false` to stop early. Returns false when the file could not be opened or read — the caller
 * decides what an unreadable file means (for a subagent: nothing; for a session: no session).
 */
export function forEachLine(
  file: string,
  onLine: (line: string) => boolean | void,
  chunkBytes: number = LINE_CHUNK_BYTES,
): boolean {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return false;
  }
  const buffer = Buffer.allocUnsafe(chunkBytes);
  // A UTF-8 character split across two chunks is held back by the decoder, never mangled.
  const decoder = new StringDecoder("utf8");
  let carry = "";
  try {
    for (;;) {
      const n = readSync(fd, buffer, 0, chunkBytes, null);
      if (n === 0) break;
      const text = carry + decoder.write(buffer.subarray(0, n));
      let start = 0;
      for (let nl = text.indexOf("\n", start); nl !== -1; nl = text.indexOf("\n", start)) {
        if (onLine(text.slice(start, nl)) === false) return true;
        start = nl + 1;
      }
      carry = text.slice(start);
    }
    carry += decoder.end();
    if (carry) onLine(carry);
    return true;
  } catch {
    return false;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
}
