// The model on a wedge event (schema 2.4, audit 2026-10-09 #2): a model read from an observation
// with a generation DERIVED from its name, or an explicit "not known" — never a placeholder.
import { ModelInfo, ModelNotKnown, ReportedModel, SessionSummaryEvent } from "@mentat/schemas";
import { describe, expect, it } from "vitest";

import { buildSessionSummary, claudeGeneration, MODEL_NOT_KNOWN, modelFromId, newDeviceSalt } from "../src";

describe("the generation mapping", () => {
  it.each([
    // shapes confirmed on this machine's journals, 2026-10-09
    ["claude-opus-5", "claude-5"],
    ["claude-opus-5-5", "claude-5.5"],
    ["claude-fable-5", "claude-5"],
    // Anthropic's documented ids, both naming schemes
    ["claude-sonnet-4-5-20250929", "claude-4.5"],
    ["claude-opus-4-1-20250805", "claude-4.1"],
    ["claude-sonnet-4-20250514", "claude-4"],
    ["claude-3-5-sonnet-20241022", "claude-3.5"],
    ["claude-3-opus-20240229", "claude-3"],
  ])("%s -> %s", (id, tag) => {
    expect(claudeGeneration(id)).toBe(tag);
    expect(modelFromId(id)).toEqual({ family: "claude", name: id, generation_tag: tag });
  });

  it("a claude-… name outside Anthropic's two schemes is not known — an alias is not a model (S1)", () => {
    for (const alias of [
      "claude-latest",
      "claude-acme-billing-migration",
      "claude-opus-acme",
      "claude-gateway-5",
      "claude-opus-5-5-20251101-acme",
      "claude-3-5-sonnet",
    ]) {
      expect(modelFromId(alias), alias).toEqual(MODEL_NOT_KNOWN);
    }
  });

  it("the tag moves with the name: two generations never share one", () => {
    expect(modelFromId("claude-opus-5")?.generation_tag).not.toBe(modelFromId("claude-opus-5-5")?.generation_tag);
  });
});

describe("the allow-list", () => {
  it.each([
    [null],
    [undefined],
    [""],
    ["<synthetic>"], // the journal's own marker for a record no model produced
    ["acme-billing-gpt"], // a name somebody chose — an employer on the wire
    ["us.anthropic.claude-sonnet-4-20250514-v1:0"], // never seen on a real journal
    ["claude-sonnet-4@20250514"],
    ["gpt-5-acme"], // a gateway alias: not one of OpenAI's tier names
    ["gpt-5.5-sol-billing"],
    ["gpt5"],
    [`claude-${"x".repeat(80)}`],
  ])("%s is not known", (id) => {
    expect(modelFromId(id as string | null | undefined)).toEqual(MODEL_NOT_KNOWN);
  });
});

describe("OpenAI's naming, for Codex (schema 2.10)", () => {
  it.each([
    ["gpt-5.5-sol", "gpt-5.5"], // the shape confirmed on a real Codex journal
    ["gpt-5", "gpt-5"],
    ["gpt-5-codex", "gpt-5"],
    ["gpt-5.1-codex-max", "gpt-5.1"],
    ["GPT-5.1-Codex-Mini", "gpt-5.1"],
  ])("%s is reported, generation %s", (id, generation) => {
    expect(modelFromId(id)).toEqual({ family: "gpt", name: id.toLowerCase(), generation_tag: generation });
  });
});

describe("the wire", () => {
  const session = (model: ModelInfo) =>
    buildSessionSummary({
      userId: "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c",
      salt: newDeviceSalt(),
      model,
      sessionId: "s1",
      prompts: [],
      toolCalls: {},
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
      iterations: 0,
      env: { mcpTools: [], projectInstructionsLoaded: false, reusableSkillCalls: 0 },
    });

  it("a reported model and 'not known' are different shapes, and neither is the other", () => {
    const reported = session(modelFromId("claude-opus-5-5")).model;
    const unknown = session(MODEL_NOT_KNOWN).model;
    expect(ReportedModel.safeParse(reported).success).toBe(true);
    expect(ModelNotKnown.safeParse(reported).success).toBe(false);
    expect(ModelNotKnown.safeParse(unknown).success).toBe(true);
    expect(ReportedModel.safeParse(unknown).success).toBe(false);
  });

  it("'not known' cannot carry a model", () => {
    expect(ModelNotKnown.safeParse({ ...MODEL_NOT_KNOWN, name: "claude-opus-5" }).success).toBe(false);
    expect(ModelNotKnown.safeParse({ ...MODEL_NOT_KNOWN, generation_tag: "2026H2" }).success).toBe(false);
  });

  it("no builder fills in a model: the old placeholder is gone", () => {
    const noModel = () => session(undefined as unknown as ModelInfo);
    expect(noModel).toThrow();
    for (const m of [modelFromId("claude-opus-5"), MODEL_NOT_KNOWN]) {
      expect(JSON.stringify(session(m).model)).not.toContain("2026H2");
    }
    expect(SessionSummaryEvent.safeParse({ ...session(MODEL_NOT_KNOWN), model: undefined }).success).toBe(false);
  });
});
