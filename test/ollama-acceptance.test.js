import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentRuntime } from '../src/core/agent/runtime.js';
import { PermissionPreset } from '../src/core/contracts.js';
import { OllamaProvider } from '../src/core/providers/ollama.js';
import { ToolRegistry } from '../src/core/tool-registry.js';
import { createBuiltInTools } from '../src/core/tools/index.js';

const runAcceptance = process.env.RUN_OLLAMA_ACCEPTANCE === '1';

async function createSession(model) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-ollama-'));
  const toolRegistry = new ToolRegistry(createBuiltInTools());

  return {
    id: `session-${model}`,
    workspaceRoot,
    model,
    permissionPreset: PermissionPreset.FULL_ACCESS,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    toolEvents: [],
    pendingApproval: null,
    toolRegistry,
    pluginRegistry: { getPlugins: () => [] },
    capabilities: null,
    capabilityOverride: null,
  };
}

test(
  'native tool-capable Ollama model can create and summarize a file change',
  { skip: !runAcceptance, timeout: 240_000 },
  async () => {
    const provider = new OllamaProvider();
    const runtime = new AgentRuntime({ provider, maxIterations: 8 });
    const session = await createSession('qwen3-coder-next:latest');

    const result = await runtime.runUserTurn(
      session,
      'Create a file named native.txt containing exactly "native-ok" and then answer with a one sentence confirmation.'
    );

    assert.equal(result.status, 'completed');
    assert.equal(await fs.readFile(path.join(session.workspaceRoot, 'native.txt'), 'utf8'), 'native-ok');
  }
);

test(
  'non-native Ollama model can use emulated tools to write, search, and run a command',
  { skip: !runAcceptance, timeout: 240_000 },
  async () => {
    const provider = new OllamaProvider();
    const runtime = new AgentRuntime({ provider, maxIterations: 10 });
    const session = await createSession('huihui_ai/qwen3-coder-abliterated:latest');

    const result = await runtime.runUserTurn(
      session,
      [
        'Create a file named emulated.txt with exactly the text "alpha".',
        'Then replace alpha with beta.',
        'Then search the workspace for beta.',
        `Then run the command ${process.platform === 'win32' ? '`Get-Content emulated.txt`' : '`cat emulated.txt`'}.`,
        'Finally answer with one short sentence.',
      ].join(' ')
    );

    assert.equal(result.status, 'completed');
    assert.equal(await fs.readFile(path.join(session.workspaceRoot, 'emulated.txt'), 'utf8'), 'beta');
    assert.equal(session.toolEvents.some((event) => event.toolName === 'run_command'), true);
  }
);
