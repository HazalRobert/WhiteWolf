import assert from 'node:assert/strict';

export const fixtureActor = Object.freeze({ id: '1', handle: 'qa_owner', name: 'QA Owner' });
export const fixtureIds = Object.freeze({ alice: '101', bob: '102', chen: '103', author: '777' });
// Actual opaque cursor shape from the pinned twscrape Following response fixture.
export const fixtureCursor = '1771337970390780275|2085474368099450818';
const csrf = 'synthetic-fixture-not-a-secret';
const queryIds = Object.freeze({
  Viewer: 'fixture_Viewer_001',
  Following: 'fixture_Following_001',
  UserByRestId: 'fixture_UserByRestId_001',
  UserByScreenName: 'fixture_UserByScreenName_001',
});
const graphRoutes = new Map(Object.entries(queryIds).map(([operation, queryId]) => [`/i/api/graphql/${queryId}/${operation}`, operation]));
const writeRoutes = new Map([
  ['/i/api/1.1/friendships/destroy.json', 'unfollow'],
  ['/i/api/1.1/friendships/create.json', 'follow'],
]);

/** Demo pages may fetch only this exact loopback origin. Nothing is forwarded elsewhere. */
export async function restrictToLocalOrigin(context, origin) {
  const allowed = new URL(origin);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(allowed.hostname), 'The demo origin must be loopback.');
  const blocked = [];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === allowed.origin) return route.continue();
    blocked.push({ method: request.method(), origin: url.origin, path: url.pathname });
    return route.abort('blockedbyclient');
  });
  return { blocked, assertIsolated() { assert.deepEqual(blocked, [], 'The demo attempted a non-local request.'); } };
}

// This function is serialized into the synthetic x.com page. Keep its dependencies local.
function installSyntheticPageClient({ actorId, fixtureCsrf }) {
  if (location.origin !== 'https://x.com') return;
  const install = () => {
    const root = document.getElementById('react-root');
    if (!root) throw new Error('Synthetic page is missing react-root.');
    const normalize = async (request, next) => {
      const host = String(request.host || 'https://x.com/i/api').replace(/\/$/, '');
      const endpoint = String(request.path || '');
      const uri = endpoint.startsWith('/i/api/') ? new URL(endpoint, 'https://x.com').href : `${host}/${endpoint.replace(/^\/+/, '')}`;
      const method = String(request.method || 'GET').toUpperCase();
      const params = Object.fromEntries(Object.entries(request.params || {}).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]));
      let data = request.data;
      if (method === 'POST') {
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Synthetic native POST expects an object before filters.');
        data = new URLSearchParams(Object.entries(data).map(([key, value]) => [key, String(value)])).toString();
      }
      return next({ ...request, host, uri, method, params, data, headers: { ...request.headers, 'content-type': method === 'POST' ? 'application/x-www-form-urlencoded' : 'application/json' } });
    };
    const sign = async (request, next) => next({
      ...request,
      headers: {
        ...request.headers,
        authorization: 'Bearer synthetic-fixture-only',
        'x-csrf-token': fixtureCsrf,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'x-client-transaction-id': 'synthetic-native-filter-transaction',
      },
    });
    class NativeHttp {
      constructor(options = {}) {
        this.host = options.host || (() => 'https://x.com/i/api');
        this.filters = options.filters || [normalize, sign];
        this.retryFilter = options.retryFilter || ((request, next) => next(request));
        this.errorFilter = options.errorFilter || ((request, next) => next(request));
        this.dispatcher = options.dispatcher || (() => { throw new Error('The original synthetic client must not send network requests.'); });
      }
      dispatch(request) {
        const dispatch = [this.retryFilter, ...this.filters, this.errorFilter].reduceRight(
          (next, filter) => input => filter(input, next),
          this.dispatcher,
        );
        return dispatch({ ...request, host: request.host || this.host() });
      }
    }
    const api = {
      apiClient: {
        client: new NativeHttp(),
        featureSwitches: { getValueWithoutScribeImpression: key => key === 'fixture_enabled' },
      },
    };
    const state = { session: { user_id: actorId } };
    const store = {
      getState: () => state,
      dispatch(thunk) {
        if (typeof thunk !== 'function') throw new Error('Only the read-only service lookup thunk is supported by the fixture.');
        return thunk(store.dispatch, store.getState, { api });
      },
    };
    root.__reactContainer$synthetic_fixture = { current: { memoizedProps: { store } } };
    // Deliberately keep these as literal metadata factories: discovery must inspect their
    // source, without evaluating module code or substituting production query IDs.
    const modules = {
      viewer: function (e) { e.exports = { queryId: "fixture_Viewer_001", operationName: "Viewer", operationType: "query", metadata: { featureSwitches: ["fixture_enabled"], fieldToggles: ["withArticlePlainText"] } }; },
      following: function (e) { e.exports = { queryId: "fixture_Following_001", operationName: "Following", operationType: "query", metadata: { featureSwitches: ["fixture_enabled"], fieldToggles: ["withArticlePlainText"] } }; },
      userByRestId: function (e) { e.exports = { queryId: "fixture_UserByRestId_001", operationName: "UserByRestId", operationType: "query", metadata: { featureSwitches: ["fixture_enabled"], fieldToggles: ["withArticlePlainText"] } }; },
      userByScreenName: function (e) { e.exports = { queryId: "fixture_UserByScreenName_001", operationName: "UserByScreenName", operationType: "query", metadata: { featureSwitches: ["fixture_enabled"], fieldToggles: ["withArticlePlainText"] } }; },
    };
    const chunks = [];
    chunks.push = function (chunk) {
      const length = Array.prototype.push.call(this, chunk);
      if (typeof chunk[2] === 'function') chunk[2]({ m: modules });
      return length;
    };
    window.webpackChunk_twitter_responsive_web = chunks;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
}

/** Exact, in-memory X endpoint fixtures. No intercepted X request is ever continued. */
export async function installXFixture(context) {
  const writes = [];
  const requests = [];
  const violations = [];
  const following = new Set([fixtureIds.alice, fixtureIds.bob, fixtureIds.chen]);
  // Optional 1.3 scenario hooks; their defaults keep every earlier scenario unchanged.
  const state = { limited: false, unsupportedInstruction: false, multiPage: false,
    beforeFollowing: null, failWrite: false, abortedWrites: [], notFoundScreenName: null, resetAt: null, followingCount: null };
  const people = [
    fixtureActor,
    { id: fixtureIds.alice, handle: 'fixture_alice', name: 'Fixture Alice' },
    { id: fixtureIds.bob, handle: 'fixture_bob', name: 'Fixture Bob' },
    { id: fixtureIds.chen, handle: 'fixture_chen', name: 'Fixture Chen' },
    { id: fixtureIds.author, handle: 'MagicalStocker', name: 'Author Fixture' },
  ];
  const byId = id => people.find(person => person.id === id);
  const result = person => ({
    __typename: 'User',
    rest_id: person.id,
    core: { screen_name: person.handle, name: person.name },
    legacy: { screen_name: person.handle, name: person.name, following: following.has(person.id), followed_by: person.id === fixtureIds.bob },
    relationship_perspectives: { following: following.has(person.id), followed_by: person.id === fixtureIds.bob },
  });
  const json = (route, body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
  await context.addInitScript(installSyntheticPageClient, { actorId: fixtureActor.id, fixtureCsrf: csrf });
  await context.addCookies([
    { name: 'twid', value: 'u%3D' + fixtureActor.id, domain: 'x.com', path: '/', secure: true },
    { name: 'ct0', value: csrf, domain: 'x.com', path: '/', secure: true },
  ]);
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    try {
      if (url.protocol === 'chrome-extension:') return route.continue();
      assert.equal(url.origin, 'https://x.com', 'Non-fixture external request blocked.');
      if (url.pathname === '/home') {
        assert.equal(request.method(), 'GET', 'Fixture document only accepts GET.');
        assert.equal(request.resourceType(), 'document', 'Only navigation may read the fixture document.');
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Synthetic X fixture</title><link rel="icon" href="data:,"></head><body><div id="react-root"><h1>Isolated test account. No X network access.</h1></div></body></html>' });
      }
      const operation = graphRoutes.get(url.pathname);
      const action = writeRoutes.get(url.pathname);
      const entry = { method: request.method(), path: url.pathname, operation: operation || action || 'UNEXPECTED' };
      requests.push(entry);
      assert.ok(operation || action, `Unexpected fixture endpoint: ${request.method()} ${url.pathname}`);
      assert.equal(request.method(), operation ? 'GET' : 'POST', `Wrong method for ${url.pathname}`);
      const headers = await request.allHeaders();
      assert.equal(headers.authorization, 'Bearer synthetic-fixture-only', 'Native authorization filter was bypassed.');
      assert.equal(headers['x-csrf-token'], csrf, 'Native CSRF filter was bypassed.');
      assert.equal(headers['x-client-transaction-id'], 'synthetic-native-filter-transaction', 'Native signing filter was bypassed.');
      assert.ok(headers.cookie?.includes('twid=u%3D' + fixtureActor.id), 'Expected synthetic actor cookie.');
      let variables;
      if (operation) {
        assert.match(headers['content-type'] || '', /^application\/json(?:;|$)/i, 'GraphQL reads use JSON headers.');
        assert.ok(url.searchParams.has('variables'), 'GraphQL variables are missing.');
        variables = JSON.parse(url.searchParams.get('variables'));
        assert.ok(variables && typeof variables === 'object' && !Array.isArray(variables), 'Variables must be an object.');
        const features = JSON.parse(url.searchParams.get('features') || '{}');
        assert.equal(features.fixture_enabled, true, 'Live feature switches must be applied.');
        entry.variables = variables;
      } else {
        assert.equal(url.search, '', 'Relationship mutations must not put parameters in the URL.');
        assert.match(headers['content-type'] || '', /^application\/x-www-form-urlencoded(?:;|$)/i, 'Mutation encoding must come from native filters.');
      }
      if (state.limited) return json(route, { error: 'synthetic rate limit' }, 429, state.resetAt ? { 'x-rate-limit-reset': String(state.resetAt) } : {});
      if (operation === 'Viewer') {
        assert.deepEqual(variables,{withCommunitiesMemberships:false});
        const actor = result(fixtureActor);
        if (state.followingCount !== null) actor.legacy.friends_count = state.followingCount;
        return json(route, { data: { viewer: { user_results: { result: actor } } } });
      }
      // A scenario hook may hold a page, drop it as a transport failure, or rate-limit only that page.
      const hook = operation === 'Following' && state.beforeFollowing ? await state.beforeFollowing(variables) : undefined;
      if (hook === 'abort') return route.abort('failed').catch(() => {});
      if (hook === 'limit') return json(route, { error: 'synthetic rate limit' }, 429, state.resetAt ? { 'x-rate-limit-reset': String(state.resetAt) } : {});
      if (operation === 'Following') {
        assert.equal(variables.userId, fixtureActor.id, 'Following must target the connected actor.');
        assert.equal(variables.count,20);assert.equal(variables.includePromotedContent,false);assert.equal(variables.withGrokTranslatedBio,false);
        assert.ok(variables.cursor === undefined || variables.cursor === '-1' || variables.cursor === '0' || (state.multiPage && variables.cursor === fixtureCursor), 'Unexpected continuation cursor.');
        const nextPage=variables.cursor===fixtureCursor;
        const entries = people.filter(person => following.has(person.id) && (!state.multiPage || (nextPage ? person.id===fixtureIds.chen : person.id!==fixtureIds.chen))).map(person => ({
          entryId: 'user-' + person.id,
          content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineUser', user_results: { result: result(person) } } },
        }));
        entries.push({ entryId: 'cursor-bottom-0', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: state.multiPage&&!nextPage?fixtureCursor:'fixture-retained-bottom-token' } });
        const instructions = [...(!nextPage?[{ type: 'TimelineClearCache' }, { type: 'TimelineTerminateTimeline', direction: 'Top' }]:[]),
          ...(!state.multiPage||nextPage?[{ type: 'TimelineTerminateTimeline', direction: 'Bottom' }]:[]), { type: 'TimelineAddEntries', entries }];
        if (state.unsupportedInstruction) instructions.push({ type: 'TimelinePinEntry', entry: entries[0] });
        return json(route, { data: { user: { result: { ...result(fixtureActor), timeline: { timeline: { instructions } } } } } });
      }
      if (operation === 'UserByRestId' || operation === 'UserByScreenName') {
        if(operation==='UserByRestId')assert.deepEqual(Object.keys(variables),['userId']);
        else {assert.deepEqual(Object.keys(variables).sort(),['screen_name','withGrokTranslatedBio']);assert.equal(variables.withGrokTranslatedBio,false);}
        if (operation === 'UserByScreenName' && state.notFoundScreenName && String(variables.screen_name).toLowerCase() === state.notFoundScreenName.toLowerCase()) return json(route, { data: {} });
        const person = operation === 'UserByRestId'
          ? byId(variables.userId)
          : people.find(candidate => candidate.handle.toLowerCase() === String(variables.screen_name || '').toLowerCase());
        assert.ok(person, `Unknown synthetic ${operation} target.`);
        return json(route, { data: { user: { result: result(person) } } });
      }
      const params = new URLSearchParams(request.postData() || '');
      assert.deepEqual([...params.keys()], ['user_id'], 'Only an explicit target ID is allowed in a mutation.');
      const targetId = params.get('user_id');
      const person = byId(targetId);
      assert.ok(person && targetId !== fixtureActor.id, 'Mutation target must be another fixture account.');
      // A transport failure after dispatch: the write never reached the synthetic account.
      if (state.failWrite) { state.abortedWrites.push({ action, id: targetId }); return route.abort('failed'); }
      writes.push({ action, id: targetId });
      if (action === 'unfollow') following.delete(targetId);
      else following.add(targetId);
      return json(route, { id_str: person.id, screen_name: person.handle, name: person.name, following: following.has(person.id), followed_by: person.id === fixtureIds.bob });
    } catch (error) {
      violations.push({ method: request.method(), origin: url.origin, path: url.pathname, reason: error.message });
      await route.abort('blockedbyclient').catch(() => {});
    }
  });
  return {
    writes, following, requests, violations, state,
    assertTraffic() {
      assert.deepEqual(violations, [], 'Unexpected requests or invalid methods must never leave the fixture.');
      assert.ok(requests.every(request => request.method === (graphRoutes.has(request.path) ? 'GET' : 'POST')), 'All reads must use GraphQL GET and mutations REST POST.');
      assert.ok(requests.filter(request => request.method === 'GET').every(request => graphRoutes.has(request.path)), 'No old REST read endpoint may be requested.');
      for (const operation of Object.keys(queryIds)) assert.ok(requests.some(request => request.operation === operation), `Expected ${operation} to be exercised.`);
    },
  };
}
