// The terminal and the pulse email name each claim with the web's words: one list
// (@mentat/schemas CLAIM_NAMES), set as a title here. They had drifted — the security claim was
// "ships without an incident" on the web and "Security hygiene" in the terminal.
import { CLAIM_NAMES, ClaimKey } from "@mentat/schemas";
import { describe, expect, it } from "vitest";

import { CLAIM_TITLES } from "../src/words";

describe("claim titles", () => {
  it("are the shared names, each as a title, for every claim the engine has", () => {
    const keys = ClaimKey.options;
    expect(keys.length, "input: the engine names claims").toBeGreaterThan(0);
    for (const key of keys) {
      const name = CLAIM_NAMES[key];
      expect(name, `${key} has no shared name`).toBeTruthy();
      expect(CLAIM_TITLES[key]).toBe(name.charAt(0).toUpperCase() + name.slice(1));
    }
  });

  it("call the claim by what it means to a person", () => {
    expect(CLAIM_TITLES.decisions_by_others).toBe("Accepted by other people");
  });
});
