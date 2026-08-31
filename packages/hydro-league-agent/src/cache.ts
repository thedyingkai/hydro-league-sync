import type { CacheResult, Clock } from './types.js';
import { systemClock } from './types.js';

interface CacheEntry<T> {
  value: T;
  fetchedAt: Date;
}

export class SegregatedRemoteCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<CacheResult<unknown>>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxStaleMs: number,
    private readonly clock: Clock = systemClock,
  ) {}

  async get<T>(key: string, loader: () => Promise<T>): Promise<CacheResult<T>> {
    const now = this.clock.now();
    const entry = this.entries.get(key) as CacheEntry<T> | undefined;
    if (entry && now.getTime() - entry.fetchedAt.getTime() <= this.ttlMs) {
      return { value: entry.value, stale: false, fetchedAt: entry.fetchedAt.toISOString() };
    }
    const existing = this.inflight.get(key) as Promise<CacheResult<T>> | undefined;
    if (existing) return existing;

    const operation = (async (): Promise<CacheResult<T>> => {
      try {
        const value = await loader();
        const fetchedAt = this.clock.now();
        this.entries.set(key, { value, fetchedAt });
        return { value, stale: false, fetchedAt: fetchedAt.toISOString() };
      } catch (error) {
        const staleAge = entry ? this.clock.now().getTime() - entry.fetchedAt.getTime() : Number.POSITIVE_INFINITY;
        if (entry && staleAge <= this.maxStaleMs) {
          return {
            value: entry.value,
            stale: true,
            fetchedAt: entry.fetchedAt.toISOString(),
            error: error instanceof Error ? error.message : String(error),
          };
        }
        throw error;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, operation as Promise<CacheResult<unknown>>);
    return operation;
  }

  clear(prefix?: string): void {
    if (!prefix) {
      this.entries.clear();
      return;
    }
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}
