/** Fixed-window counters held in memory. Enough for one API process; run a shared limiter in front if you scale out. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  /** Seconds until `key` may try again, or 0 if it is not blocked. */
  retryAfter(key: string, now = Date.now()): number {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now || h.count < this.max) return 0;
    return Math.ceil((h.resetAt - now) / 1000);
  }

  hit(key: string, now = Date.now()): void {
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else h.count += 1;
  }

  clear(key: string): void {
    this.hits.delete(key);
  }
}
