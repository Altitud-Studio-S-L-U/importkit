import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('require() and import load the same package API', async () => {
  const required = require('@altitud-studio/importkit');
  const imported = await import('@altitud-studio/importkit');
  assert.deepEqual(Object.keys(required).sort(), Object.keys(imported).sort());
  assert.equal(required.importFile, imported.importFile);
});

test('package.json is readable through the package exports', () => {
  assert.equal(require('@altitud-studio/importkit/package.json').name, '@altitud-studio/importkit');
});
