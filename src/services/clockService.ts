/**
 * MASAR Care — Timezone-Aware Clock Service (Audit Finding H1)
 *
 * Replaces hardcoded APP_REFERENCE_DATE usage across production code with an
 * injectable clock configured for Iraq's canonical clinical timezone (`Asia/Baghdad`, UTC+3).
 *
 * - Production runtime uses `LiveBaghdadClock` (or a demo/fixture clock when explicitly
 *   toggled in Demo Mode so historical demo seed records remain inspectable).
 * - Automated tests can inject `FixedBaghdadClock('2026-11-12')` or arbitrary dates/times
 *   to deterministically test midnight transitions, overdue cutoffs, and refill depletion.
 */

export const BAGHDAD_TIMEZONE = 'Asia/Baghdad';
export const DEMO_FIXTURE_DATE = '2026-11-12';
export type ClockMode = 'live_baghdad' | 'fixed_fixture';

/**
 * V1.5.4-QA Production Boundary Fix: Restrict fixed demonstration clock mode
 * strictly to local development (`import.meta.env.DEV === true` and `PROD !== true`).
 * Production clinical builds CANNOT enable `fixed_fixture` mode via deployment
 * environment variables (even if `VITE_ENABLE_DEMO_CLOCK=true` is misconfigured).
 * Automated tests inject `FixedBaghdadClock` directly via DI.
 */
export function isDemoClockModeEnabled(
  env: {
    DEV?: boolean;
    PROD?: boolean;
    VITE_ENABLE_DEMO_CLOCK?: string;
    VITE_DISABLE_DEMO_CLOCK?: string;
  } =
    ((
      import.meta as ImportMeta & {
        env?: {
          DEV?: boolean;
          PROD?: boolean;
          VITE_ENABLE_DEMO_CLOCK?: string;
          VITE_DISABLE_DEMO_CLOCK?: string;
        };
      }
    ).env ?? {})
): boolean {
  if (env.PROD === true || env.DEV !== true) {
    return false;
  }
  return env.VITE_DISABLE_DEMO_CLOCK !== 'true';
}

export function resolveRuntimeClockMode(
  requestedMode: ClockMode = 'live_baghdad',
  demoAllowed: boolean = isDemoClockModeEnabled()
): ClockMode {
  if (!demoAllowed) return 'live_baghdad';
  return requestedMode;
}

export interface IBaghdadClock {
  /** Current calendar date in Asia/Baghdad formatted as YYYY-MM-DD */
  todayDateStr(): string;
  /** Current time of day in Asia/Baghdad formatted as HH:mm (24-hour) */
  currentTimeStr(): string;
  /** Current ISO timestamp */
  nowIso(): string;
  /** Clock mode identifier */
  readonly mode: ClockMode;
}

/**
 * Formats a JavaScript Date into YYYY-MM-DD in Asia/Baghdad (UTC+3).
 */
export function formatBaghdadDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BAGHDAD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value ?? '2026';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

/**
 * Formats a JavaScript Date into HH:mm (24h) in Asia/Baghdad (UTC+3).
 */
export function formatBaghdadTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: BAGHDAD_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour === '24' ? '00' : hour}:${minute}`;
}

/**
 * Computes milliseconds remaining until the next 00:00:00 in Asia/Baghdad (UTC+3),
 * with a small +50ms safety buffer so callers always read the new local calendar date.
 */
export function msUntilNextBaghdadMidnight(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: BAGHDAD_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const ss = Number(parts.find((p) => p.type === 'second')?.value ?? '0');
  const elapsedMsToday = (hh * 3600 + mm * 60 + ss) * 1000 + now.getMilliseconds();
  const remainingMs = 86_400_000 - elapsedMsToday;
  return Math.max(1000, remainingMs + 50);
}

/**
 * Live system clock anchored to Asia/Baghdad (UTC+3).
 */
export class LiveBaghdadClock implements IBaghdadClock {
  public readonly mode = 'live_baghdad' as const;
  private readonly nowProvider: () => Date;

  constructor(nowProvider: () => Date = () => new Date()) {
    this.nowProvider = nowProvider;
  }

  todayDateStr(): string {
    return formatBaghdadDate(this.nowProvider());
  }

  currentTimeStr(): string {
    return formatBaghdadTime(this.nowProvider());
  }

  nowIso(): string {
    return this.nowProvider().toISOString();
  }
}

/**
 * Deterministic fixed clock for repeatable automated tests and demo fixture inspection.
 */
export class FixedBaghdadClock implements IBaghdadClock {
  public readonly mode = 'fixed_fixture' as const;
  private fixedDateStr: string;
  private fixedTimeStr: string;

  constructor(fixedDateStr: string = DEMO_FIXTURE_DATE, fixedTimeStr: string = '14:00') {
    this.fixedDateStr = fixedDateStr;
    this.fixedTimeStr = fixedTimeStr;
  }

  todayDateStr(): string {
    return this.fixedDateStr;
  }

  currentTimeStr(): string {
    return this.fixedTimeStr;
  }

  nowIso(): string {
    return `${this.fixedDateStr}T${this.fixedTimeStr}:00+03:00`;
  }
}

// Default active clock instance
let activeClock: IBaghdadClock = new LiveBaghdadClock();

export function getActiveClock(): IBaghdadClock {
  return activeClock;
}

export function setActiveClock(clock: IBaghdadClock): void {
  activeClock = clock;
}

export function getActiveBaghdadDateStr(): string {
  return activeClock.todayDateStr();
}
