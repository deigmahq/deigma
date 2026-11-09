/**
 * What a tool may be called on the wire, and the drift check behind the session boundary.
 *
 * The leak this closes is small in bytes and large in kind: `tool_calls` is keyed by tool name,
 * built-in names say nothing about anybody, and an MCP name like `mcp__acme-billing__query` is an
 * employer and an internal system riding in the packet. Zero Content Leakage covers that as much
 * as it covers a prompt.
 */
import { describe, expect, it } from "vitest";

import { isBuiltInTool, wireToolCalls, wireToolName } from "../src/vocabulary";

const SALT = "a-device-salt";

describe("tool names on the wire", () => {
  it("lets a built-in name travel as itself", () => {
    expect(wireToolName("Bash", SALT)).toBe("Bash");
    expect(wireToolName("Read", SALT)).toBe("Read");
    expect(isBuiltInTool("Skill")).toBe(true);
  });

  it("hashes an MCP name, so no server or employer travels", () => {
    const wire = wireToolName("mcp__acme-billing__query", SALT);
    expect(wire).toMatch(/^tool:[0-9a-f]{12}$/);
    expect(wire).not.toContain("acme");
    expect(wire).not.toContain("billing");
  });

  it("is an allow-list, so a name nobody has thought of yet is hashed too", () => {
    /** The reason this is not a `startsWith("mcp__")` filter: the next release adds a tool, and a
     *  deny-list protects only against the names somebody already thought of. */
    expect(wireToolName("SomeToolAddedNextYear", SALT)).toMatch(/^tool:[0-9a-f]{12}$/);
    expect(wireToolName("mcp__x__y", SALT)).toMatch(/^tool:/);
  });

  it("keeps the counts and the diversity, and loses only the dictionary", () => {
    const calls = { Bash: 12, Read: 3, mcp__acme__a: 5, mcp__acme__b: 1, mcp__other__c: 2 };
    const wire = wireToolCalls(calls, SALT);
    // Same number of distinct tools — which is what E-1.0's diversity component counts.
    expect(Object.keys(wire)).toHaveLength(5);
    // Same total — which is what the pipeline actually reads (`sum(tool_calls.values())`).
    expect(Object.values(wire).reduce((a, b) => a + b, 0)).toBe(23);
    expect(wire.Bash).toBe(12);
    expect(JSON.stringify(wire)).not.toContain("acme");
  });

  it("gives one name one token, stably, and different names different ones", () => {
    /** Stability is what makes counting work across sessions; distinctness is what keeps two
     *  tools from merging into one and inventing diversity that is not there. */
    expect(wireToolName("mcp__a__b", SALT)).toBe(wireToolName("mcp__a__b", SALT));
    expect(wireToolName("mcp__a__b", SALT)).not.toBe(wireToolName("mcp__a__c", SALT));
  });

  it("gives the same name different tokens on different devices", () => {
    /** The salt is per-device and never leaves it. Without that, a hash is not protection — it is
     *  a dictionary anybody can rebuild by hashing the names they guess. */
    expect(wireToolName("mcp__a__b", SALT)).not.toBe(wireToolName("mcp__a__b", "other-device"));
  });
});
