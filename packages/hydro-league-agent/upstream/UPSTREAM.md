# Upstream record

The `hydro-realboard` directory is an unmodified source snapshot of:

- Repository: https://github.com/HandsomeRun/hydro-realboard.git
- Commit: `fa662b5a1b817d4e73f3f44f5cc0ee9441851a3c`
- License: GNU Affero General Public License version 3

It was downloaded as a commit archive, so this package intentionally contains
no nested `.git` directory. Its original `LICENSE` and `NOTICE` remain in that
directory. Hydro League Agent's new views use separate `leagueboard` and
`league-realboard` names and do not replace the upstream `realboard` route.
The active derivative is `frontend/league-realboard.page.tsx`; it retains the
upstream React/React Spring presentation while adapting its input to the
authenticated league XCPCIO all-in-one proxy. The companion adapted stylesheet
is `public/hydro-league-realboard.css`.

The `hydrooj-scoreboard-xcpcio` directory is the unmodified npm source snapshot
of `@hydrooj/scoreboard-xcpcio@0.1.0` from the Hydro repository, published from
git commit `2b7b974d86e1edf093befee1e83321f33b007d08` under
AGPL-3.0-or-later. League Agent's `league-xcpcio` route is a separate forked
integration and does not replace Hydro's `xcpcio` route.

The `xcpcio-board-app` directory records `@xcpcio/board-app@0.85.4` and retains
its MIT license. See its `UPSTREAM.md` for the separate Highcharts license
boundary that applies to the official compiled bundle.

The `xcpcio-board-app-scoreboard-only` directory is a source fork of XCPCIO tag
`v0.85.4`, commit `84dacae07884d90f6db6d6664e55f8552524ef08`.
`SCOREBOARD_ONLY.patch` is the exact patch against that commit. The fork strips
Statistics, rating, Resolver, Balloon, Countdown, Highcharts, and GSAP before
building the self-hosted `league-xcpcio` assets.
