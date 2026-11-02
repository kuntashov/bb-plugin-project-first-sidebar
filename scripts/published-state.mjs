import assert from 'node:assert/strict';
import { readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [pack] = JSON.parse(readFileSync('artifacts/package.json', 'utf8'));
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
assert.equal(process.env.GITHUB_REF_NAME, `v${version}`);
assert.equal(pack.name, 'bb-plugin-project-first-sidebar');
assert.equal(pack.version, version);
assert.equal(pack.filename, `bb-plugin-project-first-sidebar-${version}.tgz`);
const bytes = readFileSync(`artifacts/${pack.filename}`);
assert.equal(pack.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`, 'Tarball integrity differs from npm pack metadata');
const response = await fetch(`https://registry.npmjs.org/${pack.name}/${version}`, { signal: AbortSignal.timeout(30_000) });
let alreadyPublished = false;
if (response.status !== 404) {
  assert.equal(response.status, 200, `Registry lookup failed: HTTP ${response.status}`);
  const published = await response.json();
  assert.equal(published.dist.integrity, pack.integrity, 'This version already exists with different bytes');
  alreadyPublished = true;
}
appendFileSync(process.env.GITHUB_OUTPUT, `already_published=${alreadyPublished}\n`);
console.log(alreadyPublished ? 'Exact artifact already published; safe release retry' : 'Version is not published');
