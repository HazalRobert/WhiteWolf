import { MAX_THEME_IMAGE_BYTES, MAX_THEME_IMAGE_EDGE, MAX_THEME_SOURCE_PIXELS, MAX_THEME_UPLOAD_BYTES,
  ThemeError, readRasterMetadata, validateThemeDataUrl, type CustomSkin } from './theme-store';

export interface FocalPoint { x: number; y: number; }
export interface CoverGeometry { width: number; height: number; left: number; top: number; scale: number; }

/** The same geometry as CSS background-size: cover with an additional user zoom. */
export function computeCover(imageWidth: number, imageHeight: number, containerWidth: number, containerHeight: number,
  x = 50, y = 50, zoom = 1): CoverGeometry {
  if (![imageWidth, imageHeight, containerWidth, containerHeight].every(value => Number.isFinite(value) && value > 0)
    || !Number.isFinite(x) || x < 0 || x > 100 || !Number.isFinite(y) || y < 0 || y > 100
    || !Number.isFinite(zoom) || zoom < 1 || zoom > 2) {
    throw new ThemeError('THEME_INVALID_DATA', 'Image placement values are invalid.');
  }
  const scale = Math.max(containerWidth / imageWidth, containerHeight / imageHeight) * zoom;
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  if (![scale, width, height].every(Number.isFinite)) throw new ThemeError('THEME_INVALID_DATA', 'Image placement values are too large.');
  return { width, height, left: (containerWidth - width) * x / 100, top: (containerHeight - height) * y / 100, scale };
}

/** Local contrast and edge density provide a deterministic focal suggestion, without network access. */
export function analyzeFocalPoint(image: { data: Uint8ClampedArray | Uint8Array; width: number; height: number }): FocalPoint {
  const { data, width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width * height > 1_048_576 || data.length !== width * height * 4) {
    throw new ThemeError('THEME_INVALID_DATA', 'The image analysis buffer is invalid.');
  }
  const luminance = new Float64Array(width * height);
  let average = 0;
  let visible = 0;
  for (let index = 0; index < luminance.length; index++) {
    const offset = index * 4;
    luminance[index] = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
    const alpha = data[offset + 3] / 255;
    average += luminance[index] * alpha;
    visible += alpha;
  }
  if (visible === 0) return { x: 50, y: 50 };
  average /= visible;
  let total = 0;
  let sumX = 0;
  let sumY = 0;
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const index = row * width + column;
    const offset = index * 4;
    const alpha = data[offset + 3] / 255;
    if (alpha === 0) continue;
    const horizontal = Math.abs(luminance[row * width + Math.min(width - 1, column + 1)] - luminance[row * width + Math.max(0, column - 1)]);
    const vertical = Math.abs(luminance[Math.min(height - 1, row + 1) * width + column] - luminance[Math.max(0, row - 1) * width + column]);
    const contrast = Math.abs(luminance[index] - average);
    const center = 1 - Math.min(1, Math.hypot((column + 0.5) / width - 0.5, (row + 0.5) / height - 0.5) / Math.SQRT1_2);
    const weight = ((horizontal + vertical) * 1.8 + contrast * 0.4) * alpha * (0.8 + center * 0.2);
    total += weight;
    sumX += ((column + 0.5) / width) * weight;
    sumY += ((row + 0.5) / height) * weight;
  }
  if (total < 0.0001) return { x: 50, y: 50 };
  return { x: Math.round(sumX / total * 1000) / 10, y: Math.round(sumY / total * 1000) / 10 };
}

type DecodedImage = { source: CanvasImageSource; width: number; height: number; release: () => void; };

async function decodeImage(blob: Blob): Promise<DecodedImage> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    }
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.decoding = 'async';
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('decode'));
        image.src = url;
      });
      return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      throw new Error('decode');
    }
  } catch { throw new ThemeError('THEME_IMAGE_DECODE', 'The image could not be decoded.'); }
}

function checkDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_THEME_SOURCE_PIXELS) {
    throw new ThemeError('THEME_IMAGE_DIMENSIONS', 'Use an image with at most 40 million pixels.');
  }
}

function canvasFor(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new ThemeError('THEME_IMAGE_ENCODE', 'Image processing is unavailable.');
  return { canvas, context };
}

function focalFor(decoded: DecodedImage): FocalPoint {
  const scale = Math.min(1, 128 / Math.max(decoded.width, decoded.height));
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  const { canvas, context } = canvasFor(width, height);
  try {
    context.drawImage(decoded.source, 0, 0, width, height);
    return analyzeFocalPoint(context.getImageData(0, 0, width, height));
  } finally { canvas.width = 0; canvas.height = 0; }
}

async function dataUrlFor(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:image/webp;base64,${btoa(binary)}`;
}

/** Decode, suggest placement, resize and recompress locally. No source file is persisted. */
export async function prepareThemeImage(file: File, name?: string): Promise<CustomSkin> {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new ThemeError('THEME_IMAGE_TYPE', 'Choose a JPEG, PNG, or WebP image.');
  }
  if (!Number.isFinite(file.size) || file.size < 24 || file.size > MAX_THEME_UPLOAD_BYTES) {
    throw new ThemeError('THEME_IMAGE_SIZE', 'Use an image no larger than 12 MiB.');
  }
  let metadata;
  try { metadata = readRasterMetadata(new Uint8Array(await file.arrayBuffer())); }
  catch (error) {
    if (error instanceof ThemeError) throw error;
    throw new ThemeError('THEME_IMAGE_DECODE', 'The image file could not be read.');
  }
  if (metadata.mime !== file.type) throw new ThemeError('THEME_IMAGE_TYPE', 'The image contents do not match its file type.');
  checkDimensions(metadata.width, metadata.height);
  const decoded = await decodeImage(file);
  let canvas: HTMLCanvasElement | undefined;
  try {
    checkDimensions(decoded.width, decoded.height);
    const focal = focalFor(decoded);
    const scale = Math.min(1, MAX_THEME_IMAGE_EDGE / Math.max(decoded.width, decoded.height));
    let width = Math.max(1, Math.round(decoded.width * scale));
    let height = Math.max(1, Math.round(decoded.height * scale));
    const created = canvasFor(width, height);
    canvas = created.canvas;
    const context = created.context;
    for (let round = 0; round < 8; round++) {
      canvas.width = width;
      canvas.height = height;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(decoded.source, 0, 0, width, height);
      for (const quality of [0.88, 0.76, 0.64, 0.5]) {
        const blob = await new Promise<Blob | null>(resolve => canvas!.toBlob(resolve, 'image/webp', quality));
        if (!blob || blob.type !== 'image/webp') throw new ThemeError('THEME_IMAGE_ENCODE', 'This browser could not encode a WebP image.');
        if (blob.size <= MAX_THEME_IMAGE_BYTES) {
          const dataUrl = await dataUrlFor(blob);
          const title = (name ?? file.name.replace(/\.[^.]+$/, '')).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Custom theme';
          return { id: `custom-${crypto.randomUUID()}`, name: title, dataUrl, width, height, ...focal, zoom: 1, opacity: 60 };
        }
      }
      width = Math.max(1, Math.round(width * 0.75));
      height = Math.max(1, Math.round(height * 0.75));
    }
    throw new ThemeError('THEME_IMAGE_ENCODE', 'The image could not be compressed below 600 KiB.');
  } catch (error) {
    if (error instanceof ThemeError) throw error;
    throw new ThemeError('THEME_IMAGE_ENCODE', 'The image could not be processed locally.');
  } finally {
    decoded.release();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

/** Re-run the same local suggestion when the user resets image placement. */
export async function suggestImageFocalPoint(dataUrl: string): Promise<FocalPoint> {
  const metadata = validateThemeDataUrl(dataUrl);
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const decoded = await decodeImage(new Blob([bytes], { type: metadata.mime }));
  try {
    checkDimensions(decoded.width, decoded.height);
    return focalFor(decoded);
  } catch (error) {
    if (error instanceof ThemeError) throw error;
    throw new ThemeError('THEME_IMAGE_DECODE', 'The saved image could not be analyzed.');
  } finally { decoded.release(); }
}
