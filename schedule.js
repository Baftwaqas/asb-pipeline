// ============================================================================
// ASB PIPELINE — schedule.js
//
// Which delivery an order belongs to. This is ASB's booking calendar, as set
// by Waqas on 2026-09-28:
//
//   Sunday     before 8pm  -> Monday delivery      after 8pm -> Thursday
//   Monday                 -> Thursday
//   Tuesday                -> Thursday
//   Wednesday  before 8pm  -> Thursday delivery    after 8pm -> Monday
//   Thursday               -> Monday
//   Friday                 -> Monday
//   Saturday               -> Monday
//
// Put another way there are exactly two cut-offs a week, Sunday 8pm and
// Wednesday 8pm, and an order belongs to the FIRST cut-off still ahead of it.
// Delivery is the day after that cut-off. Booking for the next delivery opens
// the moment the previous cut-off passes.
//
// "Closes at 8pm" is read literally: 19:59:59 makes Monday, 20:00:00 does not.
//
// All of this is Karachi time. Pakistan is UTC+5 all year with no daylight
// saving, so a fixed offset is correct and needs no time-zone database - which
// matters, because Render's containers do not reliably ship one.
//
// Pure: no database, no clock of its own. Pass the order time in.
// ============================================================================

"use strict";

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Cut-off weekday (0 = Sunday) -> the delivery it closes.
const CUTOFFS = [
  { dow: 0, label: "Monday" },    // Sunday 8pm closes Monday's delivery
  { dow: 3, label: "Thursday" },  // Wednesday 8pm closes Thursday's delivery
];
const CUTOFF_HOUR = 20;

/**
 * The delivery an order placed at `orderedAt` belongs to.
 *
 * Returns:
 *   code          'C-2026-09-29'   one cycle per delivery date
 *   deliveryDate  '2026-09-29'     a calendar date, Karachi
 *   deliveryDay   'Monday' | 'Thursday'
 *   locksAt       Date             the cut-off, as a real instant
 *   opensAt       Date             the previous cut-off
 */
function deliveryFor(orderedAt = new Date()) {
  const t = orderedAt instanceof Date ? orderedAt : new Date(orderedAt);
  if (Number.isNaN(t.getTime())) throw new Error(`deliveryFor: bad time ${orderedAt}`);

  // Shift into Karachi wall-clock time and read it with the UTC getters.
  const local = new Date(t.getTime() + PKT_OFFSET_MS);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());

  // Walk forward day by day to the first cut-off strictly after the order.
  // At most 7 steps; one of the two cut-offs is always within the week.
  for (let d = 0; d <= 7; d++) {
    const dayStart = midnight + d * DAY_MS;
    const dow = new Date(dayStart).getUTCDay();
    const cut = CUTOFFS.find((c) => c.dow === dow);
    if (!cut) continue;

    const cutoffLocal = dayStart + CUTOFF_HOUR * 60 * 60 * 1000;
    if (cutoffLocal <= local.getTime()) continue; // 8pm or later: missed it

    const deliveryLocal = new Date(dayStart + DAY_MS);
    const deliveryDate = deliveryLocal.toISOString().slice(0, 10);

    // The previous cut-off: 4 days before Sunday's (Wednesday) or 3 days
    // before Wednesday's (Sunday).
    const gapDays = cut.dow === 0 ? 4 : 3;

    return {
      code: `C-${deliveryDate}`,
      deliveryDate,
      deliveryDay: cut.label,
      locksAt: new Date(cutoffLocal - PKT_OFFSET_MS),
      opensAt: new Date(cutoffLocal - gapDays * DAY_MS - PKT_OFFSET_MS),
    };
  }
  throw new Error("deliveryFor: no cut-off found within a week (schedule misconfigured)");
}

/** The cycle after `slot` - used when a cycle was closed early by hand. */
function nextAfter(slot) {
  return deliveryFor(new Date(slot.locksAt.getTime() + 1000));
}

module.exports = { deliveryFor, nextAfter, CUTOFF_HOUR };
