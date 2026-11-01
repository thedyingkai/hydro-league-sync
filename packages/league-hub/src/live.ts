import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createAuthenticator } from './auth.js';
import type { ResolvedHubOptions } from './config.js';
import type { ContestNotificationInput, HubDatabase } from './database.js';
import { buildContestApiResources, contestApiResourceId } from './icpc.js';
import { buildScoreboard, type ScoreboardSnapshot } from './scoreboard.js';

const prefix = '/api/live';
const heartbeatMs = 15_000;
const collections = {
  'judgement-types': 'judgement_types',
  languages: 'languages',
  groups: 'groups',
  organizations: 'organizations',
  teams: 'teams',
  problems: 'problems',
  submissions: 'submissions',
  judgements: 'judgements',
  runs: 'runs',
  awards: 'awards',
} as const;
const filters: Record<keyof typeof collections, readonly string[]> = {
  'judgement-types': [], languages: [], groups: [], organizations: [], problems: [],
  teams: ['organization_id'],
  submissions: ['language_id', 'problem_id', 'team_id'],
  judgements: ['submission_id', 'judgement_type_id'],
  runs: ['judgement_id', 'judgement_type_id'], awards: [],
};
const properties: Record<string, string[]> = {
  contest: ['id', 'name', 'formal_name', 'start_time', 'duration', 'scoreboard_freeze_duration', 'scoreboard_type', 'penalty_time'],
  'judgement-types': ['id', 'name', 'penalty', 'solved'],
  languages: ['id', 'name'],
  groups: ['id', 'name', 'type'],
  organizations: ['id', 'name', 'formal_name', 'logo'],
  teams: ['id', 'name', 'display_name', 'organization_id', 'group_ids'],
  problems: ['id', 'label', 'name', 'ordinal', 'color', 'rgb'],
  submissions: ['id', 'language_id', 'problem_id', 'team_id', 'time', 'contest_time'],
  judgements: ['id', 'submission_id', 'judgement_type_id', 'start_time', 'start_contest_time', 'end_time', 'end_contest_time'],
  runs: ['id', 'judgement_id', 'ordinal', 'judgement_type_id', 'time', 'contest_time'],
  awards: ['id', 'citation', 'team_ids'],
  state: ['started', 'frozen', 'ended', 'thawed', 'finalized', 'end_of_updates'],
  scoreboard: ['time', 'contest_time', 'state', 'rows'],
  'event-feed': ['type', 'id', 'data', 'token'],
};

function preciseDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds));
  const seconds = Math.floor(total / 1_000);
  const base = `${Math.floor(seconds / 3_600)}:${String(Math.floor((seconds % 3_600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const fraction = total % 1_000;
  return fraction ? `${base}.${String(fraction).padStart(3, '0')}` : base;
}

/** Broadcast data is filtered before it can enter the independent replay log. */
export function buildBroadcastResources(database: HubDatabase, snapshot: ScoreboardSnapshot) {
  if (snapshot.view !== 'public') throw new Error('Broadcast resources require a public scoreboard');
  const resources = buildContestApiResources(database, snapshot);
  const contest = snapshot.contest;
  const now = Date.parse(snapshot.generated_at);
  const start = Date.parse(contest.start_time);
  const freeze = contest.freeze_time ? Date.parse(contest.freeze_time) : null;
  const events = database.getEvents(contest.contest_id);
  const byId = new Map(events.map((event) => [event.event_id, event]));
  // Live calculates its own ranking from contest_time, including the last-AC
  // tie-break. Preserve source milliseconds instead of the legacy CDP rounding.
  const elapsed = (event: (typeof events)[number]) => event.contest_time_ms
    ?? Math.max(0, Date.parse(event.submitted_at ?? event.occurred_at) - start);
  resources.submissions = resources.submissions.map((submission) => {
    const event = byId.get(String(submission.id))!;
    return { ...submission, contest_time: preciseDuration(elapsed(event)) };
  });
  resources.judgements = resources.judgements.map((judgement) => {
    const event = byId.get(String(judgement.submission_id))!;
    const submitted = elapsed(event);
    const judged = Math.max(submitted, Date.parse(event.judged_at ?? event.occurred_at) - start);
    return { ...judgement, start_contest_time: preciseDuration(submitted), end_contest_time: preciseDuration(judged) };
  });
  resources.contests[0]!.duration = preciseDuration(Date.parse(contest.end_time) - start);
  resources.scoreboard.contest_time = preciseDuration(Date.parse(resources.scoreboard.time) - start);
  const publishedAt = database.getContestPublishedAt(contest.contest_id);
  const releaseAt = publishedAt ?? contest.unfreeze_at;
  const ended = now >= Date.parse(contest.end_time) ? contest.end_time : null;
  const frozenAt = freeze !== null && now >= freeze ? contest.freeze_time! : null;
  const thawed = frozenAt && !snapshot.frozen && releaseAt && now >= Date.parse(releaseAt) ? releaseAt : null;
  const finalized = ended && !snapshot.frozen ? database.getContestFinalizedAt(contest.contest_id) : null;
  const state = {
    started: now >= start ? contest.start_time : null,
    frozen: frozenAt,
    ended,
    thawed,
    finalized,
    end_of_updates: finalized
      ? new Date(Math.max(Date.parse(finalized), Date.parse(thawed ?? finalized)) + 1).toISOString()
      : null,
  };

  if (snapshot.frozen && freeze !== null) {
    // Use exact source milliseconds, not the second-rounded Contest API time.
    const visible = new Set(events.filter((event) => {
      return start + Math.max(0, elapsed(event)) < freeze;
    }).map((event) => event.event_id));
    resources.judgements = resources.judgements.filter((judgement) => visible.has(String(judgement.submission_id)));
  }
  // Only Hub applies the freeze. A second freeze in ICPC Live would retain
  // pending verdicts even after Hub publishes them (and differs at the boundary).
  resources.contests[0]!.scoreboard_freeze_duration = '0:00:00';
  resources.state = state;
  resources.scoreboard.state = state;
  // Preconfigured winner/medal citations must not reveal frozen results.
  if (!finalized) resources.awards = [];
  return resources;
}

export function buildBroadcastEventFeed(database: HubDatabase, snapshot: ScoreboardSnapshot, afterToken = 0) {
  const resources = buildBroadcastResources(database, snapshot);
  const notifications: ContestNotificationInput[] = [
    { type: 'contest', id: null, data: resources.contests[0] },
  ];
  for (const [type, key] of Object.entries(collections)) {
    for (const resource of resources[key]) {
      notifications.push({ type, id: String(resource.id), data: resource });
    }
  }
  // Terminal state must follow all newly released judgements, including when
  // a client connects for the first time after publication.
  notifications.push({ type: 'state', id: null, data: resources.state });
  database.synchronizeBroadcastNotifications(notifications, snapshot.generated_at);
  const visible = new Set(notifications.map((event) => `${event.type}\0${event.id ?? ''}`));
  return database.getBroadcastNotifications(afterToken)
    .filter((event) => {
      // A later configuration change can hide a team or move the freeze earlier.
      // Keep tokens and tombstones, but do not replay an old resource payload
      // that is no longer public. Data already received by a client cannot be
      // recalled; its tombstone still removes it from the client's current view.
      if (event.data === null) return true;
      if (!visible.has(`${event.type}\0${event.id ?? ''}`)) return false;
      if (event.type === 'submissions') {
        const data = event.data as Record<string, unknown>;
        // Team mappings may also change without changing a submission's ID.
        return visible.has(`teams\0${String(data.team_id)}`)
          && visible.has(`problems\0${String(data.problem_id)}`);
      }
      return true;
    })
    .map((event) => ({ ...event, token: String(event.token) }));
}

async function error(reply: FastifyReply, code: number, message: string) {
  await reply.code(code).send({ code, message });
}

export function registerBroadcastApi(app: FastifyInstance, database: HubDatabase, options: ResolvedHubOptions): void {
  const auth = createAuthenticator(database, options);
  const streams = new Set<ServerResponse>();
  // Close hijacked responses before Fastify waits for active requests to finish.
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
  });
  app.register(async (live) => {
    live.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      await auth.authenticateBroadcast(request, reply);
    });
    const info = {
      version: '2023-06', version_url: 'https://ccs-specs.icpc.io/2023-06/contest_api',
      provider: { name: 'Hydro League Hub Broadcast', version: '0.1.2' },
    };
    live.get(prefix, async () => info);
    live.get(`${prefix}/`, async () => info);
    live.get(`${prefix}/contests`, async () => {
      const snapshot = buildScoreboard(database, 'public', options);
      return snapshot ? buildBroadcastResources(database, snapshot).contests : [];
    });

    const read = async (request: FastifyRequest<{ Params: { contestId: string } }>, reply: FastifyReply) => {
      const snapshot = buildScoreboard(database, 'public', options);
      if (!snapshot || request.params.contestId !== contestApiResourceId(snapshot.contest.contest_id, 'contest')) {
        await error(reply, 404, 'Contest not found');
        return null;
      }
      return { snapshot, resources: buildBroadcastResources(database, snapshot) };
    };
    const root = `${prefix}/contests/:contestId`;
    live.get<{ Params: { contestId: string } }>(root, async (request, reply) => {
      const result = await read(request, reply);
      if (result) return result.resources.contests[0];
    });
    live.get<{ Params: { contestId: string } }>(`${root}/access`, async (request, reply) => {
      if (!await read(request, reply)) return;
      return { capabilities: [], endpoints: Object.entries(properties).map(([type, fields]) => ({ type, properties: fields })) };
    });
    for (const name of ['state', 'scoreboard'] as const) {
      live.get<{ Params: { contestId: string } }>(`${root}/${name}`, async (request, reply) => {
        const result = await read(request, reply);
        if (result) return result.resources[name];
      });
    }
    for (const [name, key] of Object.entries(collections)) {
      live.get<{ Params: { contestId: string }; Querystring: Record<string, string | string[] | undefined> }>(`${root}/${name}`, async (request, reply) => {
        const result = await read(request, reply);
        if (!result) return;
        let rows: Array<Record<string, unknown>> = result.resources[key];
        for (const [property, value] of Object.entries(request.query)) {
          if (!filters[name as keyof typeof collections].includes(property) || typeof value !== 'string') {
            return error(reply, 400, `Invalid filter '${property}'`);
          }
          rows = rows.filter((row) => (row[property] ?? null) === (value === '' ? null : value));
        }
        return rows;
      });
      live.get<{ Params: { contestId: string; resourceId: string } }>(`${root}/${name}/:resourceId`, async (request, reply) => {
        const result = await read(request, reply);
        if (!result) return;
        const resource = result.resources[key].find((item) => item.id === request.params.resourceId);
        if (!resource) return error(reply, 404, 'Resource not found');
        return resource;
      });
    }

    live.get<{ Params: { contestId: string }; Querystring: { since_token?: string; stream?: string } }>(`${root}/event-feed`, async (request, reply) => {
      const result = await read(request, reply);
      if (!result) return;
      const rawToken = request.query.since_token ?? '0';
      if (typeof rawToken !== 'string' || !/^\d+$/.test(rawToken) || !Number.isSafeInteger(Number(rawToken))) {
        return error(reply, 400, 'since_token is invalid');
      }
      if (request.query.stream !== undefined && !['true', 'false'].includes(request.query.stream)) {
        return error(reply, 400, 'stream must be true or false');
      }
      const since = Number(rawToken);
      const all = buildBroadcastEventFeed(database, result.snapshot);
      // Previously issued tokens remain valid even when their payload is now
      // filtered out of replay by a more restrictive public configuration.
      if (since !== 0 && !database.hasBroadcastNotification(since)) {
        return error(reply, 400, 'since_token does not identify an available broadcast event');
      }
      const feed = all.filter((event) => Number(event.token) > since);
      const serialize = (events: typeof feed) => events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
      if (request.query.stream === 'false') return reply.type('application/x-ndjson').send(serialize(feed));

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store',
        connection: 'keep-alive', 'x-accel-buffering': 'no',
      });
      reply.raw.flushHeaders();
      if (feed.length) reply.raw.write(serialize(feed));
      if (result.resources.state.end_of_updates) { reply.raw.end(); return; }
      let cursor = feed.length ? Number(feed.at(-1)!.token) : since;
      let lastWrite = Date.now();
      streams.add(reply.raw);
      const interval = setInterval(() => {
        if (reply.raw.destroyed || reply.raw.writableEnded) { clearInterval(interval); return; }
        // Do not accumulate unbounded queued writes for a slow/disconnected client.
        if (reply.raw.writableNeedDrain) return;
        try {
          const snapshot = buildScoreboard(database, 'public', options);
          if (!snapshot) throw new Error('League configuration is not loaded');
          const updates = buildBroadcastEventFeed(database, snapshot, cursor);
          if (updates.length) {
            reply.raw.write(serialize(updates));
            cursor = Number(updates.at(-1)!.token);
            lastWrite = Date.now();
          } else if (Date.now() - lastWrite >= heartbeatMs) {
            reply.raw.write('\n');
            lastWrite = Date.now();
          }
          if (buildBroadcastResources(database, snapshot).state.end_of_updates) reply.raw.end();
        } catch {
          reply.raw.destroy();
        }
      }, 1_000);
      interval.unref();
      reply.raw.once('close', () => { clearInterval(interval); streams.delete(reply.raw); });
    });
  });
}
