import type { PersonId } from "../config";

export interface Prompt {
  id: string;
  text: string;
}

/** A day's questions: one per person, each built from that person's own
 * memory, plus the short label that ties them together. Theme is null when
 * the source has none to offer (the degraded static-bank path). */
export interface DailyPrompts {
  theme: string | null;
  prompts: Record<PersonId, Prompt>;
}

/** Source of the day's prompts. v0: static bank. System 3 implements this
 * same interface with LLM generation. */
export interface PromptSource {
  nextPrompts(date: string): Promise<DailyPrompts>;
}
