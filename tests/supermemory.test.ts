import { describe, expect, test } from "bun:test";
import { SupermemoryClient } from "../src/memory/supermemory";
import type { Observation } from "../src/memory/types";

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    type: "fact",
    text: "Enjoys birthday dinners at Tandoori Times.",
    topic: "family-traditions",
    person: "a",
    provenance: { dayId: 1, date: "2026-07-18", snippet: "..." },
    ...overrides,
  };
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("SupermemoryClient.add", () => {
  test("POSTs one document per observation, tagged by person, with type/topic/date metadata", async () => {
    const { fn, calls } = fakeFetch(() => new Response(JSON.stringify({ id: "x", status: "queued" })));
    const client = new SupermemoryClient("http://localhost:6767", "sm-key", fn);
    await client.add([obs()]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://localhost:6767/v3/documents");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.content).toBe("Enjoys birthday dinners at Tandoori Times.");
    expect(body.containerTags).toEqual(["person:a"]);
    expect(body.metadata).toMatchObject({ type: "fact", topic: "family-traditions", date: "2026-07-18", dayId: 1 });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sm-key");
  });

  test("throws on a non-OK add", async () => {
    const { fn } = fakeFetch(() => new Response("server error", { status: 500 }));
    const client = new SupermemoryClient("http://localhost:6767", "sm-key", fn);
    await expect(client.add([obs()])).rejects.toThrow(/500/);
  });
});

describe("SupermemoryClient.getContext", () => {
  test("lists per type filtered by person container tag, fetches full content, buckets and sorts newest-first", async () => {
    const listBody = {
      memories: [
        { id: "d2", metadata: { type: "fact", topic: "x", date: "2026-07-19" } },
        { id: "d1", metadata: { type: "fact", topic: "y", date: "2026-07-17" } },
      ],
    };
    const { fn, calls } = fakeFetch((url) => {
      if (url.endsWith("/v3/documents/list")) return new Response(JSON.stringify(listBody));
      if (url.endsWith("/v3/documents/d2")) return new Response(JSON.stringify({ content: "newer fact" }));
      if (url.endsWith("/v3/documents/d1")) return new Response(JSON.stringify({ content: "older fact" }));
      return new Response(JSON.stringify({ memories: [] }));
    });
    const client = new SupermemoryClient("http://localhost:6767", "sm-key", fn);
    const ctx = await client.getContext("a");
    expect(ctx.facts).toEqual(["[2026-07-19] newer fact", "[2026-07-17] older fact"]);

    const listCall = calls.find((c) => c.url.endsWith("/v3/documents/list") && JSON.parse(c.init.body as string).filters?.AND?.[0]?.value === "fact");
    const listBodyParsed = JSON.parse(listCall!.init.body as string);
    expect(listBodyParsed.containerTags).toEqual(["person:a"]);
  });

  test("stops once the char budget is exhausted", async () => {
    const listBody = {
      memories: [
        { id: "d1", metadata: { type: "fact", topic: "x", date: "2026-07-19" } },
      ],
    };
    const { fn } = fakeFetch((url) => {
      if (url.endsWith("/v3/documents/list")) return new Response(JSON.stringify(listBody));
      return new Response(JSON.stringify({ content: "x".repeat(500) }));
    });
    const client = new SupermemoryClient("http://localhost:6767", "sm-key", fn);
    const ctx = await client.getContext("a", 10);
    expect(ctx.facts).toEqual([]);
  });
});

describe("SupermemoryClient.getCoverage", () => {
  test("returns distinct topics across all types for that person", async () => {
    const { fn } = fakeFetch((url) => {
      if (url.endsWith("/v3/documents/list")) {
        return new Response(
          JSON.stringify({
            memories: [
              { id: "d1", metadata: { type: "fact", topic: "food" } },
              { id: "d2", metadata: { type: "interest", topic: "food" } },
              { id: "d3", metadata: { type: "interest", topic: "music" } },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({}));
    });
    const client = new SupermemoryClient("http://localhost:6767", "sm-key", fn);
    const coverage = await client.getCoverage("a");
    expect(new Set(coverage)).toEqual(new Set(["food", "music"]));
  });
});

describe("SupermemoryClient.wipe", () => {
  test("lists all documents for the person then deletes each by id", async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.endsWith("/v3/documents/list")) {
        return new Response(JSON.stringify({ memories: [{ id: "d1" }, { id: "d2" }] }));
      }
      return new Response(null, { status: 204 });
    });
    const client = new SupermemoryClient("http://localhost:6767", "sm-key", fn);
    await client.wipe("a");
    const deletes = calls.filter((c) => c.init.method === "DELETE");
    expect(deletes.map((d) => d.url).sort()).toEqual([
      "http://localhost:6767/v3/documents/d1",
      "http://localhost:6767/v3/documents/d2",
    ]);
  });
});
