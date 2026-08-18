# Project Context

## Who this is for
Chris — Superintendent at Prieb Homes (high-volume residential new home builder), Olathe/KC metro area. Builds internal tools to run job site walkthroughs and manage multiple houses across subdivisions simultaneously. Non-technical background, learning API/JSON/dev concepts as he builds — wants to understand *why* something works, not just have it work.

## Tool ecosystem (context, even if this repo is just one of them)
- **BuildTrack** — house milestone/bonus/closings tracker. Google Sheets backend via Apps Script.
- **PunchTrack** — voice-dictated walkthrough punch items. Dictate → parse → review → ship.
- **Scope Deviation Protocol** — voice-dictate contract change items, auto-email trades, log follow-up.
- **Schedule Trend** — ingests weekly schedule PDFs company-wide, spots slippage/bottleneck trends.

## Architecture principles — do not relitigate these
- Tools stay **separate and independently backended**, linked only by shared address as a common key. Deliberately not one merged database — keeps each tool small and fast as data grows.
- Creating a house in one tool does **not** auto-create linked jobs in others — those are opt-in, created only once a house actually reaches that real-world stage.
- **Token-efficient pattern:** send deltas + a rolling carried-forward summary, not full history. Code pre-filters (by neighborhood/date/etc.) *before* anything reaches Claude. Claude handles query-translation and narration — never raw full dumps. Aggregate math happens in code, not token-by-token in the model.
- Budget-conscious on API usage — flag anything that looks like it'll meaningfully increase per-query cost.

## How Chris likes to work
- **No guessing on assumptions.** If a rubric, timeline, or business rule isn't confirmed, ask — don't infer and move on. Wrong assumptions are his worst-case failure mode.
- Prefers being interviewed thoroughly on domain rules before code gets written, even if that's slower up front.
- Wants to understand the underlying reasoning (cost structure, why a filter step exists, etc.), not just receive a working feature.

## Domain reference (construction workflow — for accuracy across all tools)
- **Stage sequence:** foundation (service pulled → hole dug → formed/poured → backfill) → framing → flat work → roof → rough-in (framing + MEP: E-Mech/electrical, P-Mech/plumbing, M-Mech/HVAC, with a "Furdown" carpentry step between P-Mech and E-Mech) → RI Inspect → ReRI Inspect (ranks *above*/more-progressed than RI Inspect) → sheetrock → trim → paint → finish trades (tile, countertops, fireplace, mirrors, hardware) → closing.
- **Inspection sequence = unlock gates**, not just checkboxes: structural/foundation report → underslab plumbing inspection → garage portal → rough-in (incl. gas pressure test) → home efficiency rater visit → pre-placement concrete → combined final inspection (life-safety + exterior + permit-hold) → certificate of occupancy (required for lender funding/closing). Passing gas/electrical inspection is a prerequisite for ordering utility meter installs.
- **Superintendent-to-neighborhood map:** Chris → Woodland Hills + Ranch Villas of Prairie Farms; Jason → Prairie Farms (distinct from Ranch Villas despite similar name); Jack → Canyon Lakes; Ashton → multifamily (only sometimes on the shared sheet).
- **Culture norm:** a job "sitting" with no schedule movement must always have an explainable reason — never treated as normal without one.
- **Vendor trust dynamic:** some trades pad/misstate timelines (counter-adjust their estimates downward), some are uninvolved but want to seem informed, some are reliably honest. This is tracked per-vendor and should inform any vendor-facing scoring or output.

## House walkthrough / punch process
- Pre-walkthrough punch list done by helper first (recurring items: doors/windows/plumbing/electrical/garage/screens/caulking) → cleaners scheduled after → actual walkthrough (~1.5–2 hrs): printed packet, then live walkthrough generating items by assignee, emailed out.
- Homeowner emotional/frustrated messages route through the company's in-house agent, not directly to Chris.
- Post-move-in: unresolved items are binding punch-out obligations. 3-month and 11-month warranty windows exist for non-emergency items.

## Trade email conventions (use exactly, don't improvise format)
- Subject line = recipient's name only.
- Body opens: "Good morning. Can you please have the below listed items completed at the above address prior to [date]"
- Bullets formatted as `Room: Item` (colon separator, sub-location in parens allowed, related fixes combined with semicolons).
- Cleaners typically scheduled the day after the deadline (day before closing).

## PunchTrack-specific notes
- Review-item inputs (room/item/assignee) in the pending-review layout must each have `width: "100%"` or `flex: 1` set explicitly — a bare `S.tIn` style falls back to the browser's default input width (~20 chars) and leaves dead space instead of filling the row. Fixed once already for the item/description field ([index.html](index.html)) — check for the same gap if new fields are added to that layout.
- `Code.gs` in this repo is a **copy**, not a live sync — Apps Script does not pull from GitHub automatically. After any Code.gs change is pushed here, it still has to be manually pasted into the Apps Script editor and redeployed (Deploy > new deployment / manage deployments) before it takes effect.

---
*This is a shared/starter context file. Add tool-specific data models, status flows, and file structure notes for whichever repo this lives in.*
