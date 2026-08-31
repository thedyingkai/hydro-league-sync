import { describe, expect, it } from 'vitest';
import {
  BadgeUrlSchema,
  EventBatchEnvelopeSchema,
  EventBatchAckSchema,
  LeagueConfigSchema,
  SubmissionEventSchema,
  TeamSchema,
} from '../src/index.js';
import { atMinute, event } from './fixtures.js';

describe('versioned schemas', () => {
  it('accepts a wire event without untrusted global mapping hints', () => {
    const parsed = SubmissionEventSchema.parse(event());
    expect(parsed.protocol_version).toBe('1.0');
    expect(parsed.global_team_id).toBeUndefined();
    expect(parsed.global_problem_id).toBeUndefined();
  });

  it('rejects reused sequence zero and non-canonical rid values', () => {
    expect(SubmissionEventSchema.safeParse({ ...event(), source_seq: 0 }).success).toBe(false);
    expect(SubmissionEventSchema.safeParse({ ...event(), rid: 'folder/rid' }).success).toBe(false);
    expect(SubmissionEventSchema.safeParse({ ...event(), rid: ' rid-1 ' }).success).toBe(false);
  });

  it('rejects an event whose site differs from its batch envelope', () => {
    const parsed = EventBatchEnvelopeSchema.safeParse({
      protocol_version: '1.0',
      batch_id: '84d90cbf-8367-4ed6-b498-83c6144824a2',
      league_id: 'league-1',
      site_id: 'site-2',
      sent_at: atMinute(20),
      events: [event()],
    });
    expect(parsed.success).toBe(false);
  });

  it('validates freeze and unfreeze boundaries', () => {
    const parsed = LeagueConfigSchema.safeParse({
      protocol_version: '1.0',
      league_id: 'league-1',
      title: 'Invalid',
      rule: 'acm',
      starts_at: atMinute(0),
      ends_at: atMinute(300),
      freeze_at: atMinute(301),
      unfreeze_at: atMinute(200),
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts only credential-free HTTP(S) or safe root-relative badge URLs', () => {
    for (const url of [
      'https://assets.example.edu/badges/school-a.png',
      'http://assets.example.edu:8080/badges/school-a.png?version=2#badge',
      'https://assets.example.edu/%E6%A0%A1%E5%BE%BD.png?cache=100%25',
      'https://assets.example.edu/%E5%8C%97%E5%AD%97%F0%9F%8F%AB.png',
      '/hydro-league-xcpcio/school-badges/besti.png',
      '/hydro-league-xcpcio/school-badges/%E6%A0%A1%E5%BE%BD.png?cache=100%25',
      '/hydro-league-xcpcio/school-badges/%E5%8C%97%E5%AD%97%F0%9F%8F%AB.png',
    ]) {
      expect(BadgeUrlSchema.safeParse(url).success, url).toBe(true);
    }

    for (const url of [
      'https://user:password@assets.example.edu/logo.png',
      'https://@assets.example.edu/logo.png',
      '//assets.example.edu/logo.png',
      'data:image/png;base64,AAAA',
      'file:///tmp/logo.png',
      'javascript:alert(1)',
      'badges/logo.png',
      '/%2fassets.example.edu/logo.png',
      '/badges/../secret.png',
      '/badges/%2e%2e/secret.png',
      '/badges/%252e%252e/secret.png',
      '/badges/%25252e%25252e/secret.png',
      '/badges//secret.png',
      '/badges/%252fsecret.png',
      '/badges\\secret.png',
      '/badges/%5csecret.png',
      '/badges/%00secret.png',
      '/badges/%C2%85secret.png',
      '/badges/%E5%8C.png',
      '/badges/%FF.png',
      'https://assets.example.edu/badges/../secret.png',
      'https://assets.example.edu/badges/%2e%2e/secret.png',
      'https://assets.example.edu/badges/%25252e%25252e/secret.png',
      'https://assets.example.edu/badges//secret.png',
      'https://assets.example.edu/logo.png?label=%00',
      'https://assets.example.edu/logo.png#%5c',
      'https://assets.example.edu/%E5%8C.png',
      `/badges/${String.fromCharCode(0)}secret.png`,
      `/badges/${String.fromCharCode(0x85)}secret.png`,
    ]) {
      expect(BadgeUrlSchema.safeParse(url).success, url).toBe(false);
    }

    expect(TeamSchema.parse({
      global_team_id: 'team-1',
      name: 'Team',
      organization_id: 'school-1',
      organization_name: 'School',
      site_id: 'site-1',
      is_official: true,
      badge_url: '/hydro-league-xcpcio/school-badges/besti.png',
    }).badge_url).toBe('/hydro-league-xcpcio/school-badges/besti.png');
  });

  it('accepts only strict nonnegative integer XCPCIO medal counts', () => {
    const base = {
      protocol_version: '1.0',
      league_id: 'league-1',
      title: 'Medal Test',
      rule: 'acm',
      starts_at: atMinute(0),
      ends_at: atMinute(300),
    };
    expect(LeagueConfigSchema.safeParse({
      ...base,
      xcpcio_medals: {
        official: { gold: 9, silver: 18, bronze: 27 },
        unofficial: { gold: 2, silver: 0, bronze: 0 },
        '2025DKYCPC新生': { gold: 6, silver: 12, bronze: 18 },
      },
    }).success).toBe(true);

    for (const counts of [
      { gold: -1, silver: 18, bronze: 27 },
      { gold: 9.5, silver: 18, bronze: 27 },
      { gold: 9, silver: 18 },
      { gold: 9, silver: 18, bronze: 27, honorable: 1 },
    ]) {
      expect(LeagueConfigSchema.safeParse({
        ...base,
        xcpcio_medals: { official: counts },
      }).success).toBe(false);
    }
    expect(LeagueConfigSchema.safeParse({ ...base, xcpcio_medals: { ' ': { gold: 1, silver: 0, bronze: 0 } } }).success)
      .toBe(false);
  });

  it('does not let a high watermark cross a retryable rejection', () => {
    const parsed = EventBatchAckSchema.safeParse({
      protocol_version: '1.0',
      batch_id: '84d90cbf-8367-4ed6-b498-83c6144824a2',
      league_id: 'league-1',
      site_id: 'site-1',
      accepted_count: 4,
      duplicate_count: 0,
      rejected: [{
        source_seq: 3,
        rid: 'rid-3',
        code: 'TEMPORARY_STORAGE_FAILURE',
        message: 'retry later',
        retryable: true,
      }],
      high_watermark: 4,
      received_at: atMinute(20),
    });
    expect(parsed.success).toBe(false);
  });
});
