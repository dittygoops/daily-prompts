import type { PersonId } from "../config";
import type { Memory, Observation, PersonContext } from "./types";

const TYPE_TO_BUCKET: Record<Observation["type"], keyof PersonContext> = {
  fact: "facts",
  thread: "threads",
  interest: "interests",
  mood_signal: "recentMoods",
  prompt_preference: "promptPreferences",
};

export class FakeMemory implements Memory {
  readonly stored: Observation[] = [];

  async add(observations: Observation[]): Promise<void> {
    this.stored.push(...observations);
  }

  async getContext(person: PersonId, budgetChars = 4000): Promise<PersonContext> {
    const mine = this.stored
      .filter((o) => o.person === person)
      .sort((a, b) => b.provenance.date.localeCompare(a.provenance.date));

    const context: PersonContext = {
      facts: [],
      threads: [],
      interests: [],
      recentMoods: [],
      promptPreferences: [],
    };
    let used = 0;
    for (const o of mine) {
      const line = `[${o.provenance.date}] ${o.text}`;
      if (used + line.length > budgetChars) break;
      context[TYPE_TO_BUCKET[o.type]].push(line);
      used += line.length;
    }
    return context;
  }

  async getCoverage(person: PersonId): Promise<string[]> {
    const topics = new Set(this.stored.filter((o) => o.person === person).map((o) => o.topic));
    return [...topics];
  }

  async wipe(person: PersonId): Promise<void> {
    for (let i = this.stored.length - 1; i >= 0; i--) {
      if (this.stored[i]!.person === person) this.stored.splice(i, 1);
    }
  }
}
