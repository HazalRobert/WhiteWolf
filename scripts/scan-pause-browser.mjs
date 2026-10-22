import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixtureActor, fixtureIds, installXFixture } from './x-fixture.mjs';

// Run against a built extension, never an existing browser profile. All X requests
// are fulfilled in memory; a dead loopback proxy also blocks accidental forwarding.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd(), dist = path.join(root, 'dist'), output = path.join(root, 'qa/scan-pause-1.2.3');
const executablePath = process.env.BROWSER_EXECUTABLE || chromium.executablePath();
const themeKey = 'whitewolf_themes_v1';
const report = {
  at: new Date().toISOString(),
  scope: 'Real isolated MV3 UI, worker and page adapter with entirely synthetic X responses; explicit pause and resume only.',
  exclusions: ['No user browser profile', 'No real X account or network access', 'No production mutations', 'No complete theme regression'],
  tests: [], layouts: [], screenshots: [], errors: [], fixtureViolations: [], traffic: [],
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, message, timeout = 12000) => {
  const start = Date.now();
  while (!await predicate()) { assert.ok(Date.now() - start < timeout, message); await sleep(20); }
};
const test = async (name, work) => {
  try { const details = await work(); report.tests.push({ name, passed: true, ...(details || {}) }); console.log('PASS ' + name); }
  catch (error) { report.tests.push({ name, passed: false, error: error.message }); throw error; }
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(output, { recursive: true });
const manifestBytes = await readFile(path.join(dist, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
report.manifestSha256 = digest(manifestBytes);
report.distIndexSha256 = digest(await readFile(path.join(dist, 'index.html')));
assert.equal(manifest.version, '1.2.3', 'Build the requested release before running this script.');
assert.equal(manifest.host_permissions, undefined, 'Only the disposable test copy may grant fixture access.');

let context, ui, worker, fixture, networkGate = null;
const allGates = new Set();
const smallPeople = [
  { id: fixtureIds.alice, handle: 'fixture_alice', name: 'Fixture Alice' },
  { id: fixtureIds.bob, handle: 'fixture_bob', name: 'Fixture Bob' },
  { id: fixtureIds.chen, handle: 'fixture_chen', name: 'Fixture Chen' },
  { id: '104', handle: 'fixture_delta', name: 'Fixture Delta' },
  { id: '105', handle: 'fixture_echo', name: 'Fixture Echo' },
];
const largePeople = [...smallPeople, ...Array.from({ length: 97 }, (_, index) => ({
  id: String(1000 + index), handle: `pause_user_${index}`, name: `Pause Person ${index}`,
}))];
const scenario = { pages: [], following: [], people: smallPeople, label: '' };
const cursorAt = index => index === 0 ? null : `1771337970390780275|pause-${index}`;
const resetScenario = (label, large = false) => {
  scenario.label = label; scenario.following = []; scenario.people = large ? largePeople : smallPeople;
  scenario.pages = large
    ? Array.from({ length: Math.ceil(largePeople.length / 20) }, (_, index) => largePeople.slice(index * 20, index * 20 + 20))
    : [[smallPeople[0], smallPeople[1]], [smallPeople[1], smallPeople[2]], [smallPeople[3], smallPeople[4]]];
  fixture.following.clear();
  for (const person of scenario.people) fixture.following.add(person.id);
};
const makeGate = match => {
  assert.equal(networkGate, null, 'Only one synthetic network gate may be armed.');
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  const gate = { match, reached: false, released: false, entry: null, promise,
    release() { if (!gate.released) { gate.released = true; release(); } if (networkGate === gate) networkGate = null; },
  };
  networkGate = gate; allGates.add(gate); return gate;
};
const hold = async entry => {
  const gate = networkGate;
  if (gate && !gate.reached && gate.match(entry)) { gate.reached = true; gate.entry = entry; await gate.promise; }
};
const userResult = person => ({
  __typename: 'User', rest_id: person.id,
  core: { screen_name: person.handle, name: person.name },
  legacy: { screen_name: person.handle, name: person.name, following: fixture.following.has(person.id), followed_by: person.id === fixtureIds.bob },
  relationship_perspectives: { following: fixture.following.has(person.id), followed_by: person.id === fixtureIds.bob },
});
const snapshot = () => ui.evaluate(() => {
  const progress = document.querySelector('[data-testid="scan-progress"]');
  const numeric = id => Number(document.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/[\s,]/g, ''));
  return { pages: Number(progress?.getAttribute('data-pages') || 0), checked: Number(progress?.getAttribute('data-checked') || 0),
    total: numeric('scan-total'), paused: progress?.getAttribute('data-paused'),
    incomplete: !!document.querySelector('.scan-status.scan-incomplete') };
});
const counts = () => ({ requests: report.traffic.length, following: scenario.following.length, writes: fixture.writes.length });
const settled = () => ui.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const waitPaused = () => ui.getByTestId('scan-resume').waitFor({ state: 'visible' });
const waitReady = async total => {
  await ui.waitForFunction(total => {
    const progress = document.querySelector('[data-testid="scan-progress"]');
    return Number(progress?.getAttribute('data-checked')) === total && !document.querySelector('[data-testid="scan-resume"], [data-testid="scan-pause"]')
      && !document.querySelector('.scan-status.scan-incomplete');
  }, total, { timeout: 20000 });
  assert.equal(await ui.locator('[role="alert"]').count(), 0, 'A resumed scan must finish without missing relationship evidence.');
  const state = await snapshot(); assert.equal(state.total, total); assert.equal(state.checked, total); return state;
};
const startScan = async () => {
  await ui.locator('.language-picker select').selectOption('zh-CN');
  await ui.locator('.overview-section .section-heading button').first().click();
};
const assertQuiet = async (label, milliseconds = 1200) => {
  const before = counts(), metrics = await snapshot(); await sleep(milliseconds);
  assert.deepEqual(counts(), before, `${label}: paused work issued another request or mutation.`);
  assert.deepEqual(await snapshot(), metrics, `${label}: checkpoint changed while paused.`);
  return { quietMs: milliseconds, counts: before, checkpoint: metrics };
};
const pauseHeld = async gate => {
  await until(() => gate.reached, 'Expected the synthetic response to be held.');
  const before = await snapshot();
  await ui.getByTestId('scan-pause').click();
  // A transport cancel may settle the engine before the held HTTP response returns.
  // Release the old response before any explicit resume, then verify it cannot commit.
  gate.release(); await waitPaused(); await sleep(150);
  const paused = await snapshot();
  assert.equal(paused.pages, before.pages); assert.equal(paused.total, before.total); assert.equal(paused.checked, before.checked);
  assert.equal(paused.paused, 'true');
  assert.equal(await ui.getByTestId('scan-resume').isEnabled(), true);
  assert.equal(await ui.getByTestId('scan-restart').isEnabled(), true);
  return paused;
};
const layout = async (theme, mode, phase) => {
  for (const width of [1100, 360]) for (const language of ['zh-CN', 'fr', 'ar']) {
    await ui.setViewportSize({ width, height: 960 });
    await ui.locator('.language-picker select').selectOption(language); await settled();
    const result = await ui.evaluate(() => {
      const visible = element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
      const controls = [...document.querySelectorAll('[data-testid="scan-pause"], [data-testid="scan-resume"], [data-testid="scan-restart"], [data-testid="operation-pause"]')].filter(visible);
      const failures = [];
      for (const element of controls) {
        const box = element.getBoundingClientRect();
        if (box.left < -1 || box.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 1) failures.push(`control:${element.dataset.testid}`);
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent?.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(walker.currentNode);
          for (const text of range.getClientRects()) if (text.left < box.left - 1 || text.right > box.right + 1 || text.top < box.top - 1 || text.bottom > box.bottom + 1) failures.push(`text:${element.dataset.testid}`);
        }
      }
      const heading = document.querySelector('.overview-section .section-heading');
      const title = heading?.querySelector('h1')?.getBoundingClientRect();
      for (const control of controls.filter(element => heading?.contains(element))) {
        const box = control.getBoundingClientRect();
        if (title && Math.min(title.right, box.right) - Math.max(title.left, box.left) > 1 && Math.min(title.bottom, box.bottom) - Math.max(title.top, box.top) > 1) failures.push('heading-overlap');
      }
      return { fits: document.documentElement.scrollWidth <= innerWidth && failures.length === 0, failures,
        controls: controls.map(element => ({ id: element.dataset.testid, text: element.textContent.trim() })), dir: document.querySelector('main')?.dir };
    });
    assert.ok(result.controls.length, `${phase} must expose its pause or resume controls.`);
    assert.ok(result.fits, `${theme}/${mode}/${phase}/${width}/${language}: ${result.failures.join(',')}`);
    assert.equal(result.dir, language === 'ar' ? 'rtl' : 'ltr');
    report.layouts.push({ theme, mode, phase, width, language, ...result });
    if (language === 'zh-CN' && (phase === 'paused' || theme === 'minimal')) {
      const name = `${theme}-${mode}-${phase}-${width}.png`;
      await ui.screenshot({ path: path.join(output, name), fullPage: true }); report.screenshots.push(name);
    }
  }
  await ui.setViewportSize({ width: 1100, height: 960 });
  await ui.locator('.language-picker select').selectOption('zh-CN');
};

try {
  const temporaryRoot = await mkdtemp(path.join(root, 'qa-scan-pause-extension-'));
  const extension = path.join(temporaryRoot, 'extension'), profile = path.join(temporaryRoot, 'profile');
  await cp(dist, extension, { recursive: true });
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['https://x.com/*'] }));
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, viewport: { width: 1100, height: 960 }, deviceScaleFactor: 1,
    proxy: { server: 'http://127.0.0.1:9', bypass: '' },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-background-networking'],
  });
  context.setDefaultTimeout(12000);
  fixture = await installXFixture(context);
  // This route extends the existing exact synthetic fixture, preserving its native
  // client bootstrap and its strict mutation / identity route validation.
  await context.route('https://x.com/i/api/graphql/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const operation = url.pathname.split('/').at(-1);
    const variables = JSON.parse(url.searchParams.get('variables') || '{}');
    const entry = { at: Date.now(), scenario: scenario.label, method: request.method(), operation, variables };
    report.traffic.push(entry);
    try {
      await hold(entry);
      if (operation !== 'Following' && operation !== 'UserByRestId') return route.fallback();
      assert.equal(request.method(), 'GET');
      assert.equal(url.pathname, `/i/api/graphql/fixture_${operation}_001/${operation}`);
      const headers = await request.allHeaders();
      assert.equal(headers.authorization, 'Bearer synthetic-fixture-only');
      assert.equal(headers['x-csrf-token'], 'synthetic-fixture-not-a-secret');
      assert.equal(headers['x-client-transaction-id'], 'synthetic-native-filter-transaction');
      assert.ok(headers.cookie?.includes('twid=u%3D' + fixtureActor.id));
      assert.match(headers['content-type'] || '', /^application\/json(?:;|$)/i);
      assert.equal(JSON.parse(url.searchParams.get('features')).fixture_enabled, true);
      if (operation === 'UserByRestId') {
        const person = scenario.people.find(person => person.id === variables.userId);
        if (!person) return route.fallback();
        assert.deepEqual(Object.keys(variables), ['userId']);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { user: { result: userResult(person) } } }) });
      }
      assert.equal(variables.userId, fixtureActor.id); assert.equal(variables.count, 20);
      assert.equal(variables.includePromotedContent, false); assert.equal(variables.withGrokTranslatedBio, false);
      const cursor = variables.cursor ?? null;
      const index = scenario.pages.findIndex((_, index) => cursorAt(index) === cursor);
      assert.ok(index >= 0, `Unexpected synthetic cursor: ${cursor}`);
      scenario.following.push({ cursor, index, at: Date.now() });
      const entries = scenario.pages[index].map(person => ({ entryId: 'user-' + person.id,
        content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineUser', user_results: { result: userResult(person) } } } }));
      const terminal = index === scenario.pages.length - 1;
      entries.push({ entryId: 'cursor-bottom-0', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: terminal ? 'retained-terminal-token' : cursorAt(index + 1) } });
      const instructions = [...(index === 0 ? [{ type: 'TimelineClearCache' }] : []),
        ...(terminal ? [{ type: 'TimelineTerminateTimeline', direction: 'Bottom' }] : []), { type: 'TimelineAddEntries', entries }];
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { user: { result: { ...userResult(fixtureActor), timeline: { timeline: { instructions } } } } } }) });
    } catch (error) {
      report.fixtureViolations.push({ ...entry, error: error.message }); await route.abort('blockedbyclient').catch(() => {});
    }
  });
  context.on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith('https://x.com/')) report.fixtureViolations.push({ url: request.url(), error: 'Non-fixture HTTP request.' });
    if (request.method() === 'POST') report.traffic.push({ at: Date.now(), scenario: scenario.label, method: 'POST', operation: new URL(request.url()).pathname });
  });
  const xpage = await context.newPage(); await xpage.goto('https://x.com/home');
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://x.com/*' }))[0].id);
  const skin = await xpage.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 600;
    const drawing = canvas.getContext('2d'); drawing.fillStyle = '#c6d7e2'; drawing.fillRect(0, 0, 1200, 600);
    drawing.fillStyle = '#6e8da3'; drawing.beginPath(); drawing.moveTo(0, 600); drawing.lineTo(400, 100); drawing.lineTo(800, 600); drawing.fill();
    return { id: 'custom-pause-fixture', name: 'Pause Test Landscape', dataUrl: canvas.toDataURL('image/png'), width: 1200, height: 600, x: 50, y: 50, zoom: 1, opacity: 60 };
  });
  await worker.evaluate(async ({ themeKey, skin }) => {
    await chrome.storage.local.set({ [themeKey]: { active: 'minimal', custom: [skin] } });
    const original = chrome.scripting.executeScript.bind(chrome.scripting);
    globalThis.__pauseBrowserFixture = { calls: [], holdRelationNumber: null, relationNumber: 0, held: false, release: null };
    chrome.scripting.executeScript = async details => {
      const operation = details.args?.[0]?.operation;
      const test = globalThis.__pauseBrowserFixture;
      if (operation) test.calls.push({ kind: operation.kind, ids: operation.ids, cursor: operation.cursor, at: Date.now() });
      const result = await original(details);
      if (operation?.kind === 'relations') {
        test.relationNumber++;
        if (test.holdRelationNumber === test.relationNumber) {
          test.held = true; await new Promise(resolve => { test.release = resolve; }); test.held = false; test.release = null;
        }
      }
      return result;
    };
  }, { themeKey, skin });
  ui = await context.newPage(); ui.on('pageerror', error => report.errors.push(error.message));
  await ui.goto(`chrome-extension://${extensionId}/index.html?tab=${tabId}`);
  await ui.locator('.language-picker select').selectOption('zh-CN');
  await ui.getByRole('button', { name: '连接 X 账号', exact: true }).first().click();
  await ui.getByText('@qa_owner', { exact: true }).waitFor();
  const setTheme = async theme => {
    await ui.locator('.appearance-button').click();
    await ui.getByTestId(theme === 'custom' ? 'theme-saved-item' : `theme-preset-${theme}`).first().click();
    await ui.getByTestId('theme-apply').click(); await ui.getByTestId('theme-dialog').waitFor({ state: 'hidden' });
    assert.equal(await ui.locator('main').getAttribute('data-theme'), theme);
  };

  for (const theme of ['minimal', 'wolf', 'custom']) for (const mode of ['manual', 'auto']) {
    await test(`${theme}-${mode}-pause-inflight-page-and-resume-without-restarting`, async () => {
      await setTheme(theme); await ui.locator('#tab-' + mode).click(); resetScenario(`${theme}-${mode}`);
      const writesBefore = fixture.writes.length;
      const gate = makeGate(entry => entry.operation === 'Following' && entry.variables.cursor === cursorAt(1));
      await startScan(); await until(() => gate.reached, 'Second page was not requested.');
      assert.equal((await snapshot()).pages, 1); assert.equal((await snapshot()).total, 2);
      await layout(theme, mode, 'scanning');
      const paused = await pauseHeld(gate); const quiet = await assertQuiet(`${theme}/${mode}`);
      await layout(theme, mode, 'paused');
      // Partly scanned rows must never enable either write path.
      assert.equal(await ui.locator('.person-row button.button-unfollow:not([disabled])').count(), 0);
      if (mode === 'auto') assert.equal(await ui.getByRole('button', { name: '预览自动处理', exact: true }).isDisabled(), true);
      await ui.getByTestId('scan-resume').click(); const completed = await waitReady(5);
      assert.deepEqual(scenario.following.map(entry => entry.cursor), [null, cursorAt(1), cursorAt(1), cursorAt(2)]);
      assert.equal(completed.pages, 3); assert.equal(fixture.writes.length, writesBefore);
      return { paused, completed, ...quiet, cursors: scenario.following.map(entry => entry.cursor) };
    });
  }

  await test('pause-during-page-wait-wakes-immediately-and-resumes-next-cursor', async () => {
    await ui.locator('#tab-manual').click(); resetScenario('page-wait');
    await startScan(); await ui.waitForFunction(() => document.querySelector('[data-testid="scan-progress"]')?.getAttribute('data-pages') === '1');
    assert.equal(scenario.following.length, 1); const at = Date.now();
    await ui.getByTestId('scan-pause').click(); await waitPaused(); const pauseLatencyMs = Date.now() - at;
    assert.ok(pauseLatencyMs < 850, `Page pacing pause took ${pauseLatencyMs} ms.`);
    const quiet = await assertQuiet('page-wait');
    await ui.getByTestId('scan-resume').click(); await waitReady(5);
    assert.deepEqual(scenario.following.map(entry => entry.cursor), [null, cursorAt(1), cursorAt(2)]);
    return { pauseLatencyMs, ...quiet };
  });

  await test('pause-during-scan-connection-retains-empty-checkpoint-and-explicit-restart-discards-it', async () => {
    resetScenario('prepare-connection');
    const gate = makeGate(entry => entry.operation === 'Viewer');
    await startScan(); await until(() => gate.reached, 'Scan preparation identity was not requested.');
    await ui.getByTestId('scan-pause').click(); gate.release(); await waitPaused(); await sleep(150);
    assert.equal(scenario.following.length, 0);
    const quiet = await assertQuiet('prepare-connection');
    await ui.getByTestId('scan-resume').click(); await waitReady(5);
    assert.deepEqual(scenario.following.map(entry => entry.cursor), [null, cursorAt(1), cursorAt(2)]);
    resetScenario('explicit-restart');
    const second = makeGate(entry => entry.operation === 'Following' && entry.variables.cursor === cursorAt(1));
    await startScan(); await pauseHeld(second);
    await ui.getByTestId('scan-restart').click(); await waitReady(5);
    assert.deepEqual(scenario.following.map(entry => entry.cursor), [null, cursorAt(1), null, cursorAt(1), cursorAt(2)]);
    return { ...quiet, restartCursors: scenario.following.map(entry => entry.cursor) };
  });

  await test('pause-second-relationship-batch-preserves-first-100-and-resumes-only-uncommitted-batch', async () => {
    resetScenario('relationship-batch', true);
    await worker.evaluate(() => { const state = globalThis.__pauseBrowserFixture; state.calls = []; state.relationNumber = 0; state.holdRelationNumber = 2; });
    await startScan();
    await until(() => worker.evaluate(() => globalThis.__pauseBrowserFixture.held), 'Second relation batch was not reached.', 20000);
    const before = await snapshot(); assert.equal(before.total, 102); assert.equal(before.checked, 100); assert.equal(before.pages, 6);
    await ui.getByTestId('scan-pause').click();
    await worker.evaluate(() => { const state = globalThis.__pauseBrowserFixture; state.holdRelationNumber = null; state.release?.(); });
    await waitPaused(); await sleep(150); const paused = await snapshot();
    assert.equal(paused.checked, 100); assert.equal(paused.total, 102);
    assert.ok(await ui.locator('.person-row button.button-unfollow').count() > 0, 'The committed first batch must remain visible.');
    assert.equal(await ui.locator('.person-row button.button-unfollow:not([disabled])').count(), 0, 'Committed results remain read-only while a scan checkpoint exists.');
    const quiet = await assertQuiet('relationship-batch');
    await ui.getByTestId('scan-resume').click(); const completed = await waitReady(102);
    const relationCalls = await worker.evaluate(() => globalThis.__pauseBrowserFixture.calls.filter(call => call.kind === 'relations').map(call => call.ids));
    assert.deepEqual(relationCalls.map(ids => ids.length), [100, 2, 2]);
    assert.deepEqual(relationCalls[1], relationCalls[2]);
    assert.equal(scenario.following.length, 6, 'Resuming relations must not restart completed Following pages.');
    return { paused, completed, relationBatchSizes: relationCalls.map(ids => ids.length), ...quiet };
  });

  await test('automatic-queue-pause-stops-before-next-synthetic-mutation', async () => {
    resetScenario('automatic-queue'); await startScan(); await waitReady(5);
    await ui.locator('#tab-auto').click();
    await ui.locator('.pacing-fields input').nth(0).fill('5');
    await ui.locator('.pacing-fields input').nth(1).fill('2');
    const before = fixture.writes.length;
    await ui.getByRole('button', { name: '预览自动处理', exact: true }).click();
    await ui.locator('dialog .button-primary').click();
    await ui.locator('.row-status.success').first().waitFor();
    assert.equal(fixture.writes.length, before + 1); assert.equal(fixture.writes.at(-1).id, fixtureIds.alice);
    await ui.getByTestId('operation-pause').click();
    await ui.getByTestId('operation-pause').waitFor({ state: 'hidden' });
    const requestCount = report.traffic.length; await sleep(6200);
    assert.equal(fixture.writes.length, before + 1, 'No second queued unfollow may run after pause.');
    assert.equal(report.traffic.length, requestCount, 'Paused automatic queue must issue no further read or write.');
    assert.equal(fixture.following.has(fixtureIds.chen), true);
    assert.equal(await ui.getByTestId('scan-resume').count(), 0, 'A mutation queue must not acquire a scan-resume action.');
    await ui.screenshot({ path: path.join(output, 'automatic-queue-paused.png'), fullPage: true }); report.screenshots.push('automatic-queue-paused.png');
    return { syntheticWrites: fixture.writes.slice(before), quietMs: 6200 };
  });

  await test('isolation-runtime-and-layout-summary', async () => {
    assert.deepEqual(report.fixtureViolations, []); assert.deepEqual(fixture.violations, []); assert.deepEqual(report.errors, []);
    assert.equal(report.layouts.length, 72);
    const storage = await worker.evaluate(() => chrome.storage.local.get(null));
    const serialized = JSON.stringify(storage);
    assert.ok(!serialized.includes('synthetic-fixture-not-a-secret') && !serialized.includes('Bearer'));
    assert.equal((await ui.locator('.footer-version').innerText()).includes('v1.2.3'), true);
    return { layouts: report.layouts.length, languages: ['zh-CN', 'fr', 'ar'], widths: [1100, 360], themes: ['minimal', 'wolf', 'custom'], modes: ['manual', 'auto'], pageErrors: 0, externalRequests: 0 };
  });
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
  if (ui && !ui.isClosed()) {
    await ui.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    report.failureText = (await ui.locator('body').innerText().catch(() => '')).slice(0, 14000);
  }
} finally {
  for (const gate of allGates) gate.release();
  if (worker) await worker.evaluate(() => globalThis.__pauseBrowserFixture?.release?.()).catch(() => {});
  if (context) await context.close();
  report.baseFixtureRequests = fixture?.requests || [];
  report.baseFixtureViolations = fixture?.violations || [];
  report.summary = { tests: report.tests.length, passed: report.tests.filter(test => test.passed).length,
    failed: report.tests.filter(test => !test.passed).length, layouts: report.layouts.length, externalRequests: report.fixtureViolations.length };
  await writeFile(path.join(output, 'scan-pause-report.json'), JSON.stringify(report, null, 2) + '\n');
}
