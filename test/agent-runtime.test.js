import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentRuntime } from '../src/core/agent/runtime.js';
import { createAbortError } from '../src/core/abort.js';
import { AgentMode, PermissionPreset } from '../src/core/contracts.js';
import { ToolRegistry } from '../src/core/tool-registry.js';
import { createBuiltInTools } from '../src/core/tools/index.js';

async function createSession(
  provider,
  permissionPreset = PermissionPreset.FULL_ACCESS,
  agentMode = AgentMode.BUILD
) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-runtime-'));
  const toolRegistry = new ToolRegistry(createBuiltInTools());

  return {
    id: 'session-1',
    workspaceRoot,
    model: 'fake-model',
    agentMode,
    permissionPreset,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    toolEvents: [],
    pendingApproval: null,
    toolRegistry,
    pluginRegistry: { getPlugins: () => [] },
    capabilities: null,
    capabilityOverride: null,
    provider,
  };
}

test('runtime can complete a native tool-calling loop', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: true, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;
      if (this.turns === 1) {
        return {
          message: '',
          thinking: '',
          toolCalls: [{ name: 'fs_write', arguments: { path: 'hello.txt', content: 'world' } }],
        };
      }

      return {
        message: 'done',
        thinking: '',
        toolCalls: [],
      };
    },
  };

  const session = await createSession(provider);
  const runtime = new AgentRuntime({ provider });
  const result = await runtime.runUserTurn(session, 'create hello.txt');

  assert.equal(result.status, 'completed');
  assert.equal(session.toolEvents.length, 1);
  assert.equal(session.toolEvents[0].status, 'completed');
  assert.equal(await fs.readFile(path.join(session.workspaceRoot, 'hello.txt'), 'utf8'), 'world');
});

test('runtime pauses on approval-required tools in ask mode and continues after approval', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;
      if (this.turns === 1) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"run_command","arguments":{"command":"Write-Output \\"ok\\""}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [{ name: 'run_command', arguments: { command: 'Write-Output "ok"' } }],
          },
        };
      }

      return {
        message: '<agent-response>{"mode":"final","message":"command completed"}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'command completed',
        },
      };
    },
  };

  const session = await createSession(provider, PermissionPreset.ASK);
  const runtime = new AgentRuntime({ provider });
  const firstPass = await runtime.runUserTurn(session, 'run a command');

  assert.equal(firstPass.status, 'approval_required');
  assert.equal(session.pendingApproval.call.name, 'run_command');

  const resumed = await runtime.resolvePendingApproval(session, true);
  assert.equal(resumed.status, 'completed');
  assert.equal(session.toolEvents[0].status, 'completed');
});

test('runtime does not re-prompt approval when the model immediately repeats the same approved command', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;
      if (this.turns === 1) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"run_command","arguments":{"command":"Write-Output \\"ok\\""}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [{ name: 'run_command', arguments: { command: 'Write-Output "ok"' } }],
          },
        };
      }

      if (this.turns === 2) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"run_command","arguments":{"command":"Write-Output \\"ok\\""}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [{ name: 'run_command', arguments: { command: 'Write-Output "ok"' } }],
          },
        };
      }

      return {
        message: '<agent-response>{"mode":"final","message":"command completed after reuse warning"}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'command completed after reuse warning',
        },
      };
    },
  };

  const session = await createSession(provider, PermissionPreset.ASK);
  const runtime = new AgentRuntime({ provider });
  const firstPass = await runtime.runUserTurn(session, 'run a command twice');

  assert.equal(firstPass.status, 'approval_required');

  const resumed = await runtime.resolvePendingApproval(session, true);
  assert.equal(resumed.status, 'completed');
  assert.equal(session.pendingApproval, null);
  assert.equal(session.toolEvents[0].status, 'completed');
  assert.equal(session.toolEvents[1].status, 'skipped');
  assert.match(
    session.toolEvents[1].resultPreview,
    /already executed/i
  );
});

test('runtime skips repeated identical tool plans and stops if the loop continues', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;
      return {
        message:
          '<agent-response>{"mode":"tool","calls":[{"name":"fs_list","arguments":{"path":"."}}]}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'tool',
          calls: [{ name: 'fs_list', arguments: { path: '.' } }],
        },
      };
    },
  };

  const session = await createSession(provider);
  const runtime = new AgentRuntime({ provider, maxIterations: 4 });
  const result = await runtime.runUserTurn(session, 'inspect the repo');

  assert.equal(result.status, 'error');
  assert.equal(session.toolEvents[0].status, 'completed');
  assert.equal(session.toolEvents[1].status, 'skipped');
  assert.match(
    session.messages.at(-1).content,
    /Stopped because the model kept repeating the same tool request/
  );
});

test('runtime does not count exploratory search iterations against the main tool loop limit', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn({ tools }) {
      this.turns += 1;

      if (this.turns >= 6 || (tools?.length ?? 0) === 0) {
        return {
          message: '<agent-response>{"mode":"final","message":"I found several keyboard-related references and can summarize the project now."}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'final',
            message: 'I found several keyboard-related references and can summarize the project now.',
          },
        };
      }

      return {
        message:
          `<agent-response>{"mode":"tool","calls":[{"name":"search_text","arguments":{"query":"term-${this.turns}","path":"."}}]}</agent-response>`,
        thinking: '',
        envelope: {
          mode: 'tool',
          calls: [{ name: 'search_text', arguments: { query: `term-${this.turns}`, path: '.' } }],
        },
      };
    },
  };

  const session = await createSession(provider);
  const runtime = new AgentRuntime({ provider, maxIterations: 2 });
  const result = await runtime.runUserTurn(session, 'inspect the repo');

  assert.equal(result.status, 'completed');
  assert.equal(session.toolEvents.length, 5);
  assert.equal(session.toolEvents.every((event) => event.toolName === 'search_text'), true);
  assert.match(
    session.messages.at(-1)?.content ?? '',
    /summarize the project now/i
  );
});

test('runtime blocks undiscovered fs_read paths for emulated models', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;
      if (this.turns === 1) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"fs_read","arguments":{"path":"package.json"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [{ name: 'fs_read', arguments: { path: 'package.json' } }],
          },
        };
      }

      return {
        message: '<agent-response>{"mode":"final","message":"done"}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'done',
        },
      };
    },
  };

  const session = await createSession(provider);
  const runtime = new AgentRuntime({ provider });
  const result = await runtime.runUserTurn(session, 'read package json');

  assert.equal(result.status, 'completed');
  assert.equal(session.toolEvents[0].status, 'blocked');
  assert.match(session.toolEvents[0].resultPreview, /has not been discovered in this thread yet/);
});

test('runtime allows fs_read for existing workspace files even if they were not discovered earlier', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;
      if (this.turns === 1) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"fs_read","arguments":{"path":"report.txt"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [{ name: 'fs_read', arguments: { path: 'report.txt' } }],
          },
        };
      }

      return {
        message: '<agent-response>{"mode":"final","message":"done"}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'done',
        },
      };
    },
  };

  const session = await createSession(provider);
  await fs.writeFile(path.join(session.workspaceRoot, 'report.txt'), 'hello');

  const runtime = new AgentRuntime({ provider });
  const result = await runtime.runUserTurn(session, 'read report');

  assert.equal(result.status, 'completed');
  assert.equal(session.toolEvents[0].status, 'completed');
  assert.equal(session.toolEvents[0].toolName, 'fs_read');
});

test('runtime includes previously imported attachments in the model context', async () => {
  let seenMessages = [];
  const provider = {
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn({ messages }) {
      seenMessages = messages;
      return {
        message: '<agent-response>{"mode":"final","message":"done"}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'done',
        },
      };
    },
  };

  const session = await createSession(provider);
  session.attachments = [
    {
      id: 'attachment-1',
      name: 'report.pdf',
      originalName: 'report.pdf',
      path: '.cokgizlicoder/attachments/session-1/report.pdf',
      mimeType: 'application/pdf',
      size: 1234,
      attachedAt: new Date().toISOString(),
    },
  ];

  const runtime = new AgentRuntime({ provider });
  await runtime.runUserTurn(session, 'onceki pdfyi tekrar kullan');

  assert.equal(seenMessages[0]?.role, 'system');
  assert.match(seenMessages[0]?.content ?? '', /Thread attachments currently available/);
  assert.match(seenMessages[0]?.content ?? '', /\.cokgizlicoder\/attachments\/session-1\/report\.pdf/);
});

test('runtime does not block fs_read when an attachment alias matches an older source path', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;
      if (this.turns === 1) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"fs_read","arguments":{"path":"C:\\\\Users\\\\Xaser\\\\Desktop\\\\Downloads\\\\report.txt"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [
              {
                name: 'fs_read',
                arguments: { path: 'C:\\Users\\Xaser\\Desktop\\Downloads\\report.txt' },
              },
            ],
          },
        };
      }

      return {
        message: '<agent-response>{"mode":"final","message":"done"}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'done',
        },
      };
    },
  };

  const session = await createSession(provider);
  const attachmentPath = path.join(
    session.workspaceRoot,
    '.cokgizlicoder',
    'attachments',
    session.id,
    'report.txt'
  );
  await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
  await fs.writeFile(attachmentPath, 'hello');
  session.attachments = [
    {
      id: 'attachment-1',
      name: 'report.txt',
      originalName: 'report.txt',
      path: '.cokgizlicoder/attachments/session-1/report.txt',
      mimeType: 'text/plain',
      size: 5,
      attachedAt: new Date().toISOString(),
    },
  ];

  const runtime = new AgentRuntime({ provider });
  const result = await runtime.runUserTurn(session, 'onceki ekli dosyayi oku');

  assert.equal(result.status, 'completed');
  assert.equal(session.toolEvents[0].status, 'completed');
});

test('runtime automatically compacts older thread context into a summary', async () => {
  let seenMessages = [];

  const provider = {
    async getCapabilities() {
      return { nativeTools: true, structuredOutput: true, streaming: true };
    },
    async runTurn({ messages }) {
      seenMessages = messages;
      return {
        message: 'done',
        thinking: '',
        toolCalls: [],
      };
    },
  };

  const session = await createSession(provider);
  const baseTime = Date.now() - 60_000;

  session.messages = Array.from({ length: 40 }, (_value, index) => ({
    id: `m-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${index % 2 === 0 ? 'user' : 'assistant'} message ${index}`,
    createdAt: new Date(baseTime + index * 1_000).toISOString(),
  }));
  session.toolEvents = [
    {
      id: 'event-1',
      toolName: 'fs_read',
      arguments: { path: 'README.md' },
      status: 'completed',
      createdAt: new Date(baseTime + 2_000).toISOString(),
      completedAt: new Date(baseTime + 3_000).toISOString(),
      resultPreview: 'Read README.md (1-30 of 30 lines).',
      result: { path: 'README.md' },
    },
  ];

  const runtime = new AgentRuntime({ provider });
  const result = await runtime.runUserTurn(session, 'latest user turn');

  assert.equal(result.status, 'completed');
  assert.ok(session.contextCompression);
  assert.equal(session.contextCompression.compressedMessageCount, 21);
  assert.equal(session.contextCompression.keptMessageCount, 20);
  assert.ok(seenMessages.length < session.messages.length);
  assert.equal(seenMessages[0].role, 'system');
  assert.match(seenMessages[0].content, /Compressed conversation memory/);
  assert.match(seenMessages[0].content, /Earlier important tool outcomes/);
  assert.equal(seenMessages.at(-1).role, 'user');
  assert.equal(seenMessages.at(-1).content, 'latest user turn');
});

test('runtime blocks undiscovered web_fetch URLs for emulated models', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;
      if (this.turns === 1) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"web_fetch","arguments":{"url":"https://www.example.com/invented-article"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [
              {
                name: 'web_fetch',
                arguments: { url: 'https://www.example.com/invented-article' },
              },
            ],
          },
        };
      }

      return {
        message: '<agent-response>{"mode":"final","message":"done"}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'done',
        },
      };
    },
  };

  const session = await createSession(provider);
  const runtime = new AgentRuntime({ provider });
  const result = await runtime.runUserTurn(session, 'find something on the web');

  assert.equal(result.status, 'completed');
  assert.equal(session.toolEvents[0].status, 'blocked');
  assert.match(session.toolEvents[0].resultPreview, /has not been discovered in this thread yet/i);
  assert.match(session.toolEvents[0].resultPreview, /Run web_search again with a better query/i);
});

test('runtime allows web_fetch when the user explicitly provided the URL', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;
      if (this.turns === 1) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"web_fetch","arguments":{"url":"https://www.example.com/provided"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [
              {
                name: 'web_fetch',
                arguments: { url: 'https://www.example.com/provided' },
              },
            ],
          },
        };
      }

      return {
        message: '<agent-response>{"mode":"final","message":"done"}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'done',
        },
      };
    },
  };

  const session = await createSession(provider);
  const webFetchDefinition = session.toolRegistry.get('web_fetch');
  session.toolRegistry.register({
    ...webFetchDefinition,
    handler: async (_context, args) => ({
      url: args.url,
      title: 'Example',
      content: 'ok',
    }),
  });

  const runtime = new AgentRuntime({ provider });
  const result = await runtime.runUserTurn(
    session,
    'Read this URL: https://www.example.com/provided'
  );

  assert.equal(result.status, 'completed');
  assert.equal(session.toolEvents[0].status, 'completed');
  assert.equal(session.toolEvents[0].toolName, 'web_fetch');
});

test('runtime allows web_fetch for URLs returned by earlier web_search results', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;
      if (this.turns === 1) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"web_fetch","arguments":{"url":"https://www.example.com/search-result"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [
              {
                name: 'web_fetch',
                arguments: { url: 'https://www.example.com/search-result' },
              },
            ],
          },
        };
      }

      return {
        message: '<agent-response>{"mode":"final","message":"done"}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'done',
        },
      };
    },
  };

  const session = await createSession(provider);
  session.toolEvents.push({
    id: 'event-search-1',
    toolName: 'web_search',
    arguments: { query: 'example query' },
    status: 'completed',
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    resultPreview: 'Found 1 web results for "example query".',
    result: {
      query: 'example query',
      results: [
        {
          title: 'Example result',
          url: 'https://www.example.com/search-result',
          snippet: 'Example snippet',
        },
      ],
    },
  });

  const webFetchDefinition = session.toolRegistry.get('web_fetch');
  session.toolRegistry.register({
    ...webFetchDefinition,
    handler: async (_context, args) => ({
      url: args.url,
      title: 'Example result',
      content: 'ok',
    }),
  });

  const runtime = new AgentRuntime({ provider });
  const result = await runtime.runUserTurn(session, 'continue the research');

  assert.equal(result.status, 'completed');
  assert.equal(session.toolEvents.at(-1)?.status, 'completed');
  assert.equal(session.toolEvents.at(-1)?.toolName, 'web_fetch');
});

test('runtime allows web_fetch by exact web_search resultId without copying the URL manually', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;
      if (this.turns === 1) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"web_fetch","arguments":{"resultId":"result-1"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [
              {
                name: 'web_fetch',
                arguments: { resultId: 'result-1' },
              },
            ],
          },
        };
      }

      return {
        message: '<agent-response>{"mode":"final","message":"done"}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'done',
        },
      };
    },
  };

  const session = await createSession(provider);
  session.toolEvents.push({
    id: 'event-search-resultid-1',
    toolName: 'web_search',
    arguments: { query: 'result id test' },
    status: 'completed',
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    resultPreview: 'Found 1 web results for "result id test".',
    result: {
      query: 'result id test',
      results: [
        {
          id: 'result-1',
          title: 'Example result',
          url: 'https://www.example.com/result-id',
          snippet: 'Example snippet',
        },
      ],
    },
  });

  const webFetchDefinition = session.toolRegistry.get('web_fetch');
  session.toolRegistry.register({
    ...webFetchDefinition,
    handler: async (_context, args) => ({
      url: args.url,
      title: 'Example result',
      content: 'ok',
    }),
  });

  const runtime = new AgentRuntime({ provider });
  const result = await runtime.runUserTurn(session, 'continue the research');

  assert.equal(result.status, 'completed');
  assert.equal(session.toolEvents.at(-1)?.status, 'completed');
  assert.equal(session.toolEvents.at(-1)?.toolName, 'web_fetch');
  assert.equal(session.toolEvents.at(-1)?.arguments?.resultId, 'result-1');
  assert.equal(session.toolEvents.at(-1)?.arguments?.url, 'https://www.example.com/result-id');
});

test('runtime does not treat invented web URLs as newly discovered URLs later in the same thread', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;
      if (this.turns === 1) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"web_fetch","arguments":{"url":"https://www.example.com/invented-1"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [{ name: 'web_fetch', arguments: { url: 'https://www.example.com/invented-1' } }],
          },
        };
      }

      if (this.turns === 2) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"web_fetch","arguments":{"url":"https://www.example.com/invented-2"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [{ name: 'web_fetch', arguments: { url: 'https://www.example.com/invented-2' } }],
          },
        };
      }

      return {
        message: '<agent-response>{"mode":"final","message":"done"}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'done',
        },
      };
    },
  };

  const session = await createSession(provider);
  session.toolEvents.push({
    id: 'event-search-1',
    toolName: 'web_search',
    arguments: { query: 'example query' },
    status: 'completed',
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    resultPreview: 'Found 1 web results for "example query".',
    result: {
      query: 'example query',
      results: [
        {
          title: 'Example result',
          url: 'https://www.example.com/search-result',
          snippet: 'Example snippet',
        },
      ],
    },
  });

  const webFetchDefinition = session.toolRegistry.get('web_fetch');
  session.toolRegistry.register({
    ...webFetchDefinition,
    handler: async (_context, args) => ({
      url: args.url,
      title: 'Example result',
      content: 'ok',
    }),
  });

  const runtime = new AgentRuntime({ provider });
  const result = await runtime.runUserTurn(session, 'continue the research');

  assert.equal(result.status, 'completed');
  assert.equal(session.toolEvents[1]?.status, 'completed');
  assert.equal(session.toolEvents[1]?.result?.runtimeRedirected, true);
  assert.equal(session.toolEvents[1]?.result?.requestedUrl, 'https://www.example.com/invented-1');
  assert.equal(session.toolEvents[1]?.result?.url, 'https://www.example.com/search-result');
  assert.equal(session.toolEvents[2]?.status, 'completed');
  assert.equal(session.toolEvents[2]?.result?.runtimeRedirected, true);
  assert.equal(session.toolEvents[2]?.result?.requestedUrl, 'https://www.example.com/invented-2');
  assert.equal(session.toolEvents[2]?.result?.url, 'https://www.example.com/search-result');
});

test('runtime does not allow finalizing web research before one exact search-result URL was fetched successfully', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;

      if (this.turns === 1) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"web_search","arguments":{"query":"example research"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [{ name: 'web_search', arguments: { query: 'example research' } }],
          },
        };
      }

      if (this.turns === 2) {
        return {
          message: '<agent-response>{"mode":"final","message":"Here is my research summary."}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'final',
            message: 'Here is my research summary.',
          },
        };
      }

      if (this.turns === 3) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"web_fetch","arguments":{"url":"https://www.example.com/search-result"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [{ name: 'web_fetch', arguments: { url: 'https://www.example.com/search-result' } }],
          },
        };
      }

      return {
        message: '<agent-response>{"mode":"final","message":"Now I can summarize from the fetched page."}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'Now I can summarize from the fetched page.',
        },
      };
    },
  };

  const session = await createSession(provider);
  const webSearchDefinition = session.toolRegistry.get('web_search');
  session.toolRegistry.register({
    ...webSearchDefinition,
    handler: async () => ({
      query: 'example research',
      provider: 'duckduckgo',
      results: [
        {
          title: 'Example result',
          url: 'https://www.example.com/search-result',
          snippet: 'Example snippet',
          availability: { ok: true, status: 200, url: 'https://www.example.com/search-result', reason: 'ok' },
        },
      ],
      filteredInaccessibleResults: 0,
      inaccessibleResultsDetected: false,
      truncated: false,
    }),
  });

  const webFetchDefinition = session.toolRegistry.get('web_fetch');
  session.toolRegistry.register({
    ...webFetchDefinition,
    handler: async (_context, args) => ({
      url: args.url,
      title: 'Example result',
      content: 'verified content',
    }),
  });

  const runtime = new AgentRuntime({ provider });
  const result = await runtime.runUserTurn(session, 'research this on the web');
  const guardEvent = session.toolEvents.find(
    (event) => event.result?.guard === 'missing_web_evidence'
  );
  const completedFetchEvent = session.toolEvents.find(
    (event) => event.toolName === 'web_fetch' && event.status === 'completed'
  );

  assert.equal(result.status, 'completed');
  assert.equal(session.toolEvents[0]?.toolName, 'web_search');
  assert.equal(guardEvent?.status, 'blocked');
  assert.match(guardEvent?.resultPreview ?? '', /only 0 fetched sources succeeded so far/i);
  assert.equal(completedFetchEvent?.status, 'completed');
  assert.match(session.messages.at(-1)?.content ?? '', /Now I can summarize/);
});

test('plan mode blocks workspace-changing tool calls and keeps the agent in analysis mode', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;

      if (this.turns === 1) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"fs_write","arguments":{"path":"plan.md","content":"draft"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [{ name: 'fs_write', arguments: { path: 'plan.md', content: 'draft' } }],
          },
        };
      }

      return {
        message: '<agent-response>{"mode":"final","message":"Here is the recommended implementation plan."}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'Here is the recommended implementation plan.',
        },
      };
    },
  };

  const session = await createSession(
    provider,
    PermissionPreset.FULL_ACCESS,
    AgentMode.PLAN
  );
  const runtime = new AgentRuntime({ provider });
  const result = await runtime.runUserTurn(session, 'plan the next implementation steps');

  assert.equal(result.status, 'completed');
  assert.equal(session.toolEvents[0]?.toolName, 'fs_write');
  assert.equal(session.toolEvents[0]?.status, 'blocked');
  assert.match(session.toolEvents[0]?.resultPreview ?? '', /Plan mode is analysis-first/i);
  assert.match(session.messages.at(-1)?.content ?? '', /recommended implementation plan/i);
});

test('research mode requires two fetched sources before finalizing a web research answer', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;

      if (this.turns === 1) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"web_search","arguments":{"query":"agent research workflow"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [{ name: 'web_search', arguments: { query: 'agent research workflow' } }],
          },
        };
      }

      if (this.turns === 2) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"web_fetch","arguments":{"url":"https://www.example.com/source-1"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [{ name: 'web_fetch', arguments: { url: 'https://www.example.com/source-1' } }],
          },
        };
      }

      if (this.turns === 3) {
        return {
          message: '<agent-response>{"mode":"final","message":"I have enough to summarize now."}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'final',
            message: 'I have enough to summarize now.',
          },
        };
      }

      if (this.turns === 4) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"web_fetch","arguments":{"url":"https://www.example.com/source-2"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [{ name: 'web_fetch', arguments: { url: 'https://www.example.com/source-2' } }],
          },
        };
      }

      return {
        message: '<agent-response>{"mode":"final","message":"Now I can compare both sources."}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'Now I can compare both sources.',
        },
      };
    },
  };

  const session = await createSession(
    provider,
    PermissionPreset.FULL_ACCESS,
    AgentMode.RESEARCH
  );
  const webSearchDefinition = session.toolRegistry.get('web_search');
  session.toolRegistry.register({
    ...webSearchDefinition,
    handler: async () => ({
      query: 'agent research workflow',
      provider: 'duckduckgo',
      results: [
        {
          title: 'Source one',
          url: 'https://www.example.com/source-1',
          snippet: 'First source',
          availability: { ok: true, status: 200, url: 'https://www.example.com/source-1', reason: 'ok' },
        },
        {
          title: 'Source two',
          url: 'https://www.example.com/source-2',
          snippet: 'Second source',
          availability: { ok: true, status: 200, url: 'https://www.example.com/source-2', reason: 'ok' },
        },
      ],
      filteredInaccessibleResults: 0,
      inaccessibleResultsDetected: false,
      truncated: false,
    }),
  });

  const webFetchDefinition = session.toolRegistry.get('web_fetch');
  session.toolRegistry.register({
    ...webFetchDefinition,
    handler: async (_context, args) => ({
      url: args.url,
      title: args.url.endsWith('source-2') ? 'Source two' : 'Source one',
      content: `verified content from ${args.url}`,
    }),
  });

  const runtime = new AgentRuntime({ provider });
  const result = await runtime.runUserTurn(session, 'research this topic carefully');
  const evidenceGuardEvents = session.toolEvents.filter(
    (event) => event.result?.guard === 'missing_web_evidence'
  );
  const completedFetches = session.toolEvents.filter(
    (event) => event.toolName === 'web_fetch' && event.status === 'completed'
  );

  assert.equal(result.status, 'completed');
  assert.equal(completedFetches.length, 2);
  assert.equal(evidenceGuardEvents.length, 1);
  assert.match(
    evidenceGuardEvents[0]?.resultPreview ?? '',
    /Gather at least 2 fetched sources/i
  );
  assert.match(session.messages.at(-1)?.content ?? '', /compare both sources/i);
});

test('runtime automatically redirects invented web_fetch URLs to a real URL from the latest search results', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: false, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;

      if (this.turns === 1) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"web_search","arguments":{"query":"football referee app"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [{ name: 'web_search', arguments: { query: 'football referee app' } }],
          },
        };
      }

      if (this.turns === 2) {
        return {
          message:
            '<agent-response>{"mode":"tool","calls":[{"name":"web_fetch","arguments":{"url":"https://www.fifa.com/about-fifa/development/referee-technology"}}]}</agent-response>',
          thinking: '',
          envelope: {
            mode: 'tool',
            calls: [
              {
                name: 'web_fetch',
                arguments: { url: 'https://www.fifa.com/about-fifa/development/referee-technology' },
              },
            ],
          },
        };
      }

      return {
        message: '<agent-response>{"mode":"final","message":"done"}</agent-response>',
        thinking: '',
        envelope: {
          mode: 'final',
          message: 'done',
        },
      };
    },
  };

  const session = await createSession(provider);
  const webSearchDefinition = session.toolRegistry.get('web_search');
  session.toolRegistry.register({
    ...webSearchDefinition,
    handler: async () => ({
      query: 'football referee app',
      provider: 'duckduckgo',
      results: [
        {
          title: 'REFSIX',
          url: 'https://refsix.com/',
          snippet: 'Football referee app',
          availability: { ok: true, status: 200, url: 'https://refsix.com/', reason: 'ok' },
        },
      ],
      filteredInaccessibleResults: 0,
      inaccessibleResultsDetected: false,
      truncated: false,
    }),
  });

  const webFetchDefinition = session.toolRegistry.get('web_fetch');
  session.toolRegistry.register({
    ...webFetchDefinition,
    handler: async (_context, args) => ({
      url: args.url,
      title: 'REFSIX',
      content: 'verified content',
    }),
  });

  const runtime = new AgentRuntime({ provider });
  const result = await runtime.runUserTurn(session, 'research this');

  assert.equal(result.status, 'completed');
  assert.equal(session.toolEvents[1]?.status, 'completed');
  assert.equal(session.toolEvents[1]?.result?.runtimeRedirected, true);
  assert.equal(session.toolEvents[1]?.result?.requestedUrl, 'https://www.fifa.com/about-fifa/development/referee-technology');
  assert.equal(session.toolEvents[1]?.result?.url, 'https://refsix.com/');
  assert.match(session.toolEvents[1]?.resultPreview ?? '', /Reused exact search-result URL/i);
});

test('runtime can stop an in-flight request', async () => {
  const provider = {
    async getCapabilities() {
      return { nativeTools: true, structuredOutput: true, streaming: true };
    },
    async runTurn({ signal }) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(createAbortError('Request stopped by user.')),
          { once: true }
        );
      });
    },
  };

  const session = await createSession(provider);
  const runtime = new AgentRuntime({ provider });
  const controller = new AbortController();
  const runPromise = runtime.runUserTurn(session, 'start a long task', {
    signal: controller.signal,
  });

  controller.abort();

  const result = await runPromise;
  assert.equal(result.status, 'cancelled');
  assert.match(session.messages.at(-1)?.content ?? '', /İstek durduruldu/);
});

test('runtime marks a long-running command tool as cancelled when stopped', async () => {
  const provider = {
    turns: 0,
    async getCapabilities() {
      return { nativeTools: true, structuredOutput: true, streaming: true };
    },
    async runTurn() {
      this.turns += 1;
      if (this.turns === 1) {
        return {
          message: '',
          thinking: '',
          toolCalls: [
            {
              name: 'run_command',
              arguments: {
                command:
                  process.platform === 'win32'
                    ? 'Start-Sleep -Seconds 30'
                    : 'sleep 30',
              },
            },
          ],
        };
      }

      return {
        message: 'done',
        thinking: '',
        toolCalls: [],
      };
    },
  };

  const session = await createSession(provider);
  const runtime = new AgentRuntime({ provider });
  const controller = new AbortController();
  const runPromise = runtime.runUserTurn(session, 'run a long command', {
    signal: controller.signal,
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();

  const result = await runPromise;
  assert.equal(result.status, 'cancelled');
  assert.equal(session.toolEvents[0]?.status, 'cancelled');
  assert.match(session.toolEvents[0]?.resultPreview ?? '', /stopped by user/i);
});
