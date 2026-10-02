import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadWorkspaceContext } from '../src/core/agent/workspace-context.js';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forgepilot-context-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('project instructions and skill descriptions load without injecting skill bodies', async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Use the existing names.');
  await fs.mkdir(path.join(root, '.agents/skills/tests'), { recursive: true });
  await fs.writeFile(path.join(root, '.agents/skills/tests/SKILL.md'), '---\nname: tests\ndescription: "Run project tests"\n---\nSkill body must be read explicitly.');
  const result = await loadWorkspaceContext(root);
  assert.match(result.prompt, /Use the existing names/);
  assert.match(result.prompt, /tests: Run project tests/);
  assert.doesNotMatch(result.prompt, /Skill body must/);
  assert.deepEqual(result.paths, ['AGENTS.md', '.agents/skills/tests/SKILL.md']);
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Updated instructions');
  assert.match((await loadWorkspaceContext(root)).prompt, /Updated instructions/);
});

test('missing and oversized instructions do not break turns', async (t) => {
  const root = await workspace(t);
  assert.deepEqual(await loadWorkspaceContext(root), { paths: [], prompt: '' });
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'x'.repeat(25000));
  assert.equal((await loadWorkspaceContext(root)).prompt, '');
});

test('skill descriptions support multiline frontmatter and deterministic duplicate selection', async (t) => {
  const root = await workspace(t);
  for (const directory of ['.agents/skills/check', '.claude/skills/check']) {
    await fs.mkdir(path.join(root, directory), { recursive: true });
    await fs.writeFile(path.join(root, directory, 'SKILL.md'), '---\nname: check\ndescription: >\n  Read the repository\n  and run its tests.\n---\nBody');
  }
  const result = await loadWorkspaceContext(root);
  assert.match(result.prompt, /Read the repository and run its tests/);
  assert.deepEqual(result.paths, ['.agents/skills/check/SKILL.md']);
});

test('instruction symlinks outside the workspace are not loaded', async (t) => {
  const root = await workspace(t);
  const outside = await workspace(t);
  await fs.mkdir(path.join(outside, 'skills/tests'), { recursive: true });
  await fs.writeFile(path.join(outside, 'skills/tests/SKILL.md'), '---\nname: private\ndescription: Secret\n---\n');
  await fs.mkdir(path.join(root, '.agents'));
  await fs.symlink(path.join(outside, 'skills'), path.join(root, '.agents/skills'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await loadWorkspaceContext(root), { paths: [], prompt: '' });
});
