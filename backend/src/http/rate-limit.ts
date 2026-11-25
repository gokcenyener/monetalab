/**
 * Minimal fixed-window rate limiter for public, unauthenticated endpoints (D-S3-09 gap; M3 notifications).
 * In-memory and per process: adequate for the single-process QA fixture, not for a multi-instance deployment.
 * Over the limit: 429 RATE_LIMITED with Retry-After. Apple retries notifications that do not get HTTP 200, so a
 * throttled genuine notification is redelivered later (and reconciliation recovers anything missed).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './errors.ts';

export type RateLimitOptions = {
  windowMs: number;
  /** Requests per client key (IP) per window. */
  perKey: number;
  /** Requests for the whole route per window (protects the database if many IPs are used). */
  global: number;
  now?: () => number;
};

export function fixedWindowRateLimit(options: RateLimitOptions) {
  const now = options.now ?? Date.now;
  let windowStart = now();
  let globalCount = 0;
  let perKey = new Map<string, number>();

  return async function rateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const t = now();
    if (t - windowStart >= options.windowMs) {
      windowStart = t;
      globalCount = 0;
      perKey = new Map();
    }
    const key = request.ip || 'unknown';
    const count = (perKey.get(key) ?? 0) + 1;
    perKey.set(key, count);
    globalCount += 1;
    if (count > options.perKey || globalCount > options.global) {
      reply.header('Retry-After', String(Math.max(1, Math.ceil((windowStart + options.windowMs - t) / 1000))));
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests');
    }
  };
}
