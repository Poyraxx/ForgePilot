import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { PluginRegistry } from '../src/core/plugins/registry.js';

test('plugin registry loads local stdio plugins and exposes executable tools', async () => {
  const registry = new PluginRegistry();
  await registry.loadFromDirectories([path.resolve('fixtures/plugin-fixture')]);

  const tools = registry.getTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'fixture_echo');

  const result = await tools[0].handler(
    {
      workspaceRoot: process.cwd(),
      permissionPreset: 'full_access',
      sessionId: 'plugin-test',
    },
    { text: 'hello' }
  );

  assert.equal(result.echoed, 'hello');
  assert.equal(result.sessionId, 'plugin-test');
});
