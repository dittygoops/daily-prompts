export interface DispatchTime {
  hour: number;
  minute: number;
}

/** Calendar date (YYYY-MM-DD) of `now` in the given IANA timezone. */
export function todayInTz(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** UTC offset of `timezone` at instant `at`, in minutes. */
function offsetMinutesAt(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0; // "GMT" exactly
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/** The UTC instant at which `date` (YYYY-MM-DD) reaches hh:mm wall clock in
 * `timezone`. Iterates once to converge across DST boundaries. */
function wallClockInstant(date: string, time: DispatchTime, timezone: string): Date {
  const naive = new Date(
    `${date}T${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}:00Z`,
  );
  let guess = naive;
  for (let i = 0; i < 3; i++) {
    const offset = offsetMinutesAt(guess, timezone);
    const corrected = new Date(naive.getTime() - offset * 60_000);
    if (corrected.getTime() === guess.getTime()) break;
    guess = corrected;
  }
  return guess;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Next instant strictly after `now` at which the wall clock in `timezone`
 * reads the configured dispatch time. DST-safe. */
export function nextDispatchAt(now: Date, time: DispatchTime, timezone: string): Date {
  const today = todayInTz(now, timezone);
  const candidate = wallClockInstant(today, time, timezone);
  if (candidate.getTime() > now.getTime()) return candidate;
  return wallClockInstant(addDays(today, 1), time, timezone);
}
