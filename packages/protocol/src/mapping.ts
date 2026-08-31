import { z } from 'zod';
import {
  LocalProblemMappingSchema,
  MappedSubmissionEventSchema,
  SubmissionEventSchema,
  TeamAccountMappingSchema,
  type LocalProblemMapping,
  type MappedSubmissionEvent,
  type SubmissionEvent,
  type TeamAccountMapping,
} from './schemas.js';

export const MappingQuarantineReasonSchema = z.enum([
  'TEAM_MAPPING_NOT_FOUND',
  'PROBLEM_MAPPING_NOT_FOUND',
]);
export type MappingQuarantineReason = z.infer<typeof MappingQuarantineReasonSchema>;

export const MappingHintMismatchReasonSchema = z.enum([
  'TEAM_HINT_MISMATCH',
  'PROBLEM_HINT_MISMATCH',
]);
export type MappingHintMismatchReason = z.infer<typeof MappingHintMismatchReasonSchema>;

export interface QuarantinedSubmissionEvent {
  event: SubmissionEvent;
  reasons: MappingQuarantineReason[];
}

export interface SubmissionMappingHintMismatch {
  event: SubmissionEvent;
  reasons: MappingHintMismatchReason[];
}

export interface ResolveSubmissionMappingsInput {
  events: readonly SubmissionEvent[];
  teamMappings: readonly TeamAccountMapping[];
  problemMappings: readonly LocalProblemMapping[];
}

export interface MappingResolution {
  mapped: MappedSubmissionEvent[];
  quarantined: QuarantinedSubmissionEvent[];
  hintMismatches: SubmissionMappingHintMismatch[];
}

export class MappingConfigurationError extends Error {
  readonly mapping_key: string;

  constructor(mappingKey: string) {
    super(`Duplicate local mapping key: ${mappingKey}`);
    this.name = 'MappingConfigurationError';
    this.mapping_key = mappingKey;
  }
}

function commonKey(value: {
  league_id: string;
  site_id: string;
  domain_id: string;
  contest_id: string;
}): string {
  return [value.league_id, value.site_id, value.domain_id, value.contest_id].join('/');
}

export function localTeamMappingKey(value: {
  league_id: string;
  site_id: string;
  domain_id: string;
  contest_id: string;
  uid: number;
}): string {
  return `${commonKey(value)}/uid:${value.uid}`;
}

export function localProblemMappingKey(value: {
  league_id: string;
  site_id: string;
  domain_id: string;
  contest_id: string;
  pid: number;
}): string {
  return `${commonKey(value)}/pid:${value.pid}`;
}

function indexUnique<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (result.has(key)) throw new MappingConfigurationError(key);
    result.set(key, item);
  }
  return result;
}

/** Applies only hub-owned mappings; client global IDs are treated as consistency hints. */
export function resolveSubmissionMappings(input: ResolveSubmissionMappingsInput): MappingResolution {
  const events = z.array(SubmissionEventSchema).parse(input.events);
  const teamMappings = z.array(TeamAccountMappingSchema).parse(input.teamMappings);
  const problemMappings = z.array(LocalProblemMappingSchema).parse(input.problemMappings);
  const teams = indexUnique(teamMappings, localTeamMappingKey);
  const problems = indexUnique(problemMappings, localProblemMappingKey);
  const mapped: MappedSubmissionEvent[] = [];
  const quarantined: QuarantinedSubmissionEvent[] = [];
  const hintMismatches: SubmissionMappingHintMismatch[] = [];

  for (const event of events) {
    const team = teams.get(localTeamMappingKey(event));
    const problem = problems.get(localProblemMappingKey(event));
    const quarantineReasons: MappingQuarantineReason[] = [];
    if (team === undefined) quarantineReasons.push('TEAM_MAPPING_NOT_FOUND');
    if (problem === undefined) quarantineReasons.push('PROBLEM_MAPPING_NOT_FOUND');
    if (quarantineReasons.length > 0 || team === undefined || problem === undefined) {
      quarantined.push({ event, reasons: quarantineReasons });
      continue;
    }

    const mismatchReasons: MappingHintMismatchReason[] = [];
    if (team !== undefined
      && event.global_team_id !== undefined
      && event.global_team_id !== team.global_team_id) {
      mismatchReasons.push('TEAM_HINT_MISMATCH');
    }
    if (problem !== undefined
      && event.global_problem_id !== undefined
      && event.global_problem_id !== problem.global_problem_id) {
      mismatchReasons.push('PROBLEM_HINT_MISMATCH');
    }
    if (mismatchReasons.length > 0) hintMismatches.push({ event, reasons: mismatchReasons });
    mapped.push(MappedSubmissionEventSchema.parse({
      ...event,
      global_team_id: team.global_team_id,
      global_problem_id: problem.global_problem_id,
    }));
  }

  return { mapped, quarantined, hintMismatches };
}
