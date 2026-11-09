// Practice index pi-1.2: the three communication traces (hb-2.1), counted on the device from the
// person's own typed prompts. A truth table per rule (English, Russian, Ukrainian), then a planted
// transcript: the counts come out right and no prompt word reaches the wire.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MODEL_NOT_KNOWN, buildSessionSummary } from "@mentat/wedge-core";
import { describe, expect, it } from "vitest";

import { parseTranscript } from "../src/journals/claude-code";
import { type HabitMoment, habitsOf, promptFacts } from "../src/journals/habits";

const T0 = Date.parse("2026-10-01T10:00:00Z");
const at = (min: number) => T0 + min * 60_000;
const base: Omit<HabitMoment, "at"> = { prompt: null, touched: null, agentEdit: false, commit: false, planMode: false };
const typed = (min: number, text: string): HabitMoment => ({ ...base, at: at(min), prompt: promptFacts(text) });
const clear = (min: number): HabitMoment => ({ ...base, at: at(min), clear: true });

describe("clear_goal: the prompt states what done looks like", () => {
  const yes = [
    "add a retry to the fetch helper so that it returns the cached value when the network is down",
    "fix the parser; it should return an empty list for blank input",
    "implement pagination, expected output is 20 items per page",
    "refactor the cart module until the tests pass",
    "write a test for the discount rule and make it pass",
    "update the config loader. Example: input 'a=1' gives {a: 1}",
    "добавь кэш в загрузчик, функция должна вернуть тот же объект при повторном вызове",
    "исправь парсер, чтобы тесты проходили",
    "реализуй пагинацию, ожидаю 20 элементов на странице",
    "напиши тест для скидки и сделай чтобы тесты проходили",
    "виправ парсер, він має повертати порожній список для порожнього вводу",
    "додай кеш у завантажувач, очікується той самий об'єкт",
    "зроби пагінацію так, щоб тести проходили",
  ];
  const no = [
    // hb-2.2: "verify that…" was half of clear_goal's false positives on hand-check (review).
    "fix the login redirect and verify that the session cookie is set",
    "add a retry to the fetch helper",
    "refactor the cart module",
    "fix the login redirect",
    "добавь кэш в загрузчик",
    "исправь парсер",
    "виправ парсер",
    "make it better and faster",
  ];
  it("hits", () => {
    for (const t of yes) {
      const f = promptFacts(t);
      expect(f.work, `work: ${t}`).toBe(true);
      expect(f.clearGoal, t).toBe(true);
    }
  });
  it("misses", () => {
    for (const t of no) {
      const f = promptFacts(t);
      expect(f.work, `work: ${t}`).toBe(true);
      expect(f.clearGoal, t).toBe(false);
    }
  });
  it("a greeting, an acknowledgement or a slash command is not work and opens no occasion", () => {
    for (const t of ["ok", "thanks, continue", "да, продолжай", "/help", "привіт"]) {
      const f = promptFacts(t);
      expect(f.work, t).toBe(false);
      expect(f.clearGoal, t).toBe(false);
      expect(f.givesContext, t).toBe(false);
      expect(f.oneTask, t).toBeNull();
    }
  });
  it("occasion: the first work prompt of the session, and again the first after each /clear", () => {
    const h = habitsOf([
      typed(0, "ok"), // not work: the occasion waits
      typed(1, "fix the parser"), // opening prompt, no goal: miss
      typed(2, "now make it faster, it should return in under 5ms"), // not an opening prompt
      clear(3),
      typed(4, "fix the router until the tests pass"), // after /clear, goal: hit
      typed(5, "rename the helper"),
      clear(6), // a /clear with no work after it opens no occasion
    ]);
    expect(h.clear_goal).toEqual({ opportunities: 2, hits: 1 });
  });
  it("a session with no work prompt has no occasion", () => {
    expect(habitsOf([typed(0, "ok"), typed(1, "thanks")]).clear_goal).toBeNull();
  });
});

describe("one_task: a work prompt of 15+ words does not bundle unrelated asks", () => {
  const long = "please look at the module and make the following change carefully without touching anything else around it";
  it("shorter than 15 words is not an occasion", () => {
    expect(promptFacts("fix billing.ts and also update docs.md and also rename api.ts").oneTask).toBeNull();
  });
  it("one ask, however long, is one task", () => {
    expect(promptFacts(`${long} in billing.ts`).oneTask).toBe(true);
    expect(promptFacts("исправь ошибку округления в функции расчёта скидки так, чтобы итог считался по строкам заказа, а не по всему заказу целиком в billing.ts").oneTask).toBe(true);
  });
  it("three enumerated asks across different files is a bundle", () => {
    expect(promptFacts("Please do these:\n1. fix the rounding in billing.ts\n2. add a retry to client.ts\n3. update the docs in README.md").oneTask).toBe(false);
    expect(promptFacts("Сделай, пожалуйста, три вещи:\n- исправь округление в billing.ts\n- добавь повтор в client.ts\n- обнови описание в README.md").oneTask).toBe(false);
    expect(promptFacts("Зроби, будь ласка, три речі:\n- виправ округлення в billing.ts\n- додай повтор у client.ts\n- онови опис у README.md\n").oneTask).toBe(false);
  });
  it("an enumerated list of steps on ONE file is one task", () => {
    expect(promptFacts("Refactor billing.ts in steps:\n1. extract the rounding into a helper\n2. add a test for the helper\n3. update the callers in the same file").oneTask).toBe(true);
  });
  it("two 'also' chains joining different targets is a bundle; one is not", () => {
    expect(promptFacts("fix the rounding in billing.ts and also add a retry to client.ts and also update the docs in README.md please").oneTask).toBe(false);
    expect(promptFacts("исправь округление в billing.ts, а также добавь повтор в client.ts, а также обнови README.md пожалуйста").oneTask).toBe(false);
    expect(promptFacts("fix the rounding in billing.ts carefully and also add a test for it in the same file so it stays fixed later").oneTask).toBe(true);
  });
  it("counts occasions and hits", () => {
    const h = habitsOf([
      typed(0, `${long} in billing.ts`),
      typed(1, "fix it, also add client.ts retry and also edit README.md docs, and tidy up the helpers in utils.ts as well"),
      typed(2, "fix it"),
    ]);
    expect(h.one_task).toEqual({ opportunities: 2, hits: 1 });
  });
});

describe("gives_context: names a file/symbol, quotes an error, or states expected-vs-actual", () => {
  const yes = [
    "fix the rounding in src/billing.ts",
    "refactor parseConfig so it is shorter",
    "fix the loader, it fails with TypeError: x is not a function",
    "fix the page: I expected a list but got an empty page",
    "update `retryDelay` to back off",
    "fix get_user() so it does not crash",
    "fix the test, it returns 3 instead of 4",
    "исправь расчёт в billing.ts",
    "почини загрузку, падает с ошибкой: \"connection refused\"",
    "исправь список: ожидаю 20 строк, а получаю 3",
    "виправ завантаження, замість списку порожня сторінка",
    "виправ розрахунок у src/billing.ts",
  ];
  const no = [
    "fix the rounding bug please",
    "make the checkout faster",
    "refactor this a bit",
    "исправь округление",
    "зроби швидше",
    "fix it, e.g. whatever you think",
  ];
  it("hits", () => {
    for (const t of yes) {
      const f = promptFacts(t);
      expect(f.work, `work: ${t}`).toBe(true);
      expect(f.givesContext, t).toBe(true);
    }
  });
  it("misses", () => {
    for (const t of no) {
      const f = promptFacts(t);
      expect(f.work, `work: ${t}`).toBe(true);
      expect(f.givesContext, t).toBe(false);
    }
  });
  it("counts every work prompt as an occasion", () => {
    const h = habitsOf([typed(0, "fix billing.ts"), typed(1, "make it faster"), typed(2, "thanks")]);
    expect(h.gives_context).toEqual({ opportunities: 2, hits: 1 });
  });
});

describe("the whole path, on a planted transcript", () => {
  const ID = "33333333-4444-4555-8666-777777777777";
  const SECRET = "zebrafish marmalade quokka";
  const dir = mkdtempSync(join(tmpdir(), "hb3-"));
  const file = join(dir, `${ID}.jsonl`);
  const rec = (min: number, r: Record<string, unknown>) =>
    JSON.stringify({ timestamp: new Date(at(min)).toISOString(), sessionId: ID, ...r });
  const user = (min: number, text: string) => rec(min, { type: "user", message: { content: text } });
  writeFileSync(
    file,
    [
      user(0, `please fix the ${SECRET} rounding in billing.ts so that it returns whole cents`), // opening, goal, context
      rec(1, { type: "assistant", requestId: "r1", message: { content: [{ type: "text", text: "done" }] } }),
      user(2, `now also ${SECRET} handle the second thing`), // work, no context, <15 words
      user(3, "<command-name>/clear</command-name>\n<command-args></command-args>"),
      user(4, "add logging to the worker"), // opening after /clear, no goal, no context
      user(5, `Please do these for ${SECRET}:\n1. fix the rounding in billing.ts\n2. add a retry to client.ts\n3. update the notes in README.md`), // bundle
      user(6, "исправь округление, ожидаю 20 строк, а получаю 3"), // context, no clear-goal occasion
    ].join("\n") + "\n",
  );

  it("counts the three traces", () => {
    const [session] = parseTranscript(file);
    expect(session, "input: the planted transcript parses").toBeTruthy();
    expect(session!.humanPrompts, "input: five typed prompts and a slash command").toBeGreaterThanOrEqual(5);
    expect(session!.habits.rules_version).toBe("hb-2.3");
    expect(session!.habits.clear_goal).toEqual({ opportunities: 2, hits: 1 });
    expect(session!.habits.one_task).toEqual({ opportunities: 2, hits: 1 });
    expect(session!.habits.gives_context).toEqual({ opportunities: 5, hits: 3 });
  });

  it("no prompt word reaches the wire", () => {
    const [session] = parseTranscript(file);
    const event = buildSessionSummary({
      userId: "3f2b1e4c-8a9d-4c6e-9b1a-2d3e4f5a6b7c",
      sessionId: session!.sessionId,
      model: MODEL_NOT_KNOWN,
      prompts: [],
      toolCalls: session!.toolCalls,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: session!.durationMs,
      iterations: session!.iterations,
      env: { mcpTools: [], projectInstructionsLoaded: false, reusableSkillCalls: 0 },
      habits: session!.habits,
    });
    const wire = JSON.stringify(event.payload);
    expect(wire, "input: the new traces travel").toContain("gives_context");
    for (const w of [...SECRET.split(" "), "billing", "client.ts", "README", "rounding", "worker", "logging", "округление", "строк", "cents"]) {
      expect(wire, w).not.toContain(w);
    }
    expect(JSON.stringify(event.payload.habits).replace(/"[a-z_]+":/g, "").replace(/[{}\[\],:0-9]|null|"hb-2\.[0123]"/g, "")).toBe("");
  });
});
