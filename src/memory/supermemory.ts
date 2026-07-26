import type { PersonId } from "../config";
import type { Memory, Observation, ObservationType, PersonContext } from "./types";

const TYPE_TO_BUCKET: Record<ObservationType, keyof PersonContext> = {
  fact: "facts",
  thread: "threads",
  interest: "interests",
  mood_signal: "recentMoods",
  prompt_preference: "promptPreferences",
};

const ALL_TYPES: ObservationType[] = [
  "fact",
  "thread",
  "interest",
  "mood_signal",
  "prompt_preference",
];

interface ListedDoc {
  id: string;
  metadata?: { type?: string; topic?: string; date?: string };
}

/** Self-hosted Supermemory client. Uses /v3/documents (add/get/delete) and
 * /v3/documents/list (metadata-filtered listing); /v4/search was found to
 * return empty results against the self-hosted server during the System 2
 * spike even for successfully ingested and memory-agent-processed
 * documents, so retrieval here is built on list + per-document fetch
 * instead (both confirmed working live). Revisit if search is fixed
 * upstream. */
export class SupermemoryClient implements Memory {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      throw new Error(`Supermemory request to ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res;
  }

  async add(observations: Observation[]): Promise<void> {
    for (const o of observations) {
      await this.request("/v3/documents", {
        method: "POST",
        body: JSON.stringify({
          content: o.text,
          containerTags: [`person:${o.person}`],
          metadata: {
            type: o.type,
            topic: o.topic,
            date: o.provenance.date,
            dayId: o.provenance.dayId,
          },
        }),
      });
    }
  }

  private async listByType(person: PersonId, type: ObservationType): Promise<ListedDoc[]> {
    const res = await this.request("/v3/documents/list", {
      method: "POST",
      body: JSON.stringify({
        containerTags: [`person:${person}`],
        filters: { AND: [{ key: "type", value: type, filterType: "metadata" }] },
        sort: "createdAt",
        order: "desc",
        limit: 50,
      }),
    });
    const data = (await res.json()) as { memories: ListedDoc[] };
    return data.memories;
  }

  private async listAll(person: PersonId): Promise<ListedDoc[]> {
    const res = await this.request("/v3/documents/list", {
      method: "POST",
      body: JSON.stringify({ containerTags: [`person:${person}`], limit: 200 }),
    });
    const data = (await res.json()) as { memories: ListedDoc[] };
    return data.memories;
  }

  private async fetchContent(id: string): Promise<string> {
    const res = await this.request(`/v3/documents/${id}`);
    const data = (await res.json()) as { content: string };
    return data.content;
  }

  async getContext(person: PersonId, budgetChars = 4000): Promise<PersonContext> {
    const context: PersonContext = {
      facts: [],
      threads: [],
      interests: [],
      recentMoods: [],
      promptPreferences: [],
    };
    let used = 0;
    outer: for (const type of ALL_TYPES) {
      const docs = await this.listByType(person, type);
      for (const doc of docs) {
        const date = doc.metadata?.date ?? "";
        const content = await this.fetchContent(doc.id);
        const line = `[${date}] ${content}`;
        if (used + line.length > budgetChars) break outer;
        context[TYPE_TO_BUCKET[type]].push(line);
        used += line.length;
      }
    }
    return context;
  }

  async getCoverage(person: PersonId): Promise<string[]> {
    const docs = await this.listAll(person);
    const topics = new Set(docs.map((d) => d.metadata?.topic).filter((t): t is string => !!t));
    return [...topics];
  }

  async wipe(person: PersonId): Promise<void> {
    const docs = await this.listAll(person);
    for (const doc of docs) {
      await this.request(`/v3/documents/${doc.id}`, { method: "DELETE" });
    }
  }
}
