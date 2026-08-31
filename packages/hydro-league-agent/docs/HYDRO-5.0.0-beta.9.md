# Hydro 5.0.0-beta.9 compatibility basis

The adapter targets the published `hydrooj@5.0.0-beta.9` package and relies on
the following public plugin surfaces from that exact release:

- `src/service/bus.ts` declares
  `record/judge(rdoc: RecordDoc, updated: boolean, pdoc?, updater?)`.
- The same bus declares `record/change(rdoc, $set?, $push?, body?)`.
  The adapter reads only `rdoc` and accepts only status 0/20/21/22 from this
  hook, producing metadata-only `PENDING/JUDGING` events; it never serializes
  `$set`, `$push`, or `body`, and ignores terminal states on this hook.
- `src/handler/judge.ts` calls `app.parallel('record/judge', ...)` only after
  the final record update, contest status update, and `judgeAt` assignment.
- `src/plugin-api.ts` exports `Context`, `Logger`, `ObjectId`, `PERM`, and
  `Types` for addons.
- `src/entry/common.ts` resolves only `index.ts` or `index.js` at an addon
  root and loads it with `require(...)`; the published package therefore ships
  a CommonJS root `index.js` which delegates to the compiled CommonJS entry.
- `src/loader.ts` reads an addon's exported `Config` schema and passes the
  validated configuration to `apply(ctx, config)`.
- `src/handler/contest.ts` installs the `scoreboard` service and demonstrates
  `scoreboard.addView(...)`, contest ownership checks, and
  `PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD` for realtime/jury access.
- `src/service/db.ts` exposes `ctx.db.collection(...)` and
  `ctx.db.ensureIndexes(...)` used by the local outbox.

`record/judge` remains the only live authoritative terminal result feed.
`record/change` is used solely for the filtered progress states needed by the
cross-site realboard, while reconciliation remains the terminal-state repair
boundary.

Reference package:
https://www.npmjs.com/package/hydrooj/v/5.0.0-beta.9
