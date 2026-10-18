import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const cwd = process.cwd();
const executablePath = process.env.BROWSER_EXECUTABLE || chromium.executablePath();
const nativeSource = await readFile(path.join(cwd, 'src/x-native.ts'));
const report = {
  at: new Date().toISOString(),
  scope: 'Real React createRoot commits in a temporary headless browser; synthetic stores, API service and webpack metadata only.',
  exclusions: ['No user Chrome profile', 'No real X page or account', 'No X API requests', 'No claim about the user\'s actual X React root'],
  boundaries: {
    reactRoot: 'Created only by ReactDOM createRoot; no handwritten container marker or root fiber.',
    providers: 'A real React Context.Provider value.store wraps a function component with props.store.',
    suspendedWork: 'A real startTransition render suspends on an unresolved Promise; committed UI is checked before lookup.',
    pendingPropsProbe: 'One current, React-created component fiber has pendingProps temporarily replaced with a different synthetic store and is restored immediately. This is fault injection, not a naturally scheduled update.',
    largeTrees: 'Real React renders 24,000 or 50,000 null-returning function components. Every unique committed child/sibling Fiber is counted to exhaustion. A second distinct store, when present, must occur after Fiber 24,000 and be rejected as ambiguous.',
    network: 'Every page request is intercepted. Only the exact synthetic HTML and bundled JS routes are fulfilled; all others are aborted.',
  },
  versions: { react: require('react/package.json').version, reactDom: require('react-dom/package.json').version },
  sourceSha256: createHash('sha256').update(nativeSource).digest('hex'),
  modes: [],
};

const entry = String.raw`
import React, { createContext, startTransition } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { getXContext, nativeDiagnostic } from './src/x-native.ts';

const metrics = { nativeRequests: 0, thunkCalls: 0, suspendedRenderAttempts: 0 };
const labels = new WeakMap();
function makeStore(actorId, label) {
  const state = { session: { user_id: actorId } };
  const http = { host: () => 'https://x.com/i/api', filters: [], dispatch: () => { metrics.nativeRequests++; throw new Error('No native requests are allowed in this fixture.'); } };
  const api = { apiClient: { client: http, featureSwitches: { getValueWithoutScribeImpression: () => false } } };
  const store = {
    getState: () => state,
    dispatch(thunk) {
      if (typeof thunk !== 'function') throw new Error('Only the service lookup thunk is allowed.');
      metrics.thunkCalls++;
      return thunk(store.dispatch, store.getState, { api });
    },
  };
  labels.set(store, label);
  return { store, http, actorId, label };
}
const modules = {
  viewer: function(e) { e.exports = { queryId: "fixture_Viewer_001", operationName: "Viewer", operationType: "query", metadata: { featureSwitches: [], fieldToggles: [] } }; },
  following: function(e) { e.exports = { queryId: "fixture_Following_001", operationName: "Following", operationType: "query", metadata: { featureSwitches: [], fieldToggles: [] } }; },
  byId: function(e) { e.exports = { queryId: "fixture_UserByRestId_001", operationName: "UserByRestId", operationType: "query", metadata: { featureSwitches: [], fieldToggles: [] } }; },
  byName: function(e) { e.exports = { queryId: "fixture_UserByScreenName_001", operationName: "UserByScreenName", operationType: "query", metadata: { featureSwitches: [], fieldToggles: [] } }; },
};
const chunks = [];
chunks.push = function(chunk) { const n = Array.prototype.push.call(this, chunk); if (typeof chunk[2] === 'function') chunk[2]({ m: modules }); return n; };
window.webpackChunk_twitter_responsive_web = chunks;

const StoreContext = createContext(null);
const neverResolves = new Promise(() => {});
function StoreProbe({ store, revision, suspend }) {
  if (suspend) { metrics.suspendedRenderAttempts++; throw neverResolves; }
  return <div id="committed-state" data-store={labels.get(store)} data-actor={store.getState().session.user_id} data-revision={revision}>Synthetic committed state</div>;
}
function EmptyLeaf() { return null; }
function LateStoreCarrier({ store }) { return null; }
const container = document.getElementById('react-root');
const root = createRoot(container);
const tree = (record, revision, suspend = false) => <StoreContext.Provider value={{ store: record.store }}><StoreProbe store={record.store} revision={revision} suspend={suspend} /></StoreContext.Provider>;
const render = (record, revision) => flushSync(() => root.render(tree(record, revision)));
const markers = () => Object.keys(container).filter(key => /^__react(?:Container|Fiber)\$/.test(key)).map(key => ({ key, fiber: container[key] }));
const currentRoot = () => markers().map(({ fiber }) => fiber?.stateNode?.current || fiber?.current).find(Boolean);
function fibers(start) {
  const queue = [start], seen = new Set(), output = [];
  for (let i = 0; i < queue.length; i++) {
    const value = queue[i]; if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value); output.push(value);
    for (const child of [value.child, value.sibling]) if (child && typeof child === 'object') queue.push(child);
  }
  return output;
}
function storesIn(start, fields = ['memoizedProps', 'pendingProps']) {
  const stores = new Set();
  for (const fiber of fibers(start)) for (const field of fields) {
    const props = fiber[field];
    for (const store of [props?.store, props?.value?.store]) if (labels.has(store)) stores.add(labels.get(store));
  }
  return [...stores];
}
function committedStorePositions(committedFibers) {
  const positions = new Map();
  for (let index = 0; index < committedFibers.length; index++) {
    const props = committedFibers[index].memoizedProps;
    for (const store of [props?.store, props?.value?.store]) {
      if (!labels.has(store)) continue;
      if (!positions.has(store)) positions.set(store, { label: labels.get(store), firstFiberOrdinal: index + 1, references: 0 });
      positions.get(store).references++;
    }
  }
  return [...positions.values()];
}
function snapshot() {
  const current = currentRoot();
  const committedFibers = fibers(current);
  const dom = document.getElementById('committed-state');
  return {
    committedFiberCount: committedFibers.length,
    committedStorePositions: committedStorePositions(committedFibers),
    committedDom: dom ? { actor: dom.dataset.actor, store: dom.dataset.store, revision: dom.dataset.revision } : null,
    markers: markers().map(({ key, fiber }) => ({ prefix: key.split('$')[0], pointsToCommittedRoot: fiber === current, markerStores: storesIn(fiber), committedStores: storesIn(current), markerMemoizedStores: storesIn(fiber, ['memoizedProps']), markerPendingStores: storesIn(fiber, ['pendingProps']), committedMemoizedStores: storesIn(current, ['memoizedProps']), committedPendingStores: storesIn(current, ['pendingProps']) })),
  };
}
const tests = [];
function check(name, actorId, expected, options = {}) {
  const observed = snapshot();
  const thunkCallsBefore = metrics.thunkCalls;
  const start = performance.now();
  let outcome;
  try {
    const context = getXContext(actorId);
    outcome = { ok: true, selectedExpectedClient: context.http === expected.http, queryNames: Object.keys(context.queries).sort() };
  } catch (error) {
    const diagnostic = nativeDiagnostic(error);
    outcome = { ok: false, error: error instanceof Error ? error.message : String(error), diagnostic: diagnostic || null, stage: diagnostic?.match(/(?:^|; )stage=([^;]+)/)?.[1] || null };
  }
  outcome.elapsedMs = Number((performance.now() - start).toFixed(3));
  outcome.serviceLookupCalls = metrics.thunkCalls - thunkCallsBefore;
  const expectedNames = ['Following', 'UserByRestId', 'UserByScreenName', 'Viewer'];
  let passed = options.expectRejection ? !outcome.ok && !!outcome.diagnostic : outcome.ok && outcome.selectedExpectedClient && JSON.stringify(outcome.queryNames) === JSON.stringify(expectedNames);
  if (options.expectedStage) passed = passed && outcome.stage === options.expectedStage;
  if (options.expectedCounts) for (const [key, value] of Object.entries(options.expectedCounts)) passed = passed && outcome.diagnostic?.split('; ').includes(key + '=' + value);
  if (options.expectNoServiceLookup) passed = passed && outcome.serviceLookupCalls === 0;
  tests.push({ name, actorId, expectation: options.expectation || (options.expectRejection ? 'Reject an actor different from the committed store' : 'Return the current committed synthetic store client'), expectedStore: expected.label, passed: !!passed, ...observed, outcome });
}
function checkLargeTree(name, record, leaves, lateRecord) {
  const filler = Array.from({ length: leaves }, (_, index) => <EmptyLeaf key={'empty-' + index} />);
  // One flat children array prevents React from introducing an intermediate Fragment
  // whose sibling could put the late store near the start of a breadth-first scan.
  const children = [<StoreProbe key="committed" store={record.store} revision={name} />, ...filler];
  if (lateRecord) children.push(<StoreContext.Provider key="late-store" value={{ store: lateRecord.store }}><LateStoreCarrier store={lateRecord.store} /></StoreContext.Provider>);
  flushSync(() => root.render(<StoreContext.Provider value={{ store: record.store }}>{children}</StoreContext.Provider>));
  const before = snapshot();
  if (before.committedFiberCount < leaves) throw new Error('Large-tree fixture has fewer independent committed Fibers than required.');
  const firstPosition = before.committedStorePositions.find(item => item.label === record.label);
  if (!firstPosition || firstPosition.firstFiberOrdinal > 10) throw new Error('Expected store is not at the beginning of the large tree.');
  if (lateRecord) {
    const latePosition = before.committedStorePositions.find(item => item.label === lateRecord.label);
    if (!latePosition || latePosition.firstFiberOrdinal <= 24000) throw new Error('Second independent store is not beyond Fiber 24,000.');
  }
  check(name, record.actorId, record, lateRecord ? {
    expectRejection: true,
    expectedStage: 'storeSelection',
    expectedCounts: { stores: 2, matchedActor: lateRecord.actorId === record.actorId ? 2 : 1 },
    expectNoServiceLookup: true,
    expectation: 'Traverse the whole committed tree and reject the late second distinct store before API service lookup',
  } : { expectation: 'Traverse the whole committed large tree and return its single current store client' });
}
window.__runReactRootCheck = async () => {
  const first = makeStore('1', 'store-A'); render(first, 'initial'); check('initial-render', '1', first);
  for (let i = 1; i <= 6; i++) { render(first, 'same-' + i); check('same-store-render-' + i, '1', first); }
  const second = makeStore('1', 'store-B'); render(second, 'replace-B'); check('replace-store-same-actor', '1', second);
  for (let i = 1; i <= 3; i++) { render(second, 'B-' + i); check('replacement-rerender-' + i, '1', second); }
  const switched = makeStore('2', 'store-C-actor-2'); render(switched, 'actor-2'); check('replace-store-new-actor', '2', switched);
  check('reject-old-actor', '1', switched, { expectRejection: true });
  render(switched, 'settle-actor-2'); check('actor-2-rerender', '2', switched);
  const pending = makeStore('99', 'uncommitted-store-99');
  startTransition(() => root.render(tree(pending, 'suspended-transition', true)));
  await new Promise(resolve => setTimeout(resolve, 80));
  if (metrics.suspendedRenderAttempts === 0) throw new Error('React did not attempt the suspended concurrent render.');
  check('real-suspended-transition-keeps-committed-store', '2', switched);
  render(switched, 'after-suspension'); check('after-suspended-work-replaced', '2', switched);
  const currentProbe = fibers(currentRoot()).find(fiber => fiber.type === StoreProbe);
  if (!currentProbe) throw new Error('Current React-created StoreProbe fiber was not found.');
  const originalPendingProps = currentProbe.pendingProps;
  try {
    currentProbe.pendingProps = { ...currentProbe.memoizedProps, store: pending.store };
    check('fault-injected-uncommitted-pendingProps-ignored', '2', switched);
  } finally { currentProbe.pendingProps = originalPendingProps; }
  check('pendingProps-restored', '2', switched);
  checkLargeTree('large-24000-single-store', switched, 24000);
  checkLargeTree('large-24000-late-second-store-same-actor', switched, 24000, makeStore('2', 'late-distinct-store-actor-2'));
  checkLargeTree('large-24000-late-second-store-other-actor', switched, 24000, makeStore('99', 'late-distinct-store-actor-99'));
  checkLargeTree('large-50000-single-store', switched, 50000);
  return { reactVersion: React.version, tests, metrics };
};
`;

await mkdir(path.join(cwd, 'qa'), { recursive: true });
let browser;
try {
  assert.equal(report.versions.react, '19.2.0', 'This check is specifically scoped to installed React 19.2.0.');
  assert.equal(report.versions.reactDom, '19.2.0');
  browser = await chromium.launch({ executablePath, headless: true });
  for (const mode of ['development', 'production']) {
    const output = await build({ stdin: { contents: entry, resolveDir: cwd, sourcefile: 'react-root-fixture.jsx', loader: 'jsx' }, write: false, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', define: { 'process.env.NODE_ENV': JSON.stringify(mode) } });
    const script = output.outputFiles[0].text;
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const modeReport = { mode, blockedRequests: [], pageErrors: [], requests: [] };
    report.modes.push(modeReport);
    try {
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        modeReport.requests.push({ method: request.method(), origin: url.origin, path: url.pathname });
        if (request.method() === 'GET' && url.origin === 'https://react-root.fixture.invalid' && url.pathname === '/' && !url.search) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Isolated real React root test</title></head><body><div id="react-root"></div><script src="/fixture.js"></script></body></html>' });
        if (request.method() === 'GET' && url.origin === 'https://react-root.fixture.invalid' && url.pathname === '/fixture.js' && !url.search) return route.fulfill({ contentType: 'application/javascript', body: script });
        modeReport.blockedRequests.push({ method: request.method(), origin: url.origin, path: url.pathname });
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      page.on('pageerror', error => modeReport.pageErrors.push(error.message));
      await page.goto('https://react-root.fixture.invalid/');
      await page.waitForFunction(() => typeof window.__runReactRootCheck === 'function');
      Object.assign(modeReport, await page.evaluate(() => window.__runReactRootCheck()));
      assert.equal(modeReport.metrics.nativeRequests, 0, 'Store discovery must not dispatch an API request.');
      assert.deepEqual(modeReport.blockedRequests, [], 'Unexpected network request attempted.');
      assert.deepEqual(modeReport.pageErrors, [], 'The fixture itself raised a browser exception.');
      modeReport.fixtureValid = true;
      for (const test of modeReport.tests) console.log(`${test.passed ? 'PASS' : 'FAIL'} ${mode}/${test.name}${test.outcome.diagnostic ? ' ' + test.outcome.diagnostic : ''}`);
    } catch (error) { modeReport.failure = error.stack || String(error); }
    finally { await context.close(); }
  }
  const tests = report.modes.flatMap(mode => mode.tests || []);
  report.summary = { total: tests.length, passed: tests.filter(test => test.passed).length, failed: tests.filter(test => !test.passed).length, validFixtures: report.modes.filter(mode => mode.fixtureValid).length };
  report.passed = report.summary.failed === 0 && report.summary.validFixtures === 2;
  if (!report.passed) process.exitCode = 1;
} catch (error) { report.failure = error.stack || String(error); process.exitCode = 1; }
finally {
  if (browser) await browser.close();
  await writeFile(path.join(cwd, 'qa/react-root-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: 'qa/react-root-report.json', ...report.summary, overallPassed: report.passed }, null, 2));
}
