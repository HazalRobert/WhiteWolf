import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarSources, immediateSetting, normalizeSetting, percent, rateLimitReset, readingEstimate } from '../src/ui-helpers';

test('avatars prefer a larger rendition on X image hosting and keep the original as fallback', () => {
  const normal = 'https://pbs.twimg.com/profile_images/1234567890/AbC-d_e_normal.jpg';
  assert.deepEqual(avatarSources(normal), ['https://pbs.twimg.com/profile_images/1234567890/AbC-d_e_200x200.jpg', normal]);
  assert.deepEqual(avatarSources('https://pbs.twimg.com/profile_images/1/x_normal.PNG'), ['https://pbs.twimg.com/profile_images/1/x_200x200.PNG', 'https://pbs.twimg.com/profile_images/1/x_normal.PNG']);
  for (const url of ['https://example.test/profile_images/1/x_normal.jpg', 'https://pbs.twimg.com/profile_images/1/x_400x400.jpg',
    'https://pbs.twimg.com/profile_images/1/x_normal.jpg?query=1', 'http://pbs.twimg.com/profile_images/1/x_normal.jpg', 'https://pbs.twimg.com/media/x_normal.jpg']) {
    assert.deepEqual(avatarSources(url), [url], url);
  }
  assert.deepEqual(avatarSources(undefined), []);assert.deepEqual(avatarSources(''), []);
});

test('rate-limit reset times are read only from RATE_LIMIT diagnostics with an exact ISO value', () => {
  const at = '2026-10-23T12:34:56.000Z';
  assert.equal(rateLimitReset(`RATE_LIMIT: Following GET /x: HTTP 429; resetAt=${at}; automatic retry is disabled.`), Date.parse(at));
  assert.equal(rateLimitReset('RATE_LIMIT: Following GET /x: HTTP 429; resetAt=2026-10-23T12:34:56Z;'), Date.parse('2026-10-23T12:34:56Z'));
  for (const value of [null, undefined, '', `NETWORK: resetAt=${at}`, 'RATE_LIMIT: HTTP 429', 'RATE_LIMIT: resetAt=tomorrow', 'RATE_LIMIT: resetAt=2026-13-45T99:99:99Z']) {
    assert.equal(rateLimitReset(value), null, String(value));
  }
});

test('percentages and reading estimates stay bounded and never claim completion early', () => {
  assert.equal(percent(1, 3), 33);assert.equal(percent(5, 0), null);assert.equal(percent(5, undefined), null);assert.equal(percent(12, 10), 100);
  assert.equal(percent(Number.NaN, 10), null);
  assert.equal(readingEstimate(0, 100), 0);assert.equal(readingEstimate(50, 100), 50);assert.equal(readingEstimate(120, 100), 99);
  assert.equal(readingEstimate(10, undefined), null);assert.equal(readingEstimate(10, 0), null);
});

test('numeric settings commit only valid integers immediately and clamp on blur', () => {
  assert.equal(immediateSetting('3', 5, 300), null);assert.equal(immediateSetting('30', 5, 300), 30);assert.equal(immediateSetting('', 5, 300), null);
  assert.equal(immediateSetting('1.5', 1, 200), null);assert.equal(immediateSetting('-2', 1, 200), null);assert.equal(immediateSetting('201', 1, 200), null);
  assert.equal(normalizeSetting('3', 5, 300, 15), 5);assert.equal(normalizeSetting('999', 5, 300, 15), 300);assert.equal(normalizeSetting('', 5, 300, 15), 15);
  assert.equal(normalizeSetting('abc', 5, 300, 15), 15);assert.equal(normalizeSetting('12.6', 5, 300, 15), 13);
});
