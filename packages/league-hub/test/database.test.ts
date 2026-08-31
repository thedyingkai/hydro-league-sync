import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ContestIdImmutableError,
  HubDatabase,
  type ContestNotificationInput,
} from '../src/database.js';
import type { EventBatch, HubConfiguration, IngestEvent } from '../src/types.js';

const leagueId = 'league-2026';
const siteId = 'school-a';
const configuredAt = '2026-08-30T01:00:00.000Z';

function configuration(): HubConfiguration {
  return {
    contest: {
      contest_id: leagueId,
      name: 'League 2026',
      start_time: '2026-08-30T02:00:00.000Z',
      freeze_time: '2026-08-30T05:00:00.000Z',
      end_time: '2026-08-30T07:00:00.000Z',
      penalty_minutes: 20,
    },
    sites: [{ site_id: siteId, name: 'School A', secret: 'a'.repeat(32) }],
    teams: [
      { team_id: 'team-1', name: 'Team 1', school_id: siteId },
      { team_id: 'team-2', name: 'Team 2', school_id: siteId },
    ],
    problems: [
      { problem_id: 'problem-a', label: 'A', name: 'Alpha', ordinal: 0 },
      { problem_id: 'problem-b', label: 'B', name: 'Beta', ordinal: 1 },
    ],
    team_mappings: [
      { site_id: siteId, domain_id: 'system', contest_id: '1', local_uid: '101', team_id: 'team-1' },
    ],
    problem_mappings: [
      { site_id: siteId, domain_id: 'system', contest_id: '1', local_pid: '1001', problem_id: 'problem-a' },
    ],
  };
}

function submission(): IngestEvent {
  return {
    protocol_version: '1.0',
    event_type: 'submission.upsert',
    league_id: leagueId,
    site_id: siteId,
    domain_id: 'system',
    contest_id: '1',
    rid: '5001',
    source_seq: 1,
    status: 'AC',
    uid: 101,
    pid: 1001,
    submitted_at: '2026-08-30T02:10:00.000Z',
    judged_at: '2026-08-30T02:10:01.000Z',
    emitted_at: '2026-08-30T02:10:01.000Z',
    rejudged: false,
    global_team_id: 'team-1',
    global_problem_id: 'problem-a',
  };
}

function batch(event: IngestEvent): EventBatch {
  return {
    protocol_version: '1.0',
    batch_id: 'batch-1',
    league_id: leagueId,
    site_id: siteId,
    sent_at: event.emitted_at,
    events: [event],
  };
}

test('WAL ingestion commits use FULL durability and tolerate short writer contention', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hydro-league-db-'));
  const database = new HubDatabase(join(directory, 'hub.sqlite'));
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const journal = database.db.prepare('PRAGMA journal_mode').get() as Record<string, unknown>;
  const synchronous = database.db.prepare('PRAGMA synchronous').get() as Record<string, unknown>;
  const busyTimeout = database.db.prepare('PRAGMA busy_timeout').get() as Record<string, unknown>;
  assert.equal(journal.journal_mode, 'wal');
  assert.equal(synchronous.synchronous, 2, 'SQLite FULL is numeric level 2');
  assert.equal(busyTimeout.timeout, 5_000);
});

test('contest identity is immutable and a rejected replacement leaves all existing state intact', () => {
  const database = new HubDatabase(':memory:');
  try {
    database.importConfiguration(configuration(), configuredAt);
    database.synchronizeContestNotifications([
      { type: 'contest', id: null, data: { id: leagueId } },
    ], configuredAt);
    const beforeCursor = database.latestCursor();
    const beforeNotifications = database.getContestNotifications();
    const replacement = structuredClone(configuration());
    replacement.contest.contest_id = 'different-contest';

    assert.throws(
      () => database.importConfiguration(replacement, '2026-08-30T01:01:00.000Z'),
      (error: unknown) => error instanceof ContestIdImmutableError
        && error.code === 'CONTEST_ID_IMMUTABLE'
        && error.configuredContestId === leagueId
        && error.attemptedContestId === 'different-contest',
    );
    assert.equal(database.getContest()?.contest_id, leagueId);
    assert.equal(database.latestCursor(), beforeCursor);
    assert.deepEqual(database.getContestNotifications(), beforeNotifications);
  } finally {
    database.close();
  }
});

test('atomic finalization commits metadata and terminal notifications together or rolls all of them back', () => {
  const database = new HubDatabase(':memory:');
  try {
    database.importConfiguration(configuration(), configuredAt);
    database.synchronizeContestNotifications([
      { type: 'contest', id: null, data: { id: leagueId, name: 'before' } },
    ], configuredAt);
    const before = database.getContestNotifications();
    const finalizedAt = '2026-08-30T07:00:01.000Z';
    const publishedAt = '2026-08-30T07:05:00.000Z';
    const invalidNotifications: ContestNotificationInput[] = [
      { type: 'state', id: null, data: { finalized: finalizedAt } },
      { type: 'invalid', id: 'invalid', data: { unsupported: 1n } },
    ];

    assert.throws(() => database.finalizeContestAtomically({
      contestId: leagueId,
      finalizedAt,
      publishedAt,
      notificationCreatedAt: finalizedAt,
      notifications: invalidNotifications,
    }), /does not support bigint/);
    assert.equal(database.getContestFinalizedAt(leagueId), null);
    assert.equal(database.getContestPublishedAt(leagueId), null);
    assert.deepEqual(database.getContestNotifications(), before);

    const terminalNotifications: ContestNotificationInput[] = [
      { type: 'contest', id: null, data: { id: leagueId, name: 'final' } },
      {
        type: 'state',
        id: null,
        data: {
          finalized: finalizedAt,
          end_of_updates: '2026-08-30T07:00:02.000Z',
        },
      },
    ];
    const result = database.finalizeContestAtomically({
      contestId: leagueId,
      finalizedAt,
      publishedAt,
      notificationCreatedAt: finalizedAt,
      notifications: terminalNotifications,
    });
    assert.deepEqual(result, { finalizedAt, publishedAt });
    assert.equal(database.getContestFinalizedAt(leagueId), finalizedAt);
    assert.equal(database.getContestPublishedAt(leagueId), publishedAt);
    const notifications = database.getContestNotifications();
    assert.deepEqual(notifications.at(-1)?.data, {
      end_of_updates: '2026-08-30T07:00:02.000Z',
      finalized: finalizedAt,
    });
    assert.equal(notifications.at(-1)?.type, 'state');
  } finally {
    database.close();
  }
});

test('mapping imports recompute hints and replay every changed event through the change cursor', () => {
  const database = new HubDatabase(':memory:');
  try {
    database.importConfiguration(configuration(), configuredAt);
    const ack = database.ingestBatch(batch(submission()), '2026-08-30T02:10:02.000Z');
    assert.equal(ack.accepted_count, 1);
    const original = database.getEvents(leagueId)[0];
    assert.ok(original);
    assert.equal(original.team_id, 'team-1');
    assert.equal(original.problem_id, 'problem-a');
    assert.equal(original.mapping_warning, null);
    const firstCursor = database.latestCursor();

    const remapped = structuredClone(configuration());
    remapped.team_mappings[0]!.team_id = 'team-2';
    remapped.problem_mappings[0]!.problem_id = 'problem-b';
    database.importConfiguration(remapped, '2026-08-30T02:11:00.000Z');
    const changed = database.getEvents(leagueId)[0];
    assert.ok(changed);
    assert.equal(changed.team_id, 'team-2');
    assert.equal(changed.problem_id, 'problem-b');
    assert.equal(changed.quarantine_reason, null);
    assert.equal(changed.mapping_warning, 'TEAM_HINT_MISMATCH,PROBLEM_HINT_MISMATCH');
    const remapChanges = database.getChanges(firstCursor);
    assert.deepEqual(
      remapChanges.filter((change) => change.kind === 'event').map((change) => change.event_id),
      [changed.event_id],
    );

    const remappedCursor = database.latestCursor();
    const unmapped = structuredClone(remapped);
    unmapped.team_mappings = [];
    unmapped.problem_mappings = [];
    database.importConfiguration(unmapped, '2026-08-30T02:12:00.000Z');
    const quarantined = database.getEvents(leagueId)[0];
    assert.ok(quarantined);
    assert.equal(quarantined.team_id, null);
    assert.equal(quarantined.problem_id, null);
    assert.equal(quarantined.quarantine_reason, 'TEAM_MAPPING_MISSING,PROBLEM_MAPPING_MISSING');
    assert.equal(quarantined.mapping_warning, 'TEAM_HINT_MISMATCH,PROBLEM_HINT_MISMATCH');
    assert.deepEqual(
      database.getChanges(remappedCursor).filter((change) => change.kind === 'event').map((change) => change.event_id),
      [quarantined.event_id],
    );

    const unmappedCursor = database.latestCursor();
    database.importConfiguration(unmapped, '2026-08-30T02:13:00.000Z');
    assert.equal(
      database.getChanges(unmappedCursor).filter((change) => change.kind === 'event').length,
      0,
      'an unchanged mapping import must not replay unchanged submissions',
    );
  } finally {
    database.close();
  }
});
