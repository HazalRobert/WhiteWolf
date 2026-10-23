import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { isWhitelisted, parseFollowingPage, parsePerson, parseRelations, parseRelationship } from '../src/x-api';
import type { PageOperation, RuntimeResult, xPageRuntime } from '../src/x-api';
import type { NativeFilter, NativeHttp, NativeRequest, NativeResponse } from '../src/x-native';

// Bundle the complete adapter with its native-discovery and parser dependencies.
const compiled = buildSync({ entryPoints: [fileURLToPath(new URL('../src/x-api.ts', import.meta.url))], bundle: true,
  platform: 'browser', format: 'cjs', target: 'chrome120', write: false, keepNames: false }).outputFiles[0].text;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const user = (id: string) => ({ id_str: id, screen_name: `user${id}`, name: `User ${id}` });

test('IDs remain lossless strings and numeric IDs are rejected', () => {
  assert.equal(parsePerson({ ...user('1'), id_str: '1922333444555666777' }).id, '1922333444555666777');
  assert.throws(() => parsePerson({ ...user('1'), id_str: 1922333444555666777 }), /SCHEMA/);
});
test('legacy pagination requires explicit cursors and rejects empty continuation/duplicates', () => {
  assert.equal(parseFollowingPage({ users: [user('1')], next_cursor_str: '0' }).nextCursor, '0');
  assert.throws(() => parseFollowingPage({ users: [user('1')] }), /SCHEMA/);
  assert.throws(() => parseFollowingPage({ users: [], next_cursor_str: '22' }), /SCHEMA/);
  assert.throws(() => parseFollowingPage({ users: [user('1'), user('1')], next_cursor_str: '0' }), /SCHEMA/);
});
test('missing lookup entries, omitted connections, and empty connections are unknown', () => {
  const result = parseRelations([{ id_str: '1' }, { id_str: '2', connections: [] }], ['1', '2', '3']);
  assert.deepEqual(result.map(r => [r.following, r.followedBy]), [[null, null], [null, null], [null, null]]);
});
test('known legacy connections distinguish non-mutual, mutual, and neither', () => {
  assert.deepEqual(parseRelations([{ id_str: '1', connections: ['following'] }, { id_str: '2', connections: ['following', 'followed_by'] }, { id_str: '3', connections: ['none'] }], ['1', '2', '3']), [
    { id: '1', following: true, followedBy: false }, { id: '2', following: true, followedBy: true }, { id: '3', following: false, followedBy: false },
  ]);
});
test('malformed, unrequested, duplicate and contradictory legacy relationships fail closed', () => {
  for (const payload of [[{ id_str: '1', connections: 'following' }], [{ id_str: '1', connections: ['new-unknown-field'] }],
    [{ id_str: '2', connections: ['following'] }], [{ id_str: '1', connections: ['none', 'following'] }],
    [{ id_str: '1', connections: ['following'] }, { id_str: '1', connections: ['following'] }]]) assert.throws(() => parseRelations(payload, ['1']), /SCHEMA/);
});
test('legacy fresh relationship requires matching actor/target and explicit booleans', () => {
  const response = { relationship: { source: { id_str: '1', following: true, followed_by: false }, target: { id_str: '2' } } };
  assert.deepEqual(parseRelationship(response, '1', '2'), { id: '2', following: true, followedBy: false });
  assert.throws(() => parseRelationship(response, '3', '2'), /ACCOUNT_CHANGED/);
  assert.throws(() => parseRelationship(response, '1', '4'), /ACCOUNT_CHANGED/);
  assert.throws(() => parseRelationship({ relationship: { ...response.relationship, source: { id_str: '1', following: true } } }, '1', '2'), /SCHEMA/);
});
test('whitelists use actor and immutable ID; unresolved handles match case-insensitively', () => {
  const target = { id: '2', handle: 'newHandle', name: 'Person' };
  assert.equal(isWhitelisted({ whitelists: { '1': [{ id: '2', handle: 'oldHandle' }] } }, '1', target), true);
  assert.equal(isWhitelisted({ whitelists: { '1': [{ id: '3', handle: 'newHandle' }] } }, '1', target), false);
  assert.equal(isWhitelisted({ whitelists: { '1': [{ handle: '@NEWHANDLE' }] } }, '1', target), true);
  assert.equal(isWhitelisted({ whitelists: { '9': [{ id: '2', handle: 'newHandle' }] } }, '1', target), false);
  assert.throws(() => isWhitelisted({ whitelists: { '1': [{ id: 2, handle: 'newHandle' }] } }, '1', target), /SCHEMA/);
});

type FilterMode = 'normal' | 'double' | 'doublePost' | 'dedupe' | 'latequeue' | 'lateAfterReturn' | 'badCsrf' | 'badDelegate' | 'throwSpoofed';
type MockOptions = { followsBack?: boolean; lookupMissingBoolean?: boolean; status?: number; failAfterWrite?: boolean;
  missingNative?: boolean; viewerId?: string; filterMode?: FilterMode; nonJson?: boolean;
  rateLimitReset?: string; viewerLegacy?: Record<string, unknown>; screenNameBody?: unknown };
type RecordedRequest = { url: URL; method: string; headers: Headers; body: string | null };

function mockPage(options: MockOptions = {}) {
  const requests: RecordedRequest[] = [];
  const writes: { action: 'unfollow' | 'follow'; targetId: string }[] = [];
  const following = new Map([['2', true], ['3', false]]);
  let filterMode: FilterMode = options.filterMode ?? 'normal';
  let actorId = '1', nonce = 0;
  const doc = { cookie: 'twid=u%3D1; ct0=synthetic-csrf',
    getElementById: (id: string) => id === 'react-root' && !options.missingNative ? reactRoot : null };
  const modernUser = (id: string, handle = id === '3' ? 'MagicalStocker' : `user${id}`) => ({
    __typename: 'User', rest_id: id, core: { name: `Synthetic User ${id}`, screen_name: handle },
    relationship_perspectives: { following: following.get(id) ?? false, ...(options.lookupMissingBoolean ? {} : { followed_by: options.followsBack ?? false }) },
  });
  const viewerPayload = () => ({ data: { viewer: { user_results: { result: { ...modernUser(options.viewerId ?? actorId), ...(options.viewerLegacy ? { legacy: options.viewerLegacy } : {}) } } } } });
  const fakeNativeResponse = (request: NativeRequest): NativeResponse => ({ body: JSON.stringify(viewerPayload()), status: 200, headers: { 'content-type': 'application/json' }, request });
  let releaseQueue!: () => void, notifyQueued!: () => void;
  const queueGate = new Promise<void>(resolve => { releaseQueue = resolve; });
  const queued = new Promise<void>(resolve => { notifyQueued = resolve; });
  let lateSettled: Promise<unknown> | undefined;
  const signingFilter: NativeFilter = async (request, next) => {
    const headers = { ...request.headers, authorization: 'Bearer synthetic-native-token', 'x-csrf-token': 'synthetic-csrf',
      'x-twitter-auth-type': 'OAuth2Session', 'x-twitter-active-user': 'yes', 'x-client-transaction-id': 'synthetic-transaction' };
    let data = request.data;
    if (request.method === 'POST') {
      if (data && typeof data === 'object') data = new URLSearchParams(data as Record<string, string>).toString();
      Object.assign(headers, { 'content-type': 'application/x-www-form-urlencoded' });
    }
    return next({ ...request, headers, data });
  };
  const behaviorFilter: NativeFilter = async (request, next) => {
    if (filterMode === 'badCsrf') return next({ ...request, headers: { ...request.headers, 'x-csrf-token': 'wrong-csrf' } });
    if (filterMode === 'badDelegate') return next({ ...request, headers: { ...request.headers, 'x-act-as-user-id': '9' } });
    if (filterMode === 'throwSpoofed') throw new Error('AUTH: synthetic-private-error-must-not-leak');
    if (filterMode === 'dedupe') return fakeNativeResponse(request);
    if (filterMode === 'latequeue') { notifyQueued(); await queueGate; return next(request); }
    if (filterMode === 'lateAfterReturn') { notifyQueued(); lateSettled = queueGate.then(() => next(request)).catch(() => undefined); return fakeNativeResponse(request); }
    if (filterMode === 'double' || filterMode === 'doublePost' && request.method === 'POST') { await next(request); return next(request); }
    return next(request);
  };
  type HttpOptions = { host: () => string; filters: NativeFilter[]; dispatcher: (request: NativeRequest) => Promise<NativeResponse>; retryFilter?: NativeFilter; errorFilter?: NativeFilter };
  class MockHttp implements NativeHttp {
    host: () => string; filters: NativeFilter[]; private options: HttpOptions;
    constructor(opts: HttpOptions) { this.options = opts; this.host = opts.host; this.filters = opts.filters; }
    dispatch(request: NativeRequest): Promise<NativeResponse> {
      const host = request.host ?? this.host();
      const normalized = { ...request, host, uri: request.uri ?? `${host}${request.path}`, headers: { ...request.headers } };
      const filters = [this.options.retryFilter, ...this.filters, this.options.errorFilter].filter((filter): filter is NativeFilter => !!filter);
      const dispatch = filters.reduceRight<(request: NativeRequest) => Promise<NativeResponse>>((next, filter) => value => filter(value, next), this.options.dispatcher);
      return dispatch(normalized);
    }
  }
  const nativeHttp = new MockHttp({ host: () => 'https://x.com/i/api', filters: [signingFilter, behaviorFilter],
    retryFilter: async (request, next) => { const response = await next(request); return response.status === 429 ? next(request) : response; },
    dispatcher: async () => { throw new Error('The original native dispatcher must not be called.'); } });
  const store = {
    getState: () => ({ session: { user_id: actorId } }),
    dispatch: (thunk: (dispatch: unknown, getState: unknown, extra: unknown) => unknown) => thunk(undefined, store.getState, {
      api: { apiClient: { client: nativeHttp, featureSwitches: { getValueWithoutScribeImpression: (_key: string) => false } } } }),
  };
  const reactRoot = { __reactFiber$synthetic: { memoizedProps: { store } } };
  // Discovery accepts complete literal-only metadata factories, without invoking them.
  function viewerMetadata(e: { exports: unknown }) { e.exports = { queryId: "syntheticViewer01", operationName: "Viewer", operationType: "query", metadata: { featureSwitches: ["synthetic_feature"], fieldToggles: [] } }; }
  function followingMetadata(e: { exports: unknown }) { e.exports = { queryId: "syntheticFollowing01", operationName: "Following", operationType: "query", metadata: { featureSwitches: ["synthetic_feature"], fieldToggles: [] } }; }
  function byIdMetadata(e: { exports: unknown }) { e.exports = { queryId: "syntheticUserByRestId01", operationName: "UserByRestId", operationType: "query", metadata: { featureSwitches: ["synthetic_feature"], fieldToggles: [] } }; }
  function byNameMetadata(e: { exports: unknown }) { e.exports = { queryId: "syntheticUserByScreenName01", operationName: "UserByScreenName", operationType: "query", metadata: { featureSwitches: ["synthetic_feature"], fieldToggles: [] } }; }
  const chunks: unknown[] = [];
  chunks.push = function (...values: unknown[]): number {
    for (const chunk of values) if (Array.isArray(chunk) && typeof chunk[2] === 'function') chunk[2]({ m: { viewerMetadata, followingMetadata, byIdMetadata, byNameMetadata } });
    return Array.prototype.push.apply(this, values);
  };
  const graphRoutes = new Map([
    ['/i/api/graphql/syntheticViewer01/Viewer', 'Viewer'], ['/i/api/graphql/syntheticFollowing01/Following', 'Following'],
    ['/i/api/graphql/syntheticUserByRestId01/UserByRestId', 'UserByRestId'], ['/i/api/graphql/syntheticUserByScreenName01/UserByScreenName', 'UserByScreenName'],
  ]);
  const moduleValue = { exports: {} as { xPageRuntime: typeof xPageRuntime } };
  const sandbox = {
    module: moduleValue, exports: moduleValue.exports, window: { webpackChunk_twitter_responsive_web: chunks },
    location: { origin: 'https://x.com', href: 'https://x.com/home' }, document: doc,
    crypto: { randomUUID: () => `synthetic-nonce-${++nonce}` }, URL, URLSearchParams, Headers, Request, Response, AbortController, setTimeout, clearTimeout,
    fetch: async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = init.method ?? (input instanceof Request ? input.method : 'GET');
      const headers = new Headers(init.headers), body = init.body === undefined || init.body === null ? null : String(init.body);
      requests.push({ url, method, headers, body });
      assert.equal(url.origin, 'https://x.com');
      assert.equal(headers.get('authorization'), 'Bearer synthetic-native-token');
      assert.equal(headers.get('x-csrf-token'), 'synthetic-csrf');
      if (options.failAfterWrite && writes.length > 0) throw new Error('Synthetic connection failure after write.');
      if (options.status) return new Response('{}', { status: options.status, headers: { 'retry-after': '60', ...(options.rateLimitReset === undefined ? {} : { 'x-rate-limit-reset': options.rateLimitReset }) } });
      if (options.nonJson) return new Response('<html>synthetic challenge</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      const operation = graphRoutes.get(url.pathname);
      if (operation) {
        assert.equal(method, 'GET'); assert.equal(body, null);
        const variables = JSON.parse(url.searchParams.get('variables') ?? 'null') as Record<string, unknown> | null;
        assert.ok(variables && typeof variables === 'object');
        assert.deepEqual(JSON.parse(url.searchParams.get('features') ?? 'null'), { synthetic_feature: false });
        if (operation === 'Viewer') {assert.deepEqual(variables,{withCommunitiesMemberships:false});return Response.json(viewerPayload());}
        if (operation === 'UserByRestId') {
          assert.equal(typeof variables.userId, 'string'); assert.ok(['1', '2', '3'].includes(variables.userId as string));
          assert.deepEqual(Object.keys(variables),['userId']);
          return Response.json({ data: { user: { result: modernUser(variables.userId as string) } } });
        }
        if (operation === 'UserByScreenName') {
          if (options.screenNameBody !== undefined) return Response.json(options.screenNameBody);
          assert.ok(variables.screen_name === 'MagicalStocker' || variables.screen_name === 'user2');
          assert.equal(variables.withGrokTranslatedBio,false);assert.deepEqual(Object.keys(variables).sort(),['screen_name','withGrokTranslatedBio']);
          return Response.json({ data: { user: { result: modernUser(variables.screen_name === 'MagicalStocker' ? '3' : '2') } } });
        }
        assert.equal(variables.userId, '1');
        assert.equal(variables.count,20);assert.equal(variables.includePromotedContent,false);assert.equal(variables.withGrokTranslatedBio,false);
        const users = following.get('2') ? [{ entryId: 'user-2', content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineUser', user_results: { result: modernUser('2') } } } }] : [];
        return Response.json({ data: { user: { result: { __typename: 'User', rest_id: '1', timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [...users, { entryId: 'cursor-bottom-0', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: '0' } }] }] } } } } } });
      }
      if (url.pathname === '/i/api/1.1/friendships/destroy.json' || url.pathname === '/i/api/1.1/friendships/create.json') {
        assert.equal(method, 'POST'); assert.equal(headers.get('content-type'), 'application/x-www-form-urlencoded'); assert.equal(url.search, ''); assert.ok(body);
        const params = new URLSearchParams(body), targetId = params.get('user_id');
        assert.ok(targetId === '2' || targetId === '3'); assert.deepEqual([...params.keys()], ['user_id']);
        const action = url.pathname === '/i/api/1.1/friendships/destroy.json' ? 'unfollow' : 'follow';
        writes.push({ action, targetId }); following.set(targetId, action === 'follow'); return Response.json({});
      }
      throw new Error(`Unregistered synthetic route: ${method} ${url.pathname}`);
    },
  };
  runInNewContext(compiled, sandbox);
  const runtime = moduleValue.exports.xPageRuntime;
  const run = async (operation: PageOperation): Promise<RuntimeResult> => runtime({ type: 'PAGE', sessionId: 'session-1', bootId: 'boot-1', operation });
  return { run, runtime, requests, doc, writes: () => writes.length, writeRecords: () => writes,
    setFollowing: (value: boolean, id = '2') => { following.set(id, value); },
    setActor: (value: string) => { actorId = value; doc.cookie = `twid=u%3D${value}; ct0=synthetic-csrf`; },
    setFilterMode: (mode: FilterMode) => { filterMode = mode; },
    waitForQueue: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([queued, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native filter was never reached.')), 1000); })]); }
      finally { if (timer) clearTimeout(timer); }
    }, releaseQueue, finishLate: async () => { releaseQueue(); await lateSettled; } };
}

async function prepare(page: ReturnType<typeof mockPage>) {
  const connected = await page.run({ kind: 'connect' });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  const prepared = await page.run({ kind: 'prepareUnfollow', actorId: '1', targetId: '2' });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  return (prepared as { ok: true; data: { proofId: string } }).data.proofId;
}

test('bundled runtime retains legacy parser compatibility without browser access', () => {
  const page = mockPage();
  assert.deepEqual(plain(page.runtime({ type: 'PARSE', parser: 'relations', payload: [], ids: ['1'] })), { ok: true, data: [{ id: '1', following: null, followedBy: null }] });
  assert.equal(page.requests.length, 0);
});
test('connect uses exact discovered Viewer metadata without writing', async () => {
  const page = mockPage(), result = await page.run({ kind: 'connect' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].url.pathname, '/i/api/graphql/syntheticViewer01/Viewer'); assert.equal(page.requests[0].method, 'GET');
  assert.equal(page.writes(), 0);
});
test('a write requires fresh matching proof and a separate GraphQL relation read-back', async () => {
  const page = mockPage();
  assert.equal((await page.run({ kind: 'connect' })).ok, true);
  assert.equal((await page.run({ kind: 'unfollow', actorId: '1', targetId: '2' })).ok, false); assert.equal(page.writes(), 0);
  const proofId = await prepare(page), result = await page.run({ kind: 'unfollow', actorId: '1', targetId: '2', proofId });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(page.writes(), 1);
  assert.equal(page.requests.at(-1)?.url.pathname, '/i/api/graphql/syntheticUserByRestId01/UserByRestId'); assert.equal(page.requests.at(-1)?.method, 'GET');
  assert.equal((await page.run({ kind: 'unfollow', actorId: '1', targetId: '2', proofId })).ok, false); assert.equal(page.writes(), 1);
});
test('Following and relationship reads use exact GraphQL paths with no writes', async () => {
  const page = mockPage(); await page.run({ kind: 'connect' });
  const result = await page.run({ kind: 'following', actorId: '1', cursor: '-1' });
  assert.equal(result.ok, true, JSON.stringify(result)); if (result.ok) assert.equal((result.data as { nextCursor: string }).nextCursor, '0');
  assert.equal(page.requests.at(-1)?.url.pathname, '/i/api/graphql/syntheticFollowing01/Following');
  const relations = await page.run({ kind: 'relations', actorId: '1', ids: ['2'] });
  assert.equal(relations.ok, true, JSON.stringify(relations)); if (relations.ok) assert.deepEqual(plain(relations.data), [{ id: '2', following: true, followedBy: false }]);
  assert.equal(page.writes(), 0);
});
test('Following accepts opaque pipe cursors and forwards them losslessly through URL encoding', async () => {
  const page=mockPage();await page.run({kind:'connect'});
  for(const cursor of ['1771337970390780275|2085474368099450818','opaque:next%2Ftoken+=/=?&','x'.repeat(4096)]){
    const result=await page.run({kind:'following',actorId:'1',cursor});
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(JSON.parse(page.requests.at(-1)!.url.searchParams.get('variables')!).cursor,cursor);
  }
  const requests=page.requests.length;
  for(const cursor of ['', 'a b','a\nb','bad\u007f','x'.repeat(4097)]){
    const result=await page.run({kind:'following',actorId:'1',cursor});
    assert.equal(result.ok,false);if(!result.ok)assert.match(result.error,/SCHEMA: Invalid input cursor/);
  }
  assert.equal(page.requests.length,requests);assert.equal(page.writes(),0);
});
test('unknown or now-mutual relationships never produce a write proof', async () => {
  for (const config of [{ lookupMissingBoolean: true }, { followsBack: true }]) {
    const page = mockPage(config); await page.run({ kind: 'connect' });
    assert.equal((await page.run({ kind: 'prepareUnfollow', actorId: '1', targetId: '2' })).ok, false); assert.equal(page.writes(), 0);
  }
});
test('account switching and cancellation invalidate a prepared write', async () => {
  for (const reason of ['account', 'cancel']) {
    const page = mockPage(), proofId = await prepare(page);
    if (reason === 'account') page.setActor('9'); else await page.run({ kind: 'cancel' });
    assert.equal((await page.run({ kind: 'unfollow', actorId: '1', targetId: '2', proofId })).ok, false); assert.equal(page.writes(), 0);
  }
});
test('429 stops after one native request without inheriting retry filters', async () => {
  const page = mockPage({ status: 429 }), result = await page.run({ kind: 'connect' });
  assert.equal(result.ok, false); if (!result.ok) assert.match(result.error, /^RATE_LIMIT:/); assert.equal(page.requests.length, 1); assert.equal(page.writes(), 0);
});
test('429 reports a plausible X reset time without retrying', async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const page = mockPage({ status: 429, rateLimitReset: String(reset) }), result = await page.run({ kind: 'connect' });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.match(result.error, /^RATE_LIMIT: Viewer GET .*HTTP 429; resetAt=/); assert.ok(result.error.includes(`resetAt=${new Date(reset * 1000).toISOString()};`)); }
  assert.equal(page.requests.length, 1); assert.equal(page.writes(), 0);
  for (const value of ['', 'soon', '1.5', String(reset * 1000), String(Math.floor(Date.now() / 1000) - 3600), String(Math.floor(Date.now() / 1000) + 3 * 86400)]) {
    const other = mockPage({ status: 429, rateLimitReset: value }), failed = await other.run({ kind: 'connect' });
    assert.equal(failed.ok, false); if (!failed.ok) { assert.match(failed.error, /^RATE_LIMIT:/); assert.doesNotMatch(failed.error, /resetAt=/); }
  }
});
test('Viewer adds only a valid following count to the verified account', async () => {
  const counted = await mockPage({ viewerLegacy: { friends_count: 4321 } }).run({ kind: 'connect' });
  assert.equal(counted.ok, true); if (counted.ok) assert.deepEqual(plain(counted.data), { id: '1', handle: 'user1', name: 'Synthetic User 1', followingCount: 4321 });
  for (const friends_count of [-1, 1.5, '12', null, Number.MAX_SAFE_INTEGER + 2, 10_000_001]) {
    const result = await mockPage({ viewerLegacy: { friends_count } }).run({ kind: 'connect' });
    assert.equal(result.ok, true, JSON.stringify(result)); if (result.ok) assert.equal('followingCount' in (result.data as object), false);
  }
});
test('unknown and unavailable usernames are NOT_FOUND without a write or session failure code', async () => {
  for (const body of [{ data: {} }, { data: { user: null } }, { data: { user: {} } }, { data: { user: { result: null } } },
    { data: { user: { result: { __typename: 'UserUnavailable', reason: 'Suspended' } } } }]) {
    const page = mockPage({ screenNameBody: body }); await page.run({ kind: 'connect' });
    const result = await page.run({ kind: 'resolve', actorId: '1', handle: 'missing_user' });
    assert.equal(result.ok, false, JSON.stringify(body)); if (!result.ok) assert.equal(result.error, 'NOT_FOUND: @missing_user is unavailable or does not exist on X.');
    assert.equal(page.writes(), 0);
  }
  for (const body of [{ data: { user: { result: { __typename: 'Unexpected' } } } }, { data: { user: { other: true } } }, { data: { user: 'x' } }, {}]) {
    const page = mockPage({ screenNameBody: body }); await page.run({ kind: 'connect' });
    const result = await page.run({ kind: 'resolve', actorId: '1', handle: 'missing_user' });
    assert.equal(result.ok, false, JSON.stringify(body)); if (!result.ok) assert.match(result.error, /^SCHEMA:/);
  }
});
test('the author follow never writes when the author name is unavailable', async () => {
  const page = mockPage({ screenNameBody: { data: {} } }); await page.run({ kind: 'connect' });
  const result = await page.run({ kind: 'followAuthor', actorId: '1' });
  assert.equal(result.ok, false); if (!result.ok) assert.match(result.error, /^NOT_FOUND: @MagicalStocker/); assert.equal(page.writes(), 0);
});
test('404 identifies the failed read without fallback requests or any POST', async () => {
  const page = mockPage({ status: 404 }), result = await page.run({ kind: 'connect' });
  assert.equal(result.ok, false); if (!result.ok) { assert.match(result.error, /404/); assert.match(result.error, /Viewer|graphql/); }
  assert.equal(page.requests.length, 1); assert.equal(page.requests[0].method, 'GET'); assert.equal(page.writes(), 0);
});
test('authentication failures and malformed successful bodies cannot establish connection', async () => {
  for (const config of [{ status: 401 }, { status: 403 }, { nonJson: true }, { viewerId: '9' }]) {
    const page = mockPage(config), result = await page.run({ kind: 'connect' });
    assert.equal(result.ok, false); assert.equal(page.requests.length, 1); assert.equal(page.writes(), 0);
  }
});
test('missing native X context fails before any fetch', async () => {
  const page = mockPage({ missingNative: true }), result = await page.run({ kind: 'connect' });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.match(result.error, /^API_UNAVAILABLE:/); assert.match(result.error, /stage=root;/); assert.doesNotMatch(result.error, /synthetic-csrf|synthetic-native-token/); }
  assert.equal(page.requests.length, 0);
});
test('lost verification after a write is UNCERTAIN and is not retried', async () => {
  const page = mockPage({ failAfterWrite: true }), proofId = await prepare(page);
  const result = await page.run({ kind: 'unfollow', actorId: '1', targetId: '2', proofId });
  assert.equal(result.ok, false); if (!result.ok) assert.match(result.error, /^UNCERTAIN:/); assert.equal(page.writes(), 1);
});
test('follow-author resolves only the fixed handle and reads back after a single create', async () => {
  const page = mockPage(); await page.run({ kind: 'connect' });
  const result = await page.run({ kind: 'followAuthor', actorId: '1' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(page.writeRecords(), [{ action: 'follow', targetId: '3' }]);
  const lookup = page.requests.find(request => request.url.pathname === '/i/api/graphql/syntheticUserByScreenName01/UserByScreenName');
  assert.equal(JSON.parse(lookup!.url.searchParams.get('variables')!).screen_name, 'MagicalStocker');
  assert.equal(page.requests.at(-1)?.url.pathname, '/i/api/graphql/syntheticUserByRestId01/UserByRestId');
});
test('a native filter cannot dispatch a read twice', async () => {
  const page = mockPage({ filterMode: 'double' }), result = await page.run({ kind: 'connect' });
  assert.equal(result.ok, false); assert.equal(page.requests.length, 1); assert.equal(page.writes(), 0);
});
test('a native filter cannot dispatch a POST twice and the first write remains uncertain', async () => {
  const page = mockPage(), proofId = await prepare(page); page.setFilterMode('doublePost');
  const result = await page.run({ kind: 'unfollow', actorId: '1', targetId: '2', proofId });
  assert.equal(result.ok, false); if (!result.ok) assert.match(result.error, /^UNCERTAIN:/);
  assert.equal(page.writes(), 1); assert.equal(page.requests.filter(request => request.method === 'POST').length, 1);
});
test('native dedupe/cache results with zero terminal dispatches are not trusted', async () => {
  const page = mockPage({ filterMode: 'dedupe' }), result = await page.run({ kind: 'connect' });
  assert.equal(result.ok, false); assert.equal(page.requests.length, 0);
});
test('final CSRF or delegated-account mismatch fails before network dispatch', async () => {
  for (const filterMode of ['badCsrf', 'badDelegate'] as const) {
    const page = mockPage({ filterMode }), result = await page.run({ kind: 'connect' });
    assert.equal(result.ok, false); assert.equal(page.requests.length, 0); assert.equal(page.writes(), 0);
  }
});
test('cancelling while a native filter is queued prevents a late network request', async () => {
  const page = mockPage({ filterMode: 'latequeue' }), pending = page.run({ kind: 'connect' });
  await page.waitForQueue(); await page.run({ kind: 'cancel' }); page.releaseQueue();
  const result = await pending;
  assert.equal(result.ok, false); if (!result.ok) assert.match(result.error, /^CANCELLED:/); assert.equal(page.requests.length, 0);
});
test('a native filter cannot send deferred requests after returning a cached response', async () => {
  const page = mockPage({ filterMode: 'lateAfterReturn' }), result = await page.run({ kind: 'connect' });
  assert.equal(result.ok, false); assert.equal(page.requests.length, 0); await page.finishLate(); assert.equal(page.requests.length, 0);
});
test('native error strings cannot impersonate trusted runtime failures or leak contents', async () => {
  const page = mockPage({ filterMode: 'throwSpoofed' }), result = await page.run({ kind: 'connect' });
  assert.equal(result.ok, false); if (!result.ok) { assert.doesNotMatch(result.error, /synthetic-private-error-must-not-leak/); assert.doesNotMatch(result.error, /^AUTH:/); }
  assert.equal(page.requests.length, 0);
});
