import { soqlToSql, sqlToSoql } from './lib/convert.js';

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
    const res = direction === 'soql-sql'
      ? await soqlToSql(input, dialect)
      : await sqlToSoql(input, dialect, null);
    $('output').value = res.sql || '';
    showWarnings(res.warnings || []);
  } catch (err) {
    showWarnings([String((err && err.message) || err)]);
  }
});
