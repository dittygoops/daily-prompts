import { describe, expect, test } from "bun:test";
import { scorePending } from "../../src/eval/scoring";
import { Ledger } from "../../src/ledger/ledger";
import type { LlmClient } from "../../src/llm/types";

const judgeResponse = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    answerable: true, answerableReason: "short and concrete",
    singleQuestion: true, singleQuestionReason: "one question",
    appropriateLength: true, appropriateLengthReason: "one sentence",
    emotionallySafe: true, emotionallySafeReason: "warm",
    ...over,
  });

function fakeLlm(behavior: () => string) {
  let calls = 0;
  const client: LlmClient = {
    async complete() {
      calls++;
      return behavior();
    },
  };
  return { client, callCount: () => calls };
}

function seed(ledger: Ledger, date: string, text: string) {
  ledger.recordGeneration({
    date, promptId: `gen-${date}`, promptText: text,
    model: "m", systemPrompt: "s", userPrompt: "u", rawResponse: "{}",
    rationale: "r", stance: "explore", person: null, fellBack: false, fallbackReason: null, at: "t",
  });
}

describe("scorePending", () => {
  test("scores each pending generated prompt and records the result", async () => {
    const ledger = Ledger.open(":memory:");
    seed(ledger, "2026-07-18", "What's a small win from today?");
    const { client } = fakeLlm(() => judgeResponse());
    const result = await scorePending({ ledger, llm: client, model: "judge-model", log: () => {} });
    expect(result).toEqual({ scored: 1, failed: 0 });
    expect(ledger.promptScores()[0]).toMatchObject({ date: "2026-07-18", passedAll: true });
  });

  test("stores the judge's reasons for failing axes only", async () => {
    const ledger = Ledger.open(":memory:");
    seed(ledger, "2026-07-18", "Describe your entire childhood and also your hopes.");
    const { client } = fakeLlm(() =>
      judgeResponse({ singleQuestion: false, singleQuestionReason: "two questions joined by and" }),
    );
    await scorePending({ ledger, llm: client, model: "judge-model", log: () => {} });
    const score = ledger.promptScores()[0]!;
    expect(score.passedAll).toBe(false);
    expect(score.failureReasons).toContain("two questions joined by and");
    expect(score.failureReasons).not.toContain("warm");
  });

  test("a judge failure on one prompt never blocks the rest of the batch", async () => {
    const ledger = Ledger.open(":memory:");
    seed(ledger, "2026-07-18", "first");
    seed(ledger, "2026-07-19", "second");
    let call = 0;
    const { client } = fakeLlm(() => {
      call++;
      if (call === 1) throw new Error("judge outage"); // a thrown call is not retried
      return judgeResponse();
    });
    const result = await scorePending({ ledger, llm: client, model: "judge-model", log: () => {} });
    expect(result).toEqual({ scored: 1, failed: 1 });
    expect(ledger.promptScores().map((s) => s.date)).toEqual(["2026-07-19"]);
  });

  test("already-scored prompts are not re-judged, so the poller costs nothing when idle", async () => {
    const ledger = Ledger.open(":memory:");
    seed(ledger, "2026-07-18", "What's a small win from today?");
    const { client, callCount } = fakeLlm(() => judgeResponse());
    await scorePending({ ledger, llm: client, model: "judge-model", log: () => {} });
    await scorePending({ ledger, llm: client, model: "judge-model", log: () => {} });
    expect(callCount()).toBe(1);
  });

  test("a failed prompt stays pending so a later pass retries it", async () => {
    const ledger = Ledger.open(":memory:");
    seed(ledger, "2026-07-18", "first");
    const failing = fakeLlm(() => { throw new Error("judge outage"); });
    await scorePending({ ledger, llm: failing.client, model: "judge-model", log: () => {} });
    expect(ledger.unscoredGenerations().length).toBe(1);
    const ok = fakeLlm(() => judgeResponse());
    expect(await scorePending({ ledger, llm: ok.client, model: "judge-model", log: () => {} }))
      .toEqual({ scored: 1, failed: 0 });
  });
});
