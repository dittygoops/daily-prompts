import { describe, expect, test } from "bun:test";
import { judgePrompt } from "../../src/eval/judge";
import type { LlmClient } from "../../src/llm/types";

function fakeLlm(response: string) {
  const calls: { system: string; user: string }[] = [];
  const client: LlmClient = {
    async complete(system, user) {
      calls.push({ system, user });
      return response;
    },
  };
  return { client, calls };
}

const allPass = JSON.stringify({
  answerable: true, answerableReason: "quick",
  singleQuestion: true, singleQuestionReason: "one question",
  appropriateLength: true, appropriateLengthReason: "short",
  emotionallySafe: true, emotionallySafeReason: "warm",
});

describe("judgePrompt", () => {
  test("parses a fully-passing judgment", async () => {
    const { client, calls } = fakeLlm(allPass);
    const result = await judgePrompt("What's your favorite thing to cook?", client);
    expect(result.answerable).toBe(true);
    expect(result.singleQuestion).toBe(true);
    expect(result.appropriateLength).toBe(true);
    expect(result.emotionallySafe).toBe(true);
    expect(calls[0]!.user).toContain("What's your favorite thing to cook?");
  });

  test("parses a failing judgment with reasons preserved", async () => {
    const { client } = fakeLlm(
      JSON.stringify({
        answerable: false, answerableReason: "requires deep reflection",
        singleQuestion: true, singleQuestionReason: "one question",
        appropriateLength: true, appropriateLengthReason: "short",
        emotionallySafe: true, emotionallySafeReason: "warm",
      }),
    );
    const result = await judgePrompt("Describe your entire philosophy on life.", client);
    expect(result.answerable).toBe(false);
    expect(result.answerableReason).toBe("requires deep reflection");
  });

  test("throws on unparseable JSON", async () => {
    const { client } = fakeLlm("not json");
    await expect(judgePrompt("x", client)).rejects.toThrow();
  });

  test("throws when a required axis field is missing", async () => {
    const { client } = fakeLlm(JSON.stringify({ answerable: true }));
    await expect(judgePrompt("x", client)).rejects.toThrow();
  });

  test("passes(result) is true only when every axis passes", async () => {
    const { client } = fakeLlm(allPass);
    const result = await judgePrompt("x", client);
    const { passesAll } = await import("../../src/eval/judge");
    expect(passesAll(result)).toBe(true);
  });
});
