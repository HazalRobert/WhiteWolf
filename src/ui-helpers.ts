/** Pure presentation helpers. They never authorize an operation; the engine owns every decision. */

/** X serves larger renditions of the same profile image on its image host; the supplied URL stays the fallback. */
export function avatarSources(url: string | undefined): string[] {
  if (!url) return [];
  const larger = /^https:\/\/pbs\.twimg\.com\/profile_images\/[^?#\s]+_normal\.(?:jpe?g|png|gif|webp)$/i.test(url)
    ? url.replace(/_normal(\.[A-Za-z]+)$/, '_200x200$1') : null;
  return larger ? [larger, url] : [url];
}

/** The page adapter appends `resetAt=<ISO time>` to RATE_LIMIT diagnostics when X reported a plausible reset. */
export function rateLimitReset(error: string | null | undefined): number | null {
  const match = error?.startsWith('RATE_LIMIT:') ? /resetAt=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)/.exec(error) : null;
  const value = match ? Date.parse(match[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

/** Whole-number percentage clamped to 0–100; `null` when the denominator is unknown or zero. */
export function percent(part: number, whole: number | undefined | null): number | null {
  if (!whole || !Number.isFinite(whole) || whole <= 0 || !Number.isFinite(part)) return null;
  return Math.min(100, Math.max(0, Math.round(part / whole * 100)));
}

/**
 * Reading progress against X's reported following count. It is an estimate: the count can be stale,
 * so it never reaches 100% before pagination actually ends.
 */
export function readingEstimate(read: number, followingCount: number | undefined): number | null {
  const value = percent(read, followingCount);
  return value === null ? null : Math.min(99, value);
}

/** Commit-on-blur parsing for numeric settings: integers only, clamped, otherwise the previous value. */
export function normalizeSetting(text: string, min: number, max: number, previous: number): number {
  const value = text.trim() === '' ? NaN : Number(text);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : previous;
}

/** A typed value that is already valid may be applied immediately without clamping the draft. */
export function immediateSetting(text: string, min: number, max: number): number | null {
  if (!/^\d{1,4}$/.test(text.trim())) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}
