import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  createSignedHeaders,
  parseEventBatchAck,
  validateEventBatchEnvelope,
  validateSnapshotEnvelope,
} from './protocol.js';
import { hubPaths } from './config.js';
import { PROTOCOL_VERSION } from './event-factory.js';
import {
  parseScoreboardResponse,
  parseSiteStatusResponse,
  parseSubmissionFeedResponse,
  parseXcpcioAllInOneResponse,
} from './hub-response.js';
import type {
  AgentConfig,
  BatchAck,
  BatchEnvelope,
  BoardView,
  HeartbeatEnvelope,
  HubTransport,
  ScoreboardResponse,
  SnapshotEnvelope,
  SubmissionEvent,
  SubmissionFeedResponse,
  XcpcioAllInOneResponse,
} from './types.js';

export function createHmacHeaders(options: {
  method: string;
  pathWithQuery: string;
  bodyText: string;
  siteId: string;
  sharedSecret: string;
  timestamp?: string;
  nonce?: string;
}): Record<string, string> {
  const parsedTimestamp = options.timestamp === undefined
    ? undefined
    : Number.parseInt(options.timestamp, 10);
  return createSignedHeaders({
    method: options.method,
    path: options.pathWithQuery,
    siteId: options.siteId,
    body: options.bodyText,
    secret: options.sharedSecret,
    ...(parsedTimestamp !== undefined ? { timestamp: parsedTimestamp } : {}),
    ...(options.nonce ? { nonce: options.nonce } : {}),
  });
}

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class ContestFinalizedError extends HttpError {
  constructor(message = 'The league hub has finalized this contest') {
    super(message, 409, false, 'contest_finalized');
    this.name = 'ContestFinalizedError';
  }
}

export function isContestFinalizedError(error: unknown): error is ContestFinalizedError {
  return error instanceof ContestFinalizedError
    || (error instanceof HttpError && error.status === 409 && error.code === 'contest_finalized');
}

export class HttpHubTransport implements HubTransport {
  constructor(
    private readonly config: AgentConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request<T>(method: 'GET' | 'POST', pathWithQuery: string, body?: unknown): Promise<T> {
    const bodyText = body === undefined ? '' : canonicalJson(body);
    const headers = createHmacHeaders({
      method,
      pathWithQuery,
      bodyText,
      siteId: this.config.siteId,
      sharedSecret: this.config.sharedSecret,
    });
    const response = await this.fetchImpl(`${this.config.centerUrl}${pathWithQuery}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: bodyText }),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = text.replace(/\s+/g, ' ').slice(0, 500);
      let code: string | undefined;
      try {
        const body = JSON.parse(text) as { error?: unknown };
        if (typeof body.error === 'string') code = body.error.slice(0, 100);
      } catch {
        // Preserve the bounded response text below when the error is not JSON.
      }
      if (response.status === 409 && code === 'contest_finalized') {
        throw new ContestFinalizedError(
          `Hub ${method} ${pathWithQuery.split('?')[0]} rejected the write because the contest is finalized`,
        );
      }
      throw new HttpError(
        `Hub ${method} ${pathWithQuery.split('?')[0]} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
        response.status === 408 || response.status === 429 || response.status >= 500,
        code,
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(`Hub ${method} ${pathWithQuery.split('?')[0]} returned invalid JSON`, response.status, true);
    }
  }

  async sendBatch(events: SubmissionEvent[]): Promise<BatchAck> {
    const envelope: BatchEnvelope = validateEventBatchEnvelope({
      protocol_version: PROTOCOL_VERSION,
      batch_id: randomUUID(),
      league_id: this.config.leagueId,
      site_id: this.config.siteId,
      sent_at: new Date().toISOString(),
      events,
    });
    const ack = parseEventBatchAck(
      await this.request('POST', hubPaths.eventBatch(this.config.siteId), envelope),
    );
    if (ack.batch_id !== envelope.batch_id || ack.site_id !== this.config.siteId || ack.league_id !== this.config.leagueId) {
      throw new HttpError('Hub ACK identifiers do not match the uploaded batch', 502, true);
    }
    return ack;
  }

  async sendSnapshot(envelope: SnapshotEnvelope): Promise<BatchAck> {
    const validated = validateSnapshotEnvelope(envelope);
    const ack = parseEventBatchAck(
      await this.request('POST', hubPaths.snapshot(this.config.siteId), validated),
    );
    if (ack.batch_id !== validated.snapshot_id || ack.site_id !== this.config.siteId || ack.league_id !== this.config.leagueId) {
      throw new HttpError('Hub ACK identifiers do not match the uploaded snapshot', 502, true);
    }
    return ack;
  }

  async sendHeartbeat(envelope: HeartbeatEnvelope): Promise<void> {
    await this.request('POST', hubPaths.heartbeat(this.config.siteId), envelope);
  }

  async getScoreboard(view: BoardView): Promise<ScoreboardResponse> {
    return parseScoreboardResponse(
      await this.request('GET', hubPaths.scoreboard(this.config.leagueId, view)),
      view,
    );
  }

  async getSubmissions(cursor: string, view: BoardView): Promise<SubmissionFeedResponse> {
    return parseSubmissionFeedResponse(
      await this.request('GET', hubPaths.submissions(this.config.leagueId, cursor, view)),
      view,
    );
  }

  async getXcpcio(view: BoardView): Promise<XcpcioAllInOneResponse> {
    return parseXcpcioAllInOneResponse(
      await this.request('GET', hubPaths.xcpcio(this.config.leagueId, view)),
    );
  }

  async getSiteStatus(): Promise<unknown> {
    return parseSiteStatusResponse(
      await this.request('GET', hubPaths.siteStatus(this.config.leagueId)),
    );
  }
}
