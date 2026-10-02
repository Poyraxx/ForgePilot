import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WorkspaceBoundaryError, resolveWorkspacePath } from '../src/core/path-guard.js';

test('workspace path guard allows nested new paths and rejects traversal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-path-'));
  try {
    assert.equal(resolveWorkspacePath(root, 'src/new/file.txt'), path.join(root, 'src/new/file.txt'));
    assert.throws(() => resolveWorkspacePath(root, '../outside.txt'), WorkspaceBoundaryError);
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test('workspace path guard rejects paths through a link to an external directory', async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-link-'));
  const root = path.join(parent, 'workspace');
  const external = path.join(parent, 'external');
  await fs.mkdir(root);
  await fs.mkdir(external);

  try {
    try {
      await fs.symlink(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        context.skip('Directory links are unavailable on this host.');
        return;
      }
      throw error;
    }

    assert.throws(() => resolveWorkspacePath(root, 'linked/new.txt'), WorkspaceBoundaryError);
  } finally {
    await fs.rm(parent, { recursive: true });
  }
});
