import { describe, expect, test } from "bun:test";
import { buildGenerationUserPrompt } from "../../src/prompts/generationPrompt";
import { memoryState, memoryStates } from "./fixtures/memoryStates";

const render = (name: string) => buildGenerationUserPrompt(memoryState(name).input);

describe("writer-state fixtures", () => {
  test("every fixture has a unique name and a description", () => {
    const names = memoryStates.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of memoryStates) expect(s.description.length).toBeGreaterThan(0);
  });

  test("all nine named states are present", () => {
    const names = memoryStates.map((s) => s.name);
    expect(names).toEqual([
      "day-one-empty",
      "one-sided",
      "rich-both",
      "heavy-thread",
      "private-asymmetry",
      "feedback-constrained",
      "stale-threads",
      "low-energy-history",
      "conflicting-preferences",
    ]);
  });

  test("every fixture renders both people's sections and their own history list", () => {
    for (const s of memoryStates) {
      const rendered = buildGenerationUserPrompt(s.input);
      expect(rendered).toContain(`PERSON A: ${s.input.a.name}`);
      expect(rendered).toContain(`PERSON B: ${s.input.b.name}`);
      expect(rendered).toContain(`Questions ${s.input.a.name} was recently asked`);
      expect(rendered).toContain(`Questions ${s.input.b.name} was recently asked`);
      expect(rendered).toContain(`Today is ${s.input.today}`);
    }
  });

  test("every fixture renders exactly one ASSIGNED TARGET block per person, no candidate menus", () => {
    for (const s of memoryStates) {
      const rendered = buildGenerationUserPrompt(s.input);
      expect(rendered.split("ASSIGNED TARGET").length - 1).toBe(2);
      expect(rendered).not.toContain("CANDIDATES");
      expect(rendered).not.toContain("OFF LIMITS");
    }
  });

  test("every node target's facts render dated and kind-tagged", () => {
    for (const s of memoryStates) {
      const rendered = buildGenerationUserPrompt(s.input);
      for (const p of [s.input.a, s.input.b]) {
        if (p.target.kind !== "node") continue;
        for (const f of p.target.facts) {
          expect(rendered).toContain(`[${f.date}] (${f.kind}) ${f.text}`);
        }
      }
    }
  });

  test("background nodes render as not-targetable, never inside the ASSIGNED TARGET block", () => {
    for (const s of memoryStates) {
      const rendered = buildGenerationUserPrompt(s.input);
      for (const [letter, p] of [["A", s.input.a], ["B", s.input.b]] as const) {
        const section = letter === "A" ? rendered.slice(rendered.indexOf("PERSON A:"), rendered.indexOf("PERSON B:")) : rendered.slice(rendered.indexOf("PERSON B:"));
        if (p.background.length === 0) {
          expect(section).toContain("BACKGROUND (do not target): (none)");
        } else {
          expect(section).toContain("BACKGROUND (do not target):");
          for (const b of p.background) expect(section).toContain(`${b.domain} / ${b.subdomain}`);
        }
      }
    }
  });

  test("no fixture dates a target fact or a prior prompt in its own future", () => {
    for (const s of memoryStates) {
      const dated: string[] = [];
      for (const p of [s.input.a, s.input.b]) {
        if (p.target.kind === "node") for (const f of p.target.facts) dated.push(f.date);
      }
      for (const date of [...dated, ...s.input.history.map((h) => h.date)]) {
        expect(date < s.input.today).toBe(true);
      }
    }
  });

  test("every fixture renders the moods and preferences labels once per person", () => {
    for (const s of memoryStates) {
      const rendered = buildGenerationUserPrompt(s.input);
      for (const label of ["Recent moods (time-bound, never durable):", "Prompt preferences (durable, from feedback):"]) {
        expect(rendered.split(label).length - 1).toBe(2);
      }
    }
  });
});

describe("day-one-empty", () => {
  test("both people are assigned a seed target, not a node", () => {
    const { input } = memoryState("day-one-empty");
    expect(input.a.target.kind).toBe("seed");
    expect(input.b.target.kind).toBe("seed");
  });

  test("signals day one explicitly in each person's history section", () => {
    const rendered = render("day-one-empty");
    expect(rendered.split("this may be day one").length - 1).toBe(2);
  });
});

describe("one-sided", () => {
  test("Alex's rich node target reaches the prompt with its dated facts", () => {
    const rendered = render("one-sided");
    expect(rendered).toContain("Bakes sourdough most weekends.");
    expect(rendered).toContain("Tried a new rye starter and it collapsed.");
  });

  test("Sam (empty history) is still assigned an answerable seed target", () => {
    const { input } = memoryState("one-sided");
    expect(input.b.target.kind).toBe("seed");
    const samSection = render("one-sided").slice(render("one-sided").indexOf("PERSON B: Sam"));
    expect(samSection).toContain("ASSIGNED TARGET [seed");
  });
});

describe("rich-both", () => {
  test("every node target fact from both people survives assembly", () => {
    const { input } = memoryState("rich-both");
    const rendered = buildGenerationUserPrompt(input);
    for (const p of [input.a, input.b]) {
      if (p.target.kind !== "node") continue;
      for (const f of p.target.facts) expect(rendered).toContain(`[${f.date}] (${f.kind}) ${f.text}`);
    }
  });

  test("every prior question is listed with its date, under each person's own history", () => {
    const { input } = memoryState("rich-both");
    const rendered = buildGenerationUserPrompt(input);
    for (const h of input.history) {
      expect(rendered).toContain(`[${h.date}] "${h.a.text}"`);
      expect(rendered).toContain(`[${h.date}] "${h.b.text}"`);
    }
  });

  test("answered history lines carry the response length as an energy signal", () => {
    const rendered = render("rich-both");
    const alexSection = rendered.slice(rendered.indexOf("PERSON A: Alex"), rendered.indexOf("PERSON B: Sam"));
    expect(alexSection).toContain("(answered, 220 chars)");
  });

  test("skipped history lines carry no length", () => {
    const rendered = render("rich-both");
    const samSection = rendered.slice(rendered.indexOf("PERSON B: Sam"));
    expect(samSection).toContain("(skipped)");
    expect(rendered).not.toContain("skipped,");
  });
});

describe("heavy-thread", () => {
  test("Sam's assigned target is the layoff node, its thread facts visible not hidden", () => {
    const rendered = render("heavy-thread");
    const samSection = rendered.slice(rendered.indexOf("PERSON B: Sam"));
    expect(samSection).toContain("ASSIGNED TARGET [node 304]");
    expect(samSection).toContain("(thread) Was laid off on Friday and has not told his parents yet.");
  });

  test("the low-energy reply that followed the heavy event is visible in Sam's own history", () => {
    const rendered = render("heavy-thread");
    const samSection = rendered.slice(rendered.indexOf("PERSON B: Sam"));
    expect(samSection).toContain("(answered, 12 chars)");
  });
});

describe("private-asymmetry", () => {
  test("the private thread appears exactly once, inside its owner's section only", () => {
    const rendered = render("private-asymmetry");
    const secret = "Quietly interviewing at another company";
    expect(rendered.split(secret).length - 1).toBe(1);
    const alexSection = rendered.slice(rendered.indexOf("PERSON A: Alex"), rendered.indexOf("PERSON B: Sam"));
    expect(alexSection).toContain(secret);
  });

  test("Sam's writer input carries no trace of Alex's private target", () => {
    const { input } = memoryState("private-asymmetry");
    expect(input.b.target.kind === "node" ? input.b.target.subdomain : "").not.toBe("job-search");
  });
});

describe("feedback-constrained", () => {
  test("raw feedback reaches the prompt for both people", () => {
    const rendered = render("feedback-constrained");
    expect(rendered).toContain("these are getting too long, keep them short");
    expect(rendered).toContain("yeah shorter please");
  });

  test("an unconsumed idea is rendered with its id so usedIdeaId can cite it", () => {
    expect(render("feedback-constrained")).toContain("[id 41] ask us about the worst haircut we ever had");
  });

  test("the person with no ideas renders the none placeholder", () => {
    const rendered = render("feedback-constrained");
    expect(rendered).toContain("Unconsumed prompt ideas they suggested: (none)");
  });
});

describe("stale-threads", () => {
  test("provenance dates survive into the rendered target facts so staleness is visible", () => {
    const rendered = render("stale-threads");
    expect(rendered).toContain("[2026-06-14] (fact) Waiting to hear back about a conference talk submission.");
    expect(rendered).toContain("[2026-06-12] (fact) Deciding whether to run a 10K at the end of the month.");
  });

  test("background carries the depleted subject so the writer knows it is off limits", () => {
    const rendered = render("stale-threads");
    expect(rendered).toContain("daily-life / small-pleasures");
  });

  test("today is anchored two months after the newest target fact, so the gap is unambiguous", () => {
    const { input } = memoryState("stale-threads");
    expect(input.today).toBe("2026-08-14");
    expect(render("stale-threads")).toContain("Today is 2026-08-14");
  });
});

describe("low-energy-history", () => {
  test("every history line shows a skip, a no-response, or a near-empty answer", () => {
    const { input } = memoryState("low-energy-history");
    for (const h of input.history) {
      for (const signal of [h.a, h.b]) {
        const weak = signal.outcome !== "answered" || (signal.responseLength ?? 0) < 10;
        expect(weak).toBe(true);
      }
    }
  });

  test("no_response renders without a length, distinct from a zero-length answer", () => {
    const rendered = render("low-energy-history");
    const alexSection = rendered.slice(rendered.indexOf("PERSON A: Alex"), rendered.indexOf("PERSON B: Sam"));
    expect(alexSection).toContain("(no_response)");
  });
});

describe("conflicting-preferences", () => {
  test("both people's own preferences are present in their own section", () => {
    const rendered = render("conflicting-preferences");
    expect(rendered).toContain("Wants questions with more depth.");
    expect(rendered).toContain("Wants questions that stay light and silly.");
  });
});
