import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiHost } from '../../src/config.ts';

test('API_HOST defaults to loopback', () => {
  assert.equal(apiHost({}), '127.0.0.1');
  assert.equal(apiHost({ API_HOST: '' }), '127.0.0.1');
});

test('API_HOST accepts an opt-in LAN bind in development', () => {
  assert.equal(apiHost({ API_HOST: '0.0.0.0' }), '0.0.0.0');
  assert.equal(apiHost({ API_HOST: '192.168.1.21' }), '192.168.1.21');
  assert.equal(apiHost({ API_HOST: '::' }), '::');
});

test('API_HOST rejects hostnames and malformed addresses', () => {
  for (const value of ['localhost', 'example.com', '256.1.1.1', '1.2.3', '0.0.0.0:3000', ' 0.0.0.0']) {
    assert.throws(() => apiHost({ API_HOST: value }), /Invalid API_HOST/, value);
  }
});

test('a non-loopback API_HOST is refused with NODE_ENV=production', () => {
  assert.throws(() => apiHost({ API_HOST: '0.0.0.0', NODE_ENV: 'production' }), /NODE_ENV=production/);
  assert.equal(apiHost({ API_HOST: '127.0.0.1', NODE_ENV: 'production' }), '127.0.0.1');
});
