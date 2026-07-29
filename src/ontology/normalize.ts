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
  // ("gas", "chess") keep their s. The -ss/-us/-is/-es exclusions are not
  // cosmetic: the first live rebuild produced "basi-school" from "Basis",
  // "career-focu" from "focus" and "childhood-storie" from "stories", because
  // a bare trailing-s strip mangles singulars that merely end in s and -es
  // plurals whose stem needs the e dropped too. Not collapsing those is a
  // cheaper error than storing a corrupted subject name.
  const KEEPS_TRAILING_S = /(ss|us|is|es)$/;
  return kebab
    .split("-")
    .map((seg) => (seg.length > 3 && seg.endsWith("s") && !KEEPS_TRAILING_S.test(seg) ? seg.slice(0, -1) : seg))
    .join("-");
}
