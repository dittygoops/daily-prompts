import { describe, expect, test } from "bun:test";
import { OpenRouterClient } from "../src/llm/openrouter";

function fakeFetch(response: { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
  return { fn, calls };
}

describe("OpenRouterClient", () => {
  test("sends model, system+user messages, and json_object response format", async () => {
    const { fn, calls } = fakeFetch({
      status: 200,
      body: { choices: [{ message: { content: '{"observations":[]}' } }] },
    });
    const client = new OpenRouterClient("or-key", "google/gemini-2.5-flash", fn as typeof fetch);
    const content = await client.complete("system prompt", "user prompt");
    expect(content).toBe('{"observations":[]}');
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("google/gemini-2.5-flash");
    expect(body.messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "user prompt" },
    ]);
    expect(body.response_format).toEqual({ type: "json_object" });
    // An explicit cap avoids provider-default truncation on longer,
    // multi-observation JSON responses.
    expect(body.max_tokens).toBeGreaterThanOrEqual(1000);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer or-key");
  });

  test("throws with status and body on a non-OK response", async () => {
    const { fn } = fakeFetch({ status: 402, body: { error: { message: "insufficient credits" } } });
    const client = new OpenRouterClient("or-key", "model-x", fn as typeof fetch);
    await expect(client.complete("s", "u")).rejects.toThrow(/402/);
  });
});
