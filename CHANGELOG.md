# Changelog

All notable changes to this project are documented in this file.

## Unreleased

- Added an isolated, read-only CLICS 2023-06 broadcast API for ICPC Live with
  server-side public freeze filtering and persistent streaming notifications.
- Added a separate broadcast token, preserved by the Excel importer, and Docker
  environment wiring without sharing administrator credentials with the overlay.
- Added ICPC Live configuration generation, connection checks, data-only OBS
  setup, and regression coverage for frozen/rejudged/reconnected live feeds.
- Added a local three-school demo with independent authenticated simulators,
  durable queues, outage recovery, rejudging, and an ICPC Live dashboard.
- Documented central Hub deployment, per-school Hydro Agent configuration,
  broadcast setup, upgrades, and multi-school acceptance checks.

## 0.1.2 - 2026-09-01

- Allowed the self-hosted Agent wrapper to consume a deliberately configured,
  same-origin historical `/scoreboard/xcpcio?json=true` data endpoint.
- Changed object-form XCPCIO medal settings to retain only the explicitly
  configured Gold, Silver, and Bronze tiers, keeping manual awards authoritative
  instead of adding the upstream implicit Honorable tier.
- Documented that the historical warmup contest uses an empty medal setting and
  therefore has no awards; historical final-contest group awards remain manual.
- Excluded local XCPCIO build dependencies and generated output from Agent
  release packages while retaining the pinned fork source, patch, and license.

## 0.1.1 - 2026-09-01

- Added persisted school badge URLs and XCPCIO team groups, including custom
  medal counts for Chinese and other non-ASCII group names.
- Added persisted manual awards to Hub configuration, Contest API resources,
  the final event feed, and Resolver-compatible CDP `awards.json` exports.
- Added validated organization-logo metadata and bundled `56x56`/`160x160`
  school-emblem files to Contest API and Resolver CDP exports for same-origin
  PNG/JPEG badge assets.
- Fixed historical XCPCIO balloon colors to prefer each problem's `rgb` value
  while preserving both `color` and `rgb` in Contest API resources.
- Extended the Excel importer with school badge, team group, medal setting,
  and manual award fields, with validation for invalid or hidden references.
- Added backward-compatible SQLite migrations and configuration round-trips
  for the new XCPCIO presentation and award metadata.

## 0.1.0 - 2026-09-01

- Added reliable Hydro beta9 submission capture, persistent outbox delivery,
  HMAC authentication, heartbeats, and full-state reconciliation.
- Added the central Hub with idempotent ingestion, ACM/ICPC scoring, CE without
  penalty, unofficial teams, freeze-aware public/jury views, and site status.
- Added the self-hosted XCPCIO scoreboard fork and the Hydro Realboard fork
  without replacing existing `realboard` or `xcpcio` routes.
- Added Excel-driven global team/problem mapping, Contest API 2023-06 CDP
  export, explicit finalize/publish operations, and deployment runbooks.
- Added a rollback-safe beta9 installer, offline bundled runtime dependencies,
  public source archives, CI, and release checksums.
