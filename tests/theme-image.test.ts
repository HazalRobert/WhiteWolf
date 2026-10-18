import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFocalPoint, computeCover, prepareThemeImage, suggestImageFocalPoint } from '../src/theme-image';
import { MAX_THEME_UPLOAD_BYTES, ThemeError, type ThemeErrorCode } from '../src/theme-store';

const code = (expected: ThemeErrorCode) => (error: unknown) => error instanceof ThemeError && error.code === expected;
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width); new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}
const upload = (bytes: Uint8Array, type = 'image/png', size = bytes.length) => ({ type, size, name: 'test.png', arrayBuffer: async () => bytes.buffer } as File);

test('cover geometry always covers portrait, landscape, square and zoomed containers', () => {
  for (const [iw, ih, cw, ch] of [[1600, 900, 360, 640], [600, 1200, 1200, 700], [500, 500, 100, 100], [800, 100, 300, 900]]) {
    for (const x of [0, 50, 100]) for (const y of [0, 50, 100]) for (const zoom of [1, 1.5, 2]) {
      const result = computeCover(iw, ih, cw, ch, x, y, zoom);
      assert.ok(result.width >= cw - 1e-9 && result.height >= ch - 1e-9);
      assert.ok(result.left <= 1e-9 && result.top <= 1e-9);
      assert.ok(result.left + result.width >= cw - 1e-9 && result.top + result.height >= ch - 1e-9);
      assert.ok(Math.abs(result.width / result.height - iw / ih) < 1e-9);
    }
  }
  const leftAligned = computeCover(200, 100, 100, 100, 0, 50);
  assert.equal(leftAligned.width, 200); assert.equal(leftAligned.height, 100);
  assert.equal(Math.abs(leftAligned.left), 0); assert.equal(leftAligned.scale, 1);
  assert.equal(computeCover(200, 100, 100, 100, 100, 50).left, -100);
});

test('invalid image placement never returns NaN, infinite geometry, or uncovered zoom', () => {
  for (const input of [[0, 1, 1, 1], [1, 1, Infinity, 1], [1, 1, 1, 1, -1], [1, 1, 1, 1, 50, NaN], [1, 1, 1, 1, 50, 50, 0.5]]) {
    assert.throws(() => computeCover(...input as [number, number, number, number, number?, number?, number?]), code('THEME_INVALID_DATA'));
  }
});

test('uniform and transparent images center the focal point', () => {
  const transparent = new Uint8ClampedArray(40 * 20 * 4);
  assert.deepEqual(analyzeFocalPoint({ data: transparent, width: 40, height: 20 }), { x: 50, y: 50 });
  const uniform = new Uint8ClampedArray(40 * 20 * 4).fill(128);
  assert.deepEqual(analyzeFocalPoint({ data: uniform, width: 40, height: 20 }), { x: 50, y: 50 });
});

test('local edge and contrast analysis follows an off-center detail and mirrors consistently', () => {
  function scene(mirror: boolean): Uint8ClampedArray {
    const data = new Uint8ClampedArray(80 * 40 * 4);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 80; x++) {
      const px = mirror ? 79 - x : x;
      const bright = px >= 60 && px < 72 && y >= 10 && y < 22;
      const at = (y * 80 + x) * 4;
      data[at] = data[at + 1] = data[at + 2] = bright ? 240 : 20; data[at + 3] = 255;
    }
    return data;
  }
  const right = analyzeFocalPoint({ data: scene(false), width: 80, height: 40 });
  const left = analyzeFocalPoint({ data: scene(true), width: 80, height: 40 });
  assert.ok(right.x > 70, `right focal x=${right.x}`);
  assert.ok(left.x < 30, `left focal x=${left.x}`);
  assert.ok(Math.abs(right.x + left.x - 100) <= 0.1);
  assert.ok(right.y < 50);
});

test('malformed analysis buffers reject before allocation or traversal', () => {
  assert.throws(() => analyzeFocalPoint({ data: new Uint8Array(4), width: 100, height: 100 }), code('THEME_INVALID_DATA'));
  assert.throws(() => analyzeFocalPoint({ data: new Uint8Array(0), width: 0, height: 0 }), code('THEME_INVALID_DATA'));
  assert.throws(() => analyzeFocalPoint({ data: new Uint8Array(0), width: 1_000_000, height: 1_000_000 }), code('THEME_INVALID_DATA'));
});

test('upload preflight rejects remote/vector formats, oversized files, mismatched MIME, and huge declared dimensions before decoding', async () => {
  await assert.rejects(prepareThemeImage(upload(png(10, 10), 'image/svg+xml')), code('THEME_IMAGE_TYPE'));
  await assert.rejects(prepareThemeImage(upload(png(10, 10), 'image/png', MAX_THEME_UPLOAD_BYTES + 1)), code('THEME_IMAGE_SIZE'));
  await assert.rejects(prepareThemeImage(upload(png(10, 10), 'image/jpeg')), code('THEME_IMAGE_TYPE'));
  await assert.rejects(prepareThemeImage(upload(png(10000, 10000))), code('THEME_IMAGE_DIMENSIONS'));
  await assert.rejects(prepareThemeImage(upload(png(0, 100))), code('THEME_IMAGE_DIMENSIONS'));
  await assert.rejects(prepareThemeImage(upload(new Uint8Array(33))), code('THEME_IMAGE_TYPE'));
});

test('reset focal analysis accepts only validated local raster data URLs', async () => {
  await assert.rejects(suggestImageFocalPoint('https://example.com/image.png'), code('THEME_INVALID_DATA'));
  await assert.rejects(suggestImageFocalPoint('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), code('THEME_INVALID_DATA'));
});
