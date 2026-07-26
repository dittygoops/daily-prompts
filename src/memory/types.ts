import type { PersonId } from "../config";

export type ObservationType =
  | "fact"
  | "thread"
  | "interest"
  | "mood_signal"
  | "prompt_preference";

export interface Observation {
  type: ObservationType;
  text: string;
  topic: string;
  person: PersonId;
  provenance: { dayId: number; date: string; snippet: string };
}

export interface PersonContext {
  facts: string[];
  threads: string[];
  interests: string[];
  recentMoods: string[];
  promptPreferences: string[];
}

/** Storage + retrieval for per-person observations. The only coupling
 * surface System 3 gets (PRD F4): getContext for prompt generation,
 * getCoverage for the explore side of explore/exploit. */
export interface Memory {
  add(observations: Observation[]): Promise<void>;
  getContext(person: PersonId, budgetChars?: number): Promise<PersonContext>;
  getCoverage(person: PersonId): Promise<string[]>;
  wipe(person: PersonId): Promise<void>;
}
