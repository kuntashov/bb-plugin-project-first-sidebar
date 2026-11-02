import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = resolve(root, 'node_modules/bb-app/package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.version !== '0.48.1') throw new Error('Expected the pinned bb-app 0.48.1 build tool');
const binary = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.bb;
if (!binary) throw new Error('bb-app does not declare its public bb executable');
const env = { ...process.env };
delete env.BB_CLI;
const result = spawnSync(process.execPath, [resolve(dirname(manifestPath), binary), 'plugin', 'build', '.'], {
  cwd: root, env, stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
// BB's virtual Zod stub can contain the build host's absolute dependency path.
// Keep source maps useful while making their source labels machine-independent.
const mapPath = resolve(root, 'dist/server.js.map');
const map = JSON.parse(readFileSync(mapPath, 'utf8'));
map.sources = map.sources.map(source => {
  const prefix = source.startsWith('bb-zod-locale-stub:') ? 'bb-zod-locale-stub:' : '';
  let path = source.slice(prefix.length).replaceAll('\\', '/');
  const dependency = path.indexOf('/node_modules/');
  if (dependency >= 0) path = '../node_modules/' + path.slice(dependency + '/node_modules/'.length);
  else if (path.startsWith(root.replaceAll('\\', '/') + '/')) path = '../' + path.slice(root.length + 1);
  if (isAbsolute(path) || /^[A-Za-z]:\//.test(path)) throw new Error('Unexpected absolute source map path');
  return prefix + path;
});
writeFileSync(mapPath, JSON.stringify(map) + '\n');
