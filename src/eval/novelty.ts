export interface DuplicatePair {
  a: string;
  b: string;
  text: string;
}

const normalize = (text: string) => text.trim().toLowerCase();

/** Deterministic within-bank novelty check: exact (case/whitespace-insensitive)
 * text duplicates only. Semantic near-duplicate detection needs embeddings
 * and is out of scope for Phase 0 — this catches the cheap, unambiguous case. */
export function findExactDuplicates(prompts: { id: string; text: string }[]): DuplicatePair[] {
  const seen = new Map<string, string>(); // normalized text -> first id
  const dupes: DuplicatePair[] = [];
  for (const p of prompts) {
    const key = normalize(p.text);
    const firstId = seen.get(key);
    if (firstId) {
      dupes.push({ a: firstId, b: p.id, text: p.text });
    } else {
      seen.set(key, p.id);
    }
  }
  return dupes;
}

/** Question scaffolding that nearly every check-in prompt shares. Left in,
 * two unrelated questions look ~40% similar purely because both start
 * "what's your"; removed, overlap only reflects subject matter. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at", "for", "from", "with", "by",
  "what", "whats", "which", "who", "whos", "whom", "whose", "when", "where", "why", "how",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "done", "have", "has", "had",
  "you", "your", "yours", "youve", "youd", "youre", "i", "me", "my", "we", "our", "us", "it", "its",
  "that", "this", "these", "those", "there", "here",
  "can", "could", "would", "should", "will", "shall", "may", "might", "must",
  "one", "ever", "last", "just", "s", "t", "so", "as", "up", "out", "about", "like", "get",
]);

/** Lowercased, punctuation-stripped, stopword-free word set for a prompt.
 * Deterministic and non-LLM by construction. */
export function contentWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
  return new Set(words);
}

/** Jaccard over content words. Chosen at 0.5 because check-in prompts are
 * short (3-8 content words after stopword removal): at 0.5 two prompts must
 * share at least half their combined subject vocabulary, which reliably
 * catches restatements ("favorite thing to cook" vs "favorite thing you
 * like to cook", 0.75) while leaving same-topic-different-question pairs
 * ("best meal this month" vs "favorite thing to cook", 0.0) alone. Lower
 * thresholds start flagging any two food questions; higher ones miss
 * rewordings that only swap a single word. */
export const NEAR_DUPLICATE_THRESHOLD = 0.5;

/** How many leading words define a prompt's structural template. Four is
 * enough to separate "what's one thing you're..." from "what's your
 * favorite..." without collapsing every question starting "what's your". */
const STEM_WORDS = 4;

/** The normalized opening words of a prompt. Content-word Jaccard is blind
 * to shared scaffolding by design, which means it cannot see a generator
 * that keeps reaching for the same sentence template while varying only the
 * subject. This is the complementary check for that failure mode. */
export function openingStem(text: string, stemWords: number = STEM_WORDS): string {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, stemWords)
    .join(" ");
}

export interface RepeatedStem {
  stem: string;
  count: number;
  texts: string[];
}

/** Opening templates used by more than one prompt, most-repeated first. */
export function repeatedStems(texts: string[], stemWords: number = STEM_WORDS): RepeatedStem[] {
  const groups = new Map<string, string[]>();
  for (const text of texts) {
    const stem = openingStem(text, stemWords);
    groups.set(stem, [...(groups.get(stem) ?? []), text]);
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([stem, members]) => ({ stem, count: members.length, texts: members }))
    .sort((x, y) => y.count - x.count);
}

export interface NearestPriorMatch {
  /** The prior prompt this candidate is closest to. */
  text: string;
  similarity: number;
  isNearDuplicate: boolean;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** The closest match between a candidate prompt and the prompts that
 * preceded it. Unlike the static bank's within-bank exact-duplicate check,
 * this is the check that matters for generated prompts: System 3's whole
 * purpose is not re-asking what it already asked. */
export function nearestPrior(
  candidate: string,
  priors: string[],
  threshold: number = NEAR_DUPLICATE_THRESHOLD,
): NearestPriorMatch | null {
  if (priors.length === 0) return null;
  const candidateWords = contentWords(candidate);
  let best: NearestPriorMatch = { text: priors[0]!, similarity: -1, isNearDuplicate: false };
  for (const prior of priors) {
    const similarity = jaccard(candidateWords, contentWords(prior));
    if (similarity > best.similarity) {
      best = { text: prior, similarity, isNearDuplicate: similarity >= threshold };
    }
  }
  return best;
}

export interface DatedPrompt {
  date: string;
  person: string;
  text: string;
}

export interface StemCollision {
  date: string;
  stem: string;
  prompts: DatedPrompt[];
}

/** Two people handed the same sentence frame on the SAME day.
 * repeatedStems pools every prompt together, so it cannot tell a
 * cross-person collision from an ordinary reuse weeks apart. The generator is
 * explicitly told not to give both people the same frame today, so this is
 * the check that can actually catch it. */
export function sameDayStemCollisions(prompts: DatedPrompt[], stemWords?: number): StemCollision[] {
  const byDate = new Map<string, DatedPrompt[]>();
  for (const p of prompts) {
    const list = byDate.get(p.date) ?? [];
    list.push(p);
    byDate.set(p.date, list);
  }

  const collisions: StemCollision[] = [];
  for (const [date, sameDay] of byDate) {
    const byStem = new Map<string, DatedPrompt[]>();
    for (const p of sameDay) {
      const stem = openingStem(p.text, stemWords);
      const list = byStem.get(stem) ?? [];
      list.push(p);
      byStem.set(stem, list);
    }
    for (const [stem, group] of byStem) {
      // More than one PERSON, not merely more than one row: a retry could
      // legitimately write two rows for the same person and day.
      if (new Set(group.map((p) => p.person)).size > 1) {
        collisions.push({ date, stem, prompts: group });
      }
    }
  }
  return collisions.sort((x, y) => x.date.localeCompare(y.date));
}
