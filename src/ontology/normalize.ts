/** Normalizes an LLM-proposed subdomain before any uniqueness check, so
 * "Fitness-Goals", "fitness--goals" and "fitness-goal" collapse to one key.
 * This is the cheap deterministic half of drift defense; the semantic half
 * (nearestPrior over subdomain+summary) lives with node creation. */
export function normalizeSubdomain(raw: string): string {
  const kebab = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // Trailing-s plural collapse per hyphen segment, guarded so short words
  // ("gas", "chess") and -ss words keep their s.
  return kebab
    .split("-")
    .map((seg) => (seg.length > 3 && seg.endsWith("s") && !seg.endsWith("ss") ? seg.slice(0, -1) : seg))
    .join("-");
}
