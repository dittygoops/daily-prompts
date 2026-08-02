#!/usr/bin/env bun
// P7's review surface: renders data/seeds.tsv in authoring order (id order,
// which doubles as the warmth curve, see load-seeds.ts's
// validateWarmthOrdering) in blocks of 20, then the two coverage tables the
// spec's Feasibility section requires. This is what the owner reads to move
// the review stamp off PENDING.
import { readFileSync } from "fs";
import { join } from "path";
import type { SeedRow } from "../src/selection/types";
import { computeDomainCoverage, computeFamilyCoverage, parseSeedsFile } from "./load-seeds";

const BLOCK_SIZE = 20;

export function renderSeedBlocks(rows: SeedRow[]): string {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const lines: string[] = [];
  for (let start = 0; start < sorted.length; start += BLOCK_SIZE) {
    const block = sorted.slice(start, start + BLOCK_SIZE);
    const from = block[0]?.id ?? start + 1;
    const to = block[block.length - 1]?.id ?? start + block.length;
    lines.push(`--- seeds ${from}-${to} ---`);
    for (const r of block) {
      lines.push(`[${r.id}] (${r.domain} / ${r.family}) ${r.text}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderCoverageTable(title: string, rows: ReturnType<typeof computeDomainCoverage> | ReturnType<typeof computeFamilyCoverage>): string {
  const lines = [title];
  for (const r of rows) {
    const status = r.ok ? "OK" : "FAIL";
    lines.push(`  ${r.key.padEnd(20)} count=${String(r.count).padStart(3)} spans=${r.spanning} [${r.spanned.join(", ")}] ${status}`);
  }
  return lines.join("\n");
}

export function renderReport(parsed: { reviewedStamp: string; rows: SeedRow[] }): string {
  const parts: string[] = [];
  parts.push(`reviewed: ${parsed.reviewedStamp}`);
  parts.push(`total seeds: ${parsed.rows.length}`);
  parts.push("");
  parts.push(renderSeedBlocks(parsed.rows));
  parts.push(renderCoverageTable("Domain coverage (need >=8 seeds spanning >=4 families):", computeDomainCoverage(parsed.rows)));
  parts.push("");
  parts.push(renderCoverageTable("Family coverage (need >=6 seeds spanning >=3 domains):", computeFamilyCoverage(parsed.rows)));
  return parts.join("\n");
}

if (import.meta.main) {
  const repoRoot = join(import.meta.dir, "..");
  const seedsPath = join(repoRoot, "data", "seeds.tsv");
  const content = readFileSync(seedsPath, "utf8");
  const parsed = parseSeedsFile(content);
  console.log(renderReport(parsed));
}
