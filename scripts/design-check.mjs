import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { restrictToLocalOrigin } from './x-fixture.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = process.cwd();
const executablePath = process.env.BROWSER_EXECUTABLE || chromium.executablePath();
const report = { at: new Date().toISOString(), scope: 'Rendered UI with local synthetic data only; all non-loopback network requests blocked', layouts: [], typography: {}, contrasts: [], errors: [], screenshots: [] };
await mkdir('qa/design', { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const target = path.join(root, 'dist', pathname === '/' ? 'index.html' : pathname);
    assert.ok(target.startsWith(path.join(root, 'dist')));
    const contents = await readFile(target);
    res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' })[path.extname(target)] || 'application/octet-stream');
    res.end(contents);
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(4182, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 920 } });
  const network = await restrictToLocalOrigin(page.context(), 'http://127.0.0.1:4182');
  report.blockedRequests = network.blocked;
  page.on('pageerror', e => report.errors.push(e.message));
  await page.goto('http://127.0.0.1:4182');
  await page.getByText('Alex Morgan', { exact: true }).waitFor();
  for (const width of [1100, 800, 520, 360]) {
    await page.setViewportSize({ width, height: 920 });
    for (const language of ['zh-CN', 'en', 'fr', 'es', 'ru', 'de', 'pt', 'ja', 'ko', 'ar']) {
      await page.locator('.language-picker select').selectOption(language);
      for (const mode of ['manual', 'auto']) {
        await page.locator('#tab-' + mode).click();
        const result = await page.evaluate(() => {
          const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const controls = [...document.querySelectorAll('button,input,select')].filter(visible);
          const overflowing = controls.filter(e => { const r = e.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).map(e => e.className || e.tagName);
          const header = [...document.querySelectorAll('.app-header > *')].filter(visible).map(e => e.getBoundingClientRect());
          const overlap = header.some((a, i) => header.slice(i + 1).some(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1));
          const minText = Math.min(...[...document.querySelectorAll('main *')].filter(e => visible(e) && [...e.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())).map(e => parseFloat(getComputedStyle(e).fontSize)));
          return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, overflowing, headerOverlap: overlap, minTextPx: minText };
        });
        report.layouts.push({ width, language, mode, ...result });
        assert.ok(result.scrollWidth <= width && !result.overflowing.length && !result.headerOverlap, JSON.stringify({ width, language, mode, ...result }));
        assert.ok(result.minTextPx >= 14, `Text below 14px: ${width}/${language}/${mode}`);
      }
    }
  }
  await page.setViewportSize({ width: 1100, height: 920 });
  await page.locator('.language-picker select').selectOption('zh-CN');
  await page.locator('#tab-manual').click();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200); // Measure the settled state after the 150ms button color transition.
  report.typography = await page.evaluate(() => {
    const value = s => parseFloat(getComputedStyle(document.querySelector(s)).fontSize);
    return { bodyPx: value('body'), namePx: value('.person-name a'), handlePx: value('.person-handle'), buttonPx: value('.button-unfollow'), buttonHeightPx: document.querySelector('.button-unfollow').getBoundingClientRect().height, firstRowTopPx: document.querySelector('.person-row').getBoundingClientRect().top + scrollY };
  });
  assert.ok(report.typography.namePx >= 17 && report.typography.buttonHeightPx >= 44);
  assert.ok(report.typography.firstRowTopPx < 780, 'Results should appear without excessive page chrome');
  report.contrasts = await page.evaluate(() => {
    const color = s => s.match(/[\d.]+/g).map(Number);
    const luminance = rgb => rgb.slice(0, 3).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((v, c, i) => v + c * [.2126, .7152, .0722][i], 0);
    return ['.brand-caption', '.language-picker select', '.demo-banner', '.connection-copy strong', '.eyebrow', '.section-heading h1', '.section-heading .button-dark', '.stat-label', '.stat-highlight .stat-label', '.scan-status', '.scan-status time', '.mode-tabs button.active', '.results-heading p', '.person-name a', '.person-handle', '.relationship-badge', '.button-unfollow', '.footer-note', '.author-label'].map(selector => {
      const e = document.querySelector(selector), style = getComputedStyle(e); let parent = e, bg;
      while (parent) { bg = color(getComputedStyle(parent).backgroundColor); if (bg.length < 4 || bg[3] === 1) break; parent = parent.parentElement; }
      const fg = luminance(color(style.color)), background = luminance(bg || [255, 255, 255]);
      const ratio = (Math.max(fg, background) + .05) / (Math.min(fg, background) + .05);
      return { selector, ratio: Math.round(ratio * 100) / 100 };
    });
  });
  assert.ok(report.contrasts.every(c => c.ratio >= 4.5), JSON.stringify(report.contrasts.filter(c => c.ratio < 4.5)));
  const capture = async (name, fullPage = false) => { await page.evaluate(() => scrollTo(0, 0)); await page.mouse.move(0, 0); await page.waitForTimeout(200); await page.screenshot({ path: `qa/design/${name}.png`, fullPage }); report.screenshots.push(name + '.png'); };
  await capture('manual-overview'); await capture('manual-desktop', true);
  await page.locator('.search-box input').fill('definitely_no_matching_account_123');
  assert.equal(await page.locator('.person-row').count(), 0);
  assert.ok(await page.locator('.empty-state').isVisible());
  await capture('empty-results', true);
  await page.locator('.search-box input').fill('');
  await page.locator('.button-unfollow').first().click();
  assert.ok(await page.locator('dialog').isVisible());
  await page.locator('dialog').screenshot({ path: 'qa/design/confirmation.png' }); report.screenshots.push('confirmation.png');
  await page.keyboard.press('Escape');
  await page.locator('#tab-auto').click();
  await capture('automatic-overview'); await capture('automatic-desktop', true);
  await page.locator('.language-picker select').selectOption('ar');
  await capture('arabic-desktop', true);
  await page.locator('.language-picker select').selectOption('zh-CN');
  await page.setViewportSize({ width: 520, height: 920 });
  await capture('automatic-compact', true);
  await page.setViewportSize({ width: 360, height: 800 });
  await capture('mobile-overview');
  await page.locator('.button-unfollow').first().click();
  assert.ok(await page.locator('dialog').evaluate(e => e.scrollWidth <= e.clientWidth));
  await page.locator('dialog').screenshot({ path: 'qa/design/confirmation-compact.png' }); report.screenshots.push('confirmation-compact.png');
  assert.equal(report.errors.length, 0);
  network.assertIsolated();
  report.passed = true;
  console.log(JSON.stringify({ layouts: report.layouts.length, typography: report.typography, minContrast: Math.min(...report.contrasts.map(c => c.ratio)), screenshots: report.screenshots, errors: report.errors }, null, 2));
} catch (e) { report.failure = e.stack || String(e); console.error(report.failure); process.exitCode = 1; }
finally { if (browser) await browser.close(); server.close(); await writeFile('qa/design/design-report.json', JSON.stringify(report, null, 2)); }
