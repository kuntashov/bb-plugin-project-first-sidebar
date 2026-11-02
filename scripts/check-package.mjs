import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(manifest.name, 'bb-plugin-project-first-sidebar');
assert.notEqual(manifest.private, true);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
if (process.env.GITHUB_REF?.startsWith('refs/tags/')) {
  assert.equal(process.env.GITHUB_REF.slice('refs/tags/'.length), `v${manifest.version}`, 'Tag must match package version');
}
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish', 'prepublishOnly']) {
  assert.equal(manifest.scripts[hook], undefined, `Unexpected lifecycle hook: ${hook}`);
}
for (const name of ['server', 'app']) {
  const meta = JSON.parse(readFileSync(`dist/${name}.meta.json`, 'utf8'));
  assert.equal(meta.pluginId, 'project-first-sidebar');
  assert.equal(meta.pluginVersion, manifest.version);
  assert.equal(meta.sdkVersion, manifest.devDependencies['@get-bb/plugin-sdk']);
  assert.equal(meta.builtWith.bbVersion, manifest.devDependencies['bb-app']);
}
const sourceMap = JSON.parse(readFileSync('dist/server.js.map', 'utf8'));
assert(sourceMap.sources.every(source => !source.includes('/home/') && !source.includes('file:///')), 'Machine-specific source map path');
assert(process.env.npm_execpath, 'Run this check through npm run check:package');
const [pack] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }));
const names = new Set(pack.files.map(file => file.path));
for (const required of ['package.json', 'LICENSE', 'README.md', 'UPSTREAM.md', 'PLUGIN_OVERVIEW.md',
  'server.ts', 'app.tsx', 'hooks/useBrowserDimmingModal.ts', 'skills/project-first-sidebar/SKILL.md', 'dist/server.js', 'dist/server.js.map',
  'dist/server.meta.json', 'dist/app.js', 'dist/app.css', 'dist/app.meta.json']) {
  assert(names.has(required), `Missing package file: ${required}`);
}
for (const name of names) {
  assert(!/(^|\/)(?:\.git|\.github|node_modules|checks|docs|scripts|artifacts)(?:\/|$)/.test(name), `Unwanted package path: ${name}`);
  assert(!/\.test\.|(?:^|\/)\.env(?:\.|$)|\.log$|\.tgz$/.test(name), `Unwanted package file: ${name}`);
}
assert(pack.unpackedSize < 16 * 1024 * 1024, 'Package exceeds the reviewed size budget');
console.log(JSON.stringify({ name: manifest.name, version: manifest.version, files: names.size, unpackedBytes: pack.unpackedSize }));
