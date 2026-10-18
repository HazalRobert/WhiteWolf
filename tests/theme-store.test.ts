import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { defaultThemes, loadThemes, saveThemes, validateThemes, validateThemeDataUrl, readRasterMetadata,
  ThemeError, THEME_STORAGE_KEY, MAX_THEME_IMAGE_BYTES, type ThemeState, type ThemeErrorCode } from '../src/theme-store';

// Structural raster fixtures exercise header validation; browser decoding is checked separately.
function png(width = 100, height = 50): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  bytes[24] = 8; bytes[25] = 6;
  return bytes;
}
const dataUrl = (bytes = png(), mime = 'image/png') => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const state = (): ThemeState => ({ active: 'custom-test', custom: [{ id: 'custom-test', name: ' Test ', dataUrl: dataUrl(), width: 100, height: 50, x: 50, y: 50, zoom: 1, opacity: 60 }] });
const code = (expected: ThemeErrorCode) => (error: unknown) => error instanceof ThemeError && error.code === expected;
const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
const originalLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
function setGlobal(key: string, value: unknown): void { Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
afterEach(() => {
  if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome); else Reflect.deleteProperty(globalThis, 'chrome');
  if (originalLocal) Object.defineProperty(globalThis, 'localStorage', originalLocal); else Reflect.deleteProperty(globalThis, 'localStorage');
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else Reflect.deleteProperty(globalThis, 'navigator');
});

test('default and validated themes are independent snapshots with normalized names', () => {
  const first = defaultThemes(); first.active = 'wolf';
  assert.deepEqual(defaultThemes(), { active: 'minimal', custom: [] });
  const original = state(); const validated = validateThemes(original);
  assert.equal(validated.custom[0].name, 'Test');
  original.custom[0].x = 0;
  assert.equal(validated.custom[0].x, 50);
});

test('theme validation rejects missing active IDs, duplicate IDs, and a sixth custom theme', () => {
  assert.throws(() => validateThemes({ active: 'custom-missing', custom: [] }), code('THEME_INVALID_DATA'));
  const duplicate = state(); duplicate.custom.push({ ...duplicate.custom[0] });
  assert.throws(() => validateThemes(duplicate), code('THEME_INVALID_DATA'));
  const six = state(); six.custom = Array.from({ length: 6 }, (_, index) => ({ ...six.custom[0], id: `custom-${index}` }));
  assert.throws(() => validateThemes(six), code('THEME_LIMIT'));
});

test('theme validation rejects unsupported fields and unsafe or inconsistent image metadata', () => {
  assert.throws(() => validateThemes({ ...state(), account: '99' }), code('THEME_INVALID_DATA'));
  for (const replacement of [
    { dataUrl: 'https://example.com/image.png' },
    { dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    { width: 101 }, { x: -1 }, { y: 101 }, { zoom: 0.9 }, { opacity: NaN }, { name: 'bad\nname' },
  ]) {
    const value = state(); Object.assign(value.custom[0], replacement);
    assert.throws(() => validateThemes(value), code('THEME_INVALID_DATA'));
  }
  assert.throws(() => validateThemeDataUrl(dataUrl(png(), 'image/jpeg')), code('THEME_INVALID_DATA'));
  assert.throws(() => validateThemeDataUrl(dataUrl(png(1601, 1))), code('THEME_INVALID_DATA'));
  assert.throws(() => validateThemeDataUrl(dataUrl(png(0, 1))), code('THEME_INVALID_DATA'));
  const oversized = new Uint8Array(MAX_THEME_IMAGE_BYTES + 1); oversized.set(png());
  assert.throws(() => validateThemeDataUrl(dataUrl(oversized)), code('THEME_INVALID_DATA'));
});

test('raster metadata recognizes PNG, JPEG SOF, and compact WebP lossless headers', () => {
  assert.deepEqual(readRasterMetadata(png(800, 600)), { mime: 'image/png', width: 800, height: 600 });
  const jpeg = Uint8Array.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 8, 8, 0, 20, 0, 30, 1, 255, 217]);
  assert.deepEqual(readRasterMetadata(jpeg), { mime: 'image/jpeg', width: 30, height: 20 });
  const webp = Uint8Array.from([82, 73, 70, 70, 18, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76, 5, 0, 0, 0, 47, 0, 0, 0, 0, 0]);
  assert.deepEqual(readRasterMetadata(webp), { mime: 'image/webp', width: 1, height: 1 });
  assert.throws(() => readRasterMetadata(webp.slice(0, 25)), code('THEME_IMAGE_TYPE'));
  assert.throws(() => readRasterMetadata(png().slice(0, 24)), code('THEME_IMAGE_TYPE'));
  assert.throws(() => readRasterMetadata(new Uint8Array([255, 216, 255, 224, 255, 255])), code('THEME_IMAGE_TYPE'));
});

test('Chrome storage reads and writes only the theme key and leaves business data intact', async () => {
  const business = { whitelists: { '99': [{ id: '123', handle: 'saved' }] }, logs: [{ result: 'uncertain' }] };
  const saved: Record<string, unknown> = { reciprocal_data: structuredClone(business) };
  const reads: string[] = []; const writes: unknown[] = [];
  setGlobal('chrome', { storage: { local: {
    get: async (key: string) => { reads.push(key); return { [key]: saved[key] }; },
    set: async (values: Record<string, unknown>) => { writes.push(structuredClone(values)); Object.assign(saved, values); },
  } } });
  setGlobal('localStorage', { getItem: () => { throw new Error('must not read fallback'); }, setItem: () => { throw new Error('must not write fallback'); } });
  assert.deepEqual(await loadThemes(), defaultThemes());
  await saveThemes(state());
  assert.equal((await loadThemes()).custom[0].name, 'Test');
  assert.deepEqual(reads, [THEME_STORAGE_KEY, THEME_STORAGE_KEY]);
  assert.deepEqual(Object.keys(writes[0] as object), [THEME_STORAGE_KEY]);
  assert.deepEqual(saved.reciprocal_data, business);
});

test('failed Chrome storage operations never silently fall back or destroy the prior value', async () => {
  let fallbackCalls = 0;
  const before = state();
  setGlobal('chrome', { storage: { local: {
    get: async () => { throw new Error('secret internal error'); },
    set: async () => { throw new Error('quota full'); },
  } } });
  setGlobal('localStorage', { getItem: () => { fallbackCalls++; return null; }, setItem: () => { fallbackCalls++; } });
  await assert.rejects(loadThemes(), code('THEME_STORAGE_READ'));
  await assert.rejects(saveThemes(before), code('THEME_STORAGE_WRITE'));
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(before, state());
});

test('serialized writes retain their call-time snapshots and a failed write does not poison later saves', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writes: ThemeState[] = [];
  setGlobal('chrome', { storage: { local: { set: async (values: Record<string, ThemeState>) => {
    writes.push(values[THEME_STORAGE_KEY]);
    if (writes.length === 1) { await gate; throw new Error('full'); }
  } } } });
  const first = state();
  const one = saveThemes(first); const oneRejected = assert.rejects(one, code('THEME_STORAGE_WRITE'));
  first.custom[0].x = 1;
  const second = state(); second.custom[0].x = 20;
  const two = saveThemes(second); second.custom[0].x = 99;
  await Promise.resolve();
  assert.equal(writes.length, 1);
  release(); await oneRejected; await two;
  assert.deepEqual(writes.map(value => value.custom[0].x), [50, 20]);
});

test('demo storage round-trips only the theme key and rejects malformed saved states', async () => {
  setGlobal('chrome', undefined);
  const values = new Map<string, string>([['reciprocal_data', 'business-data']]);
  setGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  assert.deepEqual(await loadThemes(), defaultThemes());
  await saveThemes(state());
  assert.equal((await loadThemes()).active, 'custom-test');
  assert.equal(values.get('reciprocal_data'), 'business-data');
  values.set(THEME_STORAGE_KEY, JSON.stringify({ active: 'ghost', custom: [] }));
  await assert.rejects(loadThemes(), code('THEME_INVALID_DATA'));
  values.set(THEME_STORAGE_KEY, '{');
  await assert.rejects(loadThemes(), code('THEME_STORAGE_READ'));
});

test('a stale theme baseline rejects without overwriting newer saved custom themes', async () => {
  const latest = validateThemes(state());
  let writes = 0;
  setGlobal('navigator', {});
  setGlobal('chrome', { storage: { local: {
    get: async () => ({ [THEME_STORAGE_KEY]: structuredClone(latest) }),
    set: async () => { writes++; },
  } } });
  await assert.rejects(saveThemes({ active: 'wolf', custom: [] }, defaultThemes()), code('THEME_CONFLICT'));
  assert.equal(writes, 0);
  assert.deepEqual(await loadThemes(), latest);
});

test('concurrent saves from one baseline yield one success and one conflict', async () => {
  let saved = defaultThemes();
  let writes = 0;
  setGlobal('navigator', {});
  setGlobal('chrome', { storage: { local: {
    get: async () => ({ [THEME_STORAGE_KEY]: structuredClone(saved) }),
    set: async (values: Record<string, ThemeState>) => { writes++; saved = structuredClone(values[THEME_STORAGE_KEY]); },
  } } });
  const baseline = defaultThemes();
  const first = saveThemes({ active: 'wolf', custom: [] }, baseline);
  const second = saveThemes(state(), baseline);
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.ok(results[1].status === 'rejected' && code('THEME_CONFLICT')(results[1].reason));
  assert.equal(writes, 1);
  assert.deepEqual(saved, { active: 'wolf', custom: [] });
});

test('baseline comparison and write both execute inside the shared navigator lock', async () => {
  let locked = false;
  const locks: string[] = [];
  let saved = defaultThemes();
  setGlobal('navigator', { locks: { request: async (name: string, callback: () => Promise<void>) => {
    locks.push(name); locked = true;
    try { await callback(); } finally { locked = false; }
  } } });
  setGlobal('chrome', { storage: { local: {
    get: async () => { assert.equal(locked, true); return { [THEME_STORAGE_KEY]: structuredClone(saved) }; },
    set: async (values: Record<string, ThemeState>) => { assert.equal(locked, true); saved = structuredClone(values[THEME_STORAGE_KEY]); },
  } } });
  await saveThemes({ active: 'wolf', custom: [] }, defaultThemes());
  assert.deepEqual(locks, ['whitewolf-theme-storage-v1']);
  assert.equal(saved.active, 'wolf');
});

test('a failed baseline read remains THEME_STORAGE_READ and performs no write', async () => {
  let writes = 0;
  setGlobal('navigator', {});
  setGlobal('chrome', { storage: { local: {
    get: async () => { throw new Error('unavailable'); },
    set: async () => { writes++; },
  } } });
  await assert.rejects(saveThemes({ active: 'wolf', custom: [] }, defaultThemes()), code('THEME_STORAGE_READ'));
  assert.equal(writes, 0);
});
