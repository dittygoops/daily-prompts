// Anchor check (spec "The writer's contract", restored per F12): the
// written question must share at least `anchorMinSharedWords` content words
// with its target node's subdomain, summary, or facts. This is the
// structural guard against altitude retreat on exploit days (a generated
// question drifting into generic small talk that no longer touches the
// node it was supposedly targeting). Deterministic, reuses eval/novelty's
// contentWords rather than inventing a second stopword list.
//
// SelectableNode carries subdomain and summary but not raw fact text (P0's
// contract has no fact-text field on it), so `factTexts` is supplied by the
// caller (the writer package, which has the node_facts rows in hand). Seeds
// are anchored by construction (spec) and need no check here.

import { contentWords } from "../eval/novelty";

export interface AnchorTarget {
  subdomain: string;
  summary: string;
}

/** True if `questionText` shares >= minSharedWords content words with the
 * union of the target's subdomain, summary, and any supplied fact texts. */
export function anchorCheck(
  questionText: string,
  target: AnchorTarget,
  factTexts: string[],
  minSharedWords: number,
): boolean {
  const targetWords = new Set<string>();
  for (const w of contentWords(target.subdomain)) targetWords.add(w);
  for (const w of contentWords(target.summary)) targetWords.add(w);
  for (const fact of factTexts) {
    for (const w of contentWords(fact)) targetWords.add(w);
  }

  const questionWords = contentWords(questionText);
  let shared = 0;
  for (const w of questionWords) {
    if (targetWords.has(w)) shared++;
    if (shared >= minSharedWords) return true;
  }
  return shared >= minSharedWords;
}
