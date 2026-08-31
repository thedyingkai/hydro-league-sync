import { describe, expect, it } from 'vitest';
import { toXcpcioAllInOne, XcpcioAllInOneSchema } from '../src/index.js';
import { atMinute, leagueConfig, mappedEvent, problems, teams } from './fixtures.js';

describe('XCPCIO all-in-one conversion', () => {
  const events = [
    mappedEvent({ source_seq: 1, rid: 'rid-wa', status: 'WRONG_ANSWER', submitted_at: atMinute(10) }),
    mappedEvent({ source_seq: 2, rid: 'rid-ce', status: 'COMPILE_ERROR', submitted_at: atMinute(20) }),
    mappedEvent({ source_seq: 3, rid: 'rid-ac', status: 'ACCEPTED', submitted_at: atMinute(250) }),
  ];

  it('emits Hydro XCPCIO-compatible contest, team, and frozen submission data', () => {
    const json = toXcpcioAllInOne({
      config: leagueConfig(),
      teams: [teams[0]!],
      problems,
      events,
      view: 'public',
      now: atMinute(270),
    });
    expect(json.contest).toMatchObject({
      frozen_time: 3600,
      penalty: 1200,
      problem_id: ['A', 'B'],
      options: { submission_timestamp_unit: 'millisecond' },
    });
    expect(json.teams[0]?.group).toContain('official');
    expect(json.submissions.map((submission) => submission.status)).toEqual([
      'REJECTED',
      'COMPILATION_ERROR',
      'FROZEN',
    ]);
    expect(json.submissions[0]?.timestamp).toBe(600_000);
  });

  it('reveals detailed final judgements to the jury view', () => {
    const json = toXcpcioAllInOne({
      config: leagueConfig(),
      teams: [teams[0]!],
      problems,
      events,
      view: 'jury',
      now: atMinute(301),
    });
    expect(json.submissions.map((submission) => submission.status)).toEqual([
      'WRONG_ANSWER',
      'COMPILATION_ERROR',
      'CORRECT',
    ]);
  });

  it('preserves a safe root-relative team badge for same-origin serving', () => {
    const badgeUrl = '/hydro-league-xcpcio/school-badges/besti.png';
    const json = toXcpcioAllInOne({
      config: leagueConfig(),
      teams: [{ ...teams[0]!, badge_url: badgeUrl }],
      problems,
      events,
      view: 'jury',
      now: atMinute(301),
    });
    expect(json.teams[0]?.badge).toEqual({ url: badgeUrl });
    expect(() => XcpcioAllInOneSchema.parse({
      ...json,
      teams: [{ ...json.teams[0]!, badge: { url: '/badges/../private.png' } }],
    })).toThrow();
  });

  it('prefers configured per-group medal counts over the XCPCIO preset', () => {
    const medal = {
      official: { gold: 9, silver: 18, bronze: 27 },
      '2025DKYCPC\u6253\u661f': { gold: 2, silver: 0, bronze: 0 },
    };
    const json = toXcpcioAllInOne({
      config: leagueConfig({ xcpcio_preset: 'CCPC', xcpcio_medals: medal }),
      teams: [teams[0]!],
      problems,
      events,
      view: 'jury',
      now: atMinute(301),
    });
    expect(json.contest.logo.preset).toBe('CCPC');
    expect(json.contest.medal).toEqual(medal);
  });

  it('preserves readable non-ASCII team group names', () => {
    const group = '2025DKYCPC新生';
    const json = toXcpcioAllInOne({
      config: leagueConfig({ xcpcio_medals: { [group]: { gold: 6, silver: 12, bronze: 18 } } }),
      teams: [{ ...teams[0]!, groups: [group] }],
      problems,
      events,
      view: 'jury',
      now: atMinute(301),
    });
    expect(json.contest.group[group]).toBe(group);
    expect(json.teams[0]?.group).toEqual(['official', group]);
  });

  it('keeps the preset medal mode when no group medal map is configured', () => {
    const json = toXcpcioAllInOne({
      config: leagueConfig({ xcpcio_preset: 'CCPC' }),
      teams: [teams[0]!],
      problems,
      events,
      view: 'jury',
      now: atMinute(301),
    });
    expect(json.contest.medal).toBe('ccpc');
  });

  it('accepts the strict optional multi-school connection status extension', () => {
    const json = toXcpcioAllInOne({
      config: leagueConfig(),
      teams: [teams[0]!],
      problems,
      events,
      view: 'public',
      now: atMinute(270),
    });
    expect(XcpcioAllInOneSchema.parse({
      ...json,
      league_status: {
        generated_at: '2026-08-30T06:00:00.000Z',
        complete: false,
        message: 'A School is offline; standings may be incomplete',
        sites: [{ site_id: 'site-a', name: 'A Judge', school_name: 'A School', status: 'OFFLINE' }],
      },
    }).league_status?.sites[0]?.status).toBe('OFFLINE');
    expect(() => XcpcioAllInOneSchema.parse({
      ...json,
      league_status: {
        generated_at: '2026-08-30T06:00:00.000Z',
        complete: false,
        message: null,
        sites: [{ site_id: 'site-a', name: 'A Judge', status: 'OFFLINE', pending_events: 3 }],
      },
    })).toThrow();
  });
});
