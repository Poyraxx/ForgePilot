import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAbortError } from '../src/core/abort.js';
import { PermissionPreset } from '../src/core/contracts.js';
import { SessionService } from '../src/main/session-service.js';

const DEFAULT_MODEL_SETTINGS = {
  contextLength: 32768,
  temperature: 0.2,
  systemPrompt: '',
};

function createFakeProvider() {
  return {
    async listModels() {
      return [
        {
          name: 'fake-model',
          capabilities: {
            nativeTools: true,
            structuredOutput: true,
            streaming: true,
          },
        },
      ];
    },
    async getCapabilities() {
      return {
        nativeTools: true,
        structuredOutput: true,
        streaming: true,
      };
    },
    async runTurn({ messages }) {
      const lastMessage = messages.at(-1)?.content ?? '';
      return {
        message: `echo:${lastMessage}`,
        thinking: '',
        toolCalls: [],
      };
    },
  };
}

test('session service persists settings and chat history across restarts', async () => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-app-'));
  const workspaceRoot = path.join(appRoot, 'workspace');
  const statePath = path.join(appRoot, 'state', 'desktop-state.json');
  await fs.mkdir(workspaceRoot, { recursive: true });

  const provider = createFakeProvider();
  const firstService = new SessionService({ appRoot, provider, statePath });

  await firstService.saveAppState({
    preferences: {
      language: 'tr',
      workspaceRoot,
      model: 'fake-model',
      permissionPreset: PermissionPreset.ASK,
      modelSettings: {
        contextLength: 65536,
        temperature: 0.4,
        systemPrompt: 'Persist this prompt.',
      },
      showRuntimeSettings: true,
    },
    lastSessionId: null,
  });

  const created = await firstService.createSession({
    workspaceRoot,
    model: 'fake-model',
    permissionPreset: PermissionPreset.ASK,
    modelSettings: {
      contextLength: 65536,
      temperature: 0.4,
      systemPrompt: 'Persist this prompt.',
    },
  });

  await firstService.sendUserMessage(created.session.id, 'remember this thread');

  const secondService = new SessionService({ appRoot, provider, statePath });
  const bootstrap = await secondService.bootstrap();

  assert.equal(bootstrap.defaultWorkspace, workspaceRoot);
  assert.equal(bootstrap.defaultLanguage, 'tr');
  assert.equal(bootstrap.defaultModel, 'fake-model');
  assert.equal(bootstrap.defaultPermissionPreset, PermissionPreset.ASK);
  assert.equal(bootstrap.defaultModelSettings.contextLength, 65536);
  assert.equal(bootstrap.defaultModelSettings.temperature, 0.4);
  assert.equal(bootstrap.defaultModelSettings.systemPrompt, 'Persist this prompt.');
  assert.equal(bootstrap.defaultShowRuntimeSettings, true);
  assert.equal(bootstrap.sessionSummaries.length, 1);
  assert.equal(bootstrap.activeSession?.id, created.session.id);

  const restored = await secondService.getSession(created.session.id);
  const restoredUserMessages = restored.session.messages.filter((message) => message.role === 'user');

  assert.equal(restoredUserMessages.length, 1);
  assert.equal(restoredUserMessages[0].content, 'remember this thread');

  const resumed = await secondService.sendUserMessage(created.session.id, 'continue after restart');
  const assistantMessages = resumed.session.messages.filter((message) => message.role === 'assistant');

  assert.match(assistantMessages.at(-1)?.content ?? '', /echo:continue after restart/);
});

test('session service can update an existing session config in place and delete persisted threads', async () => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-app-'));
  const workspaceRoot = path.join(appRoot, 'workspace-a');
  const nextWorkspaceRoot = path.join(appRoot, 'workspace-b');
  const statePath = path.join(appRoot, 'state', 'desktop-state.json');
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(nextWorkspaceRoot, { recursive: true });

  const provider = createFakeProvider();
  const service = new SessionService({ appRoot, provider, statePath });
  const created = await service.createSession({
    workspaceRoot,
    model: 'fake-model',
    permissionPreset: PermissionPreset.FULL_ACCESS,
    modelSettings: {
      contextLength: 32768,
      temperature: 0.2,
      systemPrompt: '',
    },
  });

  await service.sendUserMessage(created.session.id, 'keep my history');

  const updated = await service.updateSessionConfig(created.session.id, {
    workspaceRoot: nextWorkspaceRoot,
    model: 'fake-model',
    permissionPreset: PermissionPreset.ASK,
    modelSettings: {
      contextLength: 131072,
      temperature: 0.7,
      systemPrompt: 'Use the new profile.',
    },
  });

  assert.equal(updated.session.workspaceRoot, nextWorkspaceRoot);
  assert.equal(updated.session.permissionPreset, PermissionPreset.ASK);
  assert.equal(updated.session.modelSettings.contextLength, 131072);
  assert.equal(updated.session.modelSettings.temperature, 0.7);
  assert.equal(updated.session.modelSettings.systemPrompt, 'Use the new profile.');

  const restored = await service.getSession(created.session.id);
  const restoredUserMessages = restored.session.messages.filter((message) => message.role === 'user');

  assert.equal(restoredUserMessages.length, 1);
  assert.equal(restoredUserMessages[0].content, 'keep my history');

  const deletion = await service.deleteSession(created.session.id);

  assert.equal(deletion.sessionSummaries.length, 0);
  assert.equal(deletion.activeSession, null);

  const secondService = new SessionService({ appRoot, provider, statePath });
  const bootstrap = await secondService.bootstrap();

  assert.equal(bootstrap.sessionSummaries.length, 0);
  assert.equal(bootstrap.activeSession, null);
});

test('session service reloads MCP tools when MCP servers are saved in preferences', async () => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-app-'));
  const workspaceRoot = path.join(appRoot, 'workspace');
  const statePath = path.join(appRoot, 'state', 'desktop-state.json');
  await fs.mkdir(workspaceRoot, { recursive: true });

  const provider = createFakeProvider();
  const service = new SessionService({ appRoot, provider, statePath });
  const created = await service.createSession({
    workspaceRoot,
    model: 'fake-model',
    permissionPreset: PermissionPreset.FULL_ACCESS,
    modelSettings: {
      contextLength: 32768,
      temperature: 0.2,
      systemPrompt: '',
    },
  });

  const fixturePath = path.resolve('fixtures/mcp-fixture/server.mjs');
  const saveResult = await service.saveAppState({
    preferences: {
      mcpServers: [
        {
          id: 'fixture-mcp',
          name: 'Fixture MCP',
          command: process.execPath,
          args: [fixturePath],
          enabled: true,
        },
      ],
    },
  });

  assert.equal(saveResult.status, 'saved');
  assert.equal(saveResult.mcpServers.length, 1);
  assert.equal(saveResult.mcpServers[0].status, 'connected');

  const restored = await service.getSession(created.session.id);
  const toolNames = restored.session.availableTools.map((tool) => tool.name);

  assert.ok(toolNames.includes('mcp.fixture-mcp.echo'));
  assert.ok(toolNames.includes('mcp.fixture-mcp.write_note'));
});

test('session service imports attachments into the workspace and persists them across restarts', async () => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-app-'));
  const workspaceRoot = path.join(appRoot, 'workspace');
  const statePath = path.join(appRoot, 'state', 'desktop-state.json');
  await fs.mkdir(workspaceRoot, { recursive: true });

  const provider = createFakeProvider();
  const service = new SessionService({ appRoot, provider, statePath });
  const created = await service.createSession({
    workspaceRoot,
    model: 'fake-model',
    permissionPreset: PermissionPreset.FULL_ACCESS,
    modelSettings: {
      contextLength: 32768,
      temperature: 0.2,
      systemPrompt: '',
    },
  });

  const imported = await service.importAttachments(created.session.id, [
    {
      clientId: 'client-1',
      name: 'report.pdf',
      type: 'application/pdf',
      size: 5,
      bytes: Buffer.from('hello'),
    },
  ]);

  assert.equal(imported.status, 'imported');
  assert.equal(imported.attachments.length, 1);
  assert.match(imported.attachments[0].path, /\.cokgizlicoder\/attachments\//);
  assert.equal(
    await fs.readFile(path.join(workspaceRoot, imported.attachments[0].path), 'utf8'),
    'hello'
  );

  const secondService = new SessionService({ appRoot, provider, statePath });
  const restored = await secondService.getSession(created.session.id);

  assert.equal(restored.session.attachments.length, 1);
  assert.equal(restored.session.attachments[0].originalName, 'report.pdf');
});

test('session service can cancel an active run', async () => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-app-'));
  const workspaceRoot = path.join(appRoot, 'workspace');
  const statePath = path.join(appRoot, 'state', 'desktop-state.json');
  await fs.mkdir(workspaceRoot, { recursive: true });

  const provider = {
    async listModels() {
      return [{ name: 'fake-model', capabilities: { nativeTools: true, structuredOutput: true, streaming: true } }];
    },
    async getCapabilities() {
      return {
        nativeTools: true,
        structuredOutput: true,
        streaming: true,
      };
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

  const service = new SessionService({ appRoot, provider, statePath });
  const created = await service.createSession({
    workspaceRoot,
    model: 'fake-model',
    permissionPreset: PermissionPreset.FULL_ACCESS,
    modelSettings: {
      contextLength: 32768,
      temperature: 0.2,
      systemPrompt: '',
    },
  });

  const sendPromise = service.sendUserMessage(created.session.id, 'start a long task');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const cancelResult = await service.cancelActiveRun(created.session.id);
  assert.equal(cancelResult.status, 'cancelled');
  assert.match(cancelResult.session.messages.at(-1)?.content ?? '', /İstek durduruldu/);

  const result = await sendPromise;
  assert.equal(result.status, 'cancelled');
  assert.match(result.session.messages.at(-1)?.content ?? '', /İstek durduruldu/);
});

test('session service returns an error session instead of rejecting when Ollama is offline', async () => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-app-'));
  const workspaceRoot = path.join(appRoot, 'workspace');
  const statePath = path.join(appRoot, 'state', 'desktop-state.json');
  await fs.mkdir(workspaceRoot, { recursive: true });

  const provider = {
    async listModels() {
      return [{ name: 'fake-model', capabilities: { nativeTools: true, structuredOutput: true, streaming: true } }];
    },
    async getCapabilities() {
      return {
        nativeTools: true,
        structuredOutput: true,
        streaming: true,
      };
    },
    async runTurn() {
      throw new Error(
        "Ollama baglantisi kurulamadi (127.0.0.1:11434). Ollama kapali gibi gorunuyor. Once Ollama'yi baslat ve sonra tekrar dene."
      );
    },
  };

  const service = new SessionService({ appRoot, provider, statePath });
  const created = await service.createSession({
    workspaceRoot,
    model: 'fake-model',
    permissionPreset: PermissionPreset.FULL_ACCESS,
    modelSettings: {
      contextLength: 32768,
      temperature: 0.2,
      systemPrompt: '',
    },
  });

  const result = await service.sendUserMessage(created.session.id, 'check something online');

  assert.equal(result.status, 'error');
  assert.match(result.errorMessage ?? '', /Ollama baglantisi kurulamadi/i);
  assert.match(result.session.messages.at(-1)?.content ?? '', /Ollama baglantisi kurulamadi/i);
});

test('session service can cancel a resumed run after approval', async () => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-app-'));
  const workspaceRoot = path.join(appRoot, 'workspace');
  const statePath = path.join(appRoot, 'state', 'desktop-state.json');
  await fs.mkdir(workspaceRoot, { recursive: true });

  const provider = {
    turns: 0,
    async listModels() {
      return [{ name: 'fake-model', capabilities: { nativeTools: true, structuredOutput: true, streaming: true } }];
    },
    async getCapabilities() {
      return {
        nativeTools: true,
        structuredOutput: true,
        streaming: true,
      };
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
                command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30',
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

  const service = new SessionService({ appRoot, provider, statePath });
  const created = await service.createSession({
    workspaceRoot,
    model: 'fake-model',
    permissionPreset: PermissionPreset.ASK,
    modelSettings: {
      contextLength: 32768,
      temperature: 0.2,
      systemPrompt: '',
    },
  });

  const firstPass = await service.sendUserMessage(created.session.id, 'run a long command');
  assert.equal(firstPass.status, 'approval_required');

  const approvalPromise = service.resolveApproval(created.session.id, true);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const cancelResult = await service.cancelActiveRun(created.session.id);
  assert.equal(cancelResult.status, 'cancelled');

  const result = await approvalPromise;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.session.toolEvents.at(-1)?.status, 'cancelled');
  assert.match(result.session.messages.at(-1)?.content ?? '', /İstek durduruldu/);
});

test('session service closes lingering running tool events after restart', async () => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-app-'));
  const workspaceRoot = path.join(appRoot, 'workspace');
  const statePath = path.join(appRoot, 'state', 'desktop-state.json');
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.mkdir(path.dirname(statePath), { recursive: true });

  const sessionId = 'persisted-session';
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        preferences: {
          workspaceRoot,
          model: 'fake-model',
          permissionPreset: PermissionPreset.FULL_ACCESS,
          modelSettings: {
            contextLength: 32768,
            temperature: 0.2,
            systemPrompt: '',
          },
          showRuntimeSettings: false,
        },
        lastSessionId: sessionId,
        sessions: [
          {
            id: sessionId,
            workspaceRoot,
            model: 'fake-model',
            permissionPreset: PermissionPreset.FULL_ACCESS,
            modelSettings: {
              contextLength: 32768,
              temperature: 0.2,
              systemPrompt: '',
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: [],
            toolEvents: [
              {
                id: 'running-event',
                toolName: 'run_command',
                arguments: { command: 'python something.py' },
                status: 'running',
                createdAt: new Date().toISOString(),
                source: 'runtime',
              },
            ],
            pendingApproval: null,
            knownPaths: ['.'],
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );

  const provider = createFakeProvider();
  const service = new SessionService({ appRoot, provider, statePath });
  const restored = await service.getSession(sessionId);

  assert.equal(restored.session.toolEvents[0]?.status, 'cancelled');
  assert.match(
    restored.session.toolEvents[0]?.resultPreview ?? '',
    /reopened while this run was still active/i
  );
});

test('session service emits serializable live session updates', async () => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-app-'));
  const workspaceRoot = path.join(appRoot, 'workspace');
  const statePath = path.join(appRoot, 'state', 'desktop-state.json');
  await fs.mkdir(workspaceRoot, { recursive: true });

  const provider = createFakeProvider();
  const service = new SessionService({ appRoot, provider, statePath });
  const created = await service.createSession({
    workspaceRoot,
    model: 'fake-model',
    permissionPreset: PermissionPreset.FULL_ACCESS,
    modelSettings: {
      contextLength: 32768,
      temperature: 0.2,
      systemPrompt: '',
    },
  });

  const updates = [];
  const unsubscribe = service.onSessionUpdate((payload) => {
    updates.push(payload);
  });

  await service.sendUserMessage(created.session.id, 'emit progress safely');
  unsubscribe();

  assert.ok(updates.length >= 1);
  assert.doesNotThrow(() => JSON.stringify(updates[0]));
  assert.equal(updates[0].session?.id, created.session.id);
  assert.equal('toolRegistry' in updates[0].session, false);
  assert.equal('pluginRegistry' in updates[0].session, false);
});

test('session service persists provider choice and provider config for multi-provider sessions', async () => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-app-'));
  const workspaceRoot = path.join(appRoot, 'workspace');
  const statePath = path.join(appRoot, 'state', 'desktop-state.json');
  await fs.mkdir(workspaceRoot, { recursive: true });

  const fakeProvider = createFakeProvider();
  const providerRegistry = {
    getCatalog() {
      return [
        {
          id: 'openai_compatible',
          label: 'OpenAI Compatible',
          description: 'Custom compatible endpoint',
          configFields: [],
        },
      ];
    },
    getProvider(providerId) {
      assert.equal(providerId, 'openai_compatible');
      return fakeProvider;
    },
  };

  const firstService = new SessionService({ appRoot, providerRegistry, statePath });
  const created = await firstService.createSession({
    workspaceRoot,
    providerId: 'openai_compatible',
    providerConfig: {
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'preview-key',
    },
    model: 'fake-model',
    permissionPreset: PermissionPreset.FULL_ACCESS,
    modelSettings: DEFAULT_MODEL_SETTINGS,
  });

  assert.equal(created.session.providerId, 'openai_compatible');

  const secondService = new SessionService({ appRoot, providerRegistry, statePath });
  const bootstrap = await secondService.bootstrap();
  const restored = await secondService.getSession(created.session.id);

  assert.equal(bootstrap.defaultProviderId, 'openai_compatible');
  assert.equal(
    bootstrap.providerConfigs.openai_compatible.baseUrl,
    'http://127.0.0.1:1234/v1'
  );
  assert.equal(restored.session.providerId, 'openai_compatible');
});

test('session service returns UI-safe model refresh errors for missing provider auth', async () => {
  const appRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-app-'));
  const statePath = path.join(appRoot, 'state', 'desktop-state.json');

  let getProviderCalls = 0;
  const providerRegistry = {
    getCatalog() {
      return [];
    },
    getProvider() {
      getProviderCalls += 1;
      return createFakeProvider();
    },
  };

  const service = new SessionService({ appRoot, providerRegistry, statePath });
  const openAiResult = await service.listModelsSafe('openai', {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
  });
  const anthropicResult = await service.listModelsSafe('anthropic', {
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
  });

  assert.equal(openAiResult.ok, false);
  assert.match(openAiResult.errorMessage, /OpenAI API key/i);
  assert.equal(anthropicResult.ok, false);
  assert.match(anthropicResult.errorMessage, /Anthropic API key/i);
  assert.equal(getProviderCalls, 0);
});
