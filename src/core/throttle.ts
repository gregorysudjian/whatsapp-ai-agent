/**
 * Token-bucket rate limiter for outbound sends.
 *
 * WhatsApp throttles per phone number, and a burst - a broadcast, or a retry
 * storm - earns 429s that cost more time than pacing would have. Refills
 * continuously rather than on an interval, so a quiet period banks capacity
 * up to the burst size instead of wasting it.
 */

export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  // Declared explicitly rather than as constructor parameter properties:
  // Node's strip-only TypeScript mode rejects those, and the test suite runs
  // under it.
  private readonly ratePerSecond: number;
  private readonly burst: number;

  constructor(ratePerSecond: number, burst: number) {
    this.ratePerSecond = ratePerSecond;
    this.burst = burst;
    this.tokens = burst;
  }

  private refill(): void {
    const now = Date.now();
    const gained = ((now - this.lastRefill) / 1000) * this.ratePerSecond;
    if (gained > 0) {
      this.tokens = Math.min(this.burst, this.tokens + gained);
      this.lastRefill = now;
    }
  }

  /** Resolves once capacity exists. Never rejects. */
  async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil((deficit / this.ratePerSecond) * 1000);
      await new Promise((r) => setTimeout(r, Math.max(5, waitMs)));
    }
  }

  /** Capacity remaining, for tests and diagnostics. */
  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

/** Comfortably under Meta's limits; the point is smoothing bursts, not speed. */
export const outboundLimiter = new TokenBucket(10, 20);
