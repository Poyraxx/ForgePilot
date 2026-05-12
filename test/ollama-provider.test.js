import test from 'node:test';
import assert from 'node:assert/strict';

import { OllamaProvider } from '../src/core/providers/ollama.js';

test('ollama provider sends native tool requests with runtime options and custom system prompt', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        message: {
          content: 'done',
          tool_calls: [],
        },
      }),
    };
  };

  try {
    const provider = new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434' });
    await provider.runTurn({
      model: 'native-model',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      useNativeTools: true,
      systemPrompt: 'Be concise.',
      runtimeOptions: {
        numCtx: 65536,
        temperature: 0.4,
      },
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].options, {
      num_ctx: 65536,
      temperature: 0.4,
    });
    assert.equal(requests[0].messages[0].role, 'system');
    assert.equal(requests[0].messages[0].content, 'Be concise.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ollama provider embeds protocol and runtime options for emulated tool requests', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        message: {
          content: '<agent-response>{"mode":"final","message":"ok"}</agent-response>',
        },
      }),
    };
  };

  try {
    const provider = new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434' });
    await provider.runTurn({
      model: 'emulated-model',
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
      knownPaths: ['.', 'README.md', 'src/main.js'],
      systemPrompt: 'Prefer short answers.',
      runtimeOptions: {
        numCtx: 8192,
        temperature: 0.1,
      },
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].options, {
      num_ctx: 8192,
      temperature: 0.1,
    });
    assert.equal(requests[0].messages[0].role, 'system');
    assert.match(requests[0].messages[0].content, /Additional agent behavior instructions/);
    assert.match(requests[0].messages[0].content, /Prefer short answers\./);
    assert.match(requests[0].messages[0].content, /agent-response/);
    assert.match(requests[0].messages[0].content, /Never invent file or directory names\./);
    assert.match(requests[0].messages[0].content, /Only use a path after you have seen that exact path/);
    assert.match(requests[0].messages[0].content, /Known paths already discovered in this thread/);
    assert.match(requests[0].messages[0].content, /README\.md/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ollama provider falls back to plain final text for casual emulated replies', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;

  globalThis.fetch = async () => {
    requests += 1;
    return {
      ok: true,
      json: async () => ({
        message: {
          content:
            requests === 1
              ? 'Aleykum selam, size nasil yardimci olabilirim?'
              : 'Aleykum selam, size nasil yardimci olabilirim?',
        },
      }),
    };
  };

  try {
    const provider = new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434' });
    const result = await provider.runTurn({
      model: 'emulated-model',
      messages: [{ role: 'user', content: 'selam aleykum' }],
      tools: [],
      useNativeTools: false,
      workspaceRoot: 'C:/workspace',
    });

    assert.equal(result.envelope.mode, 'final');
    assert.match(result.envelope.message, /yardimci olabilirim/i);
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ollama provider surfaces a friendly message when Ollama is offline', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    const error = new TypeError('fetch failed');
    error.cause = {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 11434,
    };
    throw error;
  };

  try {
    const provider = new OllamaProvider({ baseUrl: 'http://127.0.0.1:11434' });

    await assert.rejects(
      () =>
        provider.runTurn({
          model: 'native-model',
          messages: [{ role: 'user', content: 'hello' }],
          tools: [],
          useNativeTools: true,
        }),
      /Ollama baglantisi kurulamadi/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
