/** The closed review vocabulary and the device-local project hash (src/environment/names.ts). */
import { describe, expect, it } from "vitest";

import { matchesAny, projectHash, REVIEWER_WORDS } from "../src/environment/names";

describe("review vocabulary", () => {
  it("is exactly the three words the spec names", () => {
    expect(REVIEWER_WORDS).toEqual(["review", "security", "test"]);
  });

  it("matches a name on those words and on nothing else", () => {
    expect(matchesAny("code-reviewer", REVIEWER_WORDS)).toBe(true);
    expect(matchesAny("Security-Audit", REVIEWER_WORDS)).toBe(true);
    expect(matchesAny("test-runner", REVIEWER_WORDS)).toBe(true);
    expect(matchesAny("Explore", REVIEWER_WORDS)).toBe(false);
    expect(matchesAny("qa-helper", REVIEWER_WORDS)).toBe(false);
  });
});

describe("projectHash", () => {
  it("hashes the project with the device salt, so two salts never agree", () => {
    expect(projectHash("/w/project", "salt-a")).toMatch(/^[0-9a-f]{12}$/);
    expect(projectHash("/w/project", "salt-a")).not.toBe(projectHash("/w/project", "salt-b"));
    expect(projectHash("/w/project", "s")).not.toBe(projectHash("/w/other", "s"));
  });
});
