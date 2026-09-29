// One small cache for everything the server fetches from the internet
// (catalog index, per-model details, ollaya.dev index): a TTL, one shared
// in-flight load per key, a stale fallback when a refresh fails, and an upper
// bound on entries so user-controlled keys can't grow it forever.

export interface CacheResult<V> {
  value: V;
  /** Loaded by this very call (or one that finished < 5 s ago) */
  fresh: boolean;
  /** Served from an expired entry because the refresh failed */
  stale: boolean;
}

export function createTtlCache<K, V>({
  ttlMs,
  maxEntries = 1_000,
}: {
  ttlMs: number;
  maxEntries?: number;
}) {
  const entries = new Map<K, { value: V; at: number }>();
  const inflight = new Map<K, Promise<V>>();

  function remember(key: K, value: V): void {
    entries.delete(key); // re-insert: Map order doubles as LRU order
    entries.set(key, { value, at: Date.now() });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  return {
    /**
     * Returns the cached value while it is younger than the TTL, otherwise
     * loads it (sharing one load between concurrent callers). If the load
     * fails and an expired value exists, that value is returned as stale;
     * without one the error propagates.
     */
    async get(key: K, load: () => Promise<V>): Promise<CacheResult<V>> {
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < ttlMs) {
        return { value: hit.value, fresh: Date.now() - hit.at < 5_000, stale: false };
      }
      let pending = inflight.get(key);
      if (!pending) {
        pending = load().finally(() => inflight.delete(key));
        inflight.set(key, pending);
      }
      try {
        const value = await pending;
        remember(key, value);
        return { value, fresh: true, stale: false };
      } catch (err) {
        if (hit) return { value: hit.value, fresh: false, stale: true };
        throw err;
      }
    },

    /** Drops entries older than `keepMs` (default: 4× the TTL). */
    sweep(keepMs = ttlMs * 4, now = Date.now()): void {
      for (const [key, entry] of entries) if (now - entry.at > keepMs) entries.delete(key);
    },

    get size(): number {
      return entries.size;
    },
  };
}
