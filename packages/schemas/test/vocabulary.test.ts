/**
 * The closed list of areas of work and the two names a company gives a task (src/vocabulary.ts).
 * The areas are also checked against the Python that stamps them, by a drift test that reads the
 * data plane and so stays in the monorepo.
 *
 * Held here: the list is the one written down, in the order a page lists it, and its label table
 * covers exactly its list; a company's name and a role's title are refused when they could be an
 * address, a link, markup, a command or a reordering of the text around them. Every table first
 * asserts that its input is not empty.
 */
import { describe, expect, it } from "vitest";

import {
  AREAS,
  AREA_LABELS,
  COMPANY_NAME_MAX,
  ROLE_TITLE_MAX,
  WorkArea,
  CompanyName,
  RoleTitle,
} from "../src/vocabulary";

describe("the lists", () => {
  it("are the ones written down, in the order a page lists them", () => {
    expect([...AREAS]).toEqual([
      "backend_apis",
      "payments",
      "data_sql",
      "event_streaming",
      "infra_ci",
      "distributed_systems",
      "ml_evaluation",
      "frontend",
      "design_systems",
    ]);
  });

  it("have a label for every area, and no label for any other word", () => {
    expect(AREAS.length, "input: the vocabulary is not empty").toBeGreaterThan(0);
    expect(Object.keys(AREA_LABELS)).toEqual([...AREAS]);
    for (const area of AREAS) expect(AREA_LABELS[area].length, area).toBeGreaterThan(0);
  });

  it("accept their own words and nothing else", () => {
    for (const area of AREAS) expect(WorkArea.safeParse(area).success, area).toBe(true);
    for (const word of ["gardening", "Payments", "", "payments "]) {
      expect(WorkArea.safeParse(word).success, JSON.stringify(word)).toBe(false);
    }
  });
});

describe("a company's name", () => {
  it("is anything printable of up to the cap", () => {
    expect(COMPANY_NAME_MAX).toBe(80);
    for (const name of ["Northwind", "Northwind AI, Inc.", "Олена & Co", "x".repeat(COMPANY_NAME_MAX)]) {
      expect(CompanyName.safeParse(name).success, name).toBe(true);
    }
  });

  it.each([
    ["empty", ""],
    ["only spaces", "   "],
    ["over the cap", "x".repeat(COMPANY_NAME_MAX + 1)],
    ["a line break in it", "North\nwind"],
    ["a tab in it", "North\twind"],
  ])("refuses a name that is %s", (_what, name) => {
    expect(CompanyName.safeParse(name).success).toBe(false);
  });
});

describe("a role's title", () => {
  it("is plain words of up to the cap", () => {
    expect(ROLE_TITLE_MAX).toBe(80);
    for (const title of [
      "Senior Backend Engineer",
      "ML Engineer, Evaluation",
      "C++ Developer (Payments)",
      "Олена",
      "x".repeat(ROLE_TITLE_MAX),
    ]) {
      expect(RoleTitle.safeParse(title).success, title).toBe(true);
    }
  });

  it.each([
    ["empty", ""],
    ["only spaces", "   "],
    ["over the cap", "x".repeat(ROLE_TITLE_MAX + 1)],
    ["an address", "write to hr@example.com"],
    ["a link", "see https://example.com"],
    ["a path", "Engineer/Manager"],
    ["a back slash", "Engineer\\Manager"],
    ["markup", "<b>Engineer</b>"],
    ["a quote", 'The "Engineer"'],
    ["a back tick", "Engineer `ls`"],
    ["a dollar", "$(whoami)"],
    ["a semicolon", "Engineer; rm"],
    ["a pipe", "Engineer | Manager"],
    ["braces", "{Engineer}"],
    ["brackets", "[Engineer]"],
    ["an equals sign", "a=b"],
    ["a star", "Engineer*"],
    ["a tilde", "~Engineer"],
    ["a caret", "Engineer^2"],
    ["a line break", "Senior\nEngineer"],
    ["a right-to-left override", "Engineer‮txt.exe"],
    ["a left-to-right mark", "Engineer‎"],
    ["an isolate", "Engineer⁦x"],
  ])("refuses a title with %s", (_what, title) => {
    expect(RoleTitle.safeParse(title).success).toBe(false);
  });
});
