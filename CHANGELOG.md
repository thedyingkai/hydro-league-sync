# Changelog

All notable changes to this project are documented in this file.

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
