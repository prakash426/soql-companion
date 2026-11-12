import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateCache, CACHE_SHAPE_VERSION } from '../src/lib/schema-cache.js';

test('shape version is 1', () => {
  expect(CACHE_SHAPE_VERSION).toBe(1);
});

test('sample fixture is a valid cache with 4 objects', () => {
  const raw = readFileSync(new URL('../fixtures/sample-schema.json', import.meta.url), 'utf8');
  const cache = JSON.parse(raw);
  expect(validateCache(cache)).toBe(true);
  expect(Object.keys(cache.objects)).toHaveLength(4);
});

test('validateCache rejects junk', () => {
  expect(validateCache(null)).toBe(false);
  expect(validateCache({})).toBe(false);
  expect(validateCache({ version: 1, objects: { A: {} } })).toBe(false);
});
