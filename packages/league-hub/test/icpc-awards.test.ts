import assert from 'node:assert/strict';
import test from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import {
  buildCdpZip,
  buildContestApiResources,
  buildEventFeed,
  contestApiResourceId,
  HubDatabase,
} from '../src/index.js';
import type { ScoreboardSnapshot } from '../src/scoreboard.js';

const generatedAt = '2026-08-30T07:30:00.000Z';

function setup(awards?: Array<{ award_id: string; citation: string; team_ids: string[] }>): {
  database: HubDatabase;
  snapshot: ScoreboardSnapshot;
} {
  const database = new HubDatabase(':memory:');
  database.importConfiguration({
    contest: {
      contest_id: 'league-awards-test',
      name: 'Awards export test',
      start_time: '2026-08-30T02:00:00.000Z',
      end_time: '2026-08-30T07:00:00.000Z',
      penalty_minutes: 20,
    },
    sites: [],
    teams: [
      { team_id: 'team-1', name: 'Team 1', school_id: 'school' },
      { team_id: 'team with spaces', name: 'Team 2', school_id: 'school' },
    ],
    problems: [{ problem_id: 'problem-a', label: 'A', name: 'Alpha', ordinal: 0 }],
    team_mappings: [],
    problem_mappings: [],
    ...(awards === undefined ? {} : { awards }),
  }, '2026-08-30T01:00:00.000Z');
  const contest = database.getContest();
  assert.ok(contest);
  return {
    database,
    snapshot: {
      contest,
      view: 'jury',
      generated_at: generatedAt,
      cursor: 0,
      frozen: false,
      freeze_time: null,
      accuracy: { complete: true, message: null, affected_sites: [] },
      sites: [],
      problems: database.getProblems(),
      rows: [],
    },
  };
}

test('Contest API and finalized CDP preserve configured awards', (t) => {
  const configuredAwards = [
    { award_id: 'fight', citation: 'Tough Fighting Award', team_ids: ['team-1'] },
    {
      award_id: 'rank-4',
      citation: 'Champion Award',
      team_ids: ['team with spaces', 'team-1'],
    },
  ];
  const { database, snapshot } = setup(configuredAwards);
  t.after(() => database.close());

  const expectedAwards = [
    { id: 'fight', citation: 'Tough Fighting Award', team_ids: ['team-1'] },
    {
      id: 'rank-4',
      citation: 'Champion Award',
      team_ids: [contestApiResourceId('team with spaces', 'team'), 'team-1'],
    },
  ];
  assert.deepEqual(buildContestApiResources(database, snapshot).awards, expectedAwards);

  const notifications = buildEventFeed(database, snapshot, true);
  const terminalStateIndex = notifications.map((item) => item.type).lastIndexOf('state');
  const awardNotifications = notifications.filter((item) => item.type === 'awards');
  assert.deepEqual(awardNotifications.map((item) => item.data), expectedAwards);
  assert.ok(awardNotifications.every((item) => item.id === (item.data as { id: string }).id));
  assert.ok(awardNotifications.every((item) => notifications.indexOf(item) < terminalStateIndex));
  assert.equal(notifications.at(-1)?.type, 'state');

  const files = unzipSync(buildCdpZip(database, snapshot));
  assert.ok(files['awards.json']);
  assert.deepEqual(JSON.parse(strFromU8(files['awards.json']!)), expectedAwards);
  const feed = strFromU8(files['event-feed.ndjson']!).trim().split('\n').map((line) => JSON.parse(line));
  const feedAwardIndexes = feed
    .map((item, index) => item.type === 'awards' ? index : -1)
    .filter((index) => index >= 0);
  assert.deepEqual(feed.filter((item) => item.type === 'awards').map((item) => item.data), expectedAwards);
  assert.ok(feedAwardIndexes.every((index) => index < feed.length - 1));
  assert.equal(feed.at(-1).type, 'state');
});

test('Contest API exports an empty awards collection when none are configured', (t) => {
  const { database, snapshot } = setup();
  t.after(() => database.close());
  assert.deepEqual(buildContestApiResources(database, snapshot).awards, []);
});
