export interface Prompt {
  id: string;
  text: string;
}

/** Source of the day's prompt. v0: static bank. System 3 later implements
 * this same interface with LLM generation. */
export interface PromptSource {
  nextPrompt(date: string): Prompt;
}
