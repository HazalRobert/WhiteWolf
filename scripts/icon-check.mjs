import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd(), dist = path.join(root, 'dist'), output = path.join(root, 'qa/icon-1.3');
const oldIcons = process.env.OLD_ICON_DIR || null;
const executablePath = process.env.BROWSER_EXECUTABLE || chromium.executablePath();
const sizes = [16, 20, 24, 32, 48, 128];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {
  at: new Date().toISOString(),
  scope: 'Icon-only raster and manifest verification, a new isolated MV3 Chromium profile, and a local before/after visual comparison.',
  exclusions: ['No user browser profile', 'No X tab or account', 'No host permissions granted', 'No full business or theme regression'],
  tests: [], pngs: [], screenshots: [], browserErrors: [], consoleErrors: [], cspViolations: [], httpRequests: [],
};
const test = async (name, action) => {
  try { const details = await action(); report.tests.push({ name, passed: true, ...(details || {}) }); console.log('PASS ' + name); }
  catch (error) { report.tests.push({ name, passed: false, error: error.message }); throw error; }
};
await mkdir(output, { recursive: true });
const manifestBytes = await readFile(path.join(dist, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
report.manifestSha256 = digest(manifestBytes);
report.distIndexSha256 = digest(await readFile(path.join(dist, 'index.html')));
const fixtures = {}, oldFixtures = {};
let context;
try {
  await test('six-png-files-have-exact-dimensions-and-alpha-channels', async () => {
    for (const size of sizes) {
      const bytes = await readFile(path.join(dist, 'icons', size + '.png'));
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
      assert.equal(bytes.readUInt32BE(16), size); assert.equal(bytes.readUInt32BE(20), size);
      assert.equal(bytes[24], 8); assert.equal(bytes[25], 6, 'PNG must contain RGBA channels.');
      fixtures[size] = 'data:image/png;base64,' + bytes.toString('base64');
      report.pngs.push({ size, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bitDepth: bytes[24], colorType: bytes[25], bytes: bytes.length, sha256: digest(bytes) });
    }
    if (oldIcons) for (const size of [16, 32, 128]) oldFixtures[size] = 'data:image/png;base64,' + (await readFile(path.join(oldIcons, size + '.png'))).toString('base64');
    return { sizes };
  });
  await test('manifest-registers-all-six-icon-sizes-without-permission-changes', async () => {
    assert.equal(manifest.name, 'WhiteWolf'); assert.equal(manifest.version, '1.3'); assert.equal(manifest.manifest_version, 3);
    const expected = Object.fromEntries(sizes.map(size => [String(size), `icons/${size}.png`]));
    assert.deepEqual(manifest.icons, expected); assert.deepEqual(manifest.action.default_icon, expected);
    assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
    assert.equal(manifest.host_permissions, undefined); assert.deepEqual(manifest.optional_host_permissions, ['https://x.com/*']);
    return { version: manifest.version, actionIconSizes: Object.keys(manifest.action.default_icon) };
  });
  const temporaryRoot = await mkdtemp(path.join(root, 'qa-icon-extension-'));
  const extension = path.join(temporaryRoot, 'extension'), profile = path.join(temporaryRoot, 'profile');
  await cp(dist, extension, { recursive: true });
  assert.equal(digest(await readFile(path.join(extension, 'manifest.json'))), report.manifestSha256);
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, viewport: { width: 1100, height: 920 }, deviceScaleFactor: 1,
    proxy: { server: 'http://127.0.0.1:9', bypass: '' },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-background-networking'],
  });
  context.setDefaultTimeout(10000);
  const trackRequest = request => {
    if (/^https?:\/\//.test(request.url()) && !report.httpRequests.some(item => item.url === request.url() && item.method === request.method())) report.httpRequests.push({ method: request.method(), url: request.url() });
  };
  context.on('request', trackRequest);
  await context.route(/^https?:\/\//, async route => { trackRequest(route.request()); await route.abort('blockedbyclient'); });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  await page.addInitScript(() => {
    window.__iconCsp = [];
    document.addEventListener('securitypolicyviolation', event => window.__iconCsp.push({ directive: event.violatedDirective, blockedURI: event.blockedURI }));
  });
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  await page.locator('.footer-version').waitFor({ state: 'visible' });
  await test('isolated-mv3-runtime-loads-manifest-icons-and-current-version', async () => {
    const actual = await page.evaluate(async () => {
      const manifest = chrome.runtime.getManifest();
      const icons = [];
      for (const [size, source] of Object.entries(manifest.action.default_icon)) {
        const image = new Image(); image.src = chrome.runtime.getURL(source); await image.decode();
        icons.push({ size: Number(size), width: image.naturalWidth, height: image.naturalHeight, protocol: new URL(image.src).protocol });
      }
      return { id: chrome.runtime.id, version: manifest.version, manifestVersion: manifest.manifest_version, icons, permissions: await chrome.permissions.getAll(), footer: document.querySelector('.footer-version').textContent.trim(), demo: !!document.querySelector('.demo-banner') };
    });
    assert.equal(actual.id, extensionId); assert.equal(actual.version, '1.3'); assert.equal(actual.manifestVersion, 3);
    assert.equal(actual.demo, false); assert.equal(actual.footer, `WhiteWolf · v${actual.version}`);
    assert.deepEqual(actual.permissions.origins, []);
    for (const image of actual.icons) { assert.equal(image.width, image.size); assert.equal(image.height, image.size); assert.equal(image.protocol, 'chrome-extension:'); }
    report.runtime = actual;
    await page.screenshot({ path: path.join(output, 'isolated-extension-1.3.png'), fullPage: true });
    report.screenshots.push('isolated-extension-1.3.png');
    return { footer: actual.footer, loadedIcons: actual.icons.length, grantedOrigins: actual.permissions.origins };
  });
  const comparison = await context.newPage();
  await comparison.setViewportSize({ width: 1040, height: 780 });
  await test('decoded-pixels-have-transparent-corners-and-opaque-interiors', async () => {
    const pixels = await comparison.evaluate(async sources => {
      const results = [];
      for (const [expected, source] of Object.entries(sources)) {
        const image = new Image(); image.src = source; await image.decode();
        const size = Number(expected); const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
        const drawing = canvas.getContext('2d'); drawing.drawImage(image, 0, 0);
        const data = drawing.getImageData(0, 0, size, size).data;
        let transparent = 0, opaque = 0, partial = 0, white = 0;
        for (let at = 0; at < data.length; at += 4) {
          if (data[at + 3] === 0) transparent++; else if (data[at + 3] === 255) opaque++; else partial++;
          if (data[at + 3] > 200 && data[at] > 220 && data[at + 1] > 220 && data[at + 2] > 220) white++;
        }
        const corners = [0, size - 1, size * (size - 1), size * size - 1].map(index => data[index * 4 + 3]);
        results.push({ size, transparent, opaque, partial, white, corners });
      }
      return results;
    }, fixtures);
    for (const result of pixels) {
      assert.deepEqual(result.corners, [0, 0, 0, 0]); assert.ok(result.transparent > 0); assert.ok(result.opaque > result.size ** 2 * .55); assert.ok(result.white > result.size ** 2 * .15);
    }
    report.alpha = pixels;
    return { checkedSizes: pixels.map(item => item.size) };
  });
  if (oldIcons) await test('native-size-light-dark-before-after-comparison', async () => {
    const columns = [16, 20, 24, 32];
    const row = (version, values, old = false) => `<div class="row"><div class="label">${version}</div>${columns.map(size => `<div class="cell"><img data-native-size="${size}" width="${size}" height="${size}" src="${values[old && (size === 20 || size === 24) ? 32 : size]}"></div>`).join('')}</div>`;
    const panel = (title, dark) => `<section class="panel ${dark ? 'dark' : ''}"><h2>${title}</h2><div class="row headings"><span></span>${columns.map(size => `<span>${size}px</span>`).join('')}</div>${row('旧版 1.2.0', oldFixtures, true)}${row('新版 1.3', fixtures)}</section>`;
    await comparison.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;background:#f2f4f7;color:#273543;font:14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif}.sheet{padding:30px 32px;width:1040px}h1{margin:0;font-size:25px;letter-spacing:-.4px}.intro{margin:7px 0 23px;color:#5e6c79;font-size:15px}.panels{display:grid;grid-template-columns:1fr 1fr;gap:20px}.panel{padding:20px;border:1px solid #dce3e9;border-radius:14px;background:#fff}h2{font-size:16px;margin:0 0 14px}.dark{background:#292a2d;color:#edf1f4;border-color:#292a2d}.row{display:grid;grid-template-columns:108px repeat(4,1fr);align-items:center;min-height:57px;gap:6px}.headings{min-height:25px;color:#788591;font-size:13px}.dark .headings{color:#bdc7d0}.row>span,.cell{text-align:center}.cell{display:flex;align-items:center;justify-content:center;min-height:42px}.label{font-size:14px}.large{margin-top:20px;display:grid;grid-template-columns:1fr 1fr;gap:20px}.large-card{background:#fff;border:1px solid #dce3e9;border-radius:14px;padding:18px 20px}.large-title{margin:0 0 15px;font-size:16px;font-weight:600}.large-row{display:flex;align-items:center;justify-content:space-around;gap:18px}.sample{display:flex;flex-direction:column;align-items:center;gap:8px;color:#5c6c7b}.pixel{image-rendering:pixelated}.note{margin:18px 0 0;color:#626f7a;font-size:13px}.footer{margin-top:13px;border-top:1px solid #d9e2e9;padding-top:12px;color:#536474;font-size:13px}
      </style></head><body><div class="sheet"><h1>WhiteWolf · 工具栏图标对照</h1><p class="intro">上排为旧版，下排为新版。浅色与深色背景均按实际像素显示。</p><div class="panels">${panel('浅色工具栏背景', false)}${panel('深色工具栏背景', true)}</div><div class="large"><section class="large-card"><p class="large-title">128px 原始资源</p><div class="large-row"><div class="sample"><img width="128" height="128" src="${oldFixtures[128]}"><span>旧版</span></div><div class="sample"><img width="128" height="128" src="${fixtures[128]}"><span>新版</span></div></div></section><section class="large-card"><p class="large-title">16px 像素结构 · 放大 8 倍</p><div class="large-row"><div class="sample"><img class="pixel" width="128" height="128" src="${oldFixtures[16]}"><span>旧版</span></div><div class="sample"><img class="pixel" width="128" height="128" src="${fixtures[16]}"><span>新版 · 简化细节</span></div></div></section></div><p class="note">旧版没有 20 / 24px 资源，此处从旧版 32px PNG 缩放作为对照；不代表 Chrome 在每台设备上的实际资源选择。新版各尺寸均使用对应 PNG。</p><p class="footer">仅图标补丁 · 六种尺寸 16 / 20 / 24 / 32 / 48 / 128px · 本机离线渲染 · 未使用用户浏览器资料</p></div></body></html>`);
    await comparison.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
    const displayed = await comparison.locator('[data-native-size]').evaluateAll(images => images.map(image => ({ expected: Number(image.dataset.nativeSize), width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height })));
    assert.equal(displayed.length, 16);
    for (const image of displayed) { assert.equal(image.width, image.expected); assert.equal(image.height, image.expected); }
    assert.equal(await comparison.evaluate(() => devicePixelRatio), 1);
    await comparison.screenshot({ path: path.join(output, 'icon-comparison.png'), fullPage: true });
    report.screenshots.push('icon-comparison.png'); report.comparison = { backgrounds: ['#ffffff', '#292a2d'], nativeSizes: columns, devicePixelRatio: 1, oldMissingSizes: { 20: 'scaled from old 32px PNG', 24: 'scaled from old 32px PNG' } };
    return { nativeSizeImages: displayed.length, screenshot: 'icon-comparison.png' };
  });
  if (!oldIcons) { report.skipped = [{ name: 'native-size-light-dark-before-after-comparison', reason: 'Set OLD_ICON_DIR to historical icons to enable comparison.' }]; console.log('SKIP historical icon comparison: OLD_ICON_DIR is not set.'); }
  await test('no-external-requests-csp-errors-or-runtime-errors', async () => {
    report.cspViolations.push(...await page.evaluate(() => window.__iconCsp));
    assert.deepEqual(report.httpRequests, []); assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.cspViolations, []);
    assert.equal(digest(await readFile(path.join(dist, 'index.html'))), report.distIndexSha256);
    return { externalRequests: report.httpRequests.length };
  });
} catch (error) { report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1; }
finally {
  await context?.close();
  report.summary = { tests: report.tests.length, passed: report.tests.filter(item => item.passed).length, failed: report.tests.filter(item => !item.passed).length, pngs: report.pngs.length, externalRequests: report.httpRequests.length };
  report.passed = !report.failure && report.tests.length === (oldIcons ? 6 : 5) && report.summary.failed === 0;
  await writeFile(path.join(output, 'icon-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report.summary, overallPassed: report.passed, report: 'qa/icon-1.3/icon-report.json' }, null, 2));
}
