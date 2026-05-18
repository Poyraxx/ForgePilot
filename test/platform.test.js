import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  resolveDefaultStatePath,
  resolveExternalScriptPath,
  resolveShellCandidates,
} from '../src/core/platform.js';

test('resolveShellCandidates returns a usable fallback list', () => {
  const candidates = resolveShellCandidates();
  assert.equal(Array.isArray(candidates), true);
  assert.equal(candidates.length > 0, true);
  assert.equal(typeof candidates[0].command, 'string');
  assert.equal(Array.isArray(candidates[0].args), true);
});

test('resolveDefaultStatePath returns a desktop-state.json path', () => {
  const statePath = resolveDefaultStatePath();
  assert.match(statePath, /desktop-state\.json$/);
});

test('resolveExternalScriptPath leaves normal paths unchanged', () => {
  const scriptPath = path.join(process.cwd(), 'document-reader.py');
  assert.equal(resolveExternalScriptPath(scriptPath), path.resolve(scriptPath));
});
