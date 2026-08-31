import { describe, expect, it } from 'vitest';
import { computeScoreboard } from '../src/index.js';
import {
  atMinute,
  event,
  leagueConfig,
  mappedEvent,
  problems,
  teams,
} from './fixtures.js';

describe('ACM/ICPC scoring', () => {
  it('does not penalize CE, SE, FE, or IGN', () => {
    const statuses = ['COMPILE_ERROR', 'SYSTEM_ERROR', 'FORMAT_ERROR', 'IGNORED', 'WRONG_ANSWER'] as const;
    const events = statuses.map((status, index) => mappedEvent({
      source_seq: index + 1,
      rid: `rid-${index + 1}`,
      status,
      submitted_at: atMinute(index + 1),
      emitted_at: atMinute(index + 1),
    }));
    events.push(mappedEvent({
      source_seq: 6,
      rid: 'rid-6',
      status: 'ACCEPTED',
      submitted_at: atMinute(10),
      emitted_at: atMinute(10),
    }));
    const board = computeScoreboard({
      config: leagueConfig(),
      teams: [teams[0]!],
      problems: [problems[0]!],
      events,
      view: 'jury',
      now: atMinute(20),
    });
    expect(board.rows[0]).toMatchObject({ solved: 1, penalty_minutes: 30 });
    expect(board.rows[0]?.problems[0]).toMatchObject({ wrong_attempts: 1, penalty_minutes: 30 });
  });

  it('handles duplicate, out-of-order, and rejudged events without double counting', () => {
    const oldAccepted = mappedEvent({ source_seq: 4, rid: 'rid-old', status: 'ACCEPTED', submitted_at: atMinute(10) });
    const rejudgedWrong = mappedEvent({
      source_seq: 8,
      rid: 'rid-old',
      status: 'WRONG_ANSWER',
      submitted_at: atMinute(10),
      rejudged: true,
    });
    const finalAccepted = mappedEvent({
      source_seq: 6,
      rid: 'rid-final',
      status: 'ACCEPTED',
      submitted_at: atMinute(20),
    });
    const board = computeScoreboard({
      config: leagueConfig(),
      teams: [teams[0]!],
      problems: [problems[0]!],
      events: [rejudgedWrong, oldAccepted, finalAccepted, oldAccepted],
      view: 'jury',
      now: atMinute(30),
    });
    expect(board.rows[0]?.problems[0]).toMatchObject({
      solved: true,
      wrong_attempts: 1,
      solve_time_minutes: 20,
      penalty_minutes: 40,
    });
  });

  it('uses ICPC tie ranks and excludes unofficial teams from official places', () => {
    const allTeams = [
      ...teams,
      {
        global_team_id: 'team-3',
        name: 'Gamma',
        organization_id: 'school-3',
        organization_name: 'Third School',
        site_id: 'site-3',
        is_official: true,
      },
      {
        global_team_id: 'team-star',
        name: 'Star',
        organization_id: 'school-star',
        organization_name: 'Star School',
        site_id: 'site-star',
        is_official: false,
      },
    ];
    const events = [
      mappedEvent({ source_seq: 1, status: 'ACCEPTED', submitted_at: atMinute(5) }),
      mappedEvent({
        site_id: 'site-2', source_seq: 1, rid: 'rid-2', uid: 20,
        global_team_id: 'team-2', status: 'ACCEPTED', submitted_at: atMinute(5),
      }),
      mappedEvent({
        site_id: 'site-star', source_seq: 1, rid: 'rid-star', uid: 40,
        global_team_id: 'team-star', status: 'ACCEPTED', submitted_at: atMinute(1),
      }),
    ];
    const board = computeScoreboard({
      config: leagueConfig(),
      teams: allTeams,
      problems: [problems[0]!],
      events,
      view: 'jury',
      now: atMinute(20),
    });
    expect(board.rows.map((row) => [row.global_team_id, row.rank])).toEqual([
      ['team-star', null],
      ['team-1', 1],
      ['team-2', 1],
      ['team-3', 3],
    ]);
  });

  it('hides post-freeze results on public board but keeps the full jury board', () => {
    const events = [
      mappedEvent({ source_seq: 1, rid: 'rid-wa', status: 'WRONG_ANSWER', submitted_at: atMinute(230) }),
      mappedEvent({ source_seq: 2, rid: 'rid-ac', status: 'ACCEPTED', submitted_at: atMinute(250) }),
    ];
    const common = {
      config: leagueConfig(),
      teams: [teams[0]!],
      problems: [problems[0]!],
      events,
      now: atMinute(270),
    } as const;
    const publicBoard = computeScoreboard({ ...common, view: 'public' });
    const juryBoard = computeScoreboard({ ...common, view: 'jury' });
    expect(publicBoard).toMatchObject({ frozen: true });
    expect(publicBoard.rows[0]?.problems[0]).toMatchObject({
      solved: false,
      wrong_attempts: 1,
      frozen_attempts: 1,
    });
    expect(juryBoard.rows[0]?.problems[0]).toMatchObject({
      solved: true,
      wrong_attempts: 1,
      penalty_minutes: 270,
      frozen_attempts: 0,
    });
  });

  it('marks an offline school and excludes unresolved events from scoring', () => {
    const board = computeScoreboard({
      config: leagueConfig(),
      teams: [teams[0]!],
      problems: [problems[0]!],
      events: [event({ status: 'ACCEPTED' })],
      view: 'jury',
      now: atMinute(30),
      siteStatuses: [{
        site_id: 'site-1',
        school_name: 'First School',
        state: 'OFFLINE',
        last_success_at: atMinute(20),
        lag_seconds: 600,
      }],
    });
    expect(board.data_complete).toBe(false);
    expect(board.rows[0]?.solved).toBe(0);
    expect(board.warnings.map((warning) => warning.code)).toEqual(['SITE_OFFLINE', 'UNMAPPED_EVENT']);
  });
});
