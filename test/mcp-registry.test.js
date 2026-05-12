import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { McpRegistry } from '../src/core/mcp/registry.js';

test('mcp registry loads stdio MCP servers and exposes callable tools', async () => {
  const registry = new McpRegistry();
  const fixturePath = path.resolve('fixtures/mcp-fixture/server.mjs');

  await registry.loadFromConfigs([
    {
      id: 'fixture-mcp',
      name: 'Fixture MCP',
      command: process.execPath,
      args: [fixturePath],
      enabled: true,
    },
  ]);

  const servers = registry.getServers();
  const tools = registry.getTools();
  const echoTool = tools.find((tool) => tool.name === 'mcp.fixture-mcp.echo');
  const writeTool = tools.find((tool) => tool.name === 'mcp.fixture-mcp.write_note');

  assert.equal(servers.length, 1);
  assert.equal(servers[0].status, 'connected');
  assert.equal(servers[0].toolCount, 2);
  assert.ok(echoTool);
  assert.ok(writeTool);
  assert.equal(echoTool.mutatesWorkspace, false);
  assert.equal(writeTool.requiresApproval, true);

  const result = await echoTool.handler(
    {
      workspaceRoot: process.cwd(),
      permissionPreset: 'full_access',
      sessionId: 'mcp-test',
    },
    { text: 'hello' }
  );

  assert.equal(result.server, 'Fixture MCP');
  assert.equal(result.tool, 'echo');
  assert.equal(result.text, 'echo:hello');
  assert.deepEqual(result.structuredContent, { echoed: 'hello' });
});
