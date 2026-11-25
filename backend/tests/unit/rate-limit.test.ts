/** Fixed-window rate limiter for public endpoints. Categories (D-005): [BR], [NEG]. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../../src/http/errors.ts';
import { fixedWindowRateLimit } from '../../src/http/rate-limit.ts';

function harness(perKey: number, global: number) {
  let t = 1_000_000;
  const limit = fixedWindowRateLimit({ windowMs: 60_000, perKey, global, now: () => t });
  const headers: Record<string, string> = {};
  const reply = { header: (k: string, v: string) => { headers[k] = v; return reply; } } as unknown as FastifyReply;
  const call = async (ip: string) => {
    try {
      await limit({ ip } as FastifyRequest, reply);
      return 'ok';
    } catch (error) {
      assert.ok(error instanceof ApiError);
      return `${error.statusCode} ${error.code}`;
    }
  };
  return { call, headers, advance: (ms: number) => { t += ms; } };
}

describe('fixedWindowRateLimit', () => {
  it('[BR] allows up to the per-client limit, then 429 RATE_LIMITED with Retry-After', async () => {
    const h = harness(3, 100);
    assert.deepEqual([await h.call('a'), await h.call('a'), await h.call('a')], ['ok', 'ok', 'ok']);
    assert.equal(await h.call('a'), '429 RATE_LIMITED');
    assert.equal(h.headers['Retry-After'], '60');
    assert.equal(await h.call('b'), 'ok', 'another client has its own budget');
  });
  it('[NEG] the global cap applies across many clients', async () => {
    const h = harness(100, 5);
    for (let i = 0; i < 5; i++) assert.equal(await h.call(`ip-${i}`), 'ok');
    assert.equal(await h.call('ip-new'), '429 RATE_LIMITED');
  });
  it('[BR] a new window resets the counters', async () => {
    const h = harness(1, 100);
    assert.equal(await h.call('a'), 'ok');
    assert.equal(await h.call('a'), '429 RATE_LIMITED');
    h.advance(30_000);
    assert.equal(await h.call('a'), '429 RATE_LIMITED');
    assert.equal(h.headers['Retry-After'], '30');
    h.advance(30_000);
    assert.equal(await h.call('a'), 'ok');
  });
});
