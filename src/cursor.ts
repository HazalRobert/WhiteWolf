/** X cursors are opaque tokens. Never decode, split, trim, or assume base64. */
export const isValidCursor = (value: unknown): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(value);
