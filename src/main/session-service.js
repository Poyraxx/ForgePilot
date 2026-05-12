import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { AgentRuntime } from '../core/agent/runtime.js';
import { PermissionPreset, ProviderName, stripExecutableFields } from '../core/contracts.js';
import { McpRegistry } from '../core/mcp/registry.js';
import { PluginRegistry } from '../core/plugins/registry.js';
import {
  ProviderRegistry,
  normalizeProviderConfigs,
  normalizeProviderId,
} from '../core/providers/registry.js';
import { listPermissionPresets } from '../core/permissions.js';
import { relativizeWorkspacePath, resolveWorkspacePath } from '../core/path-guard.js';
import { ToolRegistry } from '../core/tool-registry.js';
import { createBuiltInTools } from '../core/tools/index.js';

const DEFAULT_MODEL_SETTINGS = Object.freeze({
  contextLength: 32768,
  temperature: 0.2,
  systemPrompt: '',
});
const DEFAULT_LANGUAGE = 'en';
const STATE_FILE_VERSION = 2;
const ACTIVE_TOOL_STATUSES = new Set(['queued', 'running', 'pending_approval']);
const ATTACHMENT_DIRECTORY = path.join('.cokgizlicoder', 'attachments');

function nowIso() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveDefaultStatePath() {
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'CokGizliCoder', 'desktop-state.json');
  }

  return path.join(os.homedir(), '.cokgizlicoder', 'desktop-state.json');
}

function truncate(value, maxLength = 44) {
  const text = String(value ?? '').trim();
  if (!text) {
    return 'Yeni sohbet';
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function normalizeWorkspaceRoot(value, fallbackRoot) {
  const candidate = String(value ?? '').trim();
  return path.resolve(candidate || fallbackRoot);
}

function normalizePermissionPreset(value) {
  return Object.values(PermissionPreset).includes(value)
    ? value
    : PermissionPreset.FULL_ACCESS;
}

function normalizeContextLength(value) {
  const parsed = Number.parseInt(value ?? DEFAULT_MODEL_SETTINGS.contextLength, 10);
  if (!Number.isFinite(parsed) || parsed < 1024) {
    return DEFAULT_MODEL_SETTINGS.contextLength;
  }

  return parsed;
}

function normalizeTemperature(value) {
  const parsed = Number.parseFloat(value ?? DEFAULT_MODEL_SETTINGS.temperature);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MODEL_SETTINGS.temperature;
  }

  return Math.min(2, Math.max(0, parsed));
}

function normalizeModelSettings(modelSettings = {}) {
  return {
    contextLength: normalizeContextLength(modelSettings.contextLength),
    temperature: normalizeTemperature(modelSettings.temperature),
    systemPrompt: String(modelSettings.systemPrompt ?? '').trim(),
  };
}

function normalizeLanguage(value) {
  return value === 'tr' ? 'tr' : DEFAULT_LANGUAGE;
}

function normalizeMcpEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => String(key).trim())
      .map(([key, envValue]) => [String(key), String(envValue ?? '')])
  );
}

function normalizeMcpArgs(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item));
}

function normalizeMcpServer(value, fallbackId = randomUUID()) {
  const name = String(value?.name ?? '').trim();
  const command = String(value?.command ?? '').trim();
  const cwd = String(value?.cwd ?? '').trim();

  return {
    id: String(value?.id ?? fallbackId).trim() || fallbackId,
    name: name || command || 'MCP Server',
    command,
    args: normalizeMcpArgs(value?.args),
    cwd,
    env: normalizeMcpEnv(value?.env),
    enabled: value?.enabled !== false,
  };
}

function normalizeMcpServers(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeMcpServer(item))
    .filter((server) => server.command);
}

function normalizePreferences(preferences = {}, fallbackRoot = process.cwd()) {
  return {
    language: normalizeLanguage(preferences.language),
    workspaceRoot: normalizeWorkspaceRoot(preferences.workspaceRoot, fallbackRoot),
    providerId: normalizeProviderId(preferences.providerId, ProviderName.OLLAMA),
    providerConfigs: normalizeProviderConfigs(preferences.providerConfigs),
    model: String(preferences.model ?? '').trim(),
    permissionPreset: normalizePermissionPreset(preferences.permissionPreset),
    modelSettings: normalizeModelSettings(preferences.modelSettings),
    showRuntimeSettings: Boolean(preferences.showRuntimeSettings),
    mcpServers: normalizeMcpServers(preferences.mcpServers),
  };
}

function buildProviderConfigError(providerId, providerConfig = {}) {
  if (providerId === ProviderName.OPENAI && !String(providerConfig.apiKey ?? '').trim()) {
    return 'OpenAI API key is not configured yet. Add it in Settings > General > Provider.';
  }

  if (providerId === ProviderName.ANTHROPIC && !String(providerConfig.apiKey ?? '').trim()) {
    return 'Anthropic API key is not configured yet. Add it in Settings > General > Provider.';
  }

  return null;
}

function normalizeListModelsError(providerId, error) {
  const message = String(error?.message ?? error ?? '').trim();

  if (
    providerId === ProviderName.OPENAI &&
    /Missing bearer authentication|invalid[_ -]?request|authentication|Incorrect API key/i.test(
      message
    )
  ) {
    return 'OpenAI API key is missing or invalid. Check Settings > General > Provider.';
  }

  if (
    providerId === ProviderName.OPENAI_COMPATIBLE &&
    /Missing bearer authentication|authentication/i.test(message)
  ) {
    return 'This OpenAI-compatible endpoint requires an API key. Add it in Settings > General > Provider.';
  }

  if (
    providerId === ProviderName.ANTHROPIC &&
    /x-api-key header is required|authentication_error|api[_ -]?key/i.test(message)
  ) {
    return 'Anthropic API key is missing or invalid. Check Settings > General > Provider.';
  }

  return message || 'Model list could not be loaded for this provider.';
}

function areModelSettingsEqual(left = {}, right = {}) {
  const normalizedLeft = normalizeModelSettings(left);
  const normalizedRight = normalizeModelSettings(right);

  return (
    normalizedLeft.contextLength === normalizedRight.contextLength &&
    normalizedLeft.temperature === normalizedRight.temperature &&
    normalizedLeft.systemPrompt === normalizedRight.systemPrompt
  );
}

function serializeMessage(message) {
  return {
    id: message.id,
    role: message.role,
    content: message.displayContent ?? message.content,
    rawContent: message.content,
    thinking: message.thinking ?? '',
    toolCalls: message.toolCalls ?? [],
    isToolTrace: Boolean(message.isToolTrace),
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    createdAt: message.createdAt,
  };
}

function serializeMessageRecord(message) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    displayContent: message.displayContent ?? null,
    thinking: message.thinking ?? '',
    toolCalls: message.toolCalls ?? [],
    toolName: message.toolName ?? null,
    isToolTrace: Boolean(message.isToolTrace),
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    createdAt: message.createdAt,
  };
}

function hydrateMessageRecord(message) {
  return {
    id: message.id,
    role: message.role,
    content: String(message.content ?? ''),
    displayContent: message.displayContent || undefined,
    thinking: message.thinking ?? '',
    toolCalls: Array.isArray(message.toolCalls) ? message.toolCalls : [],
    toolName: message.toolName || undefined,
    isToolTrace: Boolean(message.isToolTrace),
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
    createdAt: message.createdAt ?? nowIso(),
  };
}

function serializeAttachmentRecord(attachment) {
  return {
    id: String(attachment.id ?? ''),
    clientId: attachment.clientId ? String(attachment.clientId) : null,
    name: String(attachment.name ?? ''),
    originalName: String(attachment.originalName ?? attachment.name ?? ''),
    path: String(attachment.path ?? ''),
    mimeType: String(attachment.mimeType ?? ''),
    size: Number(attachment.size ?? 0),
    attachedAt: attachment.attachedAt ?? nowIso(),
  };
}

function hydrateAttachmentRecord(attachment) {
  return serializeAttachmentRecord(attachment);
}

function serializeToolEvent(event) {
  return {
    ...event,
    result: event.result ?? null,
  };
}

function normalizeKnownPaths(knownPaths = []) {
  const values = knownPaths instanceof Set ? [...knownPaths] : knownPaths;
  return [...new Set(['.', ...(Array.isArray(values) ? values : [])].map((item) => String(item)))];
}

function sanitizeAttachmentName(value) {
  const baseName = path.basename(String(value ?? '').trim() || 'attachment');
  const sanitized = baseName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return sanitized || 'attachment';
}

function normalizeAttachmentRelativePath(relativePath) {
  return String(relativePath ?? '').replace(/\\/g, '/');
}

function toNodeBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }

  if (Array.isArray(value)) {
    return Buffer.from(value);
  }

  throw new Error('Attachment payload must include binary bytes.');
}

function settleLingeringToolState(
  session,
  message = 'The active run was interrupted before it could finish.'
) {
  let changed = false;

  for (const event of session.toolEvents ?? []) {
    if (!ACTIVE_TOOL_STATUSES.has(event.status)) {
      continue;
    }

    event.status = 'cancelled';
    event.completedAt ??= nowIso();
    event.resultPreview = message;
    event.result = {
      cancelled: true,
      message,
    };
    changed = true;
  }

  if (session.pendingApproval) {
    session.pendingApproval = null;
    changed = true;
  }

  if (changed) {
    session.updatedAt = nowIso();
  }

  return changed;
}

function isBlockingRuntimeError(error) {
  return /Resolve the pending approval before sending another message\./i.test(
    String(error?.message ?? '')
  );
}

function buildAssistantErrorMessage(error) {
  const rawMessage = String(error?.message ?? error ?? '').trim();
  return rawMessage || 'Istek islenirken beklenmeyen bir hata olustu.';
}

function appendAssistantMessage(session, content) {
  const message = String(content ?? '').trim();
  if (!message) {
    return;
  }

  const lastAssistantMessage = session.messages.at(-1);
  if (lastAssistantMessage?.role === 'assistant' && lastAssistantMessage.content === message) {
    return;
  }

  session.messages.push({
    id: randomUUID(),
    role: 'assistant',
    content: message,
    thinking: '',
    toolCalls: [],
    createdAt: nowIso(),
  });
}

function createDefaultPersistedState(appRoot) {
  return {
    version: STATE_FILE_VERSION,
    preferences: normalizePreferences({}, appRoot),
    lastSessionId: null,
  };
}

export class SessionService {
  constructor({
    appRoot = process.cwd(),
    provider = null,
    providerRegistry = null,
    statePath = resolveDefaultStatePath(),
  } = {}) {
    this.appRoot = appRoot;
    this.provider = provider;
    this.providerRegistry = providerRegistry ?? (provider ? null : new ProviderRegistry());
    this.defaultProviderId = normalizeProviderId(provider?.name ?? ProviderName.OLLAMA);
    this.statePath = statePath;
    this.sessions = new Map();
    this.activeRuns = new Map();
    this.appState = createDefaultPersistedState(appRoot);
    this.mcpRegistry = new McpRegistry();
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    this.ready = this.#loadPersistedState();
  }

  onSessionUpdate(listener) {
    this.events.on('session-updated', listener);
    return () => {
      this.events.removeListener('session-updated', listener);
    };
  }

  async bootstrap() {
    await this.ready;

    const activeSession = this.appState.lastSessionId
      ? this.sessions.get(this.appState.lastSessionId) ?? null
      : null;
    const selectedProviderId =
      activeSession?.providerId ?? this.appState.preferences.providerId ?? this.defaultProviderId;
    const modelRefresh = await this.listModelsSafe(selectedProviderId);
    const models = modelRefresh.models;
    const providerError = modelRefresh.ok ? null : modelRefresh.errorMessage;

    const defaultModel = this.appState.preferences.model || models[0]?.name || '';

    return {
      appName: 'ForgePilot',
      defaultLanguage: this.appState.preferences.language,
      defaultWorkspace: this.appState.preferences.workspaceRoot,
      defaultProviderId: selectedProviderId,
      providerConfigs: this.appState.preferences.providerConfigs,
      providers: this.#getProviderCatalog(),
      defaultModel,
      defaultPermissionPreset: this.appState.preferences.permissionPreset,
      defaultModelSettings: this.appState.preferences.modelSettings,
      defaultShowRuntimeSettings: this.appState.preferences.showRuntimeSettings,
      mcpServers: this.mcpRegistry.getServers(),
      permissionPresets: listPermissionPresets(),
      loadedModelsProviderId: selectedProviderId,
      models,
      providerError,
      sessionSummaries: this.#listSessionSummaries(),
      activeSession: activeSession ? this.serializeSession(activeSession) : null,
    };
  }

  async listModels(providerId = this.appState.preferences.providerId, providerConfig = null) {
    await this.ready;
    const result = await this.listModelsSafe(providerId, providerConfig);
    if (!result.ok) {
      throw new Error(result.errorMessage);
    }

    return result.models;
  }

  async listModelsSafe(
    providerId = this.appState.preferences.providerId,
    providerConfig = null
  ) {
    await this.ready;

    const normalizedProviderId = normalizeProviderId(providerId, this.defaultProviderId);
    const mergedProviderConfigs = providerConfig
      ? {
          ...this.appState.preferences.providerConfigs,
          [normalizedProviderId]: {
            ...(this.appState.preferences.providerConfigs?.[normalizedProviderId] ?? {}),
            ...providerConfig,
          },
        }
      : this.appState.preferences.providerConfigs;
    const normalizedConfigs = normalizeProviderConfigs(mergedProviderConfigs);
    const effectiveProviderConfig = normalizedConfigs[normalizedProviderId] ?? {};
    const providerConfigError = buildProviderConfigError(
      normalizedProviderId,
      effectiveProviderConfig
    );

    if (providerConfigError) {
      return {
        ok: false,
        providerId: normalizedProviderId,
        models: [],
        errorMessage: providerConfigError,
      };
    }

    try {
      const models = await this.#getProvider(normalizedProviderId, providerConfig).listModels();
      return {
        ok: true,
        providerId: normalizedProviderId,
        models,
        errorMessage: null,
      };
    } catch (error) {
      return {
        ok: false,
        providerId: normalizedProviderId,
        models: [],
        errorMessage: normalizeListModelsError(normalizedProviderId, error),
      };
    }
  }

  async createSession({
    workspaceRoot,
    providerId,
    providerConfig,
    model,
    permissionPreset = PermissionPreset.FULL_ACCESS,
    modelSettings = DEFAULT_MODEL_SETTINGS,
  }) {
    await this.ready;

    if (!model) {
      throw new Error('A model must be selected before creating a session.');
    }

    const selectedProviderId = normalizeProviderId(
      providerId ?? this.appState.preferences.providerId,
      this.defaultProviderId
    );
    if (providerConfig) {
      this.#mergeProviderConfigIntoPreferences(selectedProviderId, providerConfig);
    }
    const resolvedWorkspace = normalizeWorkspaceRoot(workspaceRoot, this.appRoot);
    const normalizedModelSettings = normalizeModelSettings(modelSettings);
    const { pluginRegistry, toolRegistry } = await this.#createRuntimeRegistries(resolvedWorkspace);
    const selectedProvider = this.#getProvider(selectedProviderId);

    const session = {
      id: randomUUID(),
      workspaceRoot: resolvedWorkspace,
      providerId: selectedProviderId,
      model,
      permissionPreset: normalizePermissionPreset(permissionPreset),
      modelSettings: normalizedModelSettings,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: [],
      toolEvents: [],
      pendingApproval: null,
      attachments: [],
      capabilityOverride: null,
      knownPaths: new Set(['.']),
      toolRegistry,
      pluginRegistry,
    };

    session.capabilities = await selectedProvider.getCapabilities(model);
    this.sessions.set(session.id, session);
    this.appState.preferences = {
      ...this.appState.preferences,
      workspaceRoot: resolvedWorkspace,
      providerId: selectedProviderId,
      model,
      permissionPreset: session.permissionPreset,
      modelSettings: normalizedModelSettings,
    };
    this.appState.lastSessionId = session.id;
    await this.#persistState();

    return {
      status: 'created',
      session: this.serializeSession(session),
    };
  }

  async getSession(sessionId) {
    await this.ready;
    const session = this.#requireSession(sessionId);
    return { session: this.serializeSession(session) };
  }

  async importAttachments(sessionId, attachments = []) {
    await this.ready;
    const session = this.#requireSession(sessionId);

    if (!Array.isArray(attachments) || attachments.length === 0) {
      return {
        status: 'noop',
        attachments: [],
        session: this.serializeSession(session),
      };
    }

    const imported = [];
    for (const attachment of attachments) {
      const importedAttachment = await this.#storeAttachment(session, attachment);
      imported.push(importedAttachment);
    }

    if (imported.length > 0) {
      session.updatedAt = nowIso();
      this.appState.lastSessionId = session.id;
      await this.#persistState();
      this.#emitSessionUpdate(session, {
        phase: 'attachments_imported',
        status: 'attachments_imported',
      });
    }

    return {
      status: imported.length > 0 ? 'imported' : 'noop',
      attachments: imported.map(serializeAttachmentRecord),
      session: this.serializeSession(session),
    };
  }

  async sendUserMessage(sessionId, content) {
    await this.ready;
    const session = this.#requireSession(sessionId);
    if (this.activeRuns.has(sessionId)) {
      throw new Error('A request is already running for this session.');
    }

    settleLingeringToolState(
      session,
      'A previous run did not finish cleanly and was closed before this new request started.'
    );

    const controller = new AbortController();
    this.activeRuns.set(sessionId, controller);
    const runtime = this.#createRuntime(session.providerId);

    try {
      const result = await runtime.runUserTurn(session, content, {
        signal: controller.signal,
        onProgress: (update) => {
          this.#emitSessionUpdate(session, update);
        },
      });
      session.updatedAt = nowIso();
      this.appState.lastSessionId = session.id;
      await this.#persistState();
      this.#emitSessionUpdate(session, { phase: result.status, status: result.status });
      return {
        status: result.status,
        session: this.serializeSession(session),
      };
    } catch (error) {
      if (isBlockingRuntimeError(error)) {
        throw error;
      }

      const errorMessage = buildAssistantErrorMessage(error);
      appendAssistantMessage(session, errorMessage);
      session.updatedAt = nowIso();
      this.appState.lastSessionId = session.id;
      await this.#persistState();
      this.#emitSessionUpdate(session, {
        phase: 'error',
        status: 'error',
        errorMessage,
      });
      return {
        status: 'error',
        errorMessage,
        session: this.serializeSession(session),
      };
    } finally {
      this.activeRuns.delete(sessionId);
    }
  }

  async resolveApproval(sessionId, approved) {
    await this.ready;
    const session = this.#requireSession(sessionId);
    if (this.activeRuns.has(sessionId)) {
      throw new Error('A request is already running for this session.');
    }

    const controller = new AbortController();
    this.activeRuns.set(sessionId, controller);
    const runtime = this.#createRuntime(session.providerId);

    try {
      const result = await runtime.resolvePendingApproval(session, approved, {
        signal: controller.signal,
        onProgress: (update) => {
          this.#emitSessionUpdate(session, update);
        },
      });
      session.updatedAt = nowIso();
      this.appState.lastSessionId = session.id;
      await this.#persistState();
      this.#emitSessionUpdate(session, { phase: result.status, status: result.status });
      return {
        status: result.status,
        session: this.serializeSession(session),
      };
    } catch (error) {
      const errorMessage = buildAssistantErrorMessage(error);
      appendAssistantMessage(session, errorMessage);
      session.updatedAt = nowIso();
      this.appState.lastSessionId = session.id;
      await this.#persistState();
      this.#emitSessionUpdate(session, {
        phase: 'error',
        status: 'error',
        errorMessage,
      });
      return {
        status: 'error',
        errorMessage,
        session: this.serializeSession(session),
      };
    } finally {
      this.activeRuns.delete(sessionId);
    }
  }

  async cancelActiveRun(sessionId) {
    await this.ready;
    const session = this.#requireSession(sessionId);
    const controller = this.activeRuns.get(sessionId);

    if (!controller) {
      return {
        status: 'idle',
        session: this.serializeSession(session),
      };
    }

    controller.abort();

    const timeoutAt = Date.now() + 3_000;
    while (this.activeRuns.has(sessionId) && Date.now() < timeoutAt) {
      await delay(25);
    }

    const didSettleLingering = !this.activeRuns.has(sessionId)
      ? settleLingeringToolState(session, 'Request stopped by user.')
      : false;
    if (didSettleLingering) {
      await this.#persistState();
      this.#emitSessionUpdate(session, { phase: 'cancelled', status: 'cancelled' });
    }

    return {
      status: this.activeRuns.has(sessionId) ? 'cancelling' : 'cancelled',
      session: this.serializeSession(session),
    };
  }

  async updateSessionConfig(
    sessionId,
    {
      workspaceRoot,
      providerId,
      providerConfig,
      model,
      permissionPreset,
      modelSettings,
    } = {}
  ) {
    await this.ready;

    const session = this.#requireSession(sessionId);
    const nextWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot ?? session.workspaceRoot, this.appRoot);
    const nextProviderId = normalizeProviderId(providerId ?? session.providerId, this.defaultProviderId);
    const nextModel = String(model ?? session.model).trim();
    const nextPermissionPreset = normalizePermissionPreset(
      permissionPreset ?? session.permissionPreset
    );
    const nextModelSettings = normalizeModelSettings(modelSettings ?? session.modelSettings);

    if (!nextModel) {
      throw new Error('A model must be selected before updating a session.');
    }

    if (providerConfig) {
      this.#mergeProviderConfigIntoPreferences(nextProviderId, providerConfig);
    }

    const workspaceChanged = nextWorkspaceRoot !== session.workspaceRoot;
    const providerChanged = nextProviderId !== session.providerId;
    const modelChanged = nextModel !== session.model;
    const permissionChanged = nextPermissionPreset !== session.permissionPreset;
    const modelSettingsChanged = !areModelSettingsEqual(nextModelSettings, session.modelSettings);

    if (!workspaceChanged && !providerChanged && !modelChanged && !permissionChanged && !modelSettingsChanged) {
      return {
        status: 'unchanged',
        session: this.serializeSession(session),
      };
    }

    if (workspaceChanged) {
      const { pluginRegistry, toolRegistry } = await this.#createRuntimeRegistries(nextWorkspaceRoot);
      session.workspaceRoot = nextWorkspaceRoot;
      session.pluginRegistry = pluginRegistry;
      session.toolRegistry = toolRegistry;
      session.attachments = [];
      session.knownPaths = new Set(['.']);
      session.pendingApproval = null;
    }

    session.providerId = nextProviderId;
    session.model = nextModel;
    session.permissionPreset = nextPermissionPreset;
    session.modelSettings = nextModelSettings;
    session.capabilities = await this.#getProvider(nextProviderId).getCapabilities(
      nextModel,
      session.capabilityOverride ?? {}
    );
    session.updatedAt = nowIso();

    this.appState.preferences = {
      ...this.appState.preferences,
      workspaceRoot: session.workspaceRoot,
      providerId: session.providerId,
      model: session.model,
      permissionPreset: session.permissionPreset,
      modelSettings: session.modelSettings,
    };
    this.appState.lastSessionId = session.id;
    await this.#persistState();

    return {
      status: 'updated',
      session: this.serializeSession(session),
    };
  }

  async deleteSession(sessionId) {
    await this.ready;

    const existing = this.sessions.get(sessionId);
    if (!existing) {
      return {
        status: 'deleted',
        deletedSessionId: sessionId,
        sessionSummaries: this.#listSessionSummaries(),
        activeSession: this.appState.lastSessionId
          ? this.serializeSession(this.sessions.get(this.appState.lastSessionId))
          : null,
      };
    }

    this.sessions.delete(sessionId);

    if (this.appState.lastSessionId === sessionId) {
      const nextSession = [...this.sessions.values()].sort(
        (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      )[0];
      this.appState.lastSessionId = nextSession?.id ?? null;
    }

    await this.#persistState();

    return {
      status: 'deleted',
      deletedSessionId: sessionId,
      sessionSummaries: this.#listSessionSummaries(),
      activeSession: this.appState.lastSessionId
        ? this.serializeSession(this.sessions.get(this.appState.lastSessionId))
        : null,
    };
  }

  async saveAppState(payload = {}) {
    await this.ready;
    let mcpChanged = false;
    let providerPreferencesChanged = false;

    if (payload.preferences) {
      const previousMcpServers = JSON.stringify(this.appState.preferences.mcpServers ?? []);
      const previousProviderSnapshot = JSON.stringify({
        providerId: this.appState.preferences.providerId,
        providerConfigs: this.appState.preferences.providerConfigs,
      });
      this.appState.preferences = normalizePreferences(
        {
          ...this.appState.preferences,
          ...payload.preferences,
        },
        this.appRoot
      );
      mcpChanged =
        previousMcpServers !== JSON.stringify(this.appState.preferences.mcpServers ?? []);
      providerPreferencesChanged =
        previousProviderSnapshot !==
        JSON.stringify({
          providerId: this.appState.preferences.providerId,
          providerConfigs: this.appState.preferences.providerConfigs,
        });
    }

    if (Object.prototype.hasOwnProperty.call(payload, 'lastSessionId')) {
      this.appState.lastSessionId =
        payload.lastSessionId && this.sessions.has(payload.lastSessionId)
          ? payload.lastSessionId
          : null;
    }

    if (mcpChanged) {
      await this.#reloadMcpRegistry();
      await this.#refreshSessionRegistries();
    }

    if (providerPreferencesChanged) {
      await this.#refreshSessionCapabilities();
    }

    await this.#persistState();
    return {
      status: 'saved',
      preferences: this.appState.preferences,
      mcpServers: this.mcpRegistry.getServers(),
      activeSession: this.appState.lastSessionId
        ? this.serializeSession(this.sessions.get(this.appState.lastSessionId))
        : null,
    };
  }

  async shutdown() {
    await this.ready;

    for (const controller of this.activeRuns.values()) {
      controller.abort();
    }

    const timeoutAt = Date.now() + 1_500;
    while (this.activeRuns.size > 0 && Date.now() < timeoutAt) {
      await delay(25);
    }

    let changed = false;
    for (const session of this.sessions.values()) {
      changed =
        settleLingeringToolState(
          session,
          'The app was closed while this run was still active, so it was cancelled automatically.'
        ) || changed;
    }

    if (changed) {
      await this.#persistState();
    }
  }

  serializeSession(session) {
    return {
      id: session.id,
      workspaceRoot: session.workspaceRoot,
      providerId: session.providerId,
      model: session.model,
      permissionPreset: session.permissionPreset,
      modelSettings: session.modelSettings,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      capabilities: session.capabilities ?? null,
      messages: session.messages.map(serializeMessage),
      toolEvents: session.toolEvents.map(serializeToolEvent),
      pendingApproval: session.pendingApproval
        ? {
            toolName: session.pendingApproval.call.name,
            arguments: session.pendingApproval.call.arguments,
            eventId: session.pendingApproval.eventId,
          }
        : null,
      attachments: Array.isArray(session.attachments)
        ? session.attachments.map(serializeAttachmentRecord)
        : [],
      availableTools: session.toolRegistry
        .listVisibleDefinitions(session.permissionPreset)
        .map((tool) => stripExecutableFields(tool)),
      plugins: session.pluginRegistry.getPlugins(),
    };
  }

  #emitSessionUpdate(session, meta = {}) {
    const { session: _rawSession, ...safeMeta } = meta ?? {};
    this.events.emit('session-updated', {
      sessionId: session.id,
      session: this.serializeSession(session),
      ...safeMeta,
    });
  }

  #requireSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session "${sessionId}".`);
    }

    return session;
  }

  #listSessionSummaries() {
    return [...this.sessions.values()]
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
      .map((session) => {
        const userMessages =
          session.messages?.filter((message) => message.role === 'user') ?? [];
        const firstPrompt = userMessages[0]?.content ?? '';
        const lastPrompt = userMessages.at(-1)?.content ?? '';

        return {
          id: session.id,
          sessionId: session.id,
          title: truncate(firstPrompt || lastPrompt || 'Hazir oturum', 38),
          prompt: lastPrompt,
          updatedAt: session.updatedAt,
          workspaceRoot: session.workspaceRoot,
          providerId: session.providerId,
          model: session.model,
        };
      });
  }

  #getProviderCatalog() {
    if (!this.providerRegistry) {
      return [
        {
          id: this.defaultProviderId,
          label: this.provider?.name ?? 'Provider',
          description: 'Custom provider',
          configFields: [],
        },
      ];
    }

    return this.providerRegistry.getCatalog();
  }

  #mergeProviderConfigIntoPreferences(providerId, providerConfig = {}) {
    const normalizedProviderId = normalizeProviderId(providerId, this.defaultProviderId);
    const mergedConfigs = normalizeProviderConfigs({
      ...this.appState.preferences.providerConfigs,
      [normalizedProviderId]: {
        ...(this.appState.preferences.providerConfigs?.[normalizedProviderId] ?? {}),
        ...(providerConfig ?? {}),
      },
    });

    this.appState.preferences = {
      ...this.appState.preferences,
      providerConfigs: mergedConfigs,
    };
  }

  #getProvider(providerId = this.appState.preferences.providerId, providerConfig = null) {
    if (this.provider) {
      return this.provider;
    }

    const normalizedProviderId = normalizeProviderId(providerId, this.defaultProviderId);
    const providerConfigs = providerConfig
      ? normalizeProviderConfigs({
          ...this.appState.preferences.providerConfigs,
          [normalizedProviderId]: {
            ...(this.appState.preferences.providerConfigs?.[normalizedProviderId] ?? {}),
            ...providerConfig,
          },
        })
      : this.appState.preferences.providerConfigs;

    return this.providerRegistry.getProvider(normalizedProviderId, providerConfigs);
  }

  #createRuntime(providerId) {
    return new AgentRuntime({
      provider: this.#getProvider(providerId),
    });
  }

  async #createRuntimeRegistries(workspaceRoot) {
    const pluginRegistry = new PluginRegistry();
    await pluginRegistry.loadFromDirectories([
      path.join(this.appRoot, 'plugins'),
      path.join(workspaceRoot, '.cokgizlicoder', 'plugins'),
    ]);

    const toolRegistry = new ToolRegistry([
      ...createBuiltInTools(),
      ...this.mcpRegistry.getTools(),
      ...pluginRegistry.getTools(),
    ]);

    return { pluginRegistry, toolRegistry };
  }

  async #loadPersistedState() {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw);
      const nextState = {
        ...createDefaultPersistedState(this.appRoot),
        ...parsed,
        preferences: normalizePreferences(parsed?.preferences, this.appRoot),
      };

      this.appState = nextState;
      await this.#reloadMcpRegistry();

      const persistedSessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
      for (const record of persistedSessions) {
        try {
          const session = await this.#hydrateSession(record);
          this.sessions.set(session.id, session);
        } catch {
          // Skip invalid persisted sessions and keep loading the rest.
        }
      }

      if (!this.sessions.has(this.appState.lastSessionId)) {
        this.appState.lastSessionId = null;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.appState = createDefaultPersistedState(this.appRoot);
      }

      await this.#reloadMcpRegistry();
    }
  }

  async #reloadMcpRegistry() {
    await this.mcpRegistry.loadFromConfigs(this.appState.preferences.mcpServers ?? []);
  }

  async #refreshSessionRegistries() {
    for (const session of this.sessions.values()) {
      const { pluginRegistry, toolRegistry } = await this.#createRuntimeRegistries(
        session.workspaceRoot
      );
      session.pluginRegistry = pluginRegistry;
      session.toolRegistry = toolRegistry;
      this.#emitSessionUpdate(session, {
        phase: 'tools_refreshed',
        status: 'tools_refreshed',
      });
    }
  }

  async #refreshSessionCapabilities() {
    for (const session of this.sessions.values()) {
      if (!session.model) {
        continue;
      }

      try {
        session.capabilities = await this.#getProvider(session.providerId).getCapabilities(
          session.model,
          session.capabilityOverride ?? {}
        );
      } catch {
        session.capabilities = session.capabilities ?? null;
      }
    }
  }

  async #hydrateSession(record) {
    const workspaceRoot = normalizeWorkspaceRoot(record.workspaceRoot, this.appRoot);
    const { pluginRegistry, toolRegistry } = await this.#createRuntimeRegistries(workspaceRoot);
    const capabilityOverride = record.capabilityOverride ?? null;
    const providerId = normalizeProviderId(
      record.providerId ?? this.appState.preferences.providerId,
      this.defaultProviderId
    );

    let capabilities = record.capabilities ?? null;
    if (!capabilities && record.model) {
      try {
        capabilities = await this.#getProvider(providerId).getCapabilities(
          record.model,
          capabilityOverride ?? {}
        );
      } catch {
        capabilities = null;
      }
    }

    const hydratedSession = {
      id: record.id ?? randomUUID(),
      workspaceRoot,
      providerId,
      model: String(record.model ?? '').trim(),
      permissionPreset: normalizePermissionPreset(record.permissionPreset),
      modelSettings: normalizeModelSettings(record.modelSettings),
      createdAt: record.createdAt ?? nowIso(),
      updatedAt: record.updatedAt ?? record.createdAt ?? nowIso(),
      messages: Array.isArray(record.messages)
        ? record.messages.map(hydrateMessageRecord)
        : [],
      toolEvents: Array.isArray(record.toolEvents)
        ? record.toolEvents.map(serializeToolEvent)
        : [],
      pendingApproval: record.pendingApproval
        ? {
            call: {
              name: record.pendingApproval.call?.name ?? record.pendingApproval.toolName,
              arguments:
                record.pendingApproval.call?.arguments ?? record.pendingApproval.arguments ?? {},
            },
            eventId: record.pendingApproval.eventId,
            remainingCalls: Array.isArray(record.pendingApproval.remainingCalls)
              ? record.pendingApproval.remainingCalls
              : [],
          }
        : null,
      attachments: Array.isArray(record.attachments)
        ? record.attachments.map(hydrateAttachmentRecord)
        : [],
      capabilityOverride,
      capabilities,
      knownPaths: new Set(normalizeKnownPaths(record.knownPaths)),
      toolRegistry,
      pluginRegistry,
    };

    settleLingeringToolState(
      hydratedSession,
      'The app was reopened while this run was still active, so it was closed automatically.'
    );

    for (const attachment of hydratedSession.attachments) {
      hydratedSession.knownPaths.add(normalizeAttachmentRelativePath(attachment.path));
    }

    return hydratedSession;
  }

  async #persistState() {
    const payload = {
      version: STATE_FILE_VERSION,
      preferences: normalizePreferences(this.appState.preferences, this.appRoot),
      lastSessionId:
        this.appState.lastSessionId && this.sessions.has(this.appState.lastSessionId)
          ? this.appState.lastSessionId
          : null,
      sessions: [...this.sessions.values()].map((session) => ({
        id: session.id,
        workspaceRoot: session.workspaceRoot,
        providerId: session.providerId,
        model: session.model,
        permissionPreset: session.permissionPreset,
        modelSettings: normalizeModelSettings(session.modelSettings),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        capabilities: session.capabilities ?? null,
        capabilityOverride: session.capabilityOverride ?? null,
        messages: session.messages.map(serializeMessageRecord),
        toolEvents: session.toolEvents.map(serializeToolEvent),
        pendingApproval: session.pendingApproval
          ? {
              call: {
                name: session.pendingApproval.call.name,
                arguments: session.pendingApproval.call.arguments,
              },
              eventId: session.pendingApproval.eventId,
              remainingCalls: session.pendingApproval.remainingCalls ?? [],
            }
          : null,
        attachments: Array.isArray(session.attachments)
          ? session.attachments.map(serializeAttachmentRecord)
          : [],
        knownPaths: normalizeKnownPaths(session.knownPaths),
      })),
    };

    this.appState = {
      ...this.appState,
      preferences: payload.preferences,
      lastSessionId: payload.lastSessionId,
    };

    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(temporaryPath, this.statePath);
  }

  async #storeAttachment(session, attachment) {
    const originalName = sanitizeAttachmentName(attachment?.name);
    const mimeType = String(attachment?.type ?? '').trim();
    const clientId = attachment?.clientId ? String(attachment.clientId) : null;
    const bytes = toNodeBuffer(attachment?.bytes ?? attachment?.buffer ?? attachment?.data);
    const size = Number(attachment?.size ?? bytes.length) || bytes.length;

    const existing = (session.attachments ?? []).find(
      (item) =>
        item.originalName === originalName &&
        item.size === size &&
        item.mimeType === mimeType
    );

    if (existing) {
      session.knownPaths.add(normalizeAttachmentRelativePath(existing.path));
      return {
        ...existing,
        clientId,
      };
    }

    const baseRelativeDirectory = path.join(ATTACHMENT_DIRECTORY, session.id);
    const absoluteDirectory = resolveWorkspacePath(session.workspaceRoot, baseRelativeDirectory);
    await fs.mkdir(absoluteDirectory, { recursive: true });

    const extension = path.extname(originalName);
    const stem = path.basename(originalName, extension) || 'attachment';
    let candidateName = originalName;
    let counter = 2;

    while (
      (session.attachments ?? []).some(
        (item) => normalizeAttachmentRelativePath(item.path) === normalizeAttachmentRelativePath(path.join(baseRelativeDirectory, candidateName))
      )
    ) {
      candidateName = `${stem}-${counter}${extension}`;
      counter += 1;
    }

    const absolutePath = resolveWorkspacePath(
      session.workspaceRoot,
      path.join(baseRelativeDirectory, candidateName)
    );
    await fs.writeFile(absolutePath, bytes);

    const relativePath = normalizeAttachmentRelativePath(
      relativizeWorkspacePath(session.workspaceRoot, absolutePath)
    );
    const record = {
      id: randomUUID(),
      clientId,
      name: candidateName,
      originalName,
      path: relativePath,
      mimeType,
      size,
      attachedAt: nowIso(),
    };

    session.attachments ??= [];
    session.attachments.push(record);
    session.knownPaths.add(relativePath);
    session.knownPaths.add(normalizeAttachmentRelativePath(record.name));
    session.knownPaths.add(normalizeAttachmentRelativePath(record.originalName));

    const attachmentDirectory = normalizeAttachmentRelativePath(path.posix.dirname(relativePath));
    if (attachmentDirectory && attachmentDirectory !== '.') {
      session.knownPaths.add(attachmentDirectory);
    }

    return record;
  }
}
