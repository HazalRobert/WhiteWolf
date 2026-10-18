/** Visual preferences have their own key and never read or modify account data. */
export const THEME_STORAGE_KEY = 'whitewolf_themes_v1';
export const MAX_CUSTOM_SKINS = 5;
export const MAX_THEME_IMAGE_BYTES = 600 * 1024;
export const MAX_THEME_STORAGE_BYTES = 4_200_000;
export const MAX_THEME_IMAGE_EDGE = 1600;
export const MAX_THEME_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_THEME_SOURCE_PIXELS = 40_000_000;

export type ThemeErrorCode = 'THEME_INVALID_DATA' | 'THEME_LIMIT' | 'THEME_CONFLICT' | 'THEME_STORAGE_READ' | 'THEME_STORAGE_WRITE'
  | 'THEME_IMAGE_TYPE' | 'THEME_IMAGE_SIZE' | 'THEME_IMAGE_DIMENSIONS' | 'THEME_IMAGE_DECODE' | 'THEME_IMAGE_ENCODE';
export class ThemeError extends Error {
  constructor(public readonly code: ThemeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ThemeError';
  }
}
export interface CustomSkin {
  id: string;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
  /** CSS background-position percentages. */
  x: number;
  y: number;
  zoom: number;
  opacity: number;
}
export interface ThemeState { active: 'minimal' | 'wolf' | string; custom: CustomSkin[]; }
export const defaultThemes = (): ThemeState => ({ active: 'minimal', custom: [] });

export type RasterMime = 'image/png' | 'image/jpeg' | 'image/webp';
export interface RasterMetadata { mime: RasterMime; width: number; height: number; }
const invalid = (message: string): never => { throw new ThemeError('THEME_INVALID_DATA', message); };
const ascii = (bytes: Uint8Array, start: number, value: string): boolean =>
  [...value].every((character, index) => bytes[start + index] === character.charCodeAt(0));

/** Read raster dimensions before decoding; compressed files can declare enormous canvases. */
export function readRasterMetadata(bytes: Uint8Array): RasterMetadata {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 33 && bytes[0] === 137 && ascii(bytes, 1, 'PNG\r\n\x1a\n') && view.getUint32(8) === 13 && ascii(bytes, 12, 'IHDR')) {
    return { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (offset < bytes.length && bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) break;
        return { mime: 'image/jpeg', height: view.getUint16(offset + 3), width: view.getUint16(offset + 5) };
      }
      offset += length;
    }
  }
  if (bytes.length >= 26 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) {
    const end = view.getUint32(4, true) + 8;
    if (end > bytes.length || end < 26) throw new ThemeError('THEME_IMAGE_TYPE', 'The WebP file is incomplete.');
    let offset = 12;
    while (offset + 8 <= end) {
      const length = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (start + length > end) break;
      if (ascii(bytes, offset, 'VP8X') && length >= 10) {
        const uint24 = (at: number) => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
        return { mime: 'image/webp', width: uint24(start + 4) + 1, height: uint24(start + 7) + 1 };
      }
      if (ascii(bytes, offset, 'VP8L') && length >= 5 && bytes[start] === 47) {
        return { mime: 'image/webp', width: 1 + bytes[start + 1] + ((bytes[start + 2] & 63) << 8),
          height: 1 + (bytes[start + 2] >> 6) + (bytes[start + 3] << 2) + ((bytes[start + 4] & 15) << 10) };
      }
      if (ascii(bytes, offset, 'VP8 ') && length >= 10 && bytes[start + 3] === 157 && bytes[start + 4] === 1 && bytes[start + 5] === 42) {
        return { mime: 'image/webp', width: view.getUint16(start + 6, true) & 16383, height: view.getUint16(start + 8, true) & 16383 };
      }
      offset = start + length + (length & 1);
    }
  }
  throw new ThemeError('THEME_IMAGE_TYPE', 'Use a valid JPEG, PNG, or WebP raster image.');
}

export function validateThemeDataUrl(value: unknown): RasterMetadata & { bytes: number } {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_THEME_IMAGE_BYTES / 3) * 4 + 32) {
    return invalid('A saved image exceeds the 600 KiB limit.');
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) return invalid('Saved images must be local raster data URLs.');
  const encoded = match[2];
  const count = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
  if (count < 24 || count > MAX_THEME_IMAGE_BYTES) return invalid('A saved image has an invalid size.');
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const metadata = readRasterMetadata(bytes);
    if (metadata.mime !== match[1] || metadata.width < 1 || metadata.height < 1
      || Math.max(metadata.width, metadata.height) > MAX_THEME_IMAGE_EDGE) return invalid('Saved image dimensions or type are invalid.');
    return { ...metadata, bytes: count };
  } catch { return invalid('Saved image data is invalid.'); }
}

function record(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Theme data must contain objects.');
  if (Object.keys(value).some(key => !allowed.includes(key))) return invalid('Theme data contains unsupported fields.');
  return value as Record<string, unknown>;
}
function bounded(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return invalid('A theme adjustment is outside its allowed range.');
  return value;
}
/** Validate and return a fresh, serializable snapshot. Invalid saves are never silently repaired. */
export function validateThemes(value: unknown): ThemeState {
  const input = record(value, ['active', 'custom']);
  if (!Array.isArray(input.custom)) return invalid('The custom theme list is missing.');
  if (input.custom.length > MAX_CUSTOM_SKINS) throw new ThemeError('THEME_LIMIT', 'Keep at most five custom themes.');
  const ids = new Set<string>();
  const custom = input.custom.map(raw => {
    const skin = record(raw, ['id', 'name', 'dataUrl', 'width', 'height', 'x', 'y', 'zoom', 'opacity']);
    if (typeof skin.id !== 'string' || !/^custom-[A-Za-z0-9_-]{1,80}$/.test(skin.id) || ids.has(skin.id)) return invalid('Custom theme IDs must be unique.');
    ids.add(skin.id);
    if (typeof skin.name !== 'string' || !skin.name.trim() || skin.name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(skin.name)) return invalid('Theme names must contain 1 to 80 readable characters.');
    const metadata = validateThemeDataUrl(skin.dataUrl);
    if (skin.width !== metadata.width || skin.height !== metadata.height) return invalid('Saved image dimensions do not match its data.');
    return { id: skin.id, name: skin.name.trim(), dataUrl: skin.dataUrl as string,
      width: metadata.width, height: metadata.height,
      x: bounded(skin.x, 0, 100), y: bounded(skin.y, 0, 100), zoom: bounded(skin.zoom, 1, 2), opacity: bounded(skin.opacity, 0, 100) };
  });
  if (typeof input.active !== 'string' || (!['minimal', 'wolf'].includes(input.active) && !ids.has(input.active))) return invalid('The active theme does not exist.');
  const state = { active: input.active, custom };
  if (new TextEncoder().encode(JSON.stringify(state)).length > MAX_THEME_STORAGE_BYTES) throw new ThemeError('THEME_LIMIT', 'Saved themes exceed the local theme storage budget.');
  return state;
}

export async function loadThemes(): Promise<ThemeState> {
  let value: unknown;
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) value = (await chrome.storage.local.get(THEME_STORAGE_KEY))[THEME_STORAGE_KEY];
    else {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      value = stored === null ? undefined : JSON.parse(stored);
    }
  } catch { throw new ThemeError('THEME_STORAGE_READ', 'Themes could not be read from local storage.'); }
  return value === undefined ? defaultThemes() : validateThemes(value);
}

let saveQueue: Promise<void> = Promise.resolve();
export async function saveThemes(value: ThemeState, expected?: ThemeState): Promise<void> {
  const state = validateThemes(value);
  const baseline = expected === undefined ? undefined : validateThemes(expected);
  const persist = async () => {
    if (baseline !== undefined) {
      // Read failures remain read failures; they must never turn into an empty baseline.
      const latest = await loadThemes();
      if (JSON.stringify(latest) !== JSON.stringify(baseline)) {
        throw new ThemeError('THEME_CONFLICT', 'Saved themes changed in another window. Reload them before saving.');
      }
    }
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) await chrome.storage.local.set({ [THEME_STORAGE_KEY]: state });
      else localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(state));
    } catch { throw new ThemeError('THEME_STORAGE_WRITE', 'Themes could not be saved. Local storage may be full or unavailable.'); }
  };
  const write = saveQueue.then(async () => {
    if (baseline !== undefined && typeof navigator !== 'undefined' && navigator.locks?.request) {
      await navigator.locks.request('whitewolf-theme-storage-v1', persist);
    } else await persist();
  });
  saveQueue = write.catch(() => {});
  return write;
}
