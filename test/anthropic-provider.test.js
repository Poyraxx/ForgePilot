import test from 'node:test';
import assert from 'node:assert/strict';

import { AnthropicProvider } from '../src/core/providers/anthropic.js';

test('anthropic provider sends native tool requests with system prompt and tools', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: 'done',
          },
        ],
      }),
    };
  };

  try {
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com',
      apiVersion: '2023-06-01',
      maxTokens: 2048,
    });

    await provider.runTurn({
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          name: 'fs_read',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
          },
        },
      ],
      useNativeTools: true,
      systemPrompt: 'Be concise.',
      runtimeOptions: {
        temperature: 0.3,
      },
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'claude-sonnet-4-20250514');
    assert.equal(requests[0].system, 'Be concise.');
    assert.equal(requests[0].tools[0].name, 'fs_read');
    assert.equal(requests[0].max_tokens, 2048);
    assert.equal(requests[0].temperature, 0.3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('anthropic provider embeds emulation protocol when native tools are disabled', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: '<agent-response>{"mode":"final","message":"ok"}</agent-response>',
          },
        ],
      }),
    };
  };

  try {
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-test',
      forceEmulatedTools: true,
    });

    await provider.runTurn({
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          name: 'fs_read',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
          },
        },
      ],
      useNativeTools: false,
      workspaceRoot: 'C:/workspace',
      knownPaths: ['.', 'README.md'],
      systemPrompt: 'Prefer short answers.',
      runtimeOptions: {
        temperature: 0.1,
      },
    });

    assert.equal(requests.length, 1);
    assert.match(requests[0].system, /Additional agent behavior instructions/);
    assert.match(requests[0].system, /agent-response/);
    assert.match(requests[0].system, /README\.md/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
