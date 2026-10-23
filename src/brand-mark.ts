// The WhiteWolf brand icon. The control-page header (ThemeArtwork's WolfMark) and every
// extension icon PNG (scripts/whitewolf-icons.mjs) are drawn from this one source.
const WOLF = {
  silhouette: 'M9 6 20 15h8L39 6l-2 23-13 13L11 29 9 6Z',
  face: 'm13 13 3 12 8 11 8-11 3-12-9 9h-4l-9-9Z',
  eyes: 'm14 25 6 2m14-2-6 2',
  nose: 'm21 31 3 3 3-3h-6Z',
};
// The same wolf redrawn on a 16 px grid with whole-pixel cheeks, forehead, eyes and nose;
// the outline above blurs into a blob when rasterised at 1x toolbar size.
const WOLF_16 = {
  silhouette: 'M3 2 7 5h2l4-3v7l-5 5-5-5Z',
  face: 'M4 4 7 7h2l3-3v4l-4 4-4-4Z',
  eyes: 'M4 8h2l1 1H5Zm8 0h-2l-1 1h2Z',
  nose: 'M7 10h2v1H7Z',
};
export type BrandIconVariant = 'large' | 'small' | 'pixel';
// Wolf height as a share of the tile: 71% for the header and the 48/128 px icons, 75% for
// toolbar sizes. The 16 px drawing is 12 px tall (75%).
const MARK_SCALE = { large: .95, small: 1 };
// Measured on Chrome 153 (Linux): the toolbar draws 16.png at 100% display scaling and 32.png
// at every other scaling; chrome://extensions shows 48.png at 36 and 24 CSS px.
export const ICON_VARIANTS = { 16: 'pixel', 20: 'small', 24: 'small', 32: 'small', 48: 'large', 128: 'large' } as const;

const n = (value: number) => +value.toFixed(3);

export function brandIconSvg(size: number, variant: BrandIconVariant = 'large', id = 'ww'): string {
  // Tile proportions follow the 46 px header tile: 14 px corners, a 1 px top highlight and a sheen fading out at 46%.
  const unit = size / 46, radius = 14 * unit;
  // Endpoints of CSS linear-gradient(145deg) on a square tile.
  const angle = 145 * Math.PI / 180, dx = Math.sin(angle), dy = -Math.cos(angle), half = size * (Math.abs(dx) + Math.abs(dy)) / 2;
  const [x1, y1, x2, y2] = [size / 2 - dx * half, size / 2 - dy * half, size / 2 + dx * half, size / 2 + dy * half].map(n);
  const r = n(radius), u = n(unit), low = n(radius + unit), right = n(size - radius);
  const highlight = `M0 ${low}V${r}A${r} ${r} 0 0 1 ${r} 0H${right}A${r} ${r} 0 0 1 ${size} ${r}V${low}A${r} ${r} 0 0 0 ${right} ${u}H${r}A${r} ${r} 0 0 0 0 ${low}Z`;
  const pixel = variant === 'pixel', wolf = pixel ? WOLF_16 : WOLF;
  const transform = pixel ? `scale(${n(size / 16)})` : `translate(${n(size / 2)} ${n(size / 2)}) scale(${n(size / 48 * MARK_SCALE[variant])}) translate(-24 -24)`;
  const eyes = pixel ? `<path d="${wolf.eyes}" fill="#fff"/>` : `<path d="${wolf.eyes}" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<defs><linearGradient id="${id}-tile" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="#3b8ac6"/><stop offset=".55" stop-color="#1f5f8f"/><stop offset="1" stop-color="#1b3f73"/></linearGradient>`
    + `<linearGradient id="${id}-sheen" gradientUnits="userSpaceOnUse" x1="0" y1="${u}" x2="0" y2="${n(unit + .46 * (size - 2 * unit))}"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`
    + `<rect width="${size}" height="${size}" rx="${r}" fill="url(#${id}-tile)"/>`
    + `<rect x="${u}" y="${u}" width="${n(size - 2 * unit)}" height="${n(size - 2 * unit)}" rx="${n(radius - unit)}" fill="url(#${id}-sheen)"/>`
    + `<path d="${highlight}" fill="#fff" fill-opacity=".28"/>`
    + `<g transform="${transform}"><path d="${wolf.silhouette}" fill="#fff"/><path d="${wolf.face}" fill="#2a6ea2"/>${eyes}<path d="${wolf.nose}" fill="#fff"/></g></svg>`;
}
