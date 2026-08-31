# XCPCIO Board upstream record

- Package: `@xcpcio/board-app@0.85.4`
- Repository: https://github.com/xcpcio/xcpcio/tree/main/packages/apps/board
- Package license: MIT
- Published tarball integrity: `sha512-COfNOcBDH9eIl9JGhxXC2LvTuLcw2NqhYNZfOf6D8fO+3MISzgh+rpyK9htKpCxDWojXkORMp76T+6GDf6trHQ==`

The official 0.85.4 board bundle is intentionally not copied here. Its normal
Board entry statically imports `pagination-2onPPYtS.js`, which embeds
Highcharts 13.0.0 under the separate Highcharts commercial/non-commercial
license. Hiding the Statistics tab does not prevent that code from loading.

A scoreboard-only source fork was rebuilt from XCPCIO tag `v0.85.4`, commit
`84dacae07884d90f6db6d6664e55f8552524ef08`. It removes the Statistics,
rating, Resolver, Balloon, and Countdown implementations together with all
Highcharts and GSAP imports and dependencies. See
`../xcpcio-board-app-scoreboard-only/FORK.md` and
`../xcpcio-board-app-scoreboard-only/SCOREBOARD_ONLY.patch`.

Only that reviewed output is distributed. The build-time verifier pins the
full asset-tree digest and rejects Highcharts/GSAP markers. The official
compiled bundle remains excluded.
