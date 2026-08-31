import type {
  BatchAck,
  Clock,
  CollectionLike,
  FindCursorLike,
  HubTransport,
  LoggerLike,
  MongoServiceLike,
} from '../src/types.js';

function emptyAck(): BatchAck {
  return {
    protocol_version: '1.0',
    batch_id: '00000000-0000-4000-8000-000000000000',
    league_id: 'league-2026',
    site_id: 'school-a',
    accepted_count: 0,
    duplicate_count: 0,
    rejected: [],
    high_watermark: 0,
    received_at: '2026-08-30T05:00:00.000Z',
  };
}

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && !(expected instanceof Date) && !Array.isArray(expected)) {
    const operators = expected as Record<string, unknown>;
    if ('$lte' in operators && !(comparable(actual)! <= comparable(operators.$lte)!)) return false;
    if ('$gt' in operators && !(comparable(actual)! > comparable(operators.$gt)!)) return false;
    if ('$exists' in operators && ((actual !== undefined) !== Boolean(operators.$exists))) return false;
    if ('$in' in operators && !(operators.$in as unknown[]).some((item) => comparable(item) === comparable(actual))) return false;
    if ('$nin' in operators && (operators.$nin as unknown[]).some((item) => comparable(item) === comparable(actual))) return false;
    if (Object.keys(operators).some((key) => key.startsWith('$'))) return true;
  }
  return comparable(actual) === comparable(expected);
}

function matches(document: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  if (Array.isArray(filter.$or)) {
    const alternatives = filter.$or as Array<Record<string, unknown>>;
    if (!alternatives.some((alternative) => matches(document, alternative))) return false;
  }
  return Object.entries(filter)
    .filter(([key]) => !key.startsWith('$'))
    .every(([key, expected]) => matchesValue(document[key], expected));
}

function applyUpdate<T extends Record<string, unknown>>(
  document: T,
  update: Record<string, unknown>,
  inserting: boolean,
): T {
  if (inserting && update.$setOnInsert) Object.assign(document, update.$setOnInsert);
  if (update.$set) Object.assign(document, update.$set);
  if (update.$inc) {
    for (const [key, amount] of Object.entries(update.$inc as Record<string, number>)) {
      document[key as keyof T] = (Number(document[key] ?? 0) + amount) as T[keyof T];
    }
  }
  if (update.$unset) {
    for (const key of Object.keys(update.$unset as Record<string, unknown>)) delete document[key];
  }
  return document;
}

class MemoryCursor<T extends Record<string, unknown>> implements FindCursorLike<T> {
  private sortSpec: Record<string, 1 | -1> = {};
  private max = Number.POSITIVE_INFINITY;
  private projection?: Record<string, 0 | 1>;

  constructor(private readonly input: T[]) {}

  sort(spec: Record<string, 1 | -1>): FindCursorLike<T> {
    this.sortSpec = spec;
    return this;
  }

  limit(count: number): FindCursorLike<T> {
    this.max = count;
    return this;
  }

  project<U>(spec: Record<string, 0 | 1>): FindCursorLike<U> {
    this.projection = spec;
    return this as unknown as FindCursorLike<U>;
  }

  batchSize(): FindCursorLike<T> {
    return this;
  }

  async toArray(): Promise<T[]> {
    const entries = [...this.input];
    const [sortKey, direction] = Object.entries(this.sortSpec)[0] ?? [];
    if (sortKey && direction) {
      entries.sort((left, right) => {
        const a = comparable(left[sortKey]);
        const b = comparable(right[sortKey]);
        return (a! < b! ? -1 : a! > b! ? 1 : 0) * direction;
      });
    }
    return entries.slice(0, this.max).map((entry) => {
      if (!this.projection) return entry;
      return Object.fromEntries(
        Object.entries(entry).filter(([key]) => this.projection?.[key] === 1),
      ) as T;
    });
  }
}

export class MemoryCollection<T extends Record<string, unknown>> implements CollectionLike<T> {
  readonly documents: T[];

  constructor(initial: T[] = []) {
    this.documents = [...initial];
  }

  async findOne(filter: Record<string, unknown>): Promise<T | null> {
    return this.documents.find((document) => matches(document, filter)) ?? null;
  }

  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<T | null> {
    let document = this.documents.find((entry) => matches(entry, filter));
    let inserting = false;
    if (!document && options.upsert) {
      inserting = true;
      document = Object.fromEntries(
        Object.entries(filter).filter(([key, value]) => !key.startsWith('$') && typeof value !== 'object'),
      ) as T;
      this.documents.push(document);
    }
    if (!document) return null;
    return applyUpdate(document, update, inserting);
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown> = {},
  ): Promise<unknown> {
    await this.findOneAndUpdate(filter, update, options);
    return { acknowledged: true };
  }

  async updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<unknown> {
    this.documents.filter((document) => matches(document, filter)).forEach((document) => applyUpdate(document, update, false));
    return { acknowledged: true };
  }

  async countDocuments(filter: Record<string, unknown> = {}): Promise<number> {
    return this.documents.filter((document) => matches(document, filter)).length;
  }

  find(filter: Record<string, unknown>): FindCursorLike<T> {
    return new MemoryCursor(this.documents.filter((document) => matches(document, filter)));
  }
}

export class MemoryMongo implements MongoServiceLike {
  readonly collections = new Map<string, MemoryCollection<any>>();
  readonly indexes: unknown[] = [];

  collection<T extends Record<string, unknown>>(name: string): MemoryCollection<T> {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name)!;
  }

  async ensureIndexes(_collection: CollectionLike<unknown>, ...indexes: Array<Record<string, unknown>>): Promise<void> {
    this.indexes.push(...indexes);
  }
}

export class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export const silentLogger: LoggerLike = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function transportStub(overrides: Partial<HubTransport> = {}): HubTransport {
  return {
    sendBatch: async () => emptyAck(),
    sendSnapshot: async () => emptyAck(),
    sendHeartbeat: async () => undefined,
    getScoreboard: async (view) => ({ view, rows: [], teams: [] }),
    getSubmissions: async (cursor) => ({ cursor, items: [] }),
    getXcpcio: async () => ({
      contest: {
        contest_name: 'League',
        start_time: 0,
        end_time: 1,
        frozen_time: 0,
        penalty: 1200,
        problem_quantity: 0,
        problem_id: [],
        group: {},
        organization: 'School',
        status_time_display: { correct: true, incorrect: true, pending: true },
        medal: 'icpc',
        logo: { preset: 'ICPC' },
        options: { submission_timestamp_unit: 'millisecond' },
      },
      teams: [],
      submissions: [],
    }),
    getSiteStatus: async () => [],
    ...overrides,
  };
}
