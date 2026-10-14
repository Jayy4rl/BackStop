// Fixed-window rate limiting in Redis (public appeal page C5-6, OTP sends, sign-in attempts).
// Falls back to process memory when Redis is not configured (single-instance development only).
import type { Redis } from 'ioredis';

export interface RateLimiter {
  /** Returns true when the call is allowed. */
  hit(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}
  async hit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.expire(k, windowSeconds + 1);
    return n <= limit;
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly m = new Map<string, number>();
  async hit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const k = `${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
    const n = (this.m.get(k) ?? 0) + 1;
    this.m.set(k, n);
    if (this.m.size > 50_000) this.m.clear();
    return n <= limit;
  }
}
