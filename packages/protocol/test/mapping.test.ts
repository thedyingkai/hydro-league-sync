import { describe, expect, it } from 'vitest';
import {
  MappingConfigurationError,
  resolveSubmissionMappings,
} from '../src/index.js';
import { event } from './fixtures.js';

const teamMapping = {
  league_id: 'league-1',
  site_id: 'site-1',
  domain_id: 'system',
  contest_id: 'contest-1',
  uid: 10,
  global_team_id: 'team-1',
};

const problemMapping = {
  league_id: 'league-1',
  site_id: 'site-1',
  domain_id: 'system',
  contest_id: 'contest-1',
  pid: 1001,
  global_problem_id: 'problem-a',
};

describe('hub-owned event mapping', () => {
  it('enriches a local event without requiring client global IDs', () => {
    const result = resolveSubmissionMappings({
      events: [event()],
      teamMappings: [teamMapping],
      problemMappings: [problemMapping],
    });
    expect(result.quarantined).toEqual([]);
    expect(result.hintMismatches).toEqual([]);
    expect(result.mapped[0]?.global_team_id).toBe('team-1');
    expect(result.mapped[0]?.global_problem_id).toBe('problem-a');
  });

  it('quarantines missing mappings and inconsistent client hints', () => {
    const missing = resolveSubmissionMappings({
      events: [event()],
      teamMappings: [],
      problemMappings: [],
    });
    expect(missing.mapped).toEqual([]);
    expect(missing.quarantined[0]?.reasons).toEqual([
      'TEAM_MAPPING_NOT_FOUND',
      'PROBLEM_MAPPING_NOT_FOUND',
    ]);

    const mismatch = resolveSubmissionMappings({
      events: [event({ global_team_id: 'fake-team' })],
      teamMappings: [teamMapping],
      problemMappings: [problemMapping],
    });
    expect(mismatch.mapped[0]?.global_team_id).toBe('team-1');
    expect(mismatch.quarantined).toEqual([]);
    expect(mismatch.hintMismatches[0]?.reasons).toContain('TEAM_HINT_MISMATCH');
  });

  it('rejects ambiguous mapping configuration', () => {
    expect(() => resolveSubmissionMappings({
      events: [event()],
      teamMappings: [teamMapping, teamMapping],
      problemMappings: [problemMapping],
    })).toThrow(MappingConfigurationError);
  });
});
