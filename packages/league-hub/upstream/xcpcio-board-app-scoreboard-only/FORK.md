# Scoreboard-only XCPCIO fork

This directory is a source fork of `packages/apps/board` from XCPCIO tag
`v0.85.4`, commit `84dacae07884d90f6db6d6664e55f8552524ef08`.
`SCOREBOARD_ONLY.patch` records the changes against that exact directory.

The fork removes Rating, Statistics, Resolver, Balloon, Countdown, the contest
index, and their build dependencies. In particular, it removes `highcharts`,
`highcharts-vue`, and `gsap`. The catch-all route renders only the Board
component. `hls.js` remains because the Board team-stream modal uses it
directly. Hydro League Sync additionally extends the all-in-one input with an
optional `league_status` object, renders an in-board warning when one or more
schools are delayed or offline, and exposes the AGPL corresponding-source link
when the same-origin wrapper supplies one. The standings row adapter also keeps
unofficial teams visible while displaying `*` for them and computing displayed
places from official teams only. For object-form custom medal maps, the fork
also treats the configured Gold, Silver, and Bronze thresholds as exhaustive
and removes XCPCIO Core's implicit unbounded Honorable tier; string presets
such as `ccpc` retain their upstream behavior. The rank table, scoring model, filtering,
replay controls, and responsive layout remain XCPCIO implementations.

The reviewed build used:

```text
npm install --legacy-peer-deps --ignore-scripts --include=optional --no-audit --no-fund
npm run build
```

It completed with Node 22.12.0, npm 10.9.0, Vite 8.2.2, 542 transformed
modules, and a 9.13 second production build. The distributable assets are
self-hosted under `public/hydro-league-xcpcio/vendor`:

- Entry: `assets/index-DGIVwg0I.js`
- Stylesheet: `assets/index-BNXIDeGh.css`
- Files: 15
- Bytes: 2,547,128
- Tree SHA-256: `ff6ad38b44a2359477d1a9a2c4505e3b598d61be75c791507cb78207bd5b7ea8`

`tools/verify-xcpcio-assets.mjs` verifies the manifest, full asset-tree digest,
local import closure, required notices, and the absence of Highcharts/GSAP
markers on every build. `tools/smoke-xcpcio.mjs` exercises the installed
wrapper with a loopback-only mock source and fails on external network access.

The upstream `dist/index.html` is not shipped because it contains analytics
and public-CDN integrations. Hydro League Agent supplies a strict same-origin
wrapper with its own content-security policy.
