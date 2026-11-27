/**
 * The three clocks that disagree on purpose (PLAN Phase 2.2):
 * - leads are stamped in the sites' zone, Asia/Karachi (UTC+05:00, no DST);
 * - the (synthetic) Ads account reports in America/New_York (DST ends 2026-11-01 at 02:00 local);
 * - reports and reconciliation use UTC dates.
 * A click near midnight lands on three different calendar dates, and 01:30 in New York happens twice
 * on 2026-11-01. The eval fixtures pin those cases; the demo leads fall wherever the seed puts them.
 */
export const LEAD_TIME_ZONE = "Asia/Karachi";
export const ADS_ACCOUNT_TIME_ZONE = "America/New_York";
export const REPORT_TIME_ZONE = "UTC";

export interface ZonedTime {
  timeZone: string;
  /** ISO 8601 local wall time with the zone's offset at that instant, e.g. 2026-11-02T00:30:00+05:00. */
  local: string;
  /** The calendar date in that zone. */
  date: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "longOffset",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Local wall time of `instant` in `timeZone`, with its UTC offset. Whole seconds only. */
export function inZone(instant: Date, timeZone: string): ZonedTime {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  // "GMT+05:00", "GMT-04:00", or "GMT" for a zero offset.
  const offset = (parts.timeZoneName ?? "GMT").replace("GMT", "") || "+00:00";
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    timeZone,
    local: `${date}T${parts.hour}:${parts.minute}:${parts.second}${offset}`,
    date,
  };
}

/** `2026-11-01T06:30:00.000Z` → `2026-11-01T06:30:00Z` (whole seconds, as the generator makes them). */
export function utcIso(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface LeadTimes {
  utc: string;
  /** In the site's zone (Asia/Karachi). */
  site: ZonedTime;
  /** In the Ads account's zone (America/New_York). */
  adsAccount: ZonedTime;
  /** The UTC calendar date reports group by. */
  reportDate: string;
}

export function leadTimes(instant: Date, siteTimeZone: string = LEAD_TIME_ZONE): LeadTimes {
  return {
    utc: utcIso(instant),
    site: inZone(instant, siteTimeZone),
    adsAccount: inZone(instant, ADS_ACCOUNT_TIME_ZONE),
    reportDate: utcIso(instant).slice(0, 10),
  };
}
