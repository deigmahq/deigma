// Local-only guards that run BEFORE anything is measured (collector §2).
//
// Two different jobs, deliberately separate:
//   * `scanForSecrets` decides whether an event may exist at all — a hit blocks the whole event,
//     because a secret that reached a draft may also be encoded in the metrics of that draft;
//   * `scrubPii` removes personal data from any text before it is measured, so that features are
//     computed on a scrubbed copy.
//
// Both are conservative: false positives cost one dropped event, false negatives cost the
// invariant.

export class SecretFoundError extends Error {
  constructor(readonly kinds: string[]) {
    super(`secret scanner blocked the event (${kinds.join(", ")})`);
    this.name = "SecretFoundError";
  }
}

type SecretRule = { kind: string; re: RegExp };

const SECRET_RULES: SecretRule[] = [
  { kind: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "openai_key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { kind: "private_key_block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { kind: "url_credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i },
  // generic "assignment of a long opaque literal to a secret-looking name"
  {
    kind: "assigned_secret",
    re: /\b(?:secret|token|passwd|password|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*[:=]\s*["'`][^"'`\n]{16,}["'`]/i,
  },
];

/** Kinds of secret found in the text (empty = clean). Never returns the matched value. */
export function scanForSecrets(text: string): string[] {
  return SECRET_RULES.filter((r) => r.re.test(text)).map((r) => r.kind);
}

/** Throws when the text carries a secret: the caller must drop the whole event. */
export function assertNoSecrets(...texts: Array<string | null | undefined>): void {
  const kinds = [...new Set(texts.filter(Boolean).flatMap((t) => scanForSecrets(t as string)))];
  if (kinds.length > 0) throw new SecretFoundError(kinds);
}

const PII_RULES: Array<[RegExp, string]> = [
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[email]"],
  [/\b(?:\+?\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{3}[ .-]?\d{4}\b/g, "[phone]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
  [/\bAAAA[A-Za-z0-9+/]{20,}={0,2}\b/g, "[key-material]"],
  [/\bhttps?:\/\/\S+/g, "[url]"],
];

/** Replaces personal data with stable placeholders. Applied to any text before it is measured. */
export function scrubPii(text: string): string {
  return PII_RULES.reduce((acc, [re, placeholder]) => acc.replace(re, placeholder), text);
}
