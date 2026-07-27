import { describe, expect, test } from "bun:test";
import { buildGenerationUserPrompt } from "../../src/prompts/generationPrompt";
import { memoryState, memoryStates } from "./fixtures/memoryStates";

const render = (name: string) => buildGenerationUserPrompt(memoryState(name).input);

describe("memory-state fixtures", () => {
  test("every fixture has a unique name and a description", () => {
    const names = memoryStates.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of memoryStates) expect(s.description.length).toBeGreaterThan(0);
  });

  test("the seven named states the eval harness depends on are all present", () => {
    const names = memoryStates.map((s) => s.name);
    for (const required of [
      "day-one-empty",
      "one-sided",
      "rich-both",
      "heavy-thread",
      "private-asymmetry",
      "feedback-constrained",
      "stale-threads",
    ]) {
      expect(names).toContain(required);
    }
  });

  test("every fixture renders both people's sections and their own history list", () => {
    for (const s of memoryStates) {
      const rendered = buildGenerationUserPrompt(s.input);
      expect(rendered).toContain(`PERSON A: ${s.input.names.a}`);
      expect(rendered).toContain(`PERSON B: ${s.input.names.b}`);
      expect(rendered).toContain(`Questions ${s.input.names.a} was recently asked`);
      expect(rendered).toContain(`Questions ${s.input.names.b} was recently asked`);
      expect(rendered).toContain(`Today is ${s.input.today}`);
    }
  });

  test("no fixture dates a context line or a prior prompt in its own future", () => {
    for (const s of memoryStates) {
      const dated = [s.input.contextA, s.input.contextB]
        .flatMap((c) => [...c.facts, ...c.threads, ...c.interests, ...c.recentMoods, ...c.promptPreferences])
        .map((line) => line.slice(1, 11));
      for (const date of [...dated, ...s.input.history.map((h) => h.date)]) {
        expect(date < s.input.today).toBe(true);
      }
    }
  });

  test("every fixture renders every bucket label for both people", () => {
    for (const s of memoryStates) {
      const rendered = buildGenerationUserPrompt(s.input);
      for (const label of ["Facts:", "Open threads:", "Interests:", "Recent moods:", "Topics already covered:"]) {
        expect(rendered.split(label).length - 1).toBe(2);
      }
    }
  });
});

describe("day-one-empty", () => {
  test("renders empty-state placeholders rather than omitting the sections", () => {
    const rendered = render("day-one-empty");
    expect(rendered).toContain("Facts: (none yet)");
    expect(rendered).toContain("Open threads: (none yet)");
    expect(rendered).toContain("Topics already covered: (none yet");
  });

  test("signals day one explicitly in each person's history section", () => {
    const rendered = render("day-one-empty");
    expect(rendered.split("this may be day one").length - 1).toBe(2);
  });
});

describe("one-sided", () => {
  test("the populated person's context reaches the prompt", () => {
    const rendered = render("one-sided");
    expect(rendered).toContain("Bakes sourdough most weekends.");
    expect(rendered).toContain("Deciding whether to adopt a second cat.");
  });

  test("the empty person still gets placeholders and an empty coverage list", () => {
    const rendered = render("one-sided");
    const samSection = rendered.slice(rendered.indexOf("PERSON B: Sam"));
    expect(samSection).toContain("Facts: (none yet)");
    expect(samSection).toContain("Topics already covered: (none yet");
  });

  test("the non-answering person shows as no_response in every one of their own history lines", () => {
    const rendered = render("one-sided");
    const samSection = rendered.slice(rendered.indexOf("PERSON B: Sam"));
    expect(samSection.split("(no_response)").length - 1).toBe(2);
  });
});

describe("rich-both", () => {
  test("every fact, thread and interest from both contexts survives assembly", () => {
    const { input } = memoryState("rich-both");
    const rendered = buildGenerationUserPrompt(input);
    for (const ctx of [input.contextA, input.contextB]) {
      for (const entry of [...ctx.facts, ...ctx.threads, ...ctx.interests]) {
        expect(rendered).toContain(entry);
      }
    }
  });

  test("every prior question is listed with its date, under each person's own history, so the model can avoid repeats", () => {
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
  test("the heavy thread is surfaced to the model under Open threads, not hidden", () => {
    const rendered = render("heavy-thread");
    const samSection = rendered.slice(rendered.indexOf("PERSON B: Sam"));
    const threadsLine = samSection.split("\n").find((l) => l.includes("Open threads:"))!;
    expect(threadsLine).toContain("laid off on Friday");
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

  test("the other person's coverage does not mention the private topic", () => {
    const { input } = memoryState("private-asymmetry");
    expect(input.coverageB).not.toContain("job search");
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

  test("the over-long prompt that triggered the feedback is in history verbatim", () => {
    const { input } = memoryState("feedback-constrained");
    expect(buildGenerationUserPrompt(input)).toContain(input.history[0]!.a.text);
  });
});

describe("stale-threads", () => {
  test("provenance dates survive into the rendered context so staleness is visible", () => {
    const rendered = render("stale-threads");
    expect(rendered).toContain("[2026-06-14] Waiting to hear back about a conference talk submission.");
    expect(rendered).toContain("[2026-06-12] Deciding whether to run a 10K at the end of the month.");
  });

  test("no context entry is fresher than the stale window the fixture is testing", () => {
    const { input } = memoryState("stale-threads");
    const all = [input.contextA, input.contextB].flatMap((c) => [...c.facts, ...c.threads, ...c.interests]);
    for (const entry of all) expect(entry.startsWith("[2026-06-")).toBe(true);
  });

  test("today is anchored two months after the newest context line, so the gap is unambiguous", () => {
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
