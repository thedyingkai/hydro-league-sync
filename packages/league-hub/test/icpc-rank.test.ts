import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContestApiResources, HubDatabase } from '../src/index.js';
import type { ScoreboardSnapshot } from '../src/scoreboard.js';

test('Contest API keeps official ranks ahead of visible unofficial teams', (t) => {
  const database = new HubDatabase(':memory:');
  t.after(() => database.close());
  database.importConfiguration({
    contest: {
      contest_id: 'league-rank-test',
      name: 'Rank export test',
      start_time: '2026-08-30T01:00:00.000Z',
      end_time: '2026-08-30T06:00:00.000Z',
      penalty_minutes: 20,
    },
    sites: [],
    teams: [
      { team_id: 'official-a', name: 'Official A', school_id: 'school', official: true },
      { team_id: 'official-b', name: 'Official B', school_id: 'school', official: true },
      { team_id: 'official-c', name: 'Official C', school_id: 'school', official: true },
      { team_id: 'star-a', name: 'Star A', school_id: 'school', official: false },
      { team_id: 'star-b', name: 'Star B', school_id: 'school', official: false },
      { team_id: 'star-c', name: 'Star C', school_id: 'school', official: false },
    ],
    problems: [{ problem_id: 'problem-a', label: 'A', name: 'A', ordinal: 0 }],
    team_mappings: [],
    problem_mappings: [],
  }, '2026-08-30T00:00:00.000Z');

  const contest = database.getContest();
  assert.ok(contest);
  const row = (
    teamId: string,
    official: boolean,
    solved: number,
    penaltyMinutes: number,
    lastSolveTimeMs: number | null,
    rank: number | null,
  ): ScoreboardSnapshot['rows'][number] => ({
    rank,
    team: {
      team_id: teamId,
      name: teamId,
      school_id: 'school',
      official,
      hidden: false,
    },
    solved,
    penalty_minutes: penaltyMinutes,
    last_solve_time_ms: lastSolveTimeMs,
    problems: [{
      problem_id: 'problem-a',
      solved: solved > 0,
      status: solved > 0 ? 'SOLVED' : 'UNATTEMPTED',
      attempts: 0,
      num_judged: solved > 0 ? 1 : 0,
      pending: 0,
      solve_time_ms: lastSolveTimeMs,
      first_to_solve: false,
    }],
  });
  const snapshot: ScoreboardSnapshot = {
    contest,
    view: 'jury',
    generated_at: '2026-08-30T04:00:00.000Z',
    cursor: 0,
    frozen: false,
    freeze_time: null,
    accuracy: { complete: true, message: null, affected_sites: [] },
    sites: [],
    problems: database.getProblems(),
    rows: [
      row('star-a', false, 4, 80, 4_800_000, null),
      row('star-b', false, 4, 80, 4_800_000, null),
      row('official-a', true, 3, 100, 6_000_000, 1),
      row('official-b', true, 3, 100, 6_000_000, 1),
      row('star-c', false, 2, 140, 8_400_000, null),
      row('official-c', true, 1, 200, 12_000_000, 3),
    ],
  };

  const resources = buildContestApiResources(database, snapshot);
  assert.deepEqual(resources.groups, [
    { id: 'official', name: 'Official', type: 'eligibility' },
    { id: 'unofficial', name: 'Unofficial', type: 'eligibility' },
  ]);
  assert.deepEqual(
    resources.teams.map((team) => [team.id, team.group_ids]),
    [
      ['official-a', ['official']],
      ['official-b', ['official']],
      ['official-c', ['official']],
      ['star-a', ['unofficial']],
      ['star-b', ['unofficial']],
      ['star-c', ['unofficial']],
    ],
  );
  assert.deepEqual(
    resources.scoreboard.rows.map((scoreRow) => [scoreRow.team_id, scoreRow.rank]),
    [
      ['official-a', 1],
      ['official-b', 1],
      ['official-c', 3],
      ['star-a', 4],
      ['star-b', 4],
      ['star-c', 6],
    ],
  );
});
