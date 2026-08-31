# `@hydro-league-sync/protocol`

Shared, versioned protocol code for the Hydro school agent and league hub. The
package targets Node.js 22 and publishes ESM plus TypeScript declarations.

## Wire event invariants

- `protocol_version` is currently `"1.0"`.
- `source_seq` is a positive, site-wide, monotonically increasing safe integer.
  It is never reused or reset between batches. A retry reuses the same event and
  sequence.
- A Hydro submission is identified by
  `site_id/domain_id/contest_id/rid`. A rejudge keeps these fields and receives a
  new, larger `source_seq`.
- `uid`, `pid`, and `submitted_at` are immutable for a given submission key.
- `global_team_id` and `global_problem_id` are optional, untrusted cache hints.
  The hub resolves authoritative IDs from imported mappings. Missing mappings are
  quarantined and never receive placeholder IDs.
- Events contain judging metadata only. Source code, files, test data, input,
  output, compiler output, and credentials are outside the schema.

The canonical batch endpoint is:

```text
POST /api/v1/sites/{site_id}/events:batch
```

An `EventBatchEnvelope` contains:

```ts
{
  protocol_version: '1.0',
  batch_id: '84d90cbf-8367-4ed6-b498-83c6144824a2',
  league_id: 'league-2026',
  site_id: 'school-a',
  sent_at: '2026-09-01T01:02:03.000Z',
  events: [/* 1 to 1000 SubmissionEvent objects */],
}
```

`EventBatchAck.high_watermark` is the largest contiguous sequence durably
classified as accepted, duplicate, or non-retryable quarantine. It never crosses
a missing sequence or retryable rejection. The agent can remove local outbox rows
at or below that watermark.

## HMAC authentication

Create the exact body first, then sign the raw bytes that will be sent:

```ts
import { canonicalJson, createSignedHeaders } from '@hydro-league-sync/protocol';

const path = `/api/v1/sites/${siteId}/events:batch`;
const body = canonicalJson(envelope);
const headers = createSignedHeaders({
  method: 'POST',
  path,
  siteId,
  body,
  secret,
});
```

The four headers are `x-hydro-league-site-id`,
`x-hydro-league-timestamp`, `x-hydro-league-nonce`, and
`x-hydro-league-signature`. The v1 canonical request is:

```text
HL-HMAC-SHA256
METHOD
raw path and query
site id
Unix timestamp in seconds
nonce
SHA-256 of the raw request body
```

`verifyRequest` checks syntax, clock skew, and the signature. The hub must also
persist used nonces for the accepted time window; nonce replay protection cannot
be implemented by a stateless helper.

## Mapping and scoring

`resolveSubmissionMappings` applies hub-owned `TeamAccountMapping` and
`LocalProblemMapping` records. It returns mapped events, missing-mapping
quarantines, and separate client-hint mismatch audit records.

`computeScoreboard` implements ACM/ICPC scoring:

- WA, TLE, MLE, OLE, and RE before the first AC add one wrong-attempt penalty.
- CE, SE, FE, IGN, and canceled judgements do not add penalty.
- The latest `source_seq` for a `rid` is the active rejudge result.
- Ranking uses solved count, total penalty, and last accepted time.
- Tied official teams share ranks; unofficial teams are displayed but unranked.
- `public` hides post-freeze results while `jury` remains complete.

`toXcpcioAllInOne` emits the `{ contest, teams, submissions }` payload consumed
by Hydro's XCPCIO scoreboard wrapper. It accepts only mapped events.

## Development

```bash
npm run typecheck
npm test
npm run build
```
