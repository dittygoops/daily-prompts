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
