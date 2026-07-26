import type { PersonId } from "../config";
import type { Ledger, PersonState } from "../ledger/ledger";

export interface WeekDayStat {
  date: string;
  aState: PersonState;
  bState: PersonState;
}

export interface WeekStats {
  weekStart: string;
  weekEnd: string;
  totalDays: number;
  bothAnswered: number;
  days: WeekDayStat[];
}

/** Assembles a week's activity purely from ledger rows already time-bounded
 * to the range (days, person_days) — deliberately not live memory
 * (getContext/getCoverage are lifetime accumulators, not week-scoped, and
 * would need a coverage snapshot diff that doesn't exist). */
export function assembleWeekStats(ledger: Ledger, weekStart: string, weekEnd: string): WeekStats {
  const days = ledger.daysInRange(weekStart, weekEnd);
  const dayStats: WeekDayStat[] = [];
  let bothAnswered = 0;

  for (const day of days) {
    const a = ledger.personDay(day.id, "a");
    const b = ledger.personDay(day.id, "b");
    dayStats.push({ date: day.date, aState: a.state, bState: b.state });
    if (a.state === "answered" && b.state === "answered") bothAnswered++;
  }

  return { weekStart, weekEnd, totalDays: days.length, bothAnswered, days: dayStats };
}

/** "2026-07-14" -> "Jul 14" */
function formatWeekLabel(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(year!, month! - 1, day!);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function mechanicalRecapText(stats: WeekStats): string {
  const label = `Week of ${formatWeekLabel(stats.weekStart)}`;
  if (stats.totalDays === 0) {
    return `${label}: no check-ins this week.`;
  }
  return `${label}: ${stats.bothAnswered}/${stats.totalDays} days answered together.`;
}
