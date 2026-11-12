export const CACHE_SHAPE_VERSION = 1;

export function validateCache(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.version !== CACHE_SHAPE_VERSION) return false;
  if (!value.objects || typeof value.objects !== 'object') return false;
  return Object.values(value.objects).every((o) =>
    o && typeof o === 'object' &&
    o.fields && typeof o.fields === 'object' &&
    Array.isArray(o.lookups) && Array.isArray(o.children));
}
