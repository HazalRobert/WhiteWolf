import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { restrictToLocalOrigin } from './x-fixture.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
const dist = path.resolve(root, 'dist');
const output = path.join(root, 'qa/theme');
const executablePath = process.env.BROWSER_EXECUTABLE || chromium.executablePath();
const THEME_KEY = 'whitewolf_themes_v1';
const BUSINESS_KEY = 'reciprocal_data';
const codes = ['zh-CN', 'en', 'fr', 'es', 'ru', 'de', 'pt', 'ja', 'ko', 'ar'];
const seededBusiness = {
  settings: { language: 'en', mode: 'manual', intervalSeconds: 25, batchLimit: 17 },
  whitelists: { '9000001': [{ id: '102', handle: 'studio_nora' }], '987654': [{ id: '654321', handle: 'fixture_kept' }] },
  logs: [{ at: '2026-01-01T00:00:00.000Z', actorId: '987654', targetId: '654321', handle: 'fixture_kept', action: 'unfollow', result: 'uncertain' }],
  unresolved: { '987654': ['654321'] },
};
const report = {
  at: new Date().toISOString(),
  scope: 'Built local demo UI in an isolated headless browser. All non-loopback requests are blocked. Images and business data are synthetic.',
  exclusions: ['No user browser profile', 'No actual X page or account', 'No X API calls', 'No production account actions'],
  tests: [], layouts: [], screenshots: [], errors: [], assetErrors: [], storageChecks: [],
};
await mkdir(output, { recursive: true });
report.distIndexSha256 = createHash('sha256').update(await readFile(path.join(dist, 'index.html'))).digest('hex');
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    const target = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(dist, target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Path must remain inside dist.');
    const body = await readFile(target);
    response.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' })[path.extname(target)] || 'application/octet-stream');
    response.end(body);
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page;
const test = async (name, action) => {
  const start = Date.now();
  try { const detail = await action(); report.tests.push({ name, passed: true, elapsedMs: Date.now() - start, ...(detail || {}) }); console.log('PASS ' + name); return detail; }
  catch (error) { report.tests.push({ name, passed: false, elapsedMs: Date.now() - start, error: error.message }); throw error; }
};
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 960 }, serviceWorkers: 'block' });
  const network = await restrictToLocalOrigin(context, origin);
  report.blockedRequests = network.blocked;
  await context.addInitScript(({ businessKey, business }) => {
    if (!sessionStorage.getItem('theme-check-seeded')) {
      localStorage.setItem(businessKey, JSON.stringify(business));
      localStorage.setItem('fixture_unrelated_preferences', JSON.stringify({ preserve: true, number: 73 }));
      sessionStorage.setItem('theme-check-seeded', '1');
    }
    window.__themeCheckWrites = [];
    for (const method of ['setItem', 'removeItem', 'clear']) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function (...args) {
        if (this === localStorage) window.__themeCheckWrites.push({ method, key: method === 'clear' ? '*' : String(args[0]) });
        return Reflect.apply(original, this, args);
      };
    }
  }, { businessKey: BUSINESS_KEY, business: seededBusiness });
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) report.assetErrors.push({ status: response.status(), path: new URL(response.url()).pathname }); });
  const dialog = () => page.locator('.tm-dialog');
  const open = async () => { if (!(await dialog().isVisible())) await page.locator('.appearance-button').click(); await dialog().waitFor({ state: 'visible' }); };
  const close = async () => { if (await dialog().isVisible()) await page.locator('.tm-close').click(); await dialog().waitFor({ state: 'hidden' }); };
  const ready = async () => {
    await page.locator('.appearance-button').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.appearance-button')?.disabled && document.querySelector('.person-row'));
  };
  const theme = () => page.evaluate(key => { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }, THEME_KEY);
  const storage = () => page.evaluate(key => Object.fromEntries(Object.keys(localStorage).filter(item => item !== key).sort().map(item => [item, localStorage.getItem(item)])), THEME_KEY);
  const checkStorage = async (name, expected) => {
    assert.deepEqual(await storage(), expected, 'A theme action modified non-theme storage.');
    const writes = await page.evaluate(() => window.__themeCheckWrites.splice(0));
    assert.ok(writes.every(event => event.key === THEME_KEY), 'Unexpected non-theme storage write: ' + JSON.stringify(writes));
    report.storageChecks.push({ name, unchanged: true, themeWrites: writes.length });
  };
  const mode = () => page.locator('.app-shell').getAttribute('data-theme');
  const awaitMode = async expected => page.waitForFunction(value => document.querySelector('.app-shell')?.getAttribute('data-theme') === value, expected);
  const save = async () => { await page.locator('.tm-button-primary').click(); await dialog().waitFor({ state: 'hidden' }); };
  const card = name => page.locator('.tm-saved-item').filter({ has: page.getByText(name, { exact: true }) });
  const selectPreset = async name => { await page.locator('.tm-preset').filter({ has: page.locator('.tm-preset-art-' + name) }).click(); await awaitMode(name); };
  const nameInput = () => page.locator('.tm-name-field input');
  const range = key => page.locator('.tm-slider input[id$="-' + key + '"]');
  const screenshot = async (name, { fullPage = false, manager = false } = {}) => {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(output, name + '.png'), fullPage });
    report.screenshots.push(name + '.png');
    if (manager) { await dialog().screenshot({ path: path.join(output, name + '-dialog.png') }); report.screenshots.push(name + '-dialog.png'); }
  };
  await page.goto(origin);
  await ready();
  const baselineStorage = await storage();
  assert.equal(baselineStorage[BUSINESS_KEY], JSON.stringify(seededBusiness));
  const imagePayloads = await page.evaluate(() => {
    const shapes = { landscape: [1280, 720], portrait: [720, 1280], square: [960, 960] };
    return Object.fromEntries(Object.entries(shapes).map(([name, [width, height]]) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      const gradient = context.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#153d60'); gradient.addColorStop(0.58, '#5caaad'); gradient.addColorStop(1, '#f4d9a5');
      context.fillStyle = gradient; context.fillRect(0, 0, width, height);
      context.fillStyle = '#fff4dc'; context.beginPath(); context.arc(width * .72, height * .33, Math.min(width, height) * .13, 0, Math.PI * 2); context.fill();
      context.fillStyle = '#163f55'; context.beginPath(); context.moveTo(0, height); context.lineTo(width * .25, height * .55); context.lineTo(width * .5, height * .8); context.lineTo(width * .85, height * .5); context.lineTo(width, height); context.fill();
      return [name, { base64: canvas.toDataURL('image/png').split(',')[1], width, height }];
    }));
  });
  report.syntheticImages = Object.fromEntries(Object.entries(imagePayloads).map(([name, image]) => [name, { width: image.width, height: image.height, bytes: Buffer.byteLength(image.base64, 'base64') }]));
  const upload = async shape => {
    await open();
    await page.locator('.tm-file-input').setInputFiles({ name: `fixture-${shape}.png`, mimeType: 'image/png', buffer: Buffer.from(imagePayloads[shape].base64, 'base64') });
    await nameInput().waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.tm-name-field input')?.disabled && !document.querySelector('.tm-working'));
  };
  const reload = async expectedMode => { await checkStorage('before-reload', baselineStorage); await page.reload(); await ready(); await awaitMode(expectedMode); await checkStorage('after-reload', baselineStorage); };

  await test('default-minimal-and-business-baseline', async () => {
    assert.equal(await mode(), 'minimal'); assert.equal(await theme(), null);
    await checkStorage('initial', baselineStorage); await screenshot('minimal', { fullPage: true });
  });
  await test('wolf-preview-cancel-does-not-save', async () => {
    await open(); await selectPreset('wolf'); assert.equal(await theme(), null);
    await close(); assert.equal(await mode(), 'minimal'); assert.equal(await theme(), null);
    await checkStorage('wolf-preview-cancel', baselineStorage);
  });
  await test('wolf-apply-and-reload-persists', async () => {
    await open(); await selectPreset('wolf'); await save();
    assert.equal((await theme()).active, 'wolf'); await reload('wolf');
    await page.waitForFunction(() => { const image = document.querySelector('.wolf-artwork img'); return image?.complete && image.naturalWidth > 0; });
    await screenshot('wolf', { fullPage: true });
  });
  await test('invalid-image-type-has-readable-error', async () => {
    await open(); const before = await theme();
    await page.locator('.tm-file-input').setInputFiles({ name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from('Not a raster image') });
    await page.locator('.tm-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('.tm-error').innerText(), /unsupported image format/i);
    assert.deepEqual(await theme(), before); await checkStorage('invalid-image', baselineStorage);
  });
  await test('landscape-upload-empty-name-error-and-save', async () => {
    await upload('landscape'); await nameInput().fill(''); await page.locator('.tm-button-primary').click();
    await page.locator('.tm-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.tm-error').innerText(), 'Enter a theme name.');
    assert.equal((await theme()).custom.length, 0);
    await nameInput().fill('Fixture Landscape'); await screenshot('editor', { manager: true });
    await save(); const stored = await theme();
    assert.equal(stored.custom.length, 1); assert.equal(stored.custom[0].name, 'Fixture Landscape');
    assert.ok(stored.custom[0].width > stored.custom[0].height);
    assert.match(stored.custom[0].dataUrl, /^data:image\/webp;base64,/);
    await reload('custom'); await screenshot('custom', { fullPage: true });
  });
  let editedId;
  await test('custom-sliders-drag-save-and-save-as', async () => {
    await open(); await card('Fixture Landscape').click();
    const previous = (await theme()).custom[0]; editedId = previous.id;
    for (const key of ['x', 'y', 'zoom', 'opacity']) {
      await range(key).focus(); await range(key).press('Home');
      for (let step = 0; step < 3; step++) await range(key).press('ArrowRight');
    }
    const beforeDrag = { x: Number(await range('x').inputValue()), y: Number(await range('y').inputValue()) };
    await page.locator('.tm-preview-image').scrollIntoViewIfNeeded();
    const box = await page.locator('.tm-preview-image').boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + box.width * .55, box.y + box.height * .55); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .45, box.y + box.height * .35, { steps: 8 }); await page.mouse.up();
    const afterDrag = { x: Number(await range('x').inputValue()), y: Number(await range('y').inputValue()) };
    assert.notDeepEqual(afterDrag, beforeDrag, 'Dragging must update at least one focal coordinate.');
    assert.ok(Object.values(afterDrag).every(value => value >= 0 && value <= 100));
    await save(); let stored = await theme(); assert.equal(stored.custom.length, 1); assert.equal(stored.custom[0].id, editedId);
    assert.notDeepEqual([stored.custom[0].x, stored.custom[0].y, stored.custom[0].zoom, stored.custom[0].opacity], [previous.x, previous.y, previous.zoom, previous.opacity]);
    const edited = structuredClone(stored.custom[0]);
    await open(); await card('Fixture Landscape').click(); await nameInput().fill('Fixture Copy');
    await page.locator('.tm-footer').getByRole('button', { name: 'Save as', exact: true }).click(); await dialog().waitFor({ state: 'hidden' });
    stored = await theme(); assert.equal(stored.custom.length, 2);
    assert.deepEqual(stored.custom.find(item => item.id === editedId), edited, 'Save as must preserve the source theme.');
    assert.notEqual(stored.custom.find(item => item.name === 'Fixture Copy').id, editedId);
    await checkStorage('edit-save-save-as', baselineStorage); return { beforeDrag, afterDrag };
  });
  await test('portrait-and-square-real-file-input-uploads', async () => {
    for (const shape of ['portrait', 'square']) {
      await upload(shape); await nameInput().fill('Fixture ' + shape); await save();
      const item = (await theme()).custom.find(candidate => candidate.name === 'Fixture ' + shape); assert.ok(item);
      assert.ok(shape === 'portrait' ? item.height > item.width : item.height === item.width);
    }
    assert.equal((await theme()).custom.length, 4); await reload('custom');
  });
  await test('five-theme-limit-preserves-saved-themes', async () => {
    await open(); await card('Fixture Landscape').click(); await nameInput().fill('Fixture Fifth');
    await page.locator('.tm-footer').getByRole('button', { name: 'Save as', exact: true }).click(); await dialog().waitFor({ state: 'hidden' });
    const before = await theme(); assert.equal(before.custom.length, 5);
    await open(); assert.equal(await page.locator('.tm-new-button').isDisabled(), true);
    await page.locator('.tm-file-input').setInputFiles({ name: 'sixth.png', mimeType: 'image/png', buffer: Buffer.from(imagePayloads.square.base64, 'base64') });
    await page.locator('.tm-error').waitFor({ state: 'visible' });
    assert.match(await page.locator('.tm-error').innerText(), /up to 5 custom themes/i);
    assert.deepEqual(await theme(), before); await checkStorage('five-theme-limit', baselineStorage);
  });
  await test('delete-requires-confirmation-and-preserves-other-themes', async () => {
    await card('Fixture Copy').click(); const before = await theme();
    await page.locator('.tm-delete-button').click(); assert.deepEqual(await theme(), before);
    await page.locator('.tm-delete-confirm').getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(await theme(), before);
    await page.locator('.tm-delete-button').click();
    await page.locator('.tm-delete-confirm').getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).custom.length === 4, THEME_KEY);
    const after = await theme();
    assert.deepEqual(after.custom, before.custom.filter(item => item.name !== 'Fixture Copy'));
    await close(); await checkStorage('confirmed-delete', baselineStorage);
  });
  await test('auto-crop-reset-and-minimal-retain-custom-library', async () => {
    await open(); await card('Fixture Landscape').click();
    await page.locator('.tm-editor-tools').getByRole('button', { name: 'Auto crop', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.tm-working'));
    const crop = { x: Number(await range('x').inputValue()), y: Number(await range('y').inputValue()) };
    await page.locator('.tm-adjustments-heading button').click();
    await page.waitForFunction(() => !document.querySelector('.tm-working'));
    assert.equal(Number(await range('zoom').inputValue()), 1); assert.equal(Number(await range('opacity').inputValue()), 60);
    assert.equal(Number(await range('x').inputValue()), crop.x); assert.equal(Number(await range('y').inputValue()), crop.y);
    await save(); const before = await theme(); assert.equal(before.custom.length, 4);
    await open(); await selectPreset('minimal'); await save();
    assert.deepEqual((await theme()).custom, before.custom); await reload('minimal');
    return { focalPoint: crop, savedThemeCount: before.custom.length };
  });

  await test('theme-read-failure-locks-appearance-and-retry-preserves-customs', async () => {
    const savedThemes = await theme();
    const faultContext = await browser.newContext({ viewport: { width: 1100, height: 960 }, serviceWorkers: 'block' });
    const faultNetwork = await restrictToLocalOrigin(faultContext, origin);
    const faultPage = await faultContext.newPage();
    faultPage.on('pageerror', error => report.errors.push(error.message));
    try {
      await faultContext.addInitScript(({ themeKey, themeState, businessKey, business }) => {
        const read = Storage.prototype.getItem, write = Storage.prototype.setItem;
        write.call(localStorage, themeKey, JSON.stringify(themeState));
        write.call(localStorage, businessKey, JSON.stringify(business));
        window.__themeReadFault = true;
        window.__themeFaultWrites = [];
        window.__themeRawRead = () => read.call(localStorage, themeKey);
        Storage.prototype.getItem = function (key) {
          if (this === localStorage && String(key) === themeKey && window.__themeReadFault) throw new DOMException('Synthetic theme read failure', 'SecurityError');
          return read.call(this, key);
        };
        Storage.prototype.setItem = function (key, value) {
          if (this === localStorage) window.__themeFaultWrites.push(String(key));
          return write.call(this, key, value);
        };
      }, { themeKey: THEME_KEY, themeState: savedThemes, businessKey: BUSINESS_KEY, business: seededBusiness });
      await faultPage.goto(origin);
      await faultPage.locator('.theme-load-error').waitFor({ state: 'visible' });
      assert.equal(await faultPage.locator('.appearance-button').isDisabled(), true);
      assert.deepEqual(await faultPage.evaluate(() => JSON.parse(window.__themeRawRead())), savedThemes);
      assert.deepEqual(await faultPage.evaluate(() => window.__themeFaultWrites), []);
      await faultPage.screenshot({ path: path.join(output, 'load-error.png'), fullPage: false }); report.screenshots.push('load-error.png');
      await faultPage.evaluate(() => { window.__themeReadFault = false; });
      await faultPage.locator('.theme-load-error').getByRole('button', { name: 'Retry', exact: true }).click();
      await faultPage.waitForFunction(() => !document.querySelector('.appearance-button')?.disabled && !document.querySelector('.theme-load-error'));
      await faultPage.locator('.appearance-button').click();
      await faultPage.locator('.tm-dialog').waitFor({ state: 'visible' });
      assert.equal(await faultPage.locator('.tm-saved-item').count(), savedThemes.custom.length);
      assert.deepEqual(await faultPage.evaluate(() => JSON.parse(window.__themeRawRead())), savedThemes);
      assert.deepEqual(await faultPage.evaluate(() => window.__themeFaultWrites), []);
      assert.deepEqual(await faultPage.evaluate(key => JSON.parse(localStorage.getItem(key)), BUSINESS_KEY), seededBusiness);
      faultNetwork.assertIsolated();
      report.storageChecks.push({ name: 'read-fault-and-retry', unchanged: true, themeWrites: 0 });
      return { retainedThemes: savedThemes.custom.length, storageWrites: 0 };
    } catch (error) {
      await faultPage.screenshot({ path: path.join(output, 'load-error-failure.png'), fullPage: false }); report.screenshots.push('load-error-failure.png');
      throw error;
    } finally {
      report.blockedRequests.push(...faultNetwork.blocked);
      await faultContext.close();
    }
  });

  await test('ten-language-dialog-and-editor-layouts', async () => {
    for (const width of [1100, 800, 520, 360]) {
      await page.setViewportSize({ width, height: 960 });
      for (const language of codes) {
        await close();
        await page.locator('.language-picker select').selectOption(language);
        await page.waitForFunction(({ key, language }) => JSON.parse(localStorage.getItem(key)).settings.language === language, { key: BUSINESS_KEY, language });
        const languageBaseline = await storage();
        const expectedBusiness = structuredClone(seededBusiness); expectedBusiness.settings.language = language;
        assert.deepEqual(JSON.parse(languageBaseline[BUSINESS_KEY]), expectedBusiness, 'Language selection changed unrelated business state.');
        await page.evaluate(() => window.__themeCheckWrites.splice(0));
        await open();
        for (const view of ['presets', 'editor']) {
          if (view === 'editor') await card('Fixture Landscape').click();
          const layout = await page.evaluate(() => {
            const root = document.querySelector('.tm-dialog'); const bounds = root.getBoundingClientRect();
            const visible = element => { const box = element.getBoundingClientRect(), style = getComputedStyle(element); return box.width > 1 && box.height > 1 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0; };
            const label = element => (element.className || element.tagName) + ': ' + (element.textContent || '').trim().slice(0, 70);
            const controls = [...root.querySelectorAll('button,input,select')].filter(visible);
            const overflowingControls = controls.filter(element => { const box = element.getBoundingClientRect(); return box.left < bounds.left - 1 || box.right > bounds.right + 1; }).map(label);
            const textElements = [...root.querySelectorAll('*')].filter(element => visible(element) && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()));
            const fontSizes = textElements.map(element => ({ label: label(element), size: Number.parseFloat(getComputedStyle(element).fontSize) }));
            const tinyText = fontSizes.filter(item => item.size < 14);
            const clippedText = [...root.querySelectorAll('button,p,h2,h3,label')].filter(element => visible(element) && element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 2).map(label);
            const unresolvedText = /\{[A-Za-z][A-Za-z0-9_]*\}|errorFileType|brandDescriptor|themeIntro/.test(root.innerText);
            return { viewportWidth: innerWidth, pageScrollWidth: document.documentElement.scrollWidth, dialogWidth: bounds.width, dialogLeft: bounds.left, dialogRight: bounds.right, dialogScrollWidth: root.scrollWidth, dialogClientWidth: root.clientWidth, direction: getComputedStyle(root).direction, minTextPx: Math.min(...fontSizes.map(item => item.size)), overflowingControls, tinyText, clippedText, unresolvedText };
          });
          report.layouts.push({ width, language, view, ...layout });
          assert.ok(layout.pageScrollWidth <= width + 1 && layout.dialogLeft >= -1 && layout.dialogRight <= width + 1 && layout.dialogScrollWidth <= layout.dialogClientWidth + 1 && !layout.overflowingControls.length && !layout.clippedText.length, JSON.stringify({ width, language, view, ...layout }));
          assert.equal(layout.tinyText.length, 0, JSON.stringify({ width, language, view, tinyText: layout.tinyText }));
          assert.equal(layout.direction, language === 'ar' ? 'rtl' : 'ltr'); assert.equal(layout.unresolvedText, false);
          if (width === 360 && language === 'zh-CN' && view === 'editor') { await page.locator('.tm-editor').scrollIntoViewIfNeeded(); await screenshot('mobile', { manager: true }); }
          if (width === 520 && language === 'ar' && view === 'editor') { await page.locator('.tm-editor').scrollIntoViewIfNeeded(); await screenshot('arabic', { manager: true }); }
        }
        await close(); await checkStorage(`layout-${width}-${language}`, languageBaseline);
      }
    }
    assert.equal(report.layouts.length, 80); return { layouts: report.layouts.length };
  });
  await test('network-and-browser-clean', async () => {
    network.assertIsolated(); assert.deepEqual(report.errors, []); assert.deepEqual(report.assetErrors, []);
  });
  report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1;
  if (page) try { await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: false }); report.screenshots.push('failure.png'); } catch { /* Browser may already be gone. */ }
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  report.summary = { tests: report.tests.length, passed: report.tests.filter(item => item.passed).length, failed: report.tests.filter(item => !item.passed).length, layouts: report.layouts.length, storageChecks: report.storageChecks.length };
  await writeFile(path.join(output, 'theme-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report.summary, overallPassed: !!report.passed, report: 'qa/theme/theme-report.json' }, null, 2));
}
