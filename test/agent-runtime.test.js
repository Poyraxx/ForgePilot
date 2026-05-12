import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentRuntime } from '../src/core/agent/runtime.js';
import { createAbortError } from '../src/core/abort.js';
import { PermissionPreset } from '../src/core/contracts.js';
import { ToolRegistry } from '../src/core/tool-registry.js';
import { createBuiltInTools } from '../src/core/tools/index.js';

async function createSession(provider, permissionPreset = PermissionPreset.FULL_ACCESS) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-runtime-'));
  const toolRegistry = new ToolRegistry(createBuiltInTools());

  return {
    id: 'session-1',
    workspaceRoot,
    model: 'fake-model',
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
