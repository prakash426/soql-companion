import { soqlToSql, sqlToSoql } from './lib/convert.js';
import { validateCache } from './lib/schema-cache.js';

const $ = (id) => document.getElementById(id);

function showWarnings(lines) {
  const box = $('warnings');
  box.textContent = lines.join('\n');
  box.classList.toggle('show', lines.length > 0);
}

$('convert').addEventListener('click', async () => {
  const direction = $('direction').value;
  const dialect = $('dialect').value;
  const input = $('input').value;
  showWarnings([]);
  $('output').value = '';
  try {
    if (direction === 'soql-sql') {
      const res = await soqlToSql(input, dialect);
      $('output').value = res.sql || '';
      showWarnings(res.warnings || []);
      return;
    }
    const loaded = await loadSchema();
    const res = await sqlToSoql(input, dialect, loaded.schema);
    $('output').value = res.soql || '';
    showWarnings([...loaded.warnings, ...(res.warnings || [])]);
  } catch (err) {
    showWarnings([String((err && err.message) || err)]);
  }
});

async function loadSchema() {
  const cached = await readCachedSchema();
  if (cached) return { schema: cached, warnings: [] };
  const res = await fetch('fixtures/sample-schema.json');
  if (!res.ok) throw new Error('No org schema cached. Connect your org first.');
  return {
    schema: await res.json(),
    warnings: ['Using the bundled sample schema. Connect your org for real relationship checks.'],
  };
}

async function readCachedSchema() {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
    const got = await chrome.storage.local.get('schemaCache');
    const cache = got && got.schemaCache;
    if (cache && validateCache(cache)) return cache;
    return null;
  } catch {
    return null;
  }
}
