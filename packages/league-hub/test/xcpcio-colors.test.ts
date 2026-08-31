import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContestApiResources,
  buildXcpcio,
  HubDatabase,
} from '../src/index.js';
import type { ScoreboardSnapshot } from '../src/scoreboard.js';

const manualProblemColors = [
  ['1', 'A', '#ffffff'],
  ['2', 'B', '#ffb2fa'],
  ['12', 'C', '#d21111'],
  ['3', 'D', '#ffb400'],
  ['4', 'E', '#66CCFF'],
  ['5', 'F', '#703b0d'],
  ['11', 'G', '#ffbebe'],
  ['6', 'H', '#9bfcff'],
  ['13', 'I', '#ededed'],
  ['7', 'J', '#00bb19'],
  ['8', 'K', '#8700c9'],
  ['9', 'L', '#314255'],
  ['10', 'M', '#fffe87'],
] as const;

function setup(firstProblem?: { color: string; rgb: string | null }) {
  const database = new HubDatabase(':memory:');
  database.importConfiguration({
    contest: {
      contest_id: 'league-color-test',
      name: 'Color export test',
      start_time: '2026-08-30T02:00:00.000Z',
      end_time: '2026-08-30T07:00:00.000Z',
      penalty_minutes: 20,
    },
    sites: [],
    teams: [],
    problems: manualProblemColors.map(([problemId, label, rgb], ordinal) => ({
      problem_id: problemId,
      label,
      name: `Problem ${label}`,
      ordinal,
      color: ordinal === 0 && firstProblem ? firstProblem.color : 'white',
      rgb: ordinal === 0 && firstProblem ? firstProblem.rgb : rgb,
    })),
    team_mappings: [],
    problem_mappings: [],
  }, '2026-08-30T01:00:00.000Z');
  const contest = database.getContest();
  assert.ok(contest);
  const snapshot: ScoreboardSnapshot = {
    contest,
    view: 'jury',
    generated_at: '2026-08-30T03:00:00.000Z',
    cursor: 0,
    frozen: false,
    freeze_time: null,
    accuracy: { complete: true, message: null, affected_sites: [] },
    sites: [],
    problems: database.getProblems(),
    rows: [],
  };
  return { database, snapshot };
}

test('XCPCIO balloon colors prefer the historical RGB values for all thirteen problems', (t) => {
  const { database, snapshot } = setup();
  t.after(() => database.close());

  const board = buildXcpcio(database, 'jury', new Date(snapshot.generated_at));
  assert.deepEqual(
    board.contest.balloon_color,
    manualProblemColors.map(([, , rgb]) => ({
      color: '#000000',
      background_color: rgb,
    })),
  );

  assert.deepEqual(
    buildContestApiResources(database, snapshot).problems.map((problem) => ({
      label: problem.label,
      color: problem.color,
      rgb: problem.rgb,
    })),
    manualProblemColors.map(([, label, rgb]) => ({ label, color: 'white', rgb })),
    'Contest API/CDP problem resources preserve both original color fields',
  );
});

test('XCPCIO balloon colors fall back to color when RGB is absent', (t) => {
  const { database } = setup({ rgb: null, color: 'orange' });
  t.after(() => database.close());

  const board = buildXcpcio(database, 'jury', new Date('2026-08-30T03:00:00.000Z'));
  assert.ok(board.contest.balloon_color);
  assert.equal(board.contest.balloon_color[0]?.background_color, 'orange');
});
