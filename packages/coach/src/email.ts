// The Weekly Pulse as an email (Playbook §3.1). Same facts, same speech rules, same renderer as
// the terminal — only the wrapper differs. An email that said more than the CLI would be a second
// implementation of the rules, and the rules are the product.

import type { Pulse } from "./pulse";
import { renderPulse } from "./pulse";
import type { CoachLine } from "./coach";

export type PulseEmail = {
  to: string;
  subject: string;
  text: string;
  /** Minimal HTML: the pulse is a plain-text product, the HTML is a courtesy. */
  html: string;
  /** RFC 2369 / RFC 8058: the mail client's own "Unsubscribe" button, one click, no sign-in. */
  headers: { "List-Unsubscribe": string; "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
};

/** The footer line the link sits on, in both the text and the HTML part. */
export const UNSUBSCRIBE_LABEL = "Stop the Weekly Pulse (one click):";

export function renderPulseEmail(input: {
  handle: string;
  email: string;
  pulse: Pulse;
  coachLines?: CoachLine[];
  webBaseUrl: string;
  /** A link that forgets the address in one click, bound to this person. Required: a pulse
   *  without a way out of it is not sent. */
  unsubscribeUrl: string;
}): PulseEmail | null {
  // (c) an empty week is skipped, not reported as a zero — including by email.
  if (input.pulse.skipped) return null;
  const body = renderPulse(input.pulse);
  // The pulse body already carries the practice index; the coach's copy of it would say it twice.
  const coach = (input.coachLines ?? []).filter((l) => l.topic !== "practice").map((l) => l.text);
  const lines = [
    `Your week on Deigma, @${input.handle}`,
    "",
    body,
    ...(coach.length ? ["", ...coach] : []),
    "",
    // The owner's own page. It pointed at the public profile, which answers 404 while a profile is
    // private — the default — so the one link in the email led most readers nowhere (audit
    // 2026-10-29). /dashboard asks a signed-out reader to sign in and then opens it.
    `Your Deigma: ${input.webBaseUrl}/dashboard`,
    "You get this because you asked for it in Settings.",
  ];
  const footer = `${UNSUBSCRIBE_LABEL} ${input.unsubscribeUrl}`;
  const text = [...lines, footer].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;color:#24262b">${lines
    .map((l) => (l ? `<p style="margin:0 0 8px">${escapeHtml(l)}</p>` : "<br/>"))
    .join("")}<p style="margin:0 0 8px"><a href="${escapeHtml(input.unsubscribeUrl)}">${escapeHtml(
    "Stop the Weekly Pulse",
  )}</a> &middot; one click, no sign-in</p></div>`;
  return {
    to: input.email,
    // Site copy v4 §2: "Your week on Deigma — …"; the product is "your Deigma", not a passport.
    subject: `Your week on Deigma — ${firstLine(body)}`,
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${input.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

function firstLine(body: string): string {
  return body.split("\n")[1] ?? body.split("\n")[0] ?? "your week";
}

function escapeHtml(text: string): string {
  return text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c);
}
