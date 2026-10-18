import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
const dist = path.join(root, 'dist');
const qa = path.join(root, 'qa');
const executablePath = process.env.BROWSER_EXECUTABLE || chromium.executablePath();
const themeKey = 'whitewolf_themes_v1';
const businessKey = 'reciprocal_data';
const fallbackSentinel = 'fixture-invalid-localStorage-theme-must-not-be-read-or-written';
const business = {
  settings: { language: 'en', mode: 'manual', intervalSeconds: 25, batchLimit: 17 },
  whitelists: { '987654': [{ id: '654321', handle: 'fixture_kept' }] },
  logs: [{ at: '2026-01-01T00:00:00.000Z', actorId: '987654', targetId: '654321', handle: 'fixture_kept', action: 'unfollow', result: 'uncertain' }],
  unresolved: { '987654': ['654321'] },
};
const report = {
  at: new Date().toISOString(),
  scope: 'Unmodified built MV3 extension in a new isolated Chromium profile; real chrome.storage.local and extension CSP; synthetic local PNG only.',
  exclusions: ['No user browser profile', 'No X tab or account', 'No host permissions granted', 'No X or external API calls'],
  tests: [], browserErrors: [], consoleErrors: [], cspViolations: [], httpRequests: [], storageChecks: [],
};
const digest = value => createHash('sha256').update(value).digest('hex');
const test = async (name, action) => {
  try { const details = await action(); report.tests.push({ name, passed: true, ...(details || {}) }); console.log('PASS ' + name); }
  catch (error) { report.tests.push({ name, passed: false, error: error.message }); throw error; }
};
await mkdir(qa, { recursive: true });
const temporaryRoot = await mkdtemp(path.join(root, 'qa-theme-extension-'));
const extension = path.join(temporaryRoot, 'extension');
const profile = path.join(temporaryRoot, 'profile');
await cp(dist, extension, { recursive: true });
const manifestBytes = await readFile(path.join(dist, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
report.manifestSha256 = digest(manifestBytes);
report.distIndexSha256 = digest(await readFile(path.join(dist, 'index.html')));
let context, page;
try {
  assert.equal(digest(await readFile(path.join(extension, 'manifest.json'))), report.manifestSha256);
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'self'");
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, viewport: { width: 1100, height: 920 },
    // Even worker/background HTTP must fail closed; extension resources never use this proxy.
    proxy: { server: 'http://127.0.0.1:9', bypass: '' },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-background-networking'],
  });
  context.setDefaultTimeout(10000);
  await context.route(/^https?:\/\//, async route => {
    report.httpRequests.push({ method: route.request().method(), url: route.request().url() });
    await route.abort('blockedbyclient');
  });
  context.on('request', request => {
    if (/^https?:\/\//.test(request.url()) && !report.httpRequests.some(item => item.url === request.url() && item.method === request.method())) {
      report.httpRequests.push({ method: request.method(), url: request.url() });
    }
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.addInitScript(() => {
    window.__themeCspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.__themeCspViolations.push({ directive: event.violatedDirective, blockedURI: event.blockedURI }));
  });
  const url = `chrome-extension://${extensionId}/index.html`;
  const ready = async () => {
    await page.locator('.appearance-button').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.appearance-button')?.disabled);
  };
  const open = async () => { await page.locator('.appearance-button').click(); await page.locator('.tm-dialog').waitFor({ state: 'visible' }); };
  const save = async () => { await page.locator('.tm-button-primary').click(); await page.locator('.tm-dialog').waitFor({ state: 'hidden' }); };
  const theme = () => page.evaluate(async key => (await chrome.storage.local.get(key))[key], themeKey);
  const otherStorage = () => page.evaluate(async key => Object.fromEntries(Object.entries(await chrome.storage.local.get(null)).filter(([name]) => name !== key)), themeKey);
  const checkCsp = async () => { report.cspViolations.push(...await page.evaluate(() => window.__themeCspViolations.splice(0))); };
  await page.goto(url); await ready();
  await page.evaluate(async ({ businessKey, business, themeKey, fallbackSentinel }) => {
    await chrome.storage.local.set({ [businessKey]: business, fixture_unrelated_preferences: { preserve: true, number: 73 } });
    localStorage.setItem(themeKey, fallbackSentinel);
  }, { businessKey, business, themeKey, fallbackSentinel });
  await checkCsp(); await page.reload(); await ready();
  const baseline = await otherStorage();
  assert.deepEqual(baseline[businessKey], business);
  const preserve = async name => {
    assert.deepEqual(await otherStorage(), baseline, 'Theme action modified non-theme chrome.storage.local values.');
    assert.equal(await page.evaluate(key => localStorage.getItem(key), themeKey), fallbackSentinel, 'Theme operation used the demo localStorage branch.');
    report.storageChecks.push({ name, businessUnchanged: true, localStorageFallbackUnused: true });
    await checkCsp();
  };
  await test('unmodified-mv3-extension-csp-and-chrome-storage-runtime', async () => {
    const actual = await page.evaluate(async () => ({ id: chrome.runtime.id, manifest: chrome.runtime.getManifest(), permissions: await chrome.permissions.getAll(), moduleScripts: [...document.querySelectorAll('script[type="module"]')].map(item => item.src), demo: !!document.querySelector('.demo-banner') }));
    assert.equal(actual.id, extensionId); assert.equal(actual.manifest.manifest_version, 3);
    assert.deepEqual(actual.manifest.content_security_policy, manifest.content_security_policy);
    assert.deepEqual(actual.permissions.origins, []);
    assert.ok(actual.moduleScripts.length > 0 && actual.moduleScripts.every(source => source.startsWith(`chrome-extension://${extensionId}/`)));
    assert.equal(await page.locator('.app-shell').getAttribute('data-theme'), 'minimal');
    assert.equal(await theme(), undefined);
    await preserve('initial-extension-load');
    return { runtime: 'chrome-extension', manifestVersion: 3, grantedHostOrigins: actual.permissions.origins, moduleScripts: actual.moduleScripts.length };
  });
  await test('wolf-apply-and-reload-uses-chrome-storage', async () => {
    await open(); await page.locator('.tm-preset').filter({ has: page.locator('.tm-preset-art-wolf') }).click(); await save();
    assert.equal((await theme()).active, 'wolf'); await preserve('wolf-saved');
    await page.reload(); await ready();
    await page.waitForFunction(() => document.querySelector('.app-shell')?.getAttribute('data-theme') === 'wolf' && document.querySelector('.wolf-artwork img')?.complete && document.querySelector('.wolf-artwork img')?.naturalWidth > 0);
    assert.equal((await theme()).active, 'wolf'); await preserve('wolf-reloaded');
  });
  await test('real-png-upload-custom-save-and-reload-under-extension-csp', async () => {
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const drawing = canvas.getContext('2d');
      const gradient = drawing.createLinearGradient(0, 0, 1280, 720); gradient.addColorStop(0, '#244d6b'); gradient.addColorStop(1, '#b9d9c9');
      drawing.fillStyle = gradient; drawing.fillRect(0, 0, 1280, 720);
      drawing.fillStyle = '#ffedc0'; drawing.beginPath(); drawing.arc(900, 220, 100, 0, 2 * Math.PI); drawing.fill();
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await open();
    await page.locator('.tm-file-input').setInputFiles({ name: 'extension-fixture.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.locator('.tm-name-field input').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.tm-name-field input')?.disabled && !document.querySelector('.tm-working'));
    await page.locator('.tm-name-field input').fill('MV3 persisted fixture'); await save();
    const saved = await theme(); assert.equal(saved.custom.length, 1); assert.equal(saved.custom[0].name, 'MV3 persisted fixture'); assert.equal(saved.active, saved.custom[0].id);
    assert.match(saved.custom[0].dataUrl, /^data:image\/webp;base64,/); await preserve('custom-saved');
    await page.reload(); await ready();
    await page.waitForFunction(() => document.querySelector('.app-shell')?.getAttribute('data-theme') === 'custom' && document.querySelector('.custom-artwork img')?.complete && document.querySelector('.custom-artwork img')?.naturalWidth > 0);
    assert.deepEqual(await theme(), saved); await preserve('custom-reloaded');
    const image = await page.locator('.custom-artwork img').evaluate(item => ({ complete: item.complete, width: item.naturalWidth, height: item.naturalHeight, dataImage: item.src.startsWith('data:image/webp;base64,') }));
    assert.equal(image.dataImage, true); assert.equal(image.width, saved.custom[0].width); assert.equal(image.height, saved.custom[0].height);
    await page.screenshot({ path: path.join(qa, 'theme-extension-custom.png'), fullPage: true });
    report.screenshot = 'theme-extension-custom.png';
    return { inputBytes: Buffer.byteLength(png, 'base64'), storedBytes: Buffer.byteLength(saved.custom[0].dataUrl.split(',')[1], 'base64'), image };
  });
  await test('no-external-traffic-csp-errors-or-business-storage-changes', async () => {
    await preserve('final'); assert.deepEqual(report.httpRequests, []); assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.cspViolations, []);
    assert.deepEqual((await page.evaluate(() => chrome.permissions.getAll())).origins, []);
    assert.equal(digest(await readFile(path.join(extension, 'manifest.json'))), report.manifestSha256);
  });
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
  if (page) { try { await page.screenshot({ path: path.join(qa, 'theme-extension-failure.png'), fullPage: true }); } catch {} }
} finally {
  await context?.close();
  report.summary = { tests: report.tests.length, passed: report.tests.filter(item => item.passed).length, failed: report.tests.filter(item => !item.passed).length, storageChecks: report.storageChecks.length, externalRequests: report.httpRequests.length };
  report.passed = !report.failure && report.tests.length === 4 && report.summary.failed === 0;
  await writeFile(path.join(qa, 'theme-extension-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report.summary, overallPassed: report.passed, report: 'qa/theme-extension-report.json' }, null, 2));
}
