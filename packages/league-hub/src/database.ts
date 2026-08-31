import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@hydro-league-sync/protocol';
import type {
  EventBatch,
  HubAward,
  HubConfiguration,
  HubContestConfig,
  HubProblem,
  HubSite,
  HubTeam,
  IngestEvent,
  ProblemMapping,
  TeamMapping,
} from './types.js';

interface DbRow {
  [key: string]: string | number | null;
}

export interface StoredSite {
  site_id: string;
  name: string;
  school_name?: string;
  enabled: boolean;
  last_heartbeat_at: string | null;
  last_event_at: string | null;
  pending_events: number;
  rejected_events: number;
  last_acked_source_seq: number | null;
  agent_version: string | null;
  hydro_version: string | null;
}

export interface StoredEvent extends IngestEvent {
  event_id: string;
  occurred_at: string;
  contest_time_ms?: number;
  language: string | null;
  time_ms: number | null;
  memory_bytes: number | null;
  received_at: string;
  team_id: string | null;
  problem_id: string | null;
  quarantine_reason: string | null;
  mapping_warning: string | null;
}

export interface IngestAckItem {
  event_id: string;
  rid: string;
  source_seq: number;
  status: 'accepted' | 'duplicate' | 'stale' | 'rejected';
  code?: 'SOURCE_SEQ_CONFLICT' | 'IMMUTABLE_IDENTITY_CONFLICT';
  message?: string;
}

export interface ChangeRow {
  cursor: number;
  kind: string;
  site_id: string | null;
  event_id: string | null;
  created_at: string;
}

export interface ContestNotificationInput {
  type: string;
  id: string | null;
  data: unknown;
}

export interface ContestNotification extends ContestNotificationInput {
  token: number;
}

export interface ContestFinalizationInput {
  contestId: string;
  finalizedAt: string;
  notificationCreatedAt: string;
  notifications: readonly ContestNotificationInput[];
  publishedAt?: string;
}

export interface ContestFinalizationResult {
  finalizedAt: string;
  publishedAt: string | null;
}

export class BatchIdConflictError extends Error {
  readonly code = 'BATCH_ID_CONFLICT';

  constructor(batchId: string) {
    super(`batch id ${batchId} was already used with a different request payload`);
    this.name = 'BatchIdConflictError';
  }
}

export class ContestIdImmutableError extends Error {
  readonly code = 'CONTEST_ID_IMMUTABLE';

  constructor(
    readonly configuredContestId: string,
    readonly attemptedContestId: string,
  ) {
    super(`contest id is immutable after initial configuration (${configuredContestId} != ${attemptedContestId})`);
    this.name = 'ContestIdImmutableError';
  }
}

function bool(value: unknown, fallback = false): number {
  return value === undefined ? Number(fallback) : Number(Boolean(value));
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function eventId(event: IngestEvent): string {
  return createHash('sha256')
    .update(`${event.league_id}\0${event.site_id}\0${event.domain_id}\0${event.contest_id}\0${event.rid}`)
    .digest('hex')
    .slice(0, 32);
}

function immutableIdentity(event: IngestEvent): string {
  return canonicalJson({
    contest_id: event.contest_id,
    domain_id: event.domain_id,
    league_id: event.league_id,
    pid: event.pid,
    rid: event.rid,
    site_id: event.site_id,
    submitted_at: event.submitted_at,
    uid: event.uid,
  });
}

export class HubDatabase {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    // An ingestion ACK is returned only after COMMIT. FULL makes that WAL
    // commit durable across power loss; busy_timeout absorbs short writer
    // contention instead of spuriously rejecting an otherwise valid batch.
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contest_config (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        contest_id TEXT NOT NULL,
        name TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        freeze_time TEXT,
        unfreeze_at TEXT,
        penalty_minutes INTEGER NOT NULL DEFAULT 20,
        xcpcio_medals_json TEXT,
        awards_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sites (
        site_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        school_name TEXT,
        secret TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_heartbeat_at TEXT,
        last_event_at TEXT,
        pending_events INTEGER NOT NULL DEFAULT 0,
        rejected_events INTEGER NOT NULL DEFAULT 0,
        last_acked_source_seq INTEGER,
        agent_version TEXT,
        hydro_version TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS teams (
        team_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        school_id TEXT NOT NULL,
        school_name TEXT,
        official INTEGER NOT NULL DEFAULT 1,
        hidden INTEGER NOT NULL DEFAULT 0,
        groups_json TEXT NOT NULL DEFAULT '[]',
        badge_url TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS problems (
        problem_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        name TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        color TEXT,
        rgb TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS team_mappings (
        league_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        domain_id TEXT NOT NULL,
        contest_id TEXT NOT NULL,
        local_uid TEXT NOT NULL,
        team_id TEXT NOT NULL,
        PRIMARY KEY (league_id, site_id, domain_id, contest_id, local_uid),
        FOREIGN KEY (site_id) REFERENCES sites(site_id),
        FOREIGN KEY (team_id) REFERENCES teams(team_id)
      );

      CREATE TABLE IF NOT EXISTS problem_mappings (
        league_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        domain_id TEXT NOT NULL,
        contest_id TEXT NOT NULL,
        local_pid TEXT NOT NULL,
        problem_id TEXT NOT NULL,
        PRIMARY KEY (league_id, site_id, domain_id, contest_id, local_pid),
        FOREIGN KEY (site_id) REFERENCES sites(site_id),
        FOREIGN KEY (problem_id) REFERENCES problems(problem_id)
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT NOT NULL,
        league_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        domain_id TEXT NOT NULL,
        contest_id TEXT NOT NULL,
        rid TEXT NOT NULL,
        source_seq INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL,
        uid TEXT NOT NULL,
        pid TEXT NOT NULL,
        submitted_at TEXT,
        contest_time_ms INTEGER,
        language TEXT,
        score REAL,
        time_ms INTEGER,
        memory_bytes INTEGER,
        judged_at TEXT,
        team_id TEXT,
        problem_id TEXT,
        quarantine_reason TEXT,
        mapping_warning TEXT,
        event_json TEXT NOT NULL,
        PRIMARY KEY (league_id, site_id, domain_id, contest_id, rid),
        UNIQUE (event_id),
        FOREIGN KEY (site_id) REFERENCES sites(site_id)
      );

      CREATE INDEX IF NOT EXISTS events_contest_time
        ON events(league_id, contest_time_ms, occurred_at);
      CREATE INDEX IF NOT EXISTS events_team_problem
        ON events(team_id, problem_id);
      CREATE UNIQUE INDEX IF NOT EXISTS events_site_rid
        ON events(league_id, site_id, rid);

      CREATE TABLE IF NOT EXISTS nonces (
        site_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        PRIMARY KEY (site_id, nonce)
      );

      CREATE TABLE IF NOT EXISTS batches (
        site_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        request_json TEXT NOT NULL,
        ack_json TEXT NOT NULL,
        PRIMARY KEY (site_id, batch_id)
      );

      CREATE TABLE IF NOT EXISTS source_receipts (
        site_id TEXT NOT NULL,
        league_id TEXT NOT NULL,
        source_seq INTEGER NOT NULL,
        rid TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (site_id, league_id, source_seq)
      );

      CREATE TABLE IF NOT EXISTS rejected_sequences (
        site_id TEXT NOT NULL,
        league_id TEXT NOT NULL,
        source_seq INTEGER NOT NULL,
        rid TEXT NOT NULL,
        event_json TEXT NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        received_at TEXT NOT NULL,
        PRIMARY KEY (site_id, league_id, source_seq)
      );

      CREATE TABLE IF NOT EXISTS site_watermarks (
        site_id TEXT NOT NULL,
        league_id TEXT NOT NULL,
        watermark INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (site_id, league_id)
      );

      CREATE TABLE IF NOT EXISTS snapshot_progress (
        site_id TEXT NOT NULL,
        league_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        max_source_seq INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (site_id, league_id, snapshot_id)
      );

      CREATE TABLE IF NOT EXISTS changes (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        site_id TEXT,
        event_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS contest_notification_state (
        type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        resource_id TEXT,
        data_json TEXT NOT NULL,
        PRIMARY KEY (type, resource_key)
      );

      CREATE TABLE IF NOT EXISTS contest_notifications (
        token INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        resource_id TEXT,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const receiptColumns = this.db.prepare('PRAGMA table_info(source_receipts)').all() as DbRow[];
    if (!receiptColumns.some((column) => column.name === 'event_json')) {
      this.db.exec("ALTER TABLE source_receipts ADD COLUMN event_json TEXT NOT NULL DEFAULT ''");
    }
    const batchColumns = this.db.prepare('PRAGMA table_info(batches)').all() as DbRow[];
    if (!batchColumns.some((column) => column.name === 'request_json')) {
      this.db.exec("ALTER TABLE batches ADD COLUMN request_json TEXT NOT NULL DEFAULT ''");
    }
    const siteColumns = this.db.prepare('PRAGMA table_info(sites)').all() as DbRow[];
    const siteColumnNames = new Set(siteColumns.map((column) => String(column.name)));
    if (!siteColumnNames.has('pending_events')) {
      this.db.exec('ALTER TABLE sites ADD COLUMN pending_events INTEGER NOT NULL DEFAULT 0');
    }
    if (!siteColumnNames.has('rejected_events')) {
      this.db.exec('ALTER TABLE sites ADD COLUMN rejected_events INTEGER NOT NULL DEFAULT 0');
    }
    if (!siteColumnNames.has('last_acked_source_seq')) {
      this.db.exec('ALTER TABLE sites ADD COLUMN last_acked_source_seq INTEGER');
    }
    if (!siteColumnNames.has('agent_version')) {
      this.db.exec('ALTER TABLE sites ADD COLUMN agent_version TEXT');
    }
    if (!siteColumnNames.has('hydro_version')) {
      this.db.exec('ALTER TABLE sites ADD COLUMN hydro_version TEXT');
    }
    const contestColumns = this.db.prepare('PRAGMA table_info(contest_config)').all() as DbRow[];
    const contestColumnNames = new Set(contestColumns.map((column) => String(column.name)));
    if (!contestColumnNames.has('xcpcio_medals_json')) {
      this.db.exec('ALTER TABLE contest_config ADD COLUMN xcpcio_medals_json TEXT');
    }
    if (!contestColumnNames.has('awards_json')) {
      this.db.exec("ALTER TABLE contest_config ADD COLUMN awards_json TEXT NOT NULL DEFAULT '[]'");
    }
    const teamColumns = this.db.prepare('PRAGMA table_info(teams)').all() as DbRow[];
    const teamColumnNames = new Set(teamColumns.map((column) => String(column.name)));
    if (!teamColumnNames.has('groups_json')) {
      this.db.exec("ALTER TABLE teams ADD COLUMN groups_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!teamColumnNames.has('badge_url')) {
      this.db.exec('ALTER TABLE teams ADD COLUMN badge_url TEXT');
    }
  }

  private withTransaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  ping(): boolean {
    return this.db.prepare('SELECT 1 AS ok').get() !== undefined;
  }

  getContest(): HubContestConfig | null {
    const row = this.db.prepare('SELECT * FROM contest_config WHERE singleton = 1').get() as DbRow | undefined;
    if (!row) return null;
    return {
      contest_id: String(row.contest_id),
      name: String(row.name),
      start_time: String(row.start_time),
      end_time: String(row.end_time),
      freeze_time: row.freeze_time === null ? null : String(row.freeze_time),
      unfreeze_at: row.unfreeze_at === null ? null : String(row.unfreeze_at),
      penalty_minutes: Number(row.penalty_minutes),
      ...(row.xcpcio_medals_json === null
        ? {}
        : { xcpcio_medals: parseJson<NonNullable<HubContestConfig['xcpcio_medals']>>(String(row.xcpcio_medals_json), {}) }),
    };
  }

  getSites(): StoredSite[] {
    return (this.db.prepare('SELECT * FROM sites ORDER BY site_id').all() as DbRow[]).map((row) => ({
      site_id: String(row.site_id),
      name: String(row.name),
      ...(row.school_name === null ? {} : { school_name: String(row.school_name) }),
      enabled: Boolean(row.enabled),
      last_heartbeat_at: row.last_heartbeat_at === null ? null : String(row.last_heartbeat_at),
      last_event_at: row.last_event_at === null ? null : String(row.last_event_at),
      pending_events: Number(row.pending_events),
      rejected_events: Number(row.rejected_events),
      last_acked_source_seq: row.last_acked_source_seq === null ? null : Number(row.last_acked_source_seq),
      agent_version: row.agent_version === null ? null : String(row.agent_version),
      hydro_version: row.hydro_version === null ? null : String(row.hydro_version),
    }));
  }

  getSite(siteId: string): (StoredSite & { secret: string | null }) | null {
    const row = this.db.prepare('SELECT * FROM sites WHERE site_id = ?').get(siteId) as DbRow | undefined;
    if (!row) return null;
    return {
      site_id: String(row.site_id),
      name: String(row.name),
      ...(row.school_name === null ? {} : { school_name: String(row.school_name) }),
      enabled: Boolean(row.enabled),
      secret: row.secret === null ? null : String(row.secret),
      last_heartbeat_at: row.last_heartbeat_at === null ? null : String(row.last_heartbeat_at),
      last_event_at: row.last_event_at === null ? null : String(row.last_event_at),
      pending_events: Number(row.pending_events),
      rejected_events: Number(row.rejected_events),
      last_acked_source_seq: row.last_acked_source_seq === null ? null : Number(row.last_acked_source_seq),
      agent_version: row.agent_version === null ? null : String(row.agent_version),
      hydro_version: row.hydro_version === null ? null : String(row.hydro_version),
    };
  }

  getTeams(): HubTeam[] {
    return (this.db.prepare('SELECT * FROM teams ORDER BY team_id').all() as DbRow[]).map((row) => ({
      team_id: String(row.team_id),
      name: String(row.name),
      school_id: String(row.school_id),
      ...(row.school_name === null ? {} : { school_name: String(row.school_name) }),
      official: Boolean(row.official),
      hidden: Boolean(row.hidden),
      groups: parseJson<string[]>(String(row.groups_json), []),
      ...(row.badge_url === null ? {} : { badge_url: String(row.badge_url) }),
    }));
  }

  getAwards(): HubAward[] {
    const row = this.db.prepare('SELECT awards_json FROM contest_config WHERE singleton = 1').get() as DbRow | undefined;
    return row ? parseJson<HubAward[]>(row.awards_json, []) : [];
  }

  getProblems(): HubProblem[] {
    return (this.db.prepare('SELECT * FROM problems ORDER BY ordinal, problem_id').all() as DbRow[]).map((row) => ({
      problem_id: String(row.problem_id),
      label: String(row.label),
      name: String(row.name),
      ordinal: Number(row.ordinal),
      color: row.color === null ? null : String(row.color),
      rgb: row.rgb === null ? null : String(row.rgb),
    }));
  }

  getTeamMappings(): TeamMapping[] {
    return this.db.prepare('SELECT * FROM team_mappings ORDER BY site_id, local_uid').all() as unknown as TeamMapping[];
  }

  getProblemMappings(): ProblemMapping[] {
    return this.db.prepare('SELECT * FROM problem_mappings ORDER BY site_id, local_pid').all() as unknown as ProblemMapping[];
  }

  exportConfiguration(): Omit<HubConfiguration, 'sites'> & { sites: Array<Omit<HubSite, 'secret'> & { has_secret: boolean }> } | null {
    const contest = this.getContest();
    if (!contest) return null;
    const rows = this.db.prepare('SELECT site_id, name, school_name, enabled, secret IS NOT NULL AS has_secret FROM sites ORDER BY site_id').all() as DbRow[];
    return {
      contest,
      sites: rows.map((row) => ({
        site_id: String(row.site_id),
        name: String(row.name),
        ...(row.school_name === null ? {} : { school_name: String(row.school_name) }),
        enabled: Boolean(row.enabled),
        has_secret: Boolean(row.has_secret),
      })),
      teams: this.getTeams(),
      problems: this.getProblems(),
      team_mappings: this.getTeamMappings(),
      problem_mappings: this.getProblemMappings(),
      awards: this.getAwards(),
    };
  }

  importConfiguration(config: HubConfiguration, now: string): void {
    this.withTransaction(() => {
      const configuredContest = this.db.prepare(`
        SELECT contest_id FROM contest_config WHERE singleton = 1
      `).get() as DbRow | undefined;
      if (configuredContest && String(configuredContest.contest_id) !== config.contest.contest_id) {
        throw new ContestIdImmutableError(String(configuredContest.contest_id), config.contest.contest_id);
      }

      this.db.prepare(`
        INSERT INTO contest_config
          (singleton, contest_id, name, start_time, end_time, freeze_time, unfreeze_at, penalty_minutes,
            xcpcio_medals_json, awards_json, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          contest_id = excluded.contest_id,
          name = excluded.name,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          freeze_time = excluded.freeze_time,
          unfreeze_at = excluded.unfreeze_at,
          penalty_minutes = excluded.penalty_minutes,
          xcpcio_medals_json = excluded.xcpcio_medals_json,
          awards_json = excluded.awards_json,
          updated_at = excluded.updated_at
      `).run(
        config.contest.contest_id,
        config.contest.name,
        config.contest.start_time,
        config.contest.end_time,
        config.contest.freeze_time ?? null,
        config.contest.unfreeze_at ?? null,
        config.contest.penalty_minutes ?? 20,
        config.contest.xcpcio_medals === undefined ? null : JSON.stringify(config.contest.xcpcio_medals),
        JSON.stringify(config.awards ?? []),
        now,
      );

      // A configuration import is authoritative. Keeping an omitted site's old
      // secret active would let a removed school continue authenticating. A
      // listed site's omitted secret still means "preserve the current secret".
      const configuredSiteIds = new Set(config.sites.map((site) => site.site_id));
      const disableSite = this.db.prepare(`
        UPDATE sites SET enabled = 0, secret = NULL, updated_at = ? WHERE site_id = ?
      `);
      for (const row of this.db.prepare('SELECT site_id FROM sites').all() as DbRow[]) {
        const siteId = String(row.site_id);
        if (!configuredSiteIds.has(siteId)) disableSite.run(now, siteId);
      }

      const upsertSite = this.db.prepare(`
        INSERT INTO sites (site_id, name, school_name, secret, enabled, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(site_id) DO UPDATE SET
          name = excluded.name,
          school_name = excluded.school_name,
          secret = COALESCE(excluded.secret, sites.secret),
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `);
      for (const site of config.sites) {
        upsertSite.run(site.site_id, site.name, site.school_name ?? null, site.secret ?? null, bool(site.enabled, true), now);
      }

      this.db.exec('DELETE FROM team_mappings; DELETE FROM problem_mappings; DELETE FROM teams; DELETE FROM problems;');
      const insertTeam = this.db.prepare(`
        INSERT INTO teams (team_id, name, school_id, school_name, official, hidden, groups_json, badge_url, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const team of config.teams) {
        insertTeam.run(
          team.team_id,
          team.name,
          team.school_id,
          team.school_name ?? null,
          bool(team.official, true),
          bool(team.hidden),
          JSON.stringify(team.groups ?? []),
          team.badge_url ?? null,
          now,
        );
      }

      const insertProblem = this.db.prepare(`
        INSERT INTO problems (problem_id, label, name, ordinal, color, rgb, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      config.problems.forEach((problem, index) => {
        insertProblem.run(problem.problem_id, problem.label, problem.name, problem.ordinal ?? index, problem.color ?? null, problem.rgb ?? null, now);
      });

      const insertTeamMapping = this.db.prepare(`
        INSERT INTO team_mappings (league_id, site_id, domain_id, contest_id, local_uid, team_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const mapping of config.team_mappings) {
        insertTeamMapping.run(mapping.league_id ?? config.contest.contest_id, mapping.site_id, mapping.domain_id, mapping.contest_id, mapping.local_uid, mapping.team_id);
      }

      const insertProblemMapping = this.db.prepare(`
        INSERT INTO problem_mappings (league_id, site_id, domain_id, contest_id, local_pid, problem_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const mapping of config.problem_mappings) {
        insertProblemMapping.run(mapping.league_id ?? config.contest.contest_id, mapping.site_id, mapping.domain_id, mapping.contest_id, mapping.local_pid, mapping.problem_id);
      }

      this.refreshMappings(now);
      this.addChange('configuration', null, null, now);
    });
  }

  private refreshMappings(now: string): void {
    const rows = this.db.prepare(`
      SELECT event_id, league_id, site_id, domain_id, contest_id, uid, pid,
        team_id, problem_id, quarantine_reason, mapping_warning, event_json
      FROM events
      ORDER BY event_id
    `).all() as DbRow[];
    const findTeam = this.db.prepare(`
      SELECT team_id FROM team_mappings
      WHERE league_id = ? AND site_id = ? AND domain_id = ? AND contest_id = ? AND local_uid = ?
    `);
    const findProblem = this.db.prepare(`
      SELECT problem_id FROM problem_mappings
      WHERE league_id = ? AND site_id = ? AND domain_id = ? AND contest_id = ? AND local_pid = ?
    `);
    const update = this.db.prepare(`
      UPDATE events
      SET team_id = ?, problem_id = ?, quarantine_reason = ?, mapping_warning = ?
      WHERE event_id = ?
    `);
    const nullableString = (value: unknown): string | null => value === null || value === undefined ? null : String(value);

    for (const row of rows) {
      const team = findTeam.get(
        String(row.league_id),
        String(row.site_id),
        String(row.domain_id),
        String(row.contest_id),
        String(row.uid),
      ) as DbRow | undefined;
      const problem = findProblem.get(
        String(row.league_id),
        String(row.site_id),
        String(row.domain_id),
        String(row.contest_id),
        String(row.pid),
      ) as DbRow | undefined;
      const teamId = team ? String(team.team_id) : null;
      const problemId = problem ? String(problem.problem_id) : null;
      const quarantineReason = [
        teamId ? null : 'TEAM_MAPPING_MISSING',
        problemId ? null : 'PROBLEM_MAPPING_MISSING',
      ].filter((reason): reason is string => reason !== null).join(',') || null;
      const event = parseJson<Partial<IngestEvent>>(row.event_json, {});
      const mappingWarning = [
        event.global_team_id && event.global_team_id !== teamId ? 'TEAM_HINT_MISMATCH' : null,
        event.global_problem_id && event.global_problem_id !== problemId ? 'PROBLEM_HINT_MISMATCH' : null,
      ].filter((reason): reason is string => reason !== null).join(',') || null;

      if (
        nullableString(row.team_id) === teamId
        && nullableString(row.problem_id) === problemId
        && nullableString(row.quarantine_reason) === quarantineReason
        && nullableString(row.mapping_warning) === mappingWarning
      ) continue;

      update.run(teamId, problemId, quarantineReason, mappingWarning, String(row.event_id));
      this.addChange('event', nullableString(row.site_id), String(row.event_id), now);
    }
  }

  consumeNonce(siteId: string, nonce: string, timestampMs: number, oldestAllowedMs: number): boolean {
    return this.withTransaction(() => {
      this.db.prepare('DELETE FROM nonces WHERE timestamp_ms < ?').run(oldestAllowedMs);
      try {
        this.db.prepare('INSERT INTO nonces (site_id, nonce, timestamp_ms) VALUES (?, ?, ?)')
          .run(siteId, nonce, timestampMs);
        return true;
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) return false;
        throw error;
      }
    });
  }

  recordHeartbeat(siteId: string, now: string, telemetry: {
    pendingEvents: number;
    rejectedEvents: number;
    lastAckedSourceSeq: number | null;
    agentVersion: string;
    hydroVersion: string;
  }): void {
    const result = this.db.prepare(`
      UPDATE sites SET last_heartbeat_at = ?, pending_events = ?, rejected_events = ?,
        last_acked_source_seq = ?, agent_version = ?, hydro_version = ?, updated_at = ?
      WHERE site_id = ? AND enabled = 1
    `).run(
      now,
      telemetry.pendingEvents,
      telemetry.rejectedEvents,
      telemetry.lastAckedSourceSeq,
      telemetry.agentVersion,
      telemetry.hydroVersion,
      now,
      siteId,
    );
    if (result.changes === 0) throw new Error('Unknown or disabled site');
    this.addChange('heartbeat', siteId, null, now);
  }

  ingestBatch(batch: EventBatch, now: string): {
    protocol_version: '1.0'; batch_id: string; league_id: string; site_id: string;
    accepted_count: number; duplicate_count: number;
    rejected: Array<{ source_seq: number; rid: string; code: string; message: string; retryable: boolean }>;
    high_watermark: number; received_at: string;
  } {
    const storageBatchId = batch.idempotency_key ?? batch.batch_id;
    const requestJson = canonicalJson(batch);
    const existing = this.db.prepare(`
      SELECT request_json, ack_json FROM batches WHERE site_id = ? AND batch_id = ?
    `).get(batch.site_id, storageBatchId) as DbRow | undefined;
    if (existing) {
      const previousRequest = String(existing.request_json);
      if (previousRequest && previousRequest !== requestJson) throw new BatchIdConflictError(storageBatchId);
      if (!previousRequest) {
        // Pre-migration rows cannot be compared retroactively. Pin the first
        // post-upgrade retry so every subsequent reuse is checked strictly.
        this.db.prepare(`
          UPDATE batches SET request_json = ? WHERE site_id = ? AND batch_id = ? AND request_json = ''
        `).run(requestJson, batch.site_id, storageBatchId);
      }
      const ack = parseJson<ReturnType<HubDatabase['ingestBatch']> | null>(existing.ack_json, null);
      if (!ack) throw new Error(`stored ACK for batch ${storageBatchId} is invalid`);
      return ack;
    }

    return this.withTransaction(() => {
      const items: IngestAckItem[] = [];
      for (const event of batch.events) {
        items.push(this.upsertEvent(event, now));
      }
      this.db.prepare(`
        UPDATE sites SET last_event_at = ?, last_heartbeat_at = ?, updated_at = ?
        WHERE site_id = ?
      `).run(now, now, now, batch.site_id);
      if (batch.snapshot_id) {
        const chunkMaximum = batch.events.reduce((maximum, event) => Math.max(maximum, event.source_seq), 0);
        this.db.prepare(`
          INSERT INTO snapshot_progress (site_id, league_id, snapshot_id, max_source_seq, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(site_id, league_id, snapshot_id) DO UPDATE SET
            max_source_seq = MAX(snapshot_progress.max_source_seq, excluded.max_source_seq),
            updated_at = excluded.updated_at
        `).run(batch.site_id, batch.league_id, batch.snapshot_id, chunkMaximum, now);
        if (batch.snapshot_complete) {
          const progress = this.db.prepare(`
            SELECT max_source_seq FROM snapshot_progress
            WHERE site_id = ? AND league_id = ? AND snapshot_id = ?
          `).get(batch.site_id, batch.league_id, batch.snapshot_id) as DbRow;
          this.db.prepare(`
            INSERT INTO site_watermarks (site_id, league_id, watermark, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(site_id, league_id) DO UPDATE SET
              watermark = MAX(site_watermarks.watermark, excluded.watermark),
              updated_at = excluded.updated_at
          `).run(batch.site_id, batch.league_id, Number(progress.max_source_seq), now);
          this.db.prepare(`
            DELETE FROM snapshot_progress WHERE site_id = ? AND league_id = ? AND snapshot_id = ?
          `).run(batch.site_id, batch.league_id, batch.snapshot_id);
        }
      }
      const rejected = items.filter((item) => item.status === 'rejected').map((item) => ({
        source_seq: item.source_seq,
        rid: item.rid,
        code: item.code ?? 'EVENT_REJECTED',
        message: item.message ?? 'Event was rejected',
        retryable: false,
      }));
      const ack = {
        protocol_version: '1.0' as const,
        batch_id: batch.batch_id,
        league_id: batch.league_id,
        site_id: batch.site_id,
        accepted_count: items.filter((item) => item.status === 'accepted').length,
        duplicate_count: items.filter((item) => item.status === 'duplicate' || item.status === 'stale').length,
        rejected,
        high_watermark: this.highWatermark(batch.site_id, batch.league_id),
        received_at: now,
      };
      this.db.prepare(`
        INSERT INTO batches (site_id, batch_id, received_at, request_json, ack_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(batch.site_id, storageBatchId, now, requestJson, JSON.stringify(ack));
      return ack;
    });
  }

  private upsertEvent(event: IngestEvent, now: string): IngestAckItem {
    const id = eventId(event);
    const serializedEvent = canonicalJson(event);
    const receipt = this.db.prepare(`
      SELECT event_id, event_json FROM source_receipts
      WHERE site_id = ? AND league_id = ? AND source_seq = ?
    `).get(event.site_id, event.league_id, event.source_seq) as DbRow | undefined;
    if (receipt) {
      if (String(receipt.event_json) === serializedEvent) {
        return { event_id: String(receipt.event_id), rid: event.rid, source_seq: event.source_seq, status: 'duplicate' };
      }
      return {
        event_id: id,
        rid: event.rid,
        source_seq: event.source_seq,
        status: 'rejected',
        code: 'SOURCE_SEQ_CONFLICT',
        message: `source_seq ${event.source_seq} was already used by a different event payload`,
      };
    }
    const rejectedSequence = this.db.prepare(`
      SELECT event_json, code, message FROM rejected_sequences
      WHERE site_id = ? AND league_id = ? AND source_seq = ?
    `).get(event.site_id, event.league_id, event.source_seq) as DbRow | undefined;
    if (rejectedSequence) {
      if (String(rejectedSequence.event_json) === serializedEvent) {
        return { event_id: id, rid: event.rid, source_seq: event.source_seq, status: 'duplicate' };
      }
      return {
        event_id: id,
        rid: event.rid,
        source_seq: event.source_seq,
        status: 'rejected',
        code: 'SOURCE_SEQ_CONFLICT',
        message: `source_seq ${event.source_seq} was already used by a different rejected payload`,
      };
    }
    const current = this.db.prepare(`
      SELECT event_id, source_seq, event_json, league_id, site_id, domain_id, contest_id, rid,
        uid, pid, submitted_at
      FROM events
      WHERE league_id = ? AND site_id = ? AND rid = ?
    `).get(event.league_id, event.site_id, event.rid) as DbRow | undefined;
    if (current) {
      const currentIdentity = canonicalJson({
        contest_id: String(current.contest_id),
        domain_id: String(current.domain_id),
        league_id: String(current.league_id),
        pid: Number(current.pid),
        rid: String(current.rid),
        site_id: String(current.site_id),
        submitted_at: String(current.submitted_at),
        uid: Number(current.uid),
      });
      if (currentIdentity !== immutableIdentity(event)) {
        const message = `revision for ${event.site_id}/${event.domain_id}/${event.contest_id}/${event.rid} changed immutable identity fields`;
        this.db.prepare(`
          INSERT INTO rejected_sequences
            (site_id, league_id, source_seq, rid, event_json, code, message, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          event.site_id,
          event.league_id,
          event.source_seq,
          event.rid,
          serializedEvent,
          'IMMUTABLE_IDENTITY_CONFLICT',
          message,
          now,
        );
        return {
          event_id: id,
          rid: event.rid,
          source_seq: event.source_seq,
          status: 'rejected',
          code: 'IMMUTABLE_IDENTITY_CONFLICT',
          message,
        };
      }
    }
    if (current && Number(current.source_seq) >= event.source_seq) {
      if (Number(current.source_seq) === event.source_seq && String(current.event_json) !== serializedEvent) {
        return {
          event_id: id,
          rid: event.rid,
          source_seq: event.source_seq,
          status: 'rejected',
          code: 'SOURCE_SEQ_CONFLICT',
          message: `source_seq ${event.source_seq} changed payload for an existing submission`,
        };
      }
      this.db.prepare(`
        INSERT INTO source_receipts
          (site_id, league_id, source_seq, rid, event_id, event_json, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(event.site_id, event.league_id, event.source_seq, event.rid, id, serializedEvent, now);
      return {
        event_id: id,
        rid: event.rid,
        source_seq: event.source_seq,
        status: Number(current.source_seq) === event.source_seq ? 'duplicate' : 'stale',
      };
    }

    const team = this.db.prepare(`
      SELECT team_id FROM team_mappings
      WHERE league_id = ? AND site_id = ? AND domain_id = ? AND contest_id = ? AND local_uid = ?
    `).get(event.league_id, event.site_id, event.domain_id, event.contest_id, String(event.uid)) as DbRow | undefined;
    const problem = this.db.prepare(`
      SELECT problem_id FROM problem_mappings
      WHERE league_id = ? AND site_id = ? AND domain_id = ? AND contest_id = ? AND local_pid = ?
    `).get(event.league_id, event.site_id, event.domain_id, event.contest_id, String(event.pid)) as DbRow | undefined;
    const teamId = team ? String(team.team_id) : null;
    const problemId = problem ? String(problem.problem_id) : null;
    const quarantineReasons = [
      !teamId ? 'TEAM_MAPPING_MISSING' : null,
      !problemId ? 'PROBLEM_MAPPING_MISSING' : null,
    ].filter((reason): reason is string => reason !== null);
    const mappingWarnings = [
      event.global_team_id && event.global_team_id !== teamId ? 'TEAM_HINT_MISMATCH' : null,
      event.global_problem_id && event.global_problem_id !== problemId ? 'PROBLEM_HINT_MISMATCH' : null,
    ].filter((reason): reason is string => reason !== null);
    const quarantined = quarantineReasons.length > 0;

    this.db.prepare(`
      INSERT INTO events (
        event_id, league_id, site_id, domain_id, contest_id, rid, source_seq, occurred_at, received_at,
        status, uid, pid, submitted_at, contest_time_ms, language, score, time_ms,
        memory_bytes, judged_at, team_id, problem_id, quarantine_reason, mapping_warning, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(league_id, site_id, domain_id, contest_id, rid) DO UPDATE SET
        event_id = excluded.event_id,
        source_seq = excluded.source_seq,
        occurred_at = excluded.occurred_at,
        received_at = excluded.received_at,
        status = excluded.status,
        uid = excluded.uid,
        pid = excluded.pid,
        submitted_at = excluded.submitted_at,
        contest_time_ms = excluded.contest_time_ms,
        language = excluded.language,
        score = excluded.score,
        time_ms = excluded.time_ms,
        memory_bytes = excluded.memory_bytes,
        judged_at = excluded.judged_at,
        team_id = excluded.team_id,
        problem_id = excluded.problem_id,
        quarantine_reason = excluded.quarantine_reason,
        mapping_warning = excluded.mapping_warning,
        event_json = excluded.event_json
    `).run(
      id,
      event.league_id,
      event.site_id,
      event.domain_id,
      event.contest_id,
      event.rid,
      event.source_seq,
      event.emitted_at,
      now,
      event.status,
      String(event.uid),
      String(event.pid),
      event.submitted_at,
      null,
      event.lang ?? null,
      event.score ?? null,
      null,
      null,
      event.judged_at ?? null,
      teamId,
      problemId,
      quarantined ? quarantineReasons.join(',') : null,
      mappingWarnings.length ? mappingWarnings.join(',') : null,
      serializedEvent,
    );
    this.db.prepare(`
      INSERT INTO source_receipts
        (site_id, league_id, source_seq, rid, event_id, event_json, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(event.site_id, event.league_id, event.source_seq, event.rid, id, serializedEvent, now);
    this.addChange('event', event.site_id, id, now);
    return { event_id: id, rid: event.rid, source_seq: event.source_seq, status: 'accepted' };
  }

  getEvents(contestId?: string): StoredEvent[] {
    const rows = contestId
      ? this.db.prepare('SELECT * FROM events WHERE league_id = ? ORDER BY occurred_at, event_id').all(contestId) as DbRow[]
      : this.db.prepare('SELECT * FROM events ORDER BY occurred_at, event_id').all() as DbRow[];
    return rows.map((row) => {
      const parsed = parseJson<IngestEvent>(row.event_json, {} as IngestEvent);
      return {
        ...parsed,
        event_id: String(row.event_id),
        league_id: String(row.league_id),
        site_id: String(row.site_id),
        domain_id: String(row.domain_id),
        contest_id: String(row.contest_id),
        rid: String(row.rid),
        source_seq: Number(row.source_seq),
        occurred_at: String(row.occurred_at),
        received_at: String(row.received_at),
        status: String(row.status),
        uid: Number(row.uid),
        pid: Number(row.pid),
        ...(row.submitted_at === null ? {} : { submitted_at: String(row.submitted_at) }),
        ...(row.contest_time_ms === null ? {} : { contest_time_ms: Number(row.contest_time_ms) }),
        language: row.language === null ? null : String(row.language),
        score: row.score === null ? null : Number(row.score),
        time_ms: row.time_ms === null ? null : Number(row.time_ms),
        memory_bytes: row.memory_bytes === null ? null : Number(row.memory_bytes),
        judged_at: row.judged_at === null ? null : String(row.judged_at),
        team_id: row.team_id === null ? null : String(row.team_id),
        problem_id: row.problem_id === null ? null : String(row.problem_id),
        quarantine_reason: row.quarantine_reason === null ? null : String(row.quarantine_reason),
        mapping_warning: row.mapping_warning === null ? null : String(row.mapping_warning),
      };
    });
  }

  getEventById(id: string): StoredEvent | null {
    const event = this.getEvents().find((candidate) => candidate.event_id === id);
    return event ?? null;
  }

  highWatermark(siteId: string, leagueId: string): number {
    const baseline = this.db.prepare(`
      SELECT watermark FROM site_watermarks WHERE site_id = ? AND league_id = ?
    `).get(siteId, leagueId) as DbRow | undefined;
    const rows = this.db.prepare(`
      SELECT source_seq FROM source_receipts WHERE site_id = ? AND league_id = ?
      UNION
      SELECT source_seq FROM rejected_sequences WHERE site_id = ? AND league_id = ?
      ORDER BY source_seq
    `).all(siteId, leagueId, siteId, leagueId) as DbRow[];
    let watermark = baseline ? Number(baseline.watermark) : 0;
    for (const row of rows) {
      const sequence = Number(row.source_seq);
      if (sequence <= watermark) continue;
      if (sequence === watermark + 1) watermark = sequence;
      else if (sequence > watermark + 1) break;
    }
    return watermark;
  }

  latestCursor(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(cursor), 0) AS cursor FROM changes').get() as DbRow;
    return Number(row.cursor);
  }

  synchronizeContestNotifications(notifications: readonly ContestNotificationInput[], now: string): void {
    this.withTransaction(() => this.synchronizeContestNotificationsInTransaction(notifications, now));
  }

  private synchronizeContestNotificationsInTransaction(
    notifications: readonly ContestNotificationInput[],
    now: string,
  ): void {
    const current = new Map<string, ContestNotificationInput>();
    for (const notification of notifications) {
      const key = `${notification.type}\0${notification.id ?? ''}`;
      if (current.has(key)) throw new Error(`duplicate Contest API resource ${notification.type}/${notification.id ?? ''}`);
      current.set(key, notification);
    }

    const previous = this.db.prepare(`
      SELECT type, resource_key, resource_id, data_json
      FROM contest_notification_state
      ORDER BY type, resource_key
    `).all() as DbRow[];
    const append = this.db.prepare(`
      INSERT INTO contest_notifications (type, resource_id, data_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const remove = this.db.prepare(`
      DELETE FROM contest_notification_state WHERE type = ? AND resource_key = ?
    `);
    for (const row of previous) {
      const key = `${String(row.type)}\0${String(row.resource_key)}`;
      if (current.has(key)) continue;
      append.run(
        String(row.type),
        row.resource_id === null ? null : String(row.resource_id),
        'null',
        now,
      );
      remove.run(String(row.type), String(row.resource_key));
    }

    const upsert = this.db.prepare(`
      INSERT INTO contest_notification_state (type, resource_key, resource_id, data_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(type, resource_key) DO UPDATE SET
        resource_id = excluded.resource_id,
        data_json = excluded.data_json
    `);
    const getState = this.db.prepare(`
      SELECT data_json FROM contest_notification_state
      WHERE type = ? AND resource_key = ?
    `);
    for (const notification of notifications) {
      const resourceKey = notification.id ?? '';
      const serialized = canonicalJson(notification.data);
      const state = getState.get(notification.type, resourceKey) as DbRow | undefined;
      if (state && String(state.data_json) === serialized) continue;
      append.run(notification.type, notification.id, serialized, now);
      upsert.run(notification.type, resourceKey, notification.id, serialized);
    }
  }

  getContestNotifications(afterToken = 0): ContestNotification[] {
    return (this.db.prepare(`
      SELECT token, type, resource_id, data_json
      FROM contest_notifications
      WHERE token > ?
      ORDER BY token
    `).all(afterToken) as DbRow[]).map((row) => ({
      token: Number(row.token),
      type: String(row.type),
      id: row.resource_id === null ? null : String(row.resource_id),
      data: parseJson(row.data_json, null),
    }));
  }

  getContestFinalizedAt(contestId: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?')
      .get(`contest_finalized:${contestId}`) as DbRow | undefined;
    return row ? String(row.value) : null;
  }

  finalizeContestAtomically(input: ContestFinalizationInput): ContestFinalizationResult {
    return this.withTransaction(() => {
      const configuredContest = this.db.prepare(`
        SELECT contest_id FROM contest_config WHERE singleton = 1
      `).get() as DbRow | undefined;
      if (!configuredContest) throw new Error('cannot finalize before league configuration is loaded');
      const configuredContestId = String(configuredContest.contest_id);
      if (configuredContestId !== input.contestId) {
        throw new ContestIdImmutableError(configuredContestId, input.contestId);
      }

      const finalizedKey = `contest_finalized:${input.contestId}`;
      const existingFinalization = this.db.prepare('SELECT value FROM meta WHERE key = ?')
        .get(finalizedKey) as DbRow | undefined;
      const finalizedAt = existingFinalization ? String(existingFinalization.value) : input.finalizedAt;
      if (existingFinalization && finalizedAt !== input.finalizedAt) {
        throw new Error(`contest ${input.contestId} was already finalized at ${finalizedAt}`);
      }
      this.db.prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO NOTHING
      `).run(finalizedKey, finalizedAt);

      let publishedAt = this.getContestPublishedAt(input.contestId);
      if (input.publishedAt !== undefined) {
        if (publishedAt !== null && publishedAt !== input.publishedAt) {
          throw new Error(`contest ${input.contestId} results were already published at ${publishedAt}`);
        }
        this.db.prepare(`
          INSERT INTO meta (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO NOTHING
        `).run(`contest_published:${input.contestId}`, input.publishedAt);
        publishedAt = input.publishedAt;
      }

      this.synchronizeContestNotificationsInTransaction(input.notifications, input.notificationCreatedAt);
      const terminal = this.getContestNotifications().at(-1);
      const terminalData = terminal?.data && typeof terminal.data === 'object' && !Array.isArray(terminal.data)
        ? terminal.data as Record<string, unknown>
        : null;
      if (
        terminal?.type !== 'state'
        || terminalData?.finalized !== finalizedAt
        || typeof terminalData.end_of_updates !== 'string'
      ) {
        throw new Error('atomic finalization requires a terminal state notification with finalized and end_of_updates');
      }
      return { finalizedAt, publishedAt };
    });
  }

  getContestPublishedAt(contestId: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?')
      .get(`contest_published:${contestId}`) as DbRow | undefined;
    return row ? String(row.value) : null;
  }

  publishContestResults(contestId: string, publishedAt: string): string {
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO NOTHING
    `).run(`contest_published:${contestId}`, publishedAt);
    return this.getContestPublishedAt(contestId) ?? publishedAt;
  }

  getChanges(afterCursor: number, limit = 1_000): ChangeRow[] {
    return (this.db.prepare(`
      SELECT cursor, kind, site_id, event_id, created_at
      FROM changes WHERE cursor > ? ORDER BY cursor LIMIT ?
    `).all(afterCursor, limit) as DbRow[]).map((row) => ({
      cursor: Number(row.cursor),
      kind: String(row.kind),
      site_id: row.site_id === null ? null : String(row.site_id),
      event_id: row.event_id === null ? null : String(row.event_id),
      created_at: String(row.created_at),
    }));
  }

  private addChange(kind: string, siteId: string | null, eventIdValue: string | null, now: string): number {
    const result = this.db.prepare('INSERT INTO changes (kind, site_id, event_id, created_at) VALUES (?, ?, ?, ?)')
      .run(kind, siteId, eventIdValue, now);
    return Number(result.lastInsertRowid);
  }

  ensureDevFixture(now: string): void {
    if (this.getContest()) return;
    const id = randomUUID();
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run('instance_id', id);
    void now;
  }
}
