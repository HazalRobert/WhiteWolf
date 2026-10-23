import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixtureActor, fixtureIds, installXFixture } from './x-fixture.mjs';

// Exercise the built MV3 UI -> worker -> page adapter -> parser -> engine. This
// fixture never forwards X traffic. Explicit automatic confirmations may mutate
// only the isolated in-memory fixture; no user profile or real X account is used.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd(), dist = path.join(root, 'dist');
const output = path.join(root, 'qa/unavailable-1.3');
const executablePath = process.env.BROWSER_EXECUTABLE || chromium.executablePath();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { at: new Date().toISOString(),
  scope: 'Built isolated MV3 UI, worker, adapter and parser with synthetic UserUnavailable pages and explicitly confirmed in-memory automatic writes.',
  exclusions: ['No user browser profile', 'No real X requests or account', 'No production mutations'],
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
assert.equal(manifest.version, '1.3', 'Build v1.3 before running this script.');
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
  relationship_perspectives: { following: fixture.following.has(person.id), followed_by: person.id === fixtureIds.bob } });
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
    phase: progress?.dataset.phase, complete: progress?.dataset.complete, autoReady: progress?.dataset.autoReady,
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
  assert.equal(value.phase, 'ready'); assert.equal(value.complete, 'false'); assert.equal(value.autoReady, 'true');
  assert.equal(value.incomplete, true); assert.equal(value.connected, true); assert.equal(value.connectionText, '已就绪');
  assert.match(value.unavailableText || '', /3/);
  assert.equal(await ui.locator('.overview-section .section-heading button').first().isEnabled(), true);
  assert.equal(await ui.getByText('Fixture Bob', { exact: true }).count(), 0, 'Mutual users must stay outside the actionable list.');
  assert.equal(await ui.locator('.person-row').count(), 2, 'Only the two verified normal non-followers may be listed.');
  assert.equal(await ui.locator('.person-row button.button-unfollow:not([disabled])').count(), 2);
  return value;
};
const resetPresentation = async () => {
  await ui.setViewportSize({ width: 1100, height: 960 });
  await ui.locator('.language-picker select').selectOption('zh-CN');
};
// The same control reads "preview" at ready and "recheck and continue" after pause.
const autoButton = () => ui.locator('.auto-control > button');
const confirmAutomatic = async expectedCount => {
  // Actions stay disabled until a preceding whitelist save settles; then the run must be available.
  await ui.waitForFunction(() => document.querySelector('.auto-control > button')?.disabled === false, null, { timeout: 5000 });
  assert.equal(await autoButton().isEnabled(), true);
  await autoButton().click(); await ui.locator('dialog[open]').waitFor();
  assert.equal(Number(await ui.locator('dialog .preview-stat strong').innerText()), expectedCount);
  assert.equal(await ui.locator('dialog .button-primary').isEnabled(), true);
  await ui.locator('dialog .button-primary').click();
};
const waitAutoFinished = async () => {
  await ui.waitForFunction(() => document.querySelector('[data-testid="scan-progress"]')?.dataset.phase === 'ready'
    && !document.querySelector('[data-testid="operation-pause"]'), null, { timeout: 15000 });
  const state = await snapshot();
  assert.equal(state.complete, 'false'); assert.equal(state.autoReady, 'true');
  assert.match(state.unavailableText || '', /3/); return state;
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
  // This final route always runs first. POSTs may reach only the exact synthetic
  // unfollow route, whose base fixture checks method, headers and explicit IDs.
  await context.route('**/*', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const request = route.request(), url = new URL(request.url());
    if (url.origin === 'https://x.com' && url.pathname === '/i/api/1.1/friendships/destroy.json') {
      report.traffic.push({ scenario, method: 'POST', operation: 'synthetic-unfollow', targetId: new URLSearchParams(request.postData() || '').get('user_id') });
      return route.fallback();
    }
    report.violations.push({ method: 'POST', url: request.url(), error: 'Non-fixture mutation blocked.' });
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
      if (operation) globalThis.__unavailableReadback.push({ kind: operation.kind, cursor: operation.cursor, ids: operation.ids,
        targetId: operation.targetId, automatic: operation.automatic, result: result[0]?.result });
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
  await test('automatic-and-manual-confirmations-remain-available-with-unavailable-entries', async () => {
    await ui.locator('#tab-auto').click();
    assert.equal(await autoButton().isEnabled(), true);
    await autoButton().click(); await ui.locator('dialog[open]').waitFor();
    assert.equal(Number(await ui.locator('dialog .preview-stat strong').innerText()), 2);
    assert.equal(await ui.locator('dialog .button-primary').isEnabled(), true);
    await ui.locator('dialog .button-neutral').click(); await ui.locator('dialog').waitFor({ state: 'hidden' });
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
    assert.equal(paused.autoReady, 'false');
    assert.equal(await ui.locator('.person-row button.button-unfollow:not([disabled])').count(), 0);
    await ui.getByTestId('scan-resume').click(); const completed = await waitFinished();
    assert.deepEqual(followingRequests.filter(item => item.scenario === scenario).map(item => item.cursor), ['-1', cursorA, cursorA, cursorB]);
    await ui.locator('#tab-auto').click(); assert.equal(await autoButton().isEnabled(), true);
    assert.deepEqual(fixture.writes, []); return { before, paused, completed };
  });
  await test('unavailable-notice-fits-ten-languages-at-desktop-and-mobile-widths', async () => {
    for (const width of [1100, 360]) for (const language of ['zh-CN', 'en', 'fr', 'es', 'ru', 'de', 'pt', 'ja', 'ko', 'ar']) {
      await ui.setViewportSize({ width, height: 960 }); await ui.locator('.language-picker select').selectOption(language);
      const layout = await ui.evaluate(() => {
        const element = document.querySelector('[data-testid="scan-unavailable"]');
        const box = element?.getBoundingClientRect();
        return { fits: document.documentElement.scrollWidth <= innerWidth && !!box && box.left >= -1 && box.right <= innerWidth + 1,
          text: element?.textContent?.trim(), dir: document.querySelector('main')?.dir,
          autoReady: document.querySelector('[data-testid="scan-progress"]')?.dataset.autoReady };
      });
      assert.equal(layout.fits, true, `${width}/${language} must not overflow.`);
      assert.ok(layout.text); assert.equal(layout.dir, language === 'ar' ? 'rtl' : 'ltr');
      assert.equal(layout.autoReady, 'true');
      assert.equal(await autoButton().isEnabled(), true);
      if (language === 'zh-CN') { assert.match(layout.text, /自动/); assert.doesNotMatch(layout.text, /自动取关暂不可用/); }
      if (language === 'en') assert.doesNotMatch(layout.text, /Automatic unfollow is disabled/);
      report.layouts.push({ width, language, ...layout });
      if (['zh-CN', 'en', 'ar'].includes(language)) {
        const name = `unavailable-${language}-${width}.png`;
        await ui.screenshot({ path: path.join(output, name), fullPage: true }); report.screenshots.push(name);
      }
    }
    return { layouts: report.layouts.length };
  });
  await test('confirmed-automatic-run-writes-only-the-normal-non-whitelisted-candidate', async () => {
    await resetPresentation(); scenario = 'automatic-whitelist';
    await ui.locator('#tab-auto').click();
    await ui.locator('.whitelist-form input').fill('@fixture_alice');
    await ui.locator('.whitelist-form button').click();
    await ui.locator('.whitelist-chip').filter({ hasText: 'fixture_alice' }).waitFor();
    const beforeRequests = fixture.requests.length;
    await confirmAutomatic(1);
    await ui.locator('.person-row').filter({ hasText: 'Fixture Chen' }).locator('.row-status.success').waitFor();
    const state = await waitAutoFinished();
    assert.deepEqual(fixture.writes, [{ action: 'unfollow', id: fixtureIds.chen }]);
    assert.equal(fixture.following.has(fixtureIds.alice), true); assert.equal(fixture.following.has(fixtureIds.bob), true);
    assert.equal(fixture.following.has(fixtureIds.chen), false);
    const reads = fixture.requests.slice(beforeRequests).filter(request => request.operation === 'UserByRestId');
    assert.ok(reads.length >= 3, 'Automatic execution must perform fresh relationship, prepare and post-write reads.');
    assert.ok(reads.every(request => request.variables.userId === fixtureIds.chen), 'The whitelisted and unavailable entries cannot reach target reads.');
    const calls = await worker.evaluate(() => globalThis.__unavailableReadback.filter(call => call.kind === 'unfollow'));
    assert.deepEqual(calls.map(call => [call.targetId, call.automatic, call.result.ok]), [[fixtureIds.chen, true, true]]);
    await ui.screenshot({ path: path.join(output, 'automatic-whitelist-result.png'), fullPage: true }); report.screenshots.push('automatic-whitelist-result.png');
    return { state, syntheticWrites: [...fixture.writes], freshTargetReadCount: reads.length };
  });
  await test('automatic-pause-and-explicit-restart-process-only-the-remaining-normal-candidate', async () => {
    scenario = 'automatic-pause-resume';
    // Reset only in-memory fixture state to set up a separate queue. This is not
    // a follow operation, and is recorded explicitly in the report.
    fixture.following.add(fixtureIds.chen);
    await ui.locator('.whitelist-chip').filter({ hasText: 'fixture_alice' }).locator('button').click();
    await startScan(); await waitFinished();
    await ui.locator('.pacing-fields input').nth(0).fill('5');
    await ui.locator('.pacing-fields input').nth(1).fill('2');
    const beforeWrites = fixture.writes.length;
    await confirmAutomatic(2);
    await ui.locator('.person-row').filter({ hasText: 'Fixture Alice' }).locator('.row-status.success').waitFor();
    await ui.getByTestId('operation-pause').click(); await ui.getByTestId('operation-pause').waitFor({ state: 'hidden' });
    assert.equal(await ui.getByTestId('scan-resume').count(), 0, 'An automatic queue must not create a pagination checkpoint.');
    const paused = await snapshot(); assert.equal(paused.phase, 'paused'); assert.equal(paused.autoReady, 'true');
    assert.equal(paused.connected, false); assert.match(paused.unavailableText || '', /3/);
    assert.deepEqual(fixture.writes.slice(beforeWrites), [{ action: 'unfollow', id: fixtureIds.alice }]);
    const requestCount = fixture.requests.length; await sleep(5500);
    assert.equal(fixture.requests.length, requestCount, 'Paused automatic work must issue no further reads or writes.');
    assert.equal(fixture.following.has(fixtureIds.chen), true);
    await confirmAutomatic(1);
    await ui.locator('.person-row').filter({ hasText: 'Fixture Chen' }).locator('.row-status.success').waitFor();
    const completed = await waitAutoFinished();
    assert.deepEqual(fixture.writes.slice(beforeWrites), [{ action: 'unfollow', id: fixtureIds.alice }, { action: 'unfollow', id: fixtureIds.chen }]);
    assert.equal(fixture.following.has(fixtureIds.bob), true);
    assert.equal(await ui.locator('.person-row').count(), 2);
    assert.equal(await ui.locator('.row-status.success').count(), 2);
    return { fixtureReset: 'Added 103 back to the in-memory Following set before a new scan.', paused, completed,
      quietMs: 5500, syntheticWrites: fixture.writes.slice(beforeWrites) };
  });
  await test('isolation-and-source-permissions-remain-intact', async () => {
    assert.deepEqual(report.violations, []); assert.deepEqual(fixture.violations, []); assert.deepEqual(report.errors, []);
    assert.deepEqual(fixture.writes, [{ action: 'unfollow', id: fixtureIds.chen }, { action: 'unfollow', id: fixtureIds.alice }, { action: 'unfollow', id: fixtureIds.chen }]);
    const posts = report.traffic.filter(request => request.method === 'POST');
    assert.equal(posts.length, 3); assert.ok(posts.every(request => ['101', '103'].includes(request.targetId)));
    assert.equal(digest(await readFile(path.join(dist, 'manifest.json'))), report.manifestSha256);
    assert.equal(digest(await readFile(path.join(dist, 'index.html'))), report.distIndexSha256);
    assert.equal((await ui.locator('.footer-version').innerText()).includes('v1.3'), true);
    return { realXRequests: 0, syntheticWrites: fixture.writes.length, pageErrors: 0, sourceManifestUnchanged: true };
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
  report.syntheticWrites = fixture?.writes || [];
  report.summary = { tests: report.tests.length, passed: report.tests.filter(item => item.passed).length,
    failed: report.tests.filter(item => !item.passed).length, layouts: report.layouts.length, syntheticWrites: fixture?.writes.length || 0 };
  await writeFile(path.join(output, 'unavailable-report.json'), JSON.stringify(report, null, 2) + '\n');
}
