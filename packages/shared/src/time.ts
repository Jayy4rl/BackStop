// Business-day arithmetic for SLAs (C3-5, C4-8, C5-8, ruling targets). Nigeria works Monday to
// Friday; public holidays are configuration supplied by the server (dates in Africa/Lagos, UTC+1).

const LAGOS_OFFSET_MS = 60 * 60 * 1000;

function lagosDate(d: Date): Date {
  return new Date(d.getTime() + LAGOS_OFFSET_MS);
}

function isoDay(d: Date): string {
  return lagosDate(d).toISOString().slice(0, 10);
}

export function isBusinessDay(d: Date, holidays: ReadonlySet<string> = new Set()): boolean {
  const day = lagosDate(d).getUTCDay();
  return day !== 0 && day !== 6 && !holidays.has(isoDay(d));
}

/** Adds n business days, keeping the time of day. Starting on a non-business day counts from the next one. */
export function addBusinessDays(from: Date, n: number, holidays: ReadonlySet<string> = new Set()): Date {
  let d = new Date(from.getTime());
  let left = n;
  while (left > 0) {
    d = new Date(d.getTime() + 86_400_000);
    if (isBusinessDay(d, holidays)) left -= 1;
  }
  while (!isBusinessDay(d, holidays)) d = new Date(d.getTime() + 86_400_000);
  return d;
}

export function addHours(from: Date, h: number): Date {
  return new Date(from.getTime() + h * 3_600_000);
}

export function deadlineFor(from: Date, w: { businessDays?: number; hours?: number }, holidays?: ReadonlySet<string>): Date {
  if (w.hours !== undefined) return addHours(from, w.hours);
  return addBusinessDays(from, w.businessDays ?? 0, holidays);
}

/** Adds business hours (09:00–17:00 Lagos) for the 4-business-hour support target. */
export function addBusinessHours(from: Date, hours: number, holidays: ReadonlySet<string> = new Set()): Date {
  let remaining = hours * 60;
  let t = new Date(from.getTime());
  while (remaining > 0) {
    const l = lagosDate(t);
    const minutes = l.getUTCHours() * 60 + l.getUTCMinutes();
    if (!isBusinessDay(t, holidays) || minutes >= 17 * 60) {
      // jump to 09:00 next day
      const next = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() + 1, 9, 0) - LAGOS_OFFSET_MS);
      t = next;
      continue;
    }
    if (minutes < 9 * 60) {
      t = new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), 9, 0) - LAGOS_OFFSET_MS);
      continue;
    }
    const step = Math.min(remaining, 17 * 60 - minutes);
    t = new Date(t.getTime() + step * 60_000);
    remaining -= step;
  }
  return t;
}
