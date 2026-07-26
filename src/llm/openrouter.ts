import type { LlmClient } from "./types";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterClient implements LlmClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const res = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        // Some providers default to a low completion cap, which silently
        // truncates a multi-observation JSON response mid-object. Extraction
        // output is small; 2000 tokens is generous headroom.
        max_tokens: 2000,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenRouter request failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    const content = data.choices[0]?.message.content;
    if (!content) throw new Error("OpenRouter response had no message content");
    return content;
  }
}
