// Tunable thresholds for the dashboard. One place to adjust without
// hunting through metrics / worklist code. Times are in days unless noted.

export const DASHBOARD_CONFIG = {
  /** A quote is "active" if sent within this many days and not yet approved. */
  activeQuoteWindowDays: 60,
  /** Booked-recent KPI window. */
  recentlyBookedWindowDays: 30,
  /** Drafted-not-sent surfaces in worklist after this many days idle. */
  draftStaleDays: 1,
  /** How long a quote gets to be answered before it counts in conversion.
   *  A quote sent yesterday is not a loss, it is undecided, and counting it
   *  as one means every send wave makes whichever group was mailed look bad
   *  for a week. Measured live 2026-09-04: a 51-quote wave pushed the
   *  Neighbors rate to 27% while the settled figure was 71%, which is the
   *  opposite conclusion. Applies identically to Neighbors, Regular and the
   *  overall rate, and to Insights' close ratio, which shares the rule. */
  conversionCoolingDays: 7,
  /** Sent-no-reply surfaces in worklist after this many days idle. */
  sentNoReplyStaleDays: 3,
  /** Cap how many worklist rows we render (newest-first). */
  worklistMaxRows: 25,
  /** Holiday season goal — total bookings target. The "47/50 homes" example
   *  from VISION.md §5 lands here. Edit when Naldo raises/lowers the target. */
  holidaySeasonGoalHomes: 50,
} as const;
