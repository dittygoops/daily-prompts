/** A minimal chat-completions LLM client: system + user prompt in, raw
 * string content out. Kept this narrow so extraction is testable against a
 * fake with no network. */
export interface LlmClient {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}
