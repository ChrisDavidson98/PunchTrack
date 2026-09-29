# PunchTrack — BuildTrackUnified integration + "Last checked" visits

Interviewed with Chris 2026-09-29. Every decision below was confirmed by Chris;
anything not confirmed is listed under **Open questions** — don't guess those.

---

## Part 1 — PunchTrack inside BuildTrackUnified

### Decisions
1. **Screen moves, data doesn't.** PunchTrack becomes the Punch tab inside
   BuildTrackUnified (repo `ChrisDavidson98/BuildTrack-Unified`). Punch items stay
   in PunchTrack's own sheet + Apps Script backend. The BuildTrackUnified page
   calls PunchTrack's backend directly. No merged database, no data copied.
2. **Security unchanged.** Each backend keeps its own `APP_TOKEN`. The
   BuildTrackUnified page holds both and sends each to its own backend. No shared
   token, no login. Rate limits on PunchTrack's backend stay as they are.
3. **Standalone PunchTrack page stays live for a trial period,** then gets retired
   once the tab has proven itself in the field. Retiring the page never touches
   data (it lives in the sheet). Before cutover: export each active house `.md`
   and/or copy the sheet as a backup.
4. **Opt-in per house.** Every house page keeps its Punch tab (per BuildTrackUnified's
   `docs/UI-REVAMP-SPEC.md`). Until a PunchTrack job exists for that address, the tab
   shows only a **"Start walkthrough"** button, which creates the job at that moment.
   The Punch ring and "Punch open" count stay hidden/em-dash until the job exists.
   Nothing is auto-created.
5. **Match on address** — the shared key between tools.

### Where it plugs in (existing placeholders in BuildTrackUnified `index.html`)
- `PunchPanel` / `PunchScreen` (currently a link-out to GitHub Pages).
- House page underline tab `['punch', 'Punch', '—', false]`.
- Today screen `KpiTile label="Punch open"` and the `Ring label="Punch"` per house.
- UI-REVAMP-SPEC §6 said "don't call the PunchTrack backend in this pass" — this
  spec is the later merge pass that lifts that.

### Practical note
This session has read-only access to BuildTrackUnified. Building Part 1 needs push
access to that repo (or a separate session opened on it).

---

## Part 2 — "Last checked" visits

### What counts as a visit (date-level, one per house per day)
A visit to a house is logged when Chris does any of these in the app for that house:
- **dictates/adds new items**
- **marks an item complete**
- **taps "Checked today"** (new button on the house screen — for visits where
  nothing got finished)

Does **not** count: editing an item, resolving a flag, reopening, sending a report.

Only Chris uses the app (he exports lists to message his helper), so there's no
"who" field. Known, accepted gap: marking an item complete off-site (e.g. helper
texted that a Prieb item is done) still logs a visit.

### Storage — new `Visits` sheet in PunchTrack's backend
One row per house per visit day: `slug | date | openItemIds | completedItemIds`
(exact columns can be settled at build time). "Last checked" per house and the
per-item "still open on" trail are **computed from this log**, not stored separately.
No AI calls — plain sheet writes, no API cost.

### Use 1 — spot neglected houses
Threshold depends on time to closing, counted in **workdays (Mon–Fri) only**;
nothing is flagged on Sat/Sun. Holidays count as normal workdays.

| Time until closing | Neglected when last visit was… |
|---|---|
| > 14 days, or no closing date | 3+ workdays ago |
| 8–14 days | 2+ workdays ago |
| ≤ 7 days | not today (flagged starting the next workday morning) |

**Priority order does not change.** Soonest-closing-first stays the one rule.
Neglected houses get a warning badge only.

### Use 2 — dispute trail with trades
For each item, the visits where it was still open ("still open on 9/19, 9/23, 9/26").
- **In the app:** a summary on the item — "open on 15 visits, first 9/2, last
  9/26" — with the full date list one tap away.
- **In the `.md` house archive:** printed in full on the item's line, alongside the
  existing logged / sent / completed dates.

---

## Open questions (ask Chris, don't assume)
- Which statuses count as "still open" on a visit — all non-completed
  (assignable, sent, flagged, self_assigned, Prieb items), or only some?
- Exact "Checked today" button placement and label.
- Suggested build order: Part 2 in PunchTrack first (backend + standalone page),
  then Part 1 in BuildTrackUnified so the tab ships with visits already working.
  Confirm.

Reminder: any `Code.gs` change must be pasted into the Apps Script editor and
redeployed before it takes effect.
