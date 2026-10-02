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

test('anthropic provider streams text and tool input', async () => {
  const originalFetch = globalThis.fetch;
  const chunks = [];
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).stream, true);
    const events = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Looking"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"fs_read","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    return new Response(new ReadableStream({
      start(controller) {
        const bytes = new TextEncoder().encode(events.join(''));
        controller.enqueue(bytes.slice(0, 53));
        controller.enqueue(bytes.slice(53));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    const provider = new AnthropicProvider({ apiKey: 'sk-test' });
    const result = await provider.runStreamingTurn({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'read' }],
      tools: [{ name: 'fs_read', description: 'Read', inputSchema: { type: 'object' } }],
      useNativeTools: true,
      onChunk: (chunk) => chunks.push(chunk.content),
    });

    assert.deepEqual(chunks, ['Looking']);
    assert.equal(result.message, 'Looking');
    assert.deepEqual(result.toolCalls, [{ id: 'tool_1', name: 'fs_read', arguments: { path: 'README.md' } }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('anthropic provider accepts a JSON reply to a stream request', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    content: [{ type: 'text', text: 'Local reply' }],
  });

  try {
    const provider = new AnthropicProvider();
    const result = await provider.runStreamingTurn({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      useNativeTools: true,
    });
    assert.equal(result.message, 'Local reply');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
