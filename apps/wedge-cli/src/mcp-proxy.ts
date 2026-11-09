// MCP proxy: the CLI sits between the coding agent and its MCP servers, reads the JSON-RPC
// *metadata* of the traffic (method names, tool names, timings, token counts) and emits one
// `session.summary` per closed session (collector §1, §3.2, §4).
//
// It never reads arguments or results: the proxy forwards frames verbatim and only inspects the
// envelope fields it is allowed to (collector §2). Prompt text, when the agent reports it, is
// turned into features locally by wedge-core and dropped.
//
// And it FAILS OPEN (Playbook v1.7 §2, CLAUDE.md). The proxy stands in the critical path of
// somebody's daily work: ingestion being unreachable, a hanging request or a bug of ours must
// mean the call is forwarded unchanged, within the same latency budget, and the telemetry for
// that call is dropped. Telemetry is never worth a broken session.

import { buildSessionSummary, MODEL_NOT_KNOWN, requireDeviceSalt, type EnvInputs } from "@mentat/wedge-core";

import { matchesAny, REVIEWER_WORDS } from "./environment/names";
import { SESSION_IDLE_GAP_HOURS } from "./measurement";
import { wireToolCalls } from "./vocabulary";
import type { ModelInfo, SessionSummaryEvent } from "@mentat/schemas";

/** The subset of a JSON-RPC frame the proxy is allowed to look at. */
export type RpcFrame = {
  method?: string;
  params?: { name?: string; _meta?: { promptText?: string; tokensIn?: number; tokensOut?: number } };
  result?: { isError?: boolean };
  id?: string | number;
};

export type SessionState = {
  sessionId: string;
  startedAt: number;
  prompts: string[];
  toolCalls: Record<string, number>;
  tokensIn: number;
  tokensOut: number;
  iterations: number;
  mcpTools: Set<string>;
  projectInstructionsLoaded: boolean;
  reusableSkillCalls: number;
  /** When this session last saw a frame — the only thing a boundary can be read from. */
  lastActivityAt: number;
  // --- schema 2.2. The live path states the same facts the backfill does, or the two emitters
  // would answer the same claim in two different units.
  /** PtL-1.0: verification runs before landing, by category. Counted, not yet scored. */
  verificationRuns: Record<VerificationCategory, number>;
};

type VerificationCategory = "test" | "build" | "lint" | "review";

/**
 * Whether a session has ended (B4.1, B4.3).
 *
 * The unit has ONE definition, shared with the local-log backfill through
 * `SESSION_IDLE_GAP_HOURS`: two emitters using two rules would make a claim measured in "sessions"
 * mix two units, and its interval would be a lie. Four hours, chosen by measurement on 45 days of
 * real transcripts — the table is in the data plane's measurement configuration.
 *
 * Stated as a predicate rather than a timer on purpose: a wedge that keeps a process alive to
 * close a session is a wedge that outlives the tool it is measuring. The host asks on the next
 * frame, or when it shuts down.
 */
export function sessionEnded(
  state: SessionState,
  now: number,
  gapHours: number = SESSION_IDLE_GAP_HOURS,
): boolean {
  return now - state.lastActivityAt > gapHours * 3600_000;
}

export function newSession(sessionId: string, startedAt = Date.now()): SessionState {
  return {
    sessionId,
    startedAt,
    lastActivityAt: startedAt,
    prompts: [],
    toolCalls: {},
    tokensIn: 0,
    tokensOut: 0,
    iterations: 0,
    mcpTools: new Set(),
    projectInstructionsLoaded: false,
    reusableSkillCalls: 0,
    verificationRuns: { test: 0, build: 0, lint: 0, review: 0 },
  };
}

/** Folds one frame into the session state. Returns the same object for cheap streaming use. */
export function observe(state: SessionState, frame: RpcFrame, at = Date.now()): SessionState {
  state.lastActivityAt = at;
  const meta = frame.params?._meta;
  if (meta?.tokensIn) state.tokensIn += meta.tokensIn;
  if (meta?.tokensOut) state.tokensOut += meta.tokensOut;
  // The prompt text is kept in memory only long enough to be turned into features on close.
  if (meta?.promptText) {
    state.prompts.push(meta.promptText);
    state.iterations += 1;
  }
  switch (frame.method) {
    case "tools/call": {
      const tool = frame.params?.name;
      if (tool) {
        state.toolCalls[tool] = (state.toolCalls[tool] ?? 0) + 1;
        state.mcpTools.add(tool);
        // E-1.0 (collector §4): reusable skills/commands are their own component
        if (/^(skill|command|prompt)[/:.]/.test(tool)) {
          state.reusableSkillCalls += 1;
        }
        // PtL-1.0's `review` category: a reviewing subagent by name from the closed vocabulary.
        // The tool's arguments are not read.
        if (matchesAny(tool, REVIEWER_WORDS)) state.verificationRuns.review += 1;
      }
      break;
    }
    case "prompts/get":
      state.reusableSkillCalls += 1;
      break;
    case "resources/read": {
      // The fact that project instructions were loaded, never their content (collector §4).
      const name = frame.params?.name ?? "";
      if (/(^|\/)(claude\.md|\.cursorrules|agents\.md|copilot-instructions\.md)$/i.test(name)) {
        state.projectInstructionsLoaded = true;
      }
      break;
    }
    default:
      break;
  }
  return state;
}

export function closeSession(
  state: SessionState,
  identity: {
    userId: string;
    /** The device salt (device.json). Required: an upstream server's tool names are named by
     *  whoever runs it, and they travel only as salted hashes (./vocabulary). */
    salt: string;
    branch?: string;
    repoId?: number;
    prNumber?: number;
    /** The proxy sees MCP frames, which never name the model: absent means `MODEL_NOT_KNOWN`. */
    model?: ModelInfo;
  },
  endedAt = Date.now(),
): SessionSummaryEvent {
  const env: EnvInputs = {
    mcpTools: [...state.mcpTools],
    mcpToolCalls: Object.values(state.toolCalls).reduce((a, b) => a + b, 0),
    projectInstructionsLoaded: state.projectInstructionsLoaded,
    reusableSkillCalls: state.reusableSkillCalls,
  };
  // `habits` is deliberately absent on the live path (null on the wire = not observed): the proxy
  // sees MCP traffic, not the agent's own tool calls, permission mode, shell commands or git, which
  // is what the hb-2.0 traces (practice index) are counted from. They arrive from the journal
  // reader (`journals/claude-code.ts`), which reads the same session after the fact.
  return buildSessionSummary({
    humanPrompts: state.prompts.length,
    verificationRuns: state.verificationRuns,
    userId: identity.userId,
    source: "wedge_cli",
    tool: { name: "deigma-cli", version: "0.1.0" },
    model: identity.model ?? MODEL_NOT_KNOWN,
    salt: requireDeviceSalt(identity.salt),
    sessionId: state.sessionId,
    prompts: state.prompts,
    // The live path used to put `state.toolCalls` on the wire as it was — the upstream server's
    // own tool names, `mcp__acme-billing__query` included — while the backfill hashed the same
    // names (./vocabulary). One rule for both emitters (2026-10-09).
    toolCalls: wireToolCalls(state.toolCalls, identity.salt),
    tokensIn: state.tokensIn,
    tokensOut: state.tokensOut,
    durationMs: Math.max(0, endedAt - state.startedAt),
    iterations: state.iterations,
    env,
    ...(identity.branch ? { branch: identity.branch } : {}),
    ...(identity.repoId ? { repoId: identity.repoId } : {}),
    ...(identity.prNumber ? { prNumber: identity.prNumber } : {}),
  });
}
