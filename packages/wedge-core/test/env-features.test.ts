// Core 7: E-1.1 (project equipping) was retired. The wedge emits E-1.0 alone, and the three
// E-1.1 keys are absent from its output altogether (the schema still accepts them from old clients).
import { describe, expect, it } from "vitest";

import { envFeatures } from "../src/features";

describe("envFeatures", () => {
  it("speaks E-1.0 and carries no E-1.1 key", () => {
    const env = envFeatures({ mcpTools: ["a", "b"], projectInstructionsLoaded: true, reusableSkillCalls: 1 });
    expect(env.e_definition_version).toBe("E-1.0");
    expect(env.mcp_tool_count).toBe(2);
    for (const key of ["project_hash", "components_configured", "components_used"]) {
      expect(Object.keys(env)).not.toContain(key);
    }
  });
});
