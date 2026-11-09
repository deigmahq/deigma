// Which coding agent a session was read from, and which practices each agent's journal can show.
//
// Decision 1: the practice index is ONE number per person, pooled over the sessions of every agent
// they use — it is about how a person works with agents, not about one tool.
//
// Decision 2: "cannot be expressed" is not "did not do it". When an agent has no such action, or
// does not write it to its journal, a session of that agent is NO OCCASION of the practice — not a
// miss. This table is part of the definition of the index: the scorer applies it
// (`practice_index.NOT_EXPRESSIBLE`, which travels in `config_hash`) and the device reader applies
// it before a count leaves the machine. The methodology page prints it from here, never from
// literals. A drift test in the monorepo holds the Python copy to this one.
//
// A practice is listed as not expressible for an agent only with its reason, and leaves the list
// when the reason is gone (a parity check on paired sessions, plan rule 3).
import { z } from "zod";

/** The agents a session can be read from. `claude_code` is what every session before schema 2.10
 *  was (the field's default). */
export const AGENTS = ["claude_code", "codex"] as const;
export const Agent = z.enum(AGENTS);
export type Agent = z.infer<typeof Agent>;

/** How a person names the agent. */
export const AGENT_NAMES: Record<Agent, string> = { claude_code: "Claude Code", codex: "Codex" };

/** The practices counted from an agent's session on the device (the `Habits` traces). */
export const DEVICE_PRACTICES = [
  "security_review",
  "dependency_audit",
  "no_secrets",
  "permissions_on",
  "risky_confirmed",
  "tests_after_edit",
  "tests_with_code",
  "saw_diff_before_commit",
  "independent_review",
  "explore_before_edit",
  "plan_complex",
  "memory_alive",
  "clear_goal",
  "one_task",
  "gives_context",
  "located_corrections",
  "names_files",
  "plan_before_edit",
  "diff_before_commit",
] as const;
export type DevicePractice = (typeof DEVICE_PRACTICES)[number];

/** Version of the table below; moves whenever a row is added or removed. */
export const PRACTICE_AGENT_TABLE_VERSION = "pa-1.0" as const;

/**
 * Practices an agent's sessions CANNOT express, each with the reason. Everything not listed is
 * expressible. Claude Code expresses every practice (the rules were written on its journal).
 */
export const NOT_EXPRESSIBLE: Record<Agent, Partial<Record<DevicePractice, string>>> = {
  claude_code: {},
  codex: {
    security_review:
      "Codex has no security-review command and no security-reviewer subagent whose name its journal records, so nothing in a Codex session can say a security review ran.",
    independent_review:
      "Codex records no reviewer subagent, and its /review was not observed in a real session journal; a format not confirmed on a real file is not read, so no Codex session can show a review.",
  },
};

/** Whether a practice can be seen in an agent's sessions. */
export function expressible(agent: Agent, practice: DevicePractice): boolean {
  return !(practice in NOT_EXPRESSIBLE[agent]);
}

/** The table as the scorer holds it: per agent, the sorted keys that are not expressible. */
export function notExpressibleKeys(): Record<Agent, DevicePractice[]> {
  const out = {} as Record<Agent, DevicePractice[]>;
  for (const a of AGENTS) out[a] = (Object.keys(NOT_EXPRESSIBLE[a]) as DevicePractice[]).sort();
  return out;
}

/** "Claude Code", "Codex", "Claude Code and Codex" — the agents a person actually has, in the
 *  fixed order. Empty when there is none (a surface then says nothing about agents). */
export function agentsPhrase(agents: readonly Agent[]): string {
  const names = AGENTS.filter((a) => agents.includes(a)).map((a) => AGENT_NAMES[a]);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
