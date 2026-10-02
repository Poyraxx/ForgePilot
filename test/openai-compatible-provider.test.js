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

test('openai-compatible provider streams text and joins tool arguments', async () => {
  const originalFetch = globalThis.fetch;
  const chunks = [];
  const encoder = new TextEncoder();
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).stream, true);
    const events = [
      'data: {"choices":[{"delta":{"content":"Reading "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"file","tool_calls":[{"index":0,"id":"call_1","function":{"name":"fs_read","arguments":"{\\"path\\":\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"README.md\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    return new Response(new ReadableStream({
      start(controller) {
        const bytes = encoder.encode(events.join(''));
        controller.enqueue(bytes.slice(0, 37));
        controller.enqueue(bytes.slice(37, 119));
        controller.enqueue(bytes.slice(119));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    const provider = new OpenAICompatibleProvider({ apiKey: 'sk-test' });
    const result = await provider.runStreamingTurn({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'read' }],
      tools: [{ name: 'fs_read', description: 'Read', inputSchema: { type: 'object' } }],
      useNativeTools: true,
      onChunk: (chunk) => chunks.push(chunk.content),
    });

    assert.deepEqual(chunks, ['Reading ', 'Reading file']);
    assert.equal(result.message, 'Reading file');
    assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'fs_read', arguments: { path: 'README.md' } }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('openai-compatible provider accepts a JSON reply to a stream request', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    choices: [{ message: { content: 'Local reply', tool_calls: [] } }],
  });

  try {
    const provider = new OpenAICompatibleProvider();
    const result = await provider.runStreamingTurn({
      model: 'local-model',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      useNativeTools: true,
    });
    assert.equal(result.message, 'Local reply');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
