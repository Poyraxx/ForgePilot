import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenAICompatibleProvider } from '../src/core/providers/openai-compatible.js';

test('openai-compatible provider sends native tool requests with system prompt', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'done',
              tool_calls: [],
            },
          },
        ],
      }),
    };
  };

  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });

    await provider.runTurn({
      model: 'gpt-4.1',
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
        temperature: 0.4,
      },
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'gpt-4.1');
    assert.equal(requests[0].messages[0].role, 'system');
    assert.equal(requests[0].messages[0].content, 'Be concise.');
    assert.equal(requests[0].tools[0].function.name, 'fs_read');
    assert.equal(requests[0].temperature, 0.4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible provider embeds emulation protocol when native tools are disabled', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '<agent-response>{"mode":"final","message":"ok"}</agent-response>',
            },
          },
        ],
      }),
    };
  };

  try {
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://127.0.0.1:1234/v1',
      forceEmulatedTools: true,
    });

    await provider.runTurn({
      model: 'local-model',
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
    assert.equal(requests[0].messages[0].role, 'system');
    assert.match(requests[0].messages[0].content, /Additional agent behavior instructions/);
    assert.match(requests[0].messages[0].content, /agent-response/);
    assert.match(requests[0].messages[0].content, /README\.md/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
