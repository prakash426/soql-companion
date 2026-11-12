import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

for (const target of ['chrome', 'firefox']) {
  await mkdir(`dist/${target}`, { recursive: true });
  await build({
    entryPoints: ['src/popup.js'],
    bundle: true,
    format: 'esm',
    outfile: `dist/${target}/popup.js`,
    minify: true,
  });
  for (const file of ['popup.html', 'popup.css', 'sidepanel.html']) {
    await cp(`src/${file}`, `dist/${target}/${file}`);
  }
  await cp('fixtures', `dist/${target}/fixtures`, { recursive: true });
  const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
  await writeFile(`dist/${target}/manifest.json`, JSON.stringify(manifest, null, 2));
}

console.log('built dist/chrome and dist/firefox');
