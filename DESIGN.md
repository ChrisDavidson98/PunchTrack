# Design Direction — Unified Dashboard (Future Reference)

> Status: **Not yet built.** This is the intended visual/UX direction for the eventual
> unified landing page that merges BuildTrack, PunchTrack, Scope Deviation, and
> Schedule Trend. Keep new component styling loosely consistent with this where it
> doesn't cost extra effort now, but don't build the dashboard itself until it's
> explicitly prioritized.

## Overall aesthetic
Minimalist "trendy web app" look — closer to a modern SaaS product than a typical
internal business tool. Reference points: **Linear, Vercel, Raycast, Arc**.

- Monochrome base palette + a single accent color (accent used sparingly — status,
  active states, key numbers — not decoration)
- Thin borders instead of heavy drop-shadow cards
- Generous whitespace — avoid dense/cramped layouts
- Subtle motion on state changes (hover, load, status flips) — nothing flashy

## Typography
- **Barlow Condensed** — headers / titles
- **DM Mono** — data, numbers, timestamps, anything tabular

## Core dashboard concept
- One merged frontend, but backends stay separate per tool (BuildTrack,
  PunchTrack, Scope Deviation, Schedule Trend each keep their own data store —
  the frontend just calls each backend directly, no merged database)
- Layout: Scope Deviation items on top, open PunchTrack items below, per house
- Small **radial 0–100% progress rings** per house, per linked tool
  - A ring for a given tool only renders once that house actually has a job in
    that tool — no placeholder/empty ring for tools a house hasn't reached yet
  - This mirrors the existing architecture principle: tools are independently
    backended and only linked by shared address as the common key, not merged
    into one database

## Why this matters
The whole point of these tools (vs. CoConstruct) is cross-house, cross-timeline
visibility that CoConstruct doesn't offer. The dashboard is the visual layer that
makes that comparability actually glanceable — status at a glance across houses,
not buried in per-house drill-downs.
