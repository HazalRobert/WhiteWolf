// WhiteWolf 1.3 stability scenarios in an isolated MV3 browser with synthetic X responses only.
// No real account, cookie, X request or relationship change is involved.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixtureCursor, installXFixture } from './x-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd(), dist = path.join(root, 'dist'), output = path.join(root, 'qa/stability-1.3');
const executablePath = process.env.BROWSER_EXECUTABLE || chromium.executablePath();
const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, '1.3', 'Build v1.3 before running this script.');
const report = { at: new Date().toISOString(), scope: 'Built extension, real MV3 worker and page adapter against intercepted synthetic X responses; no real account or network.', tests: [], screenshots: [], errors: [] };
await mkdir(output, { recursive: true });

const testExtension = path.join(root, 'qa-extension-stability'), profile = path.join(root, `qa-profile-stability-${Date.now()}`);
await rm(testExtension, { recursive: true, force: true });
await cp(dist, testExtension, { recursive: true });
// Test-only copy: grant the fixture origin so automation need not click browser toolbar UI.
await writeFile(path.join(testExtension, 'manifest.json'), JSON.stringify({ ...manifest, host_permissions: ['https://x.com/*'] }));

let context, ui, xpage, fixture;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const test = async (name, body) => { await body(); report.tests.push(name); console.log('PASS', name); };
const capture = async name => { await ui.evaluate(() => scrollTo(0, 0)); await ui.mouse.move(0, 0); await ui.waitForTimeout(150); await ui.screenshot({ path: path.join(output, `${name}.png`), fullPage: true }); report.screenshots.push(`${name}.png`); };
const snapshot = () => ui.evaluate(() => {
  const progress = document.querySelector('[data-testid="scan-progress"]');
  return { phase: progress?.dataset.phase, complete: progress?.dataset.complete, pages: Number(progress?.dataset.pages || 0),
    connected: !!document.querySelector('.connected-indicator'), alert: document.querySelector('[role=alert] code')?.textContent ?? null,
    resume: !!document.querySelector('[data-testid="scan-resume"]'), rows: document.querySelectorAll('.person-row').length };
});
const followingCursors = start => fixture.requests.slice(start).filter(request => request.operation === 'Following').map(request => request.variables.cursor ?? null);
const startScan = () => ui.locator('.overview-section .section-heading button').first().click();
const waitReady = () => ui.waitForFunction(() => document.querySelector('[data-testid="scan-progress"]')?.dataset.phase === 'ready'
  && !document.querySelector('[data-testid="scan-pause"], [data-testid="scan-resume"]'), null, { timeout: 20000 });
const holdSecondPage = () => {
  const requested = deferred(), release = deferred();
  fixture.state.beforeFollowing = async variables => { if (variables.cursor === fixtureCursor) { requested.resolve(); return release.promise; } };
  return { requested, release };
};

try {
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: { width: 1100, height: 920 },
    args: [`--disable-extensions-except=${testExtension}`, `--load-extension=${testExtension}`] });
  fixture = await installXFixture(context);
  fixture.state.multiPage = true; fixture.state.followingCount = 3;
  xpage = await context.newPage(); await xpage.goto('https://x.com/home');
  let worker = context.serviceWorkers()[0]; if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://x.com/*' }))[0].id);
  ui = await context.newPage(); ui.on('pageerror', error => report.errors.push(error.message));
  await ui.goto(`chrome-extension://${extensionId}/index.html?tab=${tabId}`);
  await ui.locator('.language-picker select').selectOption('zh-CN');
  await ui.getByRole('button', { name: '连接 X 账号', exact: true }).first().click();
  await ui.getByText('@qa_owner', { exact: true }).waitFor();

  await test('in-app-x-navigation-during-a-scan-keeps-the-session-and-the-scan-completes', async () => {
    const { requested, release } = holdSecondPage(), start = fixture.requests.length;
    await startScan(); await requested.promise;
    await ui.waitForFunction(() => document.querySelector('.scan-meter-head')?.textContent?.includes('67%'));
    assert.equal(await ui.locator('.scan-tip').isVisible(), true);
    await capture('scan-progress-estimate');
    await xpage.evaluate(() => { history.pushState({}, '', '/notifications'); history.pushState({}, '', '/explore'); location.hash = 'synthetic'; });
    await ui.waitForTimeout(1500);
    const during = await snapshot();
    assert.equal(during.connected, true); assert.equal(during.alert, null); assert.equal(during.phase, 'scanning');
    release.resolve(); fixture.state.beforeFollowing = null; await waitReady();
    const done = await snapshot();
    assert.equal(done.complete, 'true'); assert.equal(done.rows, 2); assert.equal(done.alert, null);
    assert.deepEqual(followingCursors(start), [null, fixtureCursor]); assert.deepEqual(fixture.writes, []);
    // Return to the fixture document path (another same-document update) so later reloads stay inside the fixture.
    await xpage.evaluate(() => history.replaceState({}, '', '/home')); await ui.waitForTimeout(800);
    assert.equal((await snapshot()).connected, true);
  });

  await test('x-page-reload-interrupts-the-scan-and-resume-continues-from-the-uncommitted-page', async () => {
    const { requested, release } = holdSecondPage(), start = fixture.requests.length;
    await startScan(); await requested.promise;
    await xpage.reload();
    await ui.getByTestId('scan-resume').waitFor({ timeout: 15000 });
    const interrupted = await snapshot();
    assert.match(interrupted.alert ?? '', /^TAB_REQUIRED: The selected X page reloaded or navigated/);
    assert.equal(interrupted.pages, 1); assert.equal(interrupted.connected, false);
    assert.match(await ui.locator('.scan-paused-note').innerText(), /扫描已中断/);
    await capture('reload-interrupted-resumable');
    release.resolve('abort'); fixture.state.beforeFollowing = null;
    await ui.getByTestId('scan-resume').click(); await waitReady();
    const resumed = await snapshot();
    assert.equal(resumed.complete, 'true'); assert.equal(resumed.rows, 2); assert.equal(resumed.alert, null); assert.equal(resumed.connected, true);
    assert.deepEqual(followingCursors(start), [null, fixtureCursor, fixtureCursor]); assert.deepEqual(fixture.writes, []);
  });

  await test('a-rate-limited-page-shows-the-reset-time-and-resume-does-not-reread-earlier-pages', async () => {
    let limited = true, start = fixture.requests.length;
    fixture.state.resetAt = Math.floor(Date.now() / 1000) + 600;
    fixture.state.beforeFollowing = async variables => variables.cursor === fixtureCursor && limited ? 'limit' : undefined;
    await startScan();
    await ui.getByTestId('scan-resume').waitFor({ timeout: 15000 });
    const limitedState = await snapshot();
    assert.match(limitedState.alert ?? '', /^RATE_LIMIT: Following GET .*HTTP 429; resetAt=\d{4}-/);
    assert.match(await ui.locator('.error-extra').innerText(), /约 (9|10) 分钟/);
    await capture('rate-limit-reset-time');
    limited = false; fixture.state.beforeFollowing = null; start = fixture.requests.length;
    await ui.getByTestId('scan-resume').click(); await waitReady();
    assert.equal((await snapshot()).complete, 'true');
    assert.deepEqual(followingCursors(start), [fixtureCursor]); assert.deepEqual(fixture.writes, []);
  });

  await test('pacing-fields-accept-natural-typing-and-clamp-only-on-commit', async () => {
    await ui.locator('#tab-auto').click();
    const interval = ui.locator('.pacing-fields input').nth(0), limit = ui.locator('.pacing-fields input').nth(1);
    const type = async (input, text) => { await input.click(); await input.press('ControlOrMeta+A'); await input.pressSequentially(text); await input.press('Tab'); };
    await type(interval, '30'); assert.equal(await interval.inputValue(), '30');
    await type(limit, '12'); assert.equal(await limit.inputValue(), '12');
    await ui.locator('.auto-control > button').click(); await ui.locator('dialog[open]').waitFor();
    assert.match(await ui.locator('dialog .dialog-hint').first().innerText(), /30 秒/);
    await ui.locator('dialog .button-neutral').click();
    await type(interval, '3'); assert.equal(await interval.inputValue(), '5');
  });

  await test('an-automatic-run-shows-live-progress-and-the-next-pacing-countdown', async () => {
    const before = fixture.writes.length;
    await ui.locator('.auto-control > button').click(); await ui.locator('dialog[open]').waitFor();
    assert.equal(Number(await ui.locator('dialog .preview-stat strong').innerText()), 2);
    await ui.locator('dialog .button-primary').click();
    await ui.locator('.run-next').waitFor({ timeout: 15000 });
    assert.match(await ui.locator('.run-progress-head').innerText(), /已处理 1\/2/);
    await capture('automatic-run-progress');
    await ui.getByTestId('operation-pause').click();
    await ui.waitForFunction(() => !document.querySelector('[data-testid="operation-pause"]') && !document.querySelector('.run-progress'));
    assert.equal(fixture.writes.length, before + 1);
  });

  await test('an-unknown-whitelist-handle-keeps-the-connection-and-the-typed-text', async () => {
    fixture.state.notFoundScreenName = 'nobody_here';
    await ui.getByRole('button', { name: '连接 X 账号', exact: true }).first().click(); await ui.locator('.connected-indicator').waitFor();
    const input = ui.locator('.whitelist-form input');
    await input.fill('@nobody_here'); await ui.locator('.whitelist-form button').click();
    await ui.locator('[role=alert]').waitFor();
    assert.match(await ui.locator('[role=alert] code').textContent(), /^NOT_FOUND: @nobody_here/);
    assert.equal(await ui.locator('.connected-indicator').count(), 1);
    assert.equal(await input.inputValue(), '@nobody_here'); assert.equal(await ui.locator('.whitelist-chip').count(), 0);
    await capture('whitelist-not-found');
    await input.fill('@fixture_chen'); await ui.locator('.whitelist-form button').click();
    await ui.locator('.whitelist-chip').filter({ hasText: 'fixture_chen' }).waitFor();
    assert.equal(await input.inputValue(), ''); assert.equal(await ui.locator('[role=alert]').count(), 0);
  });

  await test('an-uncertain-write-can-be-rechecked-released-and-unfollowed-explicitly', async () => {
    await ui.locator('#tab-manual').click();
    const before = fixture.writes.length, chen = ui.locator('.person-row').filter({ hasText: 'Fixture Chen' });
    fixture.state.failWrite = true;
    await chen.getByRole('button', { name: '取消关注', exact: true }).click(); await ui.locator('dialog .button-danger').click();
    await chen.locator('.row-status.uncertain').waitFor({ timeout: 15000 });
    assert.match(await ui.locator('[role=alert] code').textContent(), /^UNCERTAIN:/);
    assert.equal(fixture.state.abortedWrites.length, 1); assert.equal(fixture.writes.length, before);
    await capture('uncertain-row-recheck');
    fixture.state.failWrite = false;
    await ui.getByRole('button', { name: '连接 X 账号', exact: true }).first().click(); await ui.locator('.connected-indicator').waitFor();
    await chen.getByRole('button', { name: '重新核实', exact: true }).click();
    await chen.getByRole('button', { name: '取消关注', exact: true }).waitFor({ timeout: 15000 });
    assert.equal(fixture.writes.length, before);
    await chen.getByRole('button', { name: '取消关注', exact: true }).click(); await ui.locator('dialog .button-danger').click();
    await chen.locator('.row-status.success').waitFor({ timeout: 15000 });
    assert.deepEqual(fixture.writes.slice(before), [{ action: 'unfollow', id: '103' }]);
    await ui.locator('.activity-panel > summary').click();
    assert.ok(await ui.locator('.log-result.result-rechecked').count() >= 1);
  });

  await test('isolation-and-runtime-summary', async () => {
    fixture.assertTraffic();
    assert.deepEqual(report.errors, []);
    assert.equal(fixture.writes.filter(write => write.action === 'follow').length, 0);
  });
  report.passed = true;
  console.log(JSON.stringify({ tests: report.tests.length, screenshots: report.screenshots, writes: fixture.writes, abortedWrites: fixture.state.abortedWrites }, null, 2));
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
  if (ui) await ui.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  if (fixture) report.traffic = fixture.requests.map(({ method, operation, variables }) => ({ method, operation, cursor: variables?.cursor ?? null }));
  if (context) await context.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await writeFile(path.join(output, 'stability-report.json'), JSON.stringify(report, null, 2));
}
