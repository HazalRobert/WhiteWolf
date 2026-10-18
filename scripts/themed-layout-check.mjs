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
const output = path.join(root, 'qa/themed-layout');
const executablePath = process.env.BROWSER_EXECUTABLE || chromium.executablePath();
const themeKey = 'whitewolf_themes_v1';
const languages = ['zh-CN', 'en', 'fr', 'es', 'ru', 'de', 'pt', 'ja', 'ko', 'ar'];
const report = {
  at: new Date().toISOString(),
  scope: 'Built main UI with synthetic local demo data in an isolated browser; only the exact loopback origin is allowed.',
  exclusions: ['No user browser profile', 'No real X page or account', 'No X API calls', 'No real account mutations'],
  layouts: [], screenshots: [], errors: [], assetErrors: [],
};
await mkdir(output, { recursive: true });
report.distIndexSha256 = createHash('sha256').update(await readFile(path.join(dist, 'index.html'))).digest('hex');
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    const target = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(dist, target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    const body = await readFile(target);
    response.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' })[path.extname(target)] || 'application/octet-stream');
    response.end(body);
  } catch { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 960 }, serviceWorkers: 'block' });
  const network = await restrictToLocalOrigin(context, origin);
  report.blockedRequests = network.blocked;
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) report.assetErrors.push({ status: response.status(), path: new URL(response.url()).pathname }); });
  const ready = async () => {
    await page.waitForFunction(() => !document.querySelector('.appearance-button')?.disabled && !!document.querySelector('.person-row'));
  };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.goto(origin);
  await ready();
  const fixture = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 600;
    const drawing = canvas.getContext('2d');
    const sky = drawing.createLinearGradient(0, 0, 1200, 600);
    sky.addColorStop(0, '#d8e9f2'); sky.addColorStop(.6, '#a9c3d2'); sky.addColorStop(1, '#7e9cad');
    drawing.fillStyle = sky; drawing.fillRect(0, 0, 1200, 600);
    drawing.fillStyle = '#edf6fa'; drawing.beginPath(); drawing.arc(870, 165, 70, 0, Math.PI * 2); drawing.fill();
    drawing.fillStyle = '#68899b'; drawing.beginPath(); drawing.moveTo(0, 600); drawing.lineTo(0, 420); drawing.lineTo(230, 200); drawing.lineTo(490, 470); drawing.lineTo(830, 240); drawing.lineTo(1200, 510); drawing.lineTo(1200, 600); drawing.fill();
    drawing.fillStyle = '#f5f8fa'; drawing.beginPath(); drawing.moveTo(150, 277); drawing.lineTo(230, 200); drawing.lineTo(330, 304); drawing.lineTo(260, 277); drawing.lineTo(221, 296); drawing.closePath(); drawing.fill();
    return { id: 'custom-layout-fixture', name: '雪山远景', dataUrl: canvas.toDataURL('image/png'), width: 1200, height: 600, x: 64, y: 35, zoom: 1.25, opacity: 62 };
  });
  const setTheme = async active => {
    await page.evaluate(({ key, active, fixture }) => localStorage.setItem(key, JSON.stringify({ active, custom: [fixture] })), { key: themeKey, active, fixture });
    await page.reload(); await ready();
    await page.waitForFunction(mode => document.querySelector('.app-shell')?.getAttribute('data-theme') === mode, active === fixture.id ? 'custom' : active);
    if (active !== 'minimal') await page.waitForFunction(() => {
      const image = document.querySelector('.wolf-artwork img, .custom-artwork img');
      return image?.complete && image.naturalWidth > 0;
    });
    await settle();
  };
  for (const theme of ['wolf', 'custom']) {
    await setTheme(theme === 'custom' ? fixture.id : theme);
    for (const width of [1100, 800, 520, 360]) {
      await page.setViewportSize({ width, height: 960 });
      for (const language of languages) {
        await page.locator('.language-picker select').selectOption(language);
        for (const mode of ['manual', 'auto']) {
          await page.locator('#tab-' + mode).click(); await settle();
          const layout = await page.evaluate(() => {
            const visible = element => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
            const rectangle = element => {
              if (!element) return null;
              const box = element.getBoundingClientRect();
              return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
            };
            const overlap = (first, second) => !!first && !!second && Math.min(first.right, second.right) - Math.max(first.left, second.left) > 1 && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 1;
            const controls = [...document.querySelectorAll('main button,main input,main select')].filter(visible);
            const overflowingControls = controls.filter(element => { const box = element.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1; }).map(element => element.className || element.tagName);
            const header = [...document.querySelectorAll('.app-header > *')].filter(visible).map(rectangle);
            const headerOverlap = header.some((first, index) => header.slice(index + 1).some(second => overlap(first, second)));
            const heading = rectangle(document.querySelector('.section-heading'));
            const title = rectangle(document.querySelector('.section-heading h1'));
            const scan = rectangle(document.querySelector('.section-heading .button-dark'));
            const wolf = rectangle(document.querySelector('.wolf-artwork'));
            const wolfImage = rectangle(document.querySelector('.wolf-artwork img'));
            const titleScanOverlap = overlap(title, scan);
            const wolfOverlap = overlap(title, wolf) || overlap(scan, wolf);
            const titleElement = document.querySelector('.section-heading h1');
            const titleClipped = titleElement.scrollWidth > titleElement.clientWidth + 2;
            const range = document.createRange(); range.selectNodeContents(titleElement);
            const titleLines = [...range.getClientRects()].filter(box => box.width > 0);
            const titleTextOverflow = titleLines.some(box => box.left < title.left - 2 || box.right > title.right + 2 || overlap(box, scan) || overlap(box, wolf));
            const headingOverflow = [title, scan, wolf, wolfImage].filter(Boolean).some(box => box.left < heading.left - 1 || box.right > heading.right + 1 || box.top < heading.top - 1 || box.bottom > heading.bottom + 1);
            const customFrame = rectangle(document.querySelector('.custom-artwork'));
            const customImage = rectangle(document.querySelector('.custom-artwork img'));
            const customCovers = !customFrame || (!!customImage && customImage.left <= customFrame.left + 1 && customImage.top <= customFrame.top + 1 && customImage.right >= customFrame.right - 1 && customImage.bottom >= customFrame.bottom - 1);
            const customFrameFits = !customFrame || ['left', 'right', 'top', 'bottom'].every(key => Math.abs(customFrame[key] - heading[key]) < 1);
            const fonts = [...document.querySelectorAll('main *')].filter(element => visible(element) && [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())).map(element => Number.parseFloat(getComputedStyle(element).fontSize));
            return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, direction: getComputedStyle(document.querySelector('.app-shell')).direction, overflowingControls, headerOverlap, titleScanOverlap, wolfOverlap, titleClipped, titleTextOverflow, headingOverflow, customCovers, customFrameFits, minTextPx: Math.min(...fonts), rectangles: { heading, title, scan, wolf, wolfImage, customFrame, customImage } };
          });
          const entry = { theme, width, language, mode, ...layout }; report.layouts.push(entry);
          assert.ok(layout.scrollWidth <= width + 1 && !layout.overflowingControls.length && !layout.headerOverlap && !layout.titleScanOverlap && !layout.wolfOverlap && !layout.titleClipped && !layout.titleTextOverflow && !layout.headingOverflow && layout.customCovers && layout.customFrameFits, JSON.stringify(entry));
          assert.ok(layout.minTextPx >= 14, JSON.stringify(entry));
          assert.equal(layout.direction, language === 'ar' ? 'rtl' : 'ltr');
        }
      }
    }
    console.log(`PASS ${theme}: 80 main-interface layouts`);
  }
  await page.setViewportSize({ width: 1100, height: 960 });
  await page.locator('.language-picker select').selectOption('zh-CN');
  await page.locator('#tab-manual').click();
  const capture = async (name, { dialog = false } = {}) => {
    await page.evaluate(() => scrollTo(0, 0)); await page.mouse.move(0, 0); await settle();
    const target = dialog ? page.locator('.tm-dialog') : page;
    await target.screenshot({ path: path.join(output, name + '.png'), ...(dialog ? {} : { fullPage: true }) });
    report.screenshots.push(name + '.png');
  };
  for (const theme of ['minimal', 'wolf', 'custom']) {
    await setTheme(theme === 'custom' ? fixture.id : theme);
    await capture(`zh-CN-${theme}-desktop`);
  }
  await page.locator('.appearance-button').click();
  await page.locator('.tm-dialog').waitFor({ state: 'visible' });
  await capture('zh-CN-custom-editor', { dialog: true });
  const aspectCheck = await page.evaluate(() => {
    const actual = document.querySelector('.section-heading').getBoundingClientRect();
    const preview = document.querySelector('.tm-preview-image').getBoundingClientRect();
    return { actual: actual.width / actual.height, preview: preview.width / preview.height };
  });
  report.previewAspect = aspectCheck;
  assert.ok(Math.abs(aspectCheck.actual - aspectCheck.preview) < .02, JSON.stringify(aspectCheck));
  await page.locator('.tm-close').click();
  await page.setViewportSize({ width: 360, height: 960 });
  for (const theme of ['wolf', 'custom']) { await setTheme(theme === 'custom' ? fixture.id : theme); await capture(`zh-CN-${theme}-mobile`); }
  assert.equal(report.layouts.length, 160);
  assert.deepEqual(report.errors, []); assert.deepEqual(report.assetErrors, []); network.assertIsolated();
  report.passed = true;
  console.log(JSON.stringify({ layouts: report.layouts.length, screenshots: report.screenshots, previewAspect: report.previewAspect, errors: report.errors }, null, 2));
} catch (error) { report.failure = error.stack || String(error); console.error(report.failure); process.exitCode = 1; }
finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, 'themed-layout-report.json'), JSON.stringify(report, null, 2));
}
