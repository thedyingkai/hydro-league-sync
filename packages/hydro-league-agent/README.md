# Hydro League Agent

School-side Hydro plugin targeting `hydrooj@5.0.0-beta.9`. It persists every
final `record/judge` update into a local MongoDB outbox before any network I/O,
then sends metadata-only batches to the league hub with acknowledgement,
retry/backoff, heartbeats, and periodic full-state reconciliation.

The default hub URL is `http://127.0.0.1:3000`. Plain HTTP is accepted only for
loopback hosts unless `allowInsecureHttp` is explicitly enabled. The plugin does
not send submission source, files, compiler output, test data, input, or output.

## Hydro configuration

Install this addon inside an existing `hydrooj@5.0.0-beta.9` installation.
Hydro is an optional peer dependency so package managers do not download a
second Hydro runtime into the addon dependency tree; the host version remains a
strict compatibility requirement.

Add the package as a Hydro addon and configure its plugin scope:

```yaml
enabled: true
centerUrl: http://127.0.0.1:3000
leagueId: league-2026
siteId: school-a
sharedSecret: replace-with-at-least-32-random-bytes
contests:
  - domainId: system
    contestId: 0123456789abcdef01234567
    teamMapping:
      "1001": TEAM-001
    problemMapping:
      "1": A
```

`global_team_id` and `global_problem_id` are omitted when a mapping is absent.
The hub remains authoritative for mappings imported from the league Excel file;
unmapped events are retained by the hub but excluded from the official board.
`sharedSecret` must contain at least 32 bytes in UTF-8 and must be unique per
school site.

## Added views

- `leagueboard`: the primary unified standings view. It embeds the reviewed,
  scoreboard-only XCPCIO 0.85.4 fork using Hydro's same-origin JSON proxy.
  Contest owners and users with Hydro's hidden-scoreboard permission receive
  the jury view; other users receive only the public/frozen view.
- `league-realboard`: the HandsomeRun Hydro Realboard fork's React and
  `react-spring` rolling-submission presentation, adapted to the unified
  XCPCIO all-in-one feed and the same public/jury boundary. The original fork
  snapshot and its attribution remain under `upstream/hydro-realboard`.
- `league-xcpcio`: compatibility alias for the same XCPCIO standings view.
  Its browser frame and assets are served locally.

All views fetch through the local Hydro server and use distinct public/jury
caches. Contestant browsers never contact the hub directly. The public/jury
choice is made from the authenticated Hydro session; a browser-supplied
`view=jury` parameter cannot elevate access. Existing `realboard` and `xcpcio`
addons and routes are left untouched.

## Reliability model

- A capture-key lease serializes concurrent identical `record/judge` callbacks
  before a sequence number is allocated.
- A MongoDB atomic counter assigns monotonically increasing `source_seq` values.
- The assigned sequence is fenced into the capture reservation before the
  outbox insert, so a lease takeover reuses it instead of allocating again.
- Workers lease due rows, batch them, and delete nothing until an explicit ACK.
- Accepted, duplicate, and stale ACKs are terminal; rejected rows are retained
  for administrator diagnosis; missing ACK items are retried.
- Exponential retry has bounded jitter and survives process restarts.
- Reconciliation scans records with an allow-list projection and posts complete
  terminal snapshots in chunks.
- The hub exports a CDP only after an administrator explicitly finalizes the
  contest; the export request itself is read-only. If a later event or snapshot
  upload returns `409 contest_finalized`, this agent logs one explicit error,
  pauses uploads, and retains the outbox for administrator review. Heartbeats
  continue. Point the site at a new/rebuilt league configuration to resume
  synchronization.

MongoDB cannot atomically update the sequence counter and outbox row on a
standalone deployment. A host crash in the few instructions between those two
writes can therefore leave one permanent sequence gap. The complete snapshot
is the recovery boundary: by default it runs every five minutes, and the hub
uses its final chunk to classify such gaps and advance the contiguous ACK.

## Licensing

The package is AGPL-3.0-only. See `LICENSE`, `NOTICE`, the pinned upstream
notices, and `public/hydro-league-xcpcio/THIRD_PARTY_NOTICES.txt`. The XCPCIO
scoreboard-only fork retains its MIT license at
`public/hydro-league-xcpcio/XCPCIO-LICENSE.txt`; the exact source patch and
build record are in `upstream/xcpcio-board-app-scoreboard-only`.

A corresponding-source archive is exposed by the installed web assets at
`/hydro-league-agent-source.zip` for AGPL network users. `npm run
source:archive` regenerates it deterministically from the package source,
tests, build metadata, protocol compatibility fixtures, pinned Realboard
snapshot, XCPCIO fork, notices, and distributed browser assets.
