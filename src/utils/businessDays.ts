/**
 * Business-Day Scheduling Utility
 * 
 * Provides timezone-aware, DST-safe calculation of sequence step follow-up times
 * based on campaign and mailbox sending-day configurations.
 * 
 * Semantics:
 * - delayDays = 0: Same eligible sending day/time. If currently outside window or on a disabled
 *   day, advances to the next eligible sending slot.
 * - delayDays = N (N > 0): Advances by N allowed sending days (e.g., Monday-Friday), skipping
 *   any disabled days (weekends or non-sending days).
 * - Preserves the intended local clock time where possible.
 * - If effective sending days cannot be resolved (empty or invalid), FAILS CLOSED (returns null).
 */

export const CANONICAL_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type CanonicalDay = typeof CANONICAL_DAYS[number];

const DAY_MAP: Record<string, CanonicalDay> = {
  'MON': 'MON', 'MONDAY': 'MON',
  'TUE': 'TUE', 'TUESDAY': 'TUE',
  'WED': 'WED', 'WEDNESDAY': 'WED',
  'THU': 'THU', 'THURSDAY': 'THU',
  'FRI': 'FRI', 'FRIDAY': 'FRI',
  'SAT': 'SAT', 'SATURDAY': 'SAT',
  'SUN': 'SUN', 'SUNDAY': 'SUN',
};

const WEEKDAY_NAMES: CanonicalDay[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * Normalizes any sending-day configuration into a unique set of canonical uppercase day codes.
 * Returns empty array [] if invalid or empty (fails closed).
 */
export function normalizeSendingDays(raw: any): CanonicalDay[] {
  if (!raw) return [];

  let items: any[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) items = parsed;
      } catch (_) {
        return [];
      }
    } else if (trimmed.includes(',')) {
      items = trimmed.split(',');
    } else if (trimmed.length > 0) {
      items = [trimmed];
    }
  }

  const validDays = new Set<CanonicalDay>();
  for (const item of items) {
    if (typeof item === 'string') {
      const clean = item.trim().toUpperCase();
      const mapped = DAY_MAP[clean] || DAY_MAP[clean.slice(0, 3)];
      if (mapped) validDays.add(mapped);
    }
  }

  return Array.from(validDays);
}

/**
 * Resolves effective sending days respecting both campaign and assigned mailbox restrictions.
 * Effective days are NEVER broader than either configuration (strictly computes intersection).
 * If either configuration produces an empty set, or if their intersection is empty,
 * FAILS CLOSED by returning [].
 */
export function resolveEffectiveSendingDays(params: {
  campaignDays?: any;
  mailboxDays?: any;
}): CanonicalDay[] {
  const hasCampaign = params.campaignDays !== undefined && params.campaignDays !== null;
  const hasMailbox = params.mailboxDays !== undefined && params.mailboxDays !== null;

  if (hasCampaign && hasMailbox) {
    const camp = normalizeSendingDays(params.campaignDays);
    const mb = normalizeSendingDays(params.mailboxDays);
    if (camp.length === 0 || mb.length === 0) return [];
    // Strict intersection
    return camp.filter(d => mb.includes(d));
  } else if (hasCampaign) {
    return normalizeSendingDays(params.campaignDays);
  } else if (hasMailbox) {
    return normalizeSendingDays(params.mailboxDays);
  }

  // If neither is provided, fail closed
  return [];
}

export interface ZonedDateParts {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  hour: number;  // 0-23
  minute: number;// 0-59
  second: number;// 0-59
  millisecond: number;
  weekday: CanonicalDay;
}

/**
 * Deconstructs a UTC Date into local date parts for a specific timezone using Intl.DateTimeFormat.
 */
export function getZonedParts(date: Date, timeZone: string = 'Asia/Kolkata'): ZonedDateParts {
  const tz = timeZone || 'Asia/Kolkata';
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') partMap[p.type] = p.value;
  }

  const rawWeekday = (partMap.weekday || '').toUpperCase().slice(0, 3);
  const weekday: CanonicalDay = DAY_MAP[rawWeekday] || 'MON';

  return {
    year: parseInt(partMap.year || '1970', 10),
    month: parseInt(partMap.month || '1', 10),
    day: parseInt(partMap.day || '1', 10),
    hour: parseInt(partMap.hour || '0', 10),
    minute: parseInt(partMap.minute || '0', 10),
    second: parseInt(partMap.second || '0', 10),
    millisecond: date.getUTCMilliseconds(),
    weekday
  };
}

/**
 * Converts local calendar year, month, day, hour, minute, second, ms in timeZone back to an exact UTC Date.
 * Uses an iterative offset resolution to guarantee DST correctness across transitions without 1-hour drift.
 */
export function zonedToUtcDate(
  year: number,
  month: number, // 1-12
  day: number,   // 1-31
  hour: number,  // 0-23
  minute: number,// 0-59
  second: number,// 0-59
  millisecond: number = 0,
  timeZone: string = 'Asia/Kolkata'
): Date {
  const tz = timeZone || 'Asia/Kolkata';

  // Initial UTC guess
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));

  for (let iter = 0; iter < 3; iter++) {
    const z = getZonedParts(guess, tz);
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    const actualAsUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
    const diff = desiredAsUtc - actualAsUtc;

    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }

  // Preserve original milliseconds
  return new Date(guess.getTime() - (guess.getUTCMilliseconds() - millisecond));
}

/**
 * Adds N local calendar days using UTC mid-day arithmetic to guarantee no DST boundary shifts.
 */
export function addLocalCalendarDays(
  year: number,
  month: number, // 1-12
  day: number,   // 1-31
  daysToAdd: number
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + daysToAdd, 12, 0, 0));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate()
  };
}

/**
 * Returns the canonical day of week for given local calendar date.
 */
export function getLocalDayOfWeek(year: number, month: number, day: number): CanonicalDay {
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const dayIndex = d.getUTCDay();
  return WEEKDAY_NAMES[dayIndex] || 'MON';
}

export interface ParsedTime {
  hour: number;
  minute: number;
  second: number;
}

export function parseTimeString(timeStr?: string | null): ParsedTime | null {
  if (!timeStr) return null;
  const trimmed = timeStr.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const h = match[1] ?? '0';
  const m = match[2] ?? '0';
  const s = match[3] ?? '0';
  return {
    hour: parseInt(h, 10),
    minute: parseInt(m, 10),
    second: parseInt(s, 10)
  };
}

/**
 * Normalizes time string to standard HH:MM:SS format.
 */
export function normalizeTimeString(timeStr?: string | null): string | null {
  const parsed = parseTimeString(timeStr);
  if (!parsed) return null;
  const h = String(parsed.hour).padStart(2, '0');
  const m = String(parsed.minute).padStart(2, '0');
  const s = String(parsed.second).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export interface CalculateNextEligibleSendTimeParams {
  from?: Date | string | number | null;
  delayDays: number;
  sendingDays?: any;
  sendingWindowStart?: string | null;
  sendingWindowEnd?: string | null;
  timezone?: string | null;
}

/**
 * Calculates the exact next eligible send time for a sequence step.
 * 
 * Rules:
 * 1. Fails closed (returns null) if delayDays < 0, or if allowed sendingDays cannot be resolved.
 * 2. If delayDays = 0: checks if current day is allowed. If not, advances to the first allowed day.
 * 3. If delayDays > 0: advances by delayDays allowed sending days (e.g. Thu + 2 on Mon-Fri = Mon).
 * 4. Preserves intended local clock time.
 * 5. If local time is outside [sendingWindowStart, sendingWindowEnd]:
 *    - if before window start: sets time to window start on that day.
 *    - if after window end: window on that day is expired; advances to the next eligible sending day at window start.
 */
export function calculateNextEligibleSendTime(params: CalculateNextEligibleSendTimeParams): Date | null {
  if (params.delayDays < 0) return null;

  const allowedDays = Array.isArray(params.sendingDays) && params.sendingDays.every(d => CANONICAL_DAYS.includes(d as any))
    ? (params.sendingDays as CanonicalDay[])
    : normalizeSendingDays(params.sendingDays);

  // FAIL CLOSED if no allowed days
  if (allowedDays.length === 0) {
    return null;
  }

  const timeZone = params.timezone || 'Asia/Kolkata';
  const baseDate = params.from ? new Date(params.from) : new Date();
  if (isNaN(baseDate.getTime())) return null;

  const parts = getZonedParts(baseDate, timeZone);
  let curYear = parts.year;
  let curMonth = parts.month;
  let curDay = parts.day;
  let curWeekday = parts.weekday;

  const startParsed = parseTimeString(params.sendingWindowStart);
  const endParsed = parseTimeString(params.sendingWindowEnd);
  const startStr = normalizeTimeString(params.sendingWindowStart);
  const endStr = normalizeTimeString(params.sendingWindowEnd);

  let targetHour = parts.hour;
  let targetMinute = parts.minute;
  let targetSecond = parts.second;
  let targetMs = parts.millisecond;

  if (params.delayDays === 0) {
    // If delay is 0, check if today is an allowed day
    if (!allowedDays.includes(curWeekday)) {
      // Advance to the first allowed sending day
      let safety = 0;
      while (!allowedDays.includes(curWeekday) && safety++ < 14) {
        const nextCal = addLocalCalendarDays(curYear, curMonth, curDay, 1);
        curYear = nextCal.year;
        curMonth = nextCal.month;
        curDay = nextCal.day;
        curWeekday = getLocalDayOfWeek(curYear, curMonth, curDay);
      }
      // Since base date was on disabled day, if window start is defined, align to window start
      if (startParsed) {
        targetHour = startParsed.hour;
        targetMinute = startParsed.minute;
        targetSecond = startParsed.second;
        targetMs = 0;
      }
    } else if (startStr && endStr && startParsed) {
      // On an allowed day with 0 delay: check window bounds
      const curTimeStr = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}:${String(parts.second).padStart(2, '0')}`;
      if (curTimeStr < startStr) {
        // Before window: align to start
        targetHour = startParsed.hour;
        targetMinute = startParsed.minute;
        targetSecond = startParsed.second;
        targetMs = 0;
      } else if (curTimeStr > endStr) {
        // After window: today's window closed, advance to next allowed day at window start
        let safety = 0;
        let advanced = false;
        while ((!advanced || !allowedDays.includes(curWeekday)) && safety++ < 14) {
          const nextCal = addLocalCalendarDays(curYear, curMonth, curDay, 1);
          curYear = nextCal.year;
          curMonth = nextCal.month;
          curDay = nextCal.day;
          curWeekday = getLocalDayOfWeek(curYear, curMonth, curDay);
          advanced = true;
        }
        targetHour = startParsed.hour;
        targetMinute = startParsed.minute;
        targetSecond = startParsed.second;
        targetMs = 0;
      }
      // If within window, preserve local time as-is
    }
  } else {
    // delayDays > 0: count delayDays allowed sending days
    let daysCounted = 0;
    const maxSearchDays = Math.max(365, params.delayDays * 14);
    let safety = 0;

    while (daysCounted < params.delayDays && safety++ < maxSearchDays) {
      const nextCal = addLocalCalendarDays(curYear, curMonth, curDay, 1);
      curYear = nextCal.year;
      curMonth = nextCal.month;
      curDay = nextCal.day;
      curWeekday = getLocalDayOfWeek(curYear, curMonth, curDay);

      if (allowedDays.includes(curWeekday)) {
        daysCounted++;
      }
    }

    if (daysCounted < params.delayDays) {
      return null;
    }

    // Check window constraints on the calculated date
    if (startStr && endStr && startParsed) {
      const targetTimeStr = `${String(targetHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')}:${String(targetSecond).padStart(2, '0')}`;
      if (targetTimeStr < startStr) {
        // Before window start: normalize to window start
        targetHour = startParsed.hour;
        targetMinute = startParsed.minute;
        targetSecond = startParsed.second;
        targetMs = 0;
      } else if (targetTimeStr > endStr) {
        // After window end: advance to next eligible day at window start
        let advanceSafety = 0;
        let advanced = false;
        while ((!advanced || !allowedDays.includes(curWeekday)) && advanceSafety++ < 14) {
          const nextCal = addLocalCalendarDays(curYear, curMonth, curDay, 1);
          curYear = nextCal.year;
          curMonth = nextCal.month;
          curDay = nextCal.day;
          curWeekday = getLocalDayOfWeek(curYear, curMonth, curDay);
          advanced = true;
        }
        targetHour = startParsed.hour;
        targetMinute = startParsed.minute;
        targetSecond = startParsed.second;
        targetMs = 0;
      }
      // If within window, preserve local time as-is
    }
  }

  return zonedToUtcDate(curYear, curMonth, curDay, targetHour, targetMinute, targetSecond, targetMs, timeZone);
}
