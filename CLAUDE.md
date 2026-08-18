<!--
This macro block is meant to be pasted, verbatim or near-verbatim, at the top of
every tool's CLAUDE.md (BuildTrackUnified, PunchTrack, Schedule Trend). Keep it in
sync by hand when a cross-tool rule changes — there's no auto-sync between repos.
-->

## Who this is for

Chris — Superintendent at Prieb Homes, a high-volume residential new home builder,
Olathe/KC metro area. Field-based, managing multiple houses across subdivisions at
once. Builds internal tools himself because CoConstruct (the company's main system)
has no cross-house/cross-timeline intelligence — only per-house, per-assignee, or
per-vendor views. Non-technical background, learning API/JSON/dev concepts as he
builds — explain *why*, not just *what*.

## The tool ecosystem — context, not code you can see

- **BuildTrackUnified** — house milestone/bonus/closing tracker, with Scope Deviation
  (contract change items → trade emails → follow-up log) embedded inside it as its
  own section/tab. Google Sheets + Apps Script backend.
- **PunchTrack** — voice-dictated walkthrough punch items. Own repo, own backend.
- **Schedule Trend** — ingests weekly Thursday-meeting schedule PDFs (~100 houses,
  back to 2020) to spot slippage/bottleneck trends, with a vendor trust/reliability
  scoring layer. Own repo, own backend. A duration-baseline/drift layer is planned
  to be built *inside* this tool, not as a separate one.

**This file only describes the contract those other tools are expected to honor —
not their live code.** If you need to know what another tool's backend actually does
right now, that's out of scope for this repo/session; say so rather than guessing,
and trust what you find in *this* repo's own files over anything below if they ever
conflict.

## Architecture principles — do not relitigate these

- Tools stay **separate and independently backended**, linked only by shared address
  as the common key. Deliberately not one merged database — keeps each tool small and
  fast as data accumulates, and keeps a bug in one tool from taking down another.
- Creating a house in one tool does **not** auto-create linked jobs in others — those
  are opt-in, created only once a house actually reaches that real-world stage.
- Eventual direction (not yet built, reference only): one unified dashboard frontend
  that calls each tool's backend directly — still no merged database. Per-house radial
  progress rings per tool, rendered only once that house has a job in that tool. See
  each repo's own DESIGN.md if one exists for visual direction.
- **Token-efficient pattern:** send deltas + a rolling carried-forward summary to
  Claude, not full history. Code pre-filters (by neighborhood/date/etc.) before
  anything reaches the model; the model handles query-translation and narration,
  never raw dumps. Aggregate math happens in code, not token-by-token in the model.
- API cost budget: modest (~$20/mo as of mid-2026), open to more but flag anything
  that would meaningfully increase per-query spend.

## Security conventions — decided, don't re-open without asking

- Every backend requires an `APP_TOKEN` (Apps Script Script Property) on every
  request, checked via a `checkToken()` guard before any read/write/AI action runs.
  Never add a debug/status endpoint that returns the token or bypasses this check —
  that has bitten this project before.
- Every backend rate-limits via `CacheService` buckets (~60/min reads, ~20/min
  writes, ~10/min AI calls) plus a per-day AI cap tracked in Script Properties.
  This is the primary real protection, not the token — see below.
- **Known, accepted tradeoff:** `SCRIPT_URL` and `APP_TOKEN` are hardcoded in each
  tool's client-side `index.html`, which is served directly by public GitHub Pages
  repos. The token is *not* actually secret — anyone who finds the page can view-source
  it. This is a deliberate choice (rate limiting is the real backstop, not the token)
  rather than an oversight — don't "fix" it by architecting around it without asking.
- If `APP_TOKEN` is ever found to have leaked (e.g. via a debug endpoint, a bad log
  line, or being committed to a *newly-made-private* assumption that turns out
  false), rotate it in Script Properties immediately and say so.

## How Chris likes to work

- **No guessing on assumptions.** If a rubric, timeline, or business rule isn't
  confirmed, ask — don't infer and move on. Wrong assumptions are the worst-case
  failure mode, worse than the extra time spent asking.
- Prefers being interviewed thoroughly on domain rules before code gets written,
  even if that's slower up front.
- Wants to understand the underlying reasoning (cost structure, why a filter step
  exists, etc.), not just receive a working feature.

## Domain reference (construction workflow — for accuracy across all tools)

- **Stage sequence:** foundation (service pulled → hole dug → formed/poured →
  backfill) → framing → flat work → roof → rough-in (framing + MEP: E-Mech/electrical,
  P-Mech/plumbing, M-Mech/HVAC, with a "Furdown" carpentry step between P-Mech and
  E-Mech) → RI Inspect → ReRI Inspect (more progressed than RI Inspect) → sheetrock →
  trim → paint → finish trades (tile, countertops, fireplace, mirrors, hardware) →
  closing.
- **Inspection gates:** structural/foundation report → underslab plumbing inspection
  → garage portal → rough-in (incl. gas pressure test) → home efficiency rater visit
  → pre-placement concrete → combined final inspection (life-safety + exterior +
  permit-hold) → certificate of occupancy (required for lender funding/closing).
  Passing gas/electrical inspection is a prerequisite for utility meter installs.
- **Superintendent-to-neighborhood map:** Chris → Woodland Hills + Ranch Villas of
  Prairie Farms; Jason → Prairie Farms (distinct despite similar name); Jack →
  Canyon Lakes; Ashton → multifamily (only sometimes on the shared sheet).
- **Culture norm:** a job "sitting" with no schedule movement must always have an
  explainable reason.
- **Vendor trust dynamic:** some trades pad/misstate timelines (counter-adjust
  downward), some are uninvolved but want to seem informed, some are reliably
  honest — tracked per-vendor, informs vendor-facing scoring/output.

## Trade email conventions (use exactly, don't improvise format)

- Subject line = recipient's name only.
- Body opens: "Good morning. Can you please have the below listed items completed
  at the above address prior to [date]"
- Bullets as `Room: Item` (colon separator, sub-location in parens allowed, related
  fixes combined with semicolons).
- Cleaners typically scheduled the day after the deadline (day before closing).

---

## This repo: PunchTrack

Voice-dictated walkthrough punch items. Dictate → parse → review → ship.

### Data model
`Jobs` sheet: slug | address | closingDate | createdAt | lastUpdated.
`Items` sheet: id | slug | room | item | assignee | status | dateLogged | dateSent |
notes | dateCompleted. `status` ∈ assignable | flagged | self_assigned | sent.
An assignable item becomes "sent" when its report ships; flagged/self_assigned
items never auto-transition — self_assigned items get marked sent when Chris
ships/acknowledges his own list, flagged items only leave "flagged" when manually
resolved in the UI.

### Security status — has auth and rate limiting
- `checkToken()` is enforced on every GET/POST action.
- `CacheService` rate limiting (~60/min reads, ~20/min writes, ~10/min AI) plus a
  per-day AI cap (150/day, Script Properties) on `parseDictation`/`parseConfirmation` —
  ported 2026-08-18 from BuildTrackUnified's Scope Deviation backend, same pattern.
- `Code.gs` in this repo is a manual **copy**, not a live sync — Apps Script doesn't
  pull from GitHub automatically. After any change here, it still has to be pasted
  into the Apps Script editor and redeployed (Deploy > new deployment / manage
  deployments) before it takes effect. Say so explicitly if you edit this file.

### UI gotcha (already fixed once, watch for regressions)
Review-item inputs (room/item/assignee) in the pending-review layout must each have
`width: "100%"` or `flex: 1` set explicitly — a bare `S.tIn` style falls back to the
browser's default input width (~20 chars) and leaves dead space instead of filling
the row. Check for the same gap if new fields are added to that layout.
