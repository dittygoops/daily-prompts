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

function scriptedLlm(responses: string[]) {
  const calls: { system: string; user: string }[] = [];
  const client: LlmClient = {
    async complete(system, user) {
      calls.push({ system, user });
      return responses[calls.length - 1] ?? responses[responses.length - 1]!;
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

  test("rejects a judgment whose reasons are blank, since an unexplained verdict is not reviewable", async () => {
    const { client } = fakeLlm(
      JSON.stringify({
        answerable: true, answerableReason: "",
        singleQuestion: true, singleQuestionReason: "",
        appropriateLength: true, appropriateLengthReason: "",
        emotionallySafe: true, emotionallySafeReason: "",
      }),
    );
    await expect(judgePrompt("x", client)).rejects.toThrow();
  });

  test("retries once when the first response is unparseable and succeeds on the second", async () => {
    const { client, calls } = scriptedLlm(["```json oops", allPass]);
    const result = await judgePrompt("x", client);
    expect(result.answerable).toBe(true);
    expect(calls.length).toBe(2);
  });

  test("retries once when the first response fails the schema", async () => {
    const { client, calls } = scriptedLlm([JSON.stringify({ answerable: true }), allPass]);
    await judgePrompt("x", client);
    expect(calls.length).toBe(2);
  });

  test("does not retry a response that already parses", async () => {
    const { client, calls } = scriptedLlm([allPass, allPass]);
    await judgePrompt("x", client);
    expect(calls.length).toBe(1);
  });

  test("gives up after the retry rather than looping", async () => {
    const { client, calls } = fakeLlm("not json");
    await expect(judgePrompt("x", client)).rejects.toThrow();
    expect(calls.length).toBe(2);
  });

  test("passes(result) is true only when every axis passes", async () => {
    const { client } = fakeLlm(allPass);
    const result = await judgePrompt("x", client);
    const { passesAll } = await import("../../src/eval/judge");
    expect(passesAll(result)).toBe(true);
  });
});
