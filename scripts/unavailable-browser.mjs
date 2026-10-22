import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixtureActor, fixtureIds, installXFixture } from './x-fixture.mjs';

// Exercise the built MV3 UI -> worker -> page adapter -> parser -> engine. This
// fixture never forwards X traffic and refuses every POST, even synthetic writes.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd(), dist = path.join(root, 'dist');
const output = path.join(root, 'qa/unavailable-1.2.3');
const executablePath = process.env.BROWSER_EXECUTABLE || chromium.executablePath();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { at: new Date().toISOString(),
  scope: 'Built isolated MV3 UI, worker, adapter and parser with synthetic UserUnavailable pages; no writes.',
  exclusions: ['No user browser profile', 'No real X requests or account', 'No mutation confirmation'],
  tests: [], layouts: [], screenshots: [], traffic: [], violations: [], errors: [] };
const test = async (name, work) => {
  try { const details = await work(); report.tests.push({ name, passed: true, ...details }); console.log('PASS ' + name); }
  catch (error) { report.tests.push({ name, passed: false, error: error.message }); throw error; }
};
const until = async (predicate, message) => {
  const start = Date.now();
  while (!await predicate()) { assert.ok(Date.now() - start < 15000, message); await sleep(20); }
};
await mkdir(output, { recursive: true });
const manifestBytes = await readFile(path.join(dist, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
assert.equal(manifest.version, '1.2.3', 'Build v1.2.3 before running this script.');
assert.equal(manifest.host_permissions, undefined, 'The delivery manifest must not grant required host permissions.');
report.manifestSha256 = digest(manifestBytes);
report.distIndexSha256 = digest(await readFile(path.join(dist, 'index.html')));

const people = [
  { id: fixtureIds.alice, handle: 'fixture_alice', name: 'Fixture Alice' },
  { id: fixtureIds.bob, handle: 'fixture_bob', name: 'Fixture Bob' },
  { id: fixtureIds.chen, handle: 'fixture_chen', name: 'Fixture Chen' },
];
const cursorA = '1771337970390780275|unavailable-page-two';
const cursorB = '1771337970390780275|unavailable-page-three';
let context, ui, worker, fixture, gate = null;
let scenario = 'initial';
const followingRequests = [];
const userResult = person => ({ __typename: 'User', rest_id: person.id,
  core: { screen_name: person.handle, name: person.name },
  relationship_perspectives: { following: person.id !== fixtureActor.id, followed_by: person.id === fixtureIds.bob } });
const userEntry = (result, entryId) => ({ entryId, content: {
  entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineUser', user_results: { result } },
} });
const unavailable = (entryId, wrapped = false) => userEntry(wrapped
  ? { __typename: 'UserWithVisibilityResults', user: { __typename: 'UserUnavailable', reason: 'Unavailable' } }
  : { __typename: 'UserUnavailable', reason: 'Unavailable' }, entryId);
const snapshot = () => ui.evaluate(() => {
  const progress = document.querySelector('[data-testid="scan-progress"]');
  const numeric = id => Number(document.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/[\s,]/g, ''));
  return { pages: Number(progress?.dataset.pages || 0), checked: Number(progress?.dataset.checked || 0),
    phase: progress?.dataset.phase, complete: progress?.dataset.complete,
    total: numeric('scan-total'), unavailableText: document.querySelector('[data-testid="scan-unavailable"]')?.textContent?.trim(),
    paused: progress?.dataset.paused, incomplete: !!document.querySelector('.scan-status.scan-incomplete'),
    connected: !!document.querySelector('.connected-indicator'),
    connectionText: document.querySelector('.connected-indicator')?.textContent?.trim() };
});
const startScan = async () => {
  await ui.locator('.language-picker select').selectOption('zh-CN');
  await ui.locator('.overview-section .section-heading button').first().click();
};
const waitFinished = async () => {
  await ui.waitForFunction(() => {
    const progress = document.querySelector('[data-testid="scan-progress"]');
    return Number(progress?.dataset.pages) === 3 && Number(progress?.dataset.checked) === 3
      && !document.querySelector('[data-testid="scan-pause"], [data-testid="scan-resume"]')
      && !!document.querySelector('.scan-status time');
  }, null, { timeout: 20000 });
  const value = await snapshot();
  assert.equal(value.total, 3); assert.equal(value.checked, 3); assert.equal(value.pages, 3);
  assert.equal(value.phase, 'ready'); assert.equal(value.complete, 'false');
  assert.equal(value.incomplete, true); assert.equal(value.connected, true); assert.equal(value.connectionText, '已就绪');
  assert.match(value.unavailableText || '', /3/);
  assert.equal(await ui.locator('.overview-section .section-heading button').first().isEnabled(), true);
  assert.equal(await ui.getByText('Fixture Bob', { exact: true }).count(), 0, 'Mutual users must stay outside the actionable list.');
  assert.equal(await ui.locator('.person-row').count(), 2, 'Only the two verified normal non-followers may be listed.');
  assert.equal(await ui.locator('.person-row button.button-unfollow:not([disabled])').count(), 2);
  return value;
};

try {
  const temporaryRoot = await mkdtemp(path.join(root, 'qa-unavailable-extension-'));
  const extension = path.join(temporaryRoot, 'extension'), profile = path.join(temporaryRoot, 'profile');
  await cp(dist, extension, { recursive: true });
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['https://x.com/*'] }));
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, viewport: { width: 1100, height: 960 },
    proxy: { server: 'http://127.0.0.1:9', bypass: '' },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-background-networking'],
  });
  context.setDefaultTimeout(12000);
  fixture = await installXFixture(context);
  await context.route('https://x.com/i/api/graphql/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const operation = url.pathname.split('/').at(-1);
    if (operation !== 'Following') return route.fallback();
    const entry = { scenario, method: request.method(), operation, variables: JSON.parse(url.searchParams.get('variables') || '{}') };
    report.traffic.push(entry);
    try {
      assert.equal(request.method(), 'GET');
      assert.equal(url.pathname, '/i/api/graphql/fixture_Following_001/Following');
      const headers = await request.allHeaders();
      assert.equal(headers.authorization, 'Bearer synthetic-fixture-only');
      assert.equal(headers['x-csrf-token'], 'synthetic-fixture-not-a-secret');
      assert.equal(headers['x-client-transaction-id'], 'synthetic-native-filter-transaction');
      assert.ok(headers.cookie?.includes('twid=u%3D' + fixtureActor.id));
      assert.match(headers['content-type'] || '', /^application\/json(?:;|$)/i);
      assert.equal(JSON.parse(url.searchParams.get('features')).fixture_enabled, true);
      const variables = entry.variables;
      assert.equal(variables.userId, fixtureActor.id); assert.equal(variables.count, 20);
      assert.equal(variables.includePromotedContent, false); assert.equal(variables.withGrokTranslatedBio, false);
      assert.deepEqual(Object.keys(variables).sort(), ['userId', 'count', 'includePromotedContent', 'withGrokTranslatedBio', ...(variables.cursor ? ['cursor'] : [])].sort());
      const cursor = variables.cursor ?? '-1';
      assert.ok(['-1', cursorA, cursorB].includes(cursor), 'Unexpected synthetic Following cursor.');
      followingRequests.push({ scenario, cursor });
      const activeGate = gate;
      if (activeGate && cursor === cursorA && !activeGate.reached) { activeGate.reached = true; await activeGate.promise; }
      const entries = cursor === '-1'
        ? [userEntry(userResult(people[0]), 'user-101'), unavailable('unavailable-one'), userEntry(userResult(people[1]), 'user-102')]
        : cursor === cursorA ? [unavailable('unavailable-two'), unavailable('unavailable-three', true)]
          : [userEntry(userResult(people[2]), 'user-103')];
      entries.push({ entryId: 'cursor-bottom', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom',
        value: cursor === '-1' ? cursorA : cursor === cursorA ? cursorB : 'retained-terminal-token' } });
      const instructions = [...(cursor === '-1' ? [{ type: 'TimelineClearCache' }] : []),
        { type: 'TimelineAddEntries', entries }, ...(cursor === cursorB ? [{ type: 'TimelineTerminateTimeline', direction: 'Bottom' }] : [])];
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { user: { result: {
        ...userResult(fixtureActor), timeline: { timeline: { instructions } },
      } } } }) });
    } catch (error) { report.violations.push({ ...entry, error: error.message }); await route.abort('blockedbyclient').catch(() => {}); }
  });
  // This final route always runs first. Neither a fixture bug nor an accidental
  // confirm click can issue even an in-memory relationship mutation.
  await context.route('**/*', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    report.violations.push({ method: 'POST', url: route.request().url(), error: 'All writes are forbidden in this regression.' });
    return route.abort('blockedbyclient');
  });
  context.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== 'https://x.com') report.violations.push({ url: request.url(), error: 'Non-fixture HTTP request.' });
  });
  const xpage = await context.newPage(); await xpage.goto('https://x.com/home');
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://x.com/*' }))[0].id);
  await worker.evaluate(() => {
    const original = chrome.scripting.executeScript.bind(chrome.scripting);
    globalThis.__unavailableReadback = [];
    chrome.scripting.executeScript = async details => {
      const operation = details.args?.[0]?.operation;
      const result = await original(details);
      if (operation) globalThis.__unavailableReadback.push({ kind: operation.kind, cursor: operation.cursor, ids: operation.ids, result: result[0]?.result });
      return result;
    };
  });
  ui = await context.newPage(); ui.on('pageerror', error => report.errors.push(error.message));
  await ui.goto(`chrome-extension://${extensionId}/index.html?tab=${tabId}`);
  await ui.locator('.language-picker select').selectOption('zh-CN');
  await ui.getByRole('button', { name: '连接 X 账号', exact: true }).first().click();
  await ui.getByText('@qa_owner', { exact: true }).waitFor();

  await test('mixed-and-unavailable-only-pages-reach-ready-with-normal-users', async () => {
    scenario = 'initial'; await startScan(); const state = await waitFinished();
    const calls = await worker.evaluate(() => globalThis.__unavailableReadback);
    const pages = calls.filter(call => call.kind === 'following');
    assert.deepEqual(pages.map(call => call.cursor), ['-1', cursorA, cursorB]);
    assert.ok(pages.every(call => call.result.ok));
    assert.deepEqual(pages.map(call => call.result.data.unavailableCount || 0), [1, 2, 0]);
    assert.deepEqual(pages.map(call => call.result.data.users.map(person => person.id)), [['101', '102'], [], ['103']]);
    assert.deepEqual(pages.map(call => call.result.data.relations.map(relation => relation.id)), [['101', '102'], [], ['103']]);
    assert.deepEqual(calls.filter(call => call.kind === 'relations').map(call => call.ids), [['101', '102', '103']]);
    assert.deepEqual(fixture.writes, []);
    return { state, pageReadback: pages.map(call => ({ cursor: call.cursor, ...call.result.data })) };
  });
  await test('automatic-is-disabled-but-normal-manual-confirmation-remains-available', async () => {
    await ui.locator('#tab-auto').click();
    assert.equal(await ui.getByRole('button', { name: '预览自动处理', exact: true }).isDisabled(), true);
    await ui.locator('#tab-manual').click();
    await ui.locator('.person-row').filter({ hasText: 'Fixture Alice' }).getByRole('button', { name: '取消关注', exact: true }).click();
    await ui.locator('dialog[open]').waitFor();
    assert.equal(await ui.locator('dialog .button-danger').isEnabled(), true);
    assert.match(await ui.locator('dialog').innerText(), /fixture_alice/);
    await ui.screenshot({ path: path.join(output, 'manual-confirmation.png'), fullPage: true }); report.screenshots.push('manual-confirmation.png');
    await ui.locator('dialog .button-neutral').click(); await ui.locator('dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(fixture.writes, []); return { confirmClicked: false, syntheticWrites: 0 };
  });
  await test('pause-and-resume-preserve-only-committed-unavailable-count', async () => {
    scenario = 'pause-resume'; let release;
    gate = { reached: false, promise: new Promise(resolve => { release = resolve; }), release: () => release() };
    await startScan(); await until(() => gate.reached, 'The unavailable-only page was not requested.');
    const before = await snapshot(); assert.equal(before.pages, 1); assert.match(before.unavailableText || '', /1/);
    await ui.getByTestId('scan-pause').click(); gate.release(); gate = null;
    await ui.getByTestId('scan-resume').waitFor(); await sleep(150);
    const paused = await snapshot(); assert.equal(paused.pages, 1); assert.equal(paused.total, 2);
    assert.equal(paused.checked, 0); assert.match(paused.unavailableText || '', /1/);
    assert.equal(await ui.locator('.person-row button.button-unfollow:not([disabled])').count(), 0);
    await ui.getByTestId('scan-resume').click(); const completed = await waitFinished();
    assert.deepEqual(followingRequests.filter(item => item.scenario === scenario).map(item => item.cursor), ['-1', cursorA, cursorA, cursorB]);
    assert.deepEqual(fixture.writes, []); return { before, paused, completed };
  });
  await test('unavailable-notice-fits-ten-languages-at-desktop-and-mobile-widths', async () => {
    for (const width of [1100, 360]) for (const language of ['zh-CN', 'en', 'fr', 'es', 'ru', 'de', 'pt', 'ja', 'ko', 'ar']) {
      await ui.setViewportSize({ width, height: 960 }); await ui.locator('.language-picker select').selectOption(language);
      const layout = await ui.evaluate(() => {
        const element = document.querySelector('[data-testid="scan-unavailable"]');
        const box = element?.getBoundingClientRect();
        return { fits: document.documentElement.scrollWidth <= innerWidth && !!box && box.left >= -1 && box.right <= innerWidth + 1,
          text: element?.textContent?.trim(), dir: document.querySelector('main')?.dir };
      });
      assert.equal(layout.fits, true, `${width}/${language} must not overflow.`);
      assert.ok(layout.text); assert.equal(layout.dir, language === 'ar' ? 'rtl' : 'ltr');
      report.layouts.push({ width, language, ...layout });
      if (['zh-CN', 'en', 'ar'].includes(language)) {
        const name = `unavailable-${language}-${width}.png`;
        await ui.screenshot({ path: path.join(output, name), fullPage: true }); report.screenshots.push(name);
      }
    }
    return { layouts: report.layouts.length };
  });
  await test('isolation-and-source-permissions-remain-intact', async () => {
    assert.deepEqual(report.violations, []); assert.deepEqual(fixture.violations, []); assert.deepEqual(report.errors, []);
    assert.deepEqual(fixture.writes, []);
    assert.equal(digest(await readFile(path.join(dist, 'manifest.json'))), report.manifestSha256);
    assert.equal(digest(await readFile(path.join(dist, 'index.html'))), report.distIndexSha256);
    assert.equal((await ui.locator('.footer-version').innerText()).includes('v1.2.3'), true);
    return { realXRequests: 0, syntheticWrites: 0, pageErrors: 0, sourceManifestUnchanged: true };
  });
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
  if (ui && !ui.isClosed()) {
    await ui.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    report.failureText = (await ui.locator('body').innerText().catch(() => '')).slice(0, 14000);
  }
} finally {
  gate?.release();
  if (context) await context.close();
  report.baseFixtureRequests = fixture?.requests || []; report.baseFixtureViolations = fixture?.violations || [];
  report.followingRequests = followingRequests;
  report.summary = { tests: report.tests.length, passed: report.tests.filter(item => item.passed).length,
    failed: report.tests.filter(item => !item.passed).length, layouts: report.layouts.length, syntheticWrites: fixture?.writes.length || 0 };
  await writeFile(path.join(output, 'unavailable-report.json'), JSON.stringify(report, null, 2) + '\n');
}
