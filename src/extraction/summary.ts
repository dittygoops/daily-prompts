import type { NodeDomain } from "../ledger/ledger";
import type { LlmClient } from "../llm/types";

const MAX_SUMMARY_CHARS = 140;
const MAX_ATTEMPTS = 2; // one real attempt plus one retry, per the spec

/** One plain sentence naming the subject durably: no dates, no moods, no
 * trailing quotes, no second sentence. Pragmatic, not a full sentence
 * splitter: a period/question/exclamation followed by a capital letter is
 * the cheap, reliable signal that a second sentence snuck in. */
function isSingleSentence(text: string): boolean {
  return !/[.!?]\s+[A-Z]/.test(text);
}

function isValidSummary(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > MAX_SUMMARY_CHARS) return false;
  return isSingleSentence(trimmed);
}

const SUMMARY_SYSTEM_PROMPT = `You write one durable summary sentence for a subject in a person's life, given the dated facts recorded about it so far.

Rules:
- Exactly one sentence, no more than 140 characters.
- Third person, describing the subject itself, not the person's mood or a specific date.
- Never bake in dates ("on 2026-03-14"), relative time ("recently", "this week"), or moods ("seems excited about").
- Plain text only. No JSON, no quotation marks, no markdown, no trailing period commentary.
- Respond with the sentence alone, nothing else.`;

function buildSummaryUserPrompt(node: { domain: NodeDomain; subdomain: string; summary: string }, facts: { date: string; text: string }[]): string {
  const lines = [
    `Subject: ${node.domain}/${node.subdomain}`,
    `Current summary: ${node.summary}`,
    `Facts recorded about this subject, oldest first:`,
  ];
  for (const f of facts) lines.push(`- [${f.date}] ${f.text}`);
  return lines.join("\n");
}

/** Rewrites a node's summary from its accumulated facts. The sole LLM write
 * to nodes.summary - nothing else in this codebase produces node summary
 * text. On any failure (bad output, thrown error) after one retry, the OLD
 * summary is kept and the failure is logged loudly: a bad summary must never
 * silently corrupt a durable field. */
export async function rewriteNodeSummary(
  node: { id: number; domain: NodeDomain; subdomain: string; summary: string },
  facts: { date: string; text: string }[],
  llm: LlmClient,
  log: (msg: string) => void = () => {},
): Promise<string> {
  const userPrompt = buildSummaryUserPrompt(node, facts);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      raw = await llm.complete(SUMMARY_SYSTEM_PROMPT, userPrompt);
    } catch (err) {
      log(`SUMMARY REWRITE FAILED node ${node.id} attempt ${attempt}: ${err}`);
      continue;
    }
    const trimmed = raw.trim();
    if (isValidSummary(trimmed)) {
      return trimmed;
    }
    log(`SUMMARY REWRITE invalid output for node ${node.id} attempt ${attempt}: ${trimmed.slice(0, 200)}`);
  }

  log(`SUMMARY REWRITE giving up on node ${node.id} after ${MAX_ATTEMPTS} attempts, keeping old summary`);
  return node.summary;
}
