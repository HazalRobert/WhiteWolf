// Run from the dependency/build directory: node <source>/tests/theme-image-browser.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(path.resolve('package.json'));
const { buildSync } = require('esbuild');
const { chromium } = require('playwright');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const bundle = buildSync({ stdin: { contents: 'export * from "./theme-image"; export * from "./theme-store";', resolveDir: source }, bundle: true, write: false, format: 'iife', globalName: 'ThemeTest', target: 'chrome120' }).outputFiles[0].text;
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Local theme codec regression</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || chromium.executablePath(), headless: true });
  const page = await browser.newPage();
  const externalRequests = [];
  await page.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
    externalRequests.push(route.request().url()); return route.abort();
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.addScriptTag({ content: bundle });
  const results = await page.evaluate(async () => {
    const api = window.ThemeTest;
    const canvas = document.createElement('canvas'); canvas.width = 2400; canvas.height = 1200;
    const context = canvas.getContext('2d');
    context.fillStyle = '#141d29'; context.fillRect(0, 0, 2400, 1200);
    context.fillStyle = '#ffffff'; context.fillRect(1750, 350, 350, 400);
    const results = [];
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
      const source = await new Promise(resolve => canvas.toBlob(resolve, mime, 0.9));
      const file = new File([source], 'Sample landscape.png', { type: mime });
      const skin = await api.prepareThemeImage(file);
      const metadata = api.validateThemeDataUrl(skin.dataUrl);
      const validated = api.validateThemes({ active: skin.id, custom: [skin] });
      await api.saveThemes(validated);
      const loaded = await api.loadThemes();
      const reset = await api.suggestImageFocalPoint(skin.dataUrl);
      const decoded = await createImageBitmap(await (await fetch(skin.dataUrl)).blob());
      results.push({ mime, dimensions: [skin.width, skin.height], decoded: [decoded.width, decoded.height], bytes: metadata.bytes,
        focal: { x: skin.x, y: skin.y }, reset, name: skin.name, idValid: /^custom-[a-f0-9-]{36}$/.test(skin.id), persisted: JSON.stringify(loaded) === JSON.stringify(validated), outputMime: metadata.mime });
      decoded.close();
    }
    canvas.width = 1600; canvas.height = 1600;
    const noise = context.createImageData(1600, 1600);
    let seed = 12345;
    for (let index = 0; index < noise.data.length; index += 4) {
      for (let channel = 0; channel < 3; channel++) { seed = (seed * 1664525 + 1013904223) >>> 0; noise.data[index + channel] = seed >>> 24; }
      noise.data[index + 3] = 255;
    }
    context.putImageData(noise, 0, 0);
    const noisyInput = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const compressed = await api.prepareThemeImage(new File([noisyInput], 'noise.png', { type: 'image/png' }));
    const compressedMetadata = api.validateThemeDataUrl(compressed.dataUrl);
    const noisy = { inputBytes: noisyInput.size, outputBytes: compressedMetadata.bytes, width: compressed.width, height: compressed.height };
    const invalid = new File([new Uint8Array(40)], 'bad.png', { type: 'image/png' });
    let malformedCode;
    try { await api.prepareThemeImage(invalid); } catch (error) { malformedCode = error.code; }
    const incompletePng = new Uint8Array(33);
    incompletePng.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    new DataView(incompletePng.buffer).setUint32(16, 40); new DataView(incompletePng.buffer).setUint32(20, 20);
    let decodeCode;
    try { await api.prepareThemeImage(new File([incompletePng], 'truncated.png', { type: 'image/png' })); } catch (error) { decodeCode = error.code; }
    return { results, noisy, malformedCode, decodeCode, storageKeys: Object.keys(localStorage) };
  });
  assert.equal(results.results.length, 3);
  for (const item of results.results) {
    assert.deepEqual(item.dimensions, [1600, 800]);
    assert.deepEqual(item.decoded, item.dimensions);
    assert.ok(item.bytes <= 600 * 1024 && item.bytes > 0);
    assert.equal(item.outputMime, 'image/webp');
    assert.ok(item.focal.x > 65 && item.focal.x <= 100);
    assert.ok(Math.abs(item.focal.x - item.reset.x) < 3);
    assert.ok(item.persisted && item.idValid);
    assert.equal(item.name, 'Sample landscape');
  }
  assert.equal(results.malformedCode, 'THEME_IMAGE_TYPE');
  assert.equal(results.decodeCode, 'THEME_IMAGE_DECODE');
  assert.ok(results.noisy.inputBytes > 600 * 1024);
  assert.ok(results.noisy.outputBytes <= 600 * 1024);
  assert.ok(results.noisy.width <= 1600 && results.noisy.height <= 1600);
  assert.deepEqual(results.storageKeys, ['whitewolf_themes_v1']);
  assert.deepEqual(externalRequests, []);
  console.log(JSON.stringify({ passed: true, ...results, externalRequests: externalRequests.length }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
