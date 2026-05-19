import React, { startTransition, useDeferredValue, useEffect, useRef, useState } from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';
import htm from 'https://esm.sh/htm@3.1.1';
import { parseAgentEnvelope } from '../core/envelope.js';
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_OPTIONS,
  getLanguageLocale,
  resolveLanguage,
  resolveLanguageFromLocale,
  translate,
} from './i18n/index.js';

const html = htm.bind(React.createElement);
const THEME_STORAGE_KEY = 'cokgizlicoder.theme';
const DEFAULT_THEME = 'codex';
const DEFAULT_MODEL_SETTINGS = Object.freeze({
  contextLength: 32768,
  temperature: 0.2,
  systemPrompt: '',
});
const NAV_ITEMS = [
  { id: 'new', labelKey: 'nav.new', badge: '+' },
  { id: 'search', labelKey: 'nav.search', badge: '/' },
  { id: 'automations', labelKey: 'nav.automations', badge: 'AU' },
];
const THEME_OPTIONS = [
  {
    id: 'codex',
    label: 'Codex Dark',
    description: 'Koyu çalışma yüzeyi, ince kontrast ve mavi vurgu.',
    swatches: ['#111317', '#191d22', '#7aa2ff'],
  },
  {
    id: 'graphite',
    label: 'Graphite',
    description: 'Biraz daha sıcak gri tonlar ve camgöbeği vurgu.',
    swatches: ['#14171b', '#1f2329', '#59d0c2'],
  },
  {
    id: 'paper',
    label: 'Paper',
    description: 'Açık tema, koyu metin ve bakır vurgu.',
    swatches: ['#ece6da', '#f7f2e9', '#cb6c3c'],
  },
];
const TOP_MENU_ITEMS = [
  { id: 'dosya', labelKey: 'menu.top.dosya' },
  { id: 'duzenle', labelKey: 'menu.top.duzenle' },
  { id: 'goruntule', labelKey: 'menu.top.goruntule' },
  { id: 'pencere', labelKey: 'menu.top.pencere' },
  { id: 'yardim', labelKey: 'menu.top.yardim' },
];
const TOP_MENU_ACTIONS = {
  app: [
    { id: 'new-thread', label: 'New Chat' },
    { id: 'quick-chat', label: 'Quick Chat' },
    { id: 'choose-workspace', label: 'Open Folder...' },
    { type: 'separator', id: 'app-separator-1' },
    { id: 'open-about', label: 'About ForgePilot' },
    { id: 'window-close', label: 'Exit' },
  ],
  dosya: [
    { id: 'create-session', label: 'Oturumu baslat' },
    { id: 'choose-workspace', label: 'Workspace sec' },
    { id: 'refresh-models', label: 'Modelleri yenile' },
    { id: 'open-settings', label: 'Ayarlar...' },
  ],
  duzenle: [
    { id: 'clear-composer', label: 'Composer temizle' },
    { id: 'fill-summary-prompt', label: 'Workspace ozeti iste' },
    { id: 'fill-readme-prompt', label: 'README gorevi koy' },
  ],
  goruntule: [
    { id: 'toggle-runtime-settings', label: 'Runtime ayarlari' },
    { id: 'open-appearance-settings', label: 'Appearance settings' },
    { id: 'focus-last-event', label: 'Son tool eventi sec' },
  ],
  pencere: [
    { id: 'window-minimize', label: 'Asagi al' },
    { id: 'window-toggle-maximize', label: 'Buyut / geri al' },
    { id: 'window-close', label: 'Kapat' },
  ],
  yardim: [
    { id: 'export-progress-report', label: 'Export progress report' },
    { id: 'fill-tool-prompt', label: 'Tool ozetini iste' },
    { id: 'fill-command-prompt', label: 'Komut calistirma gorevi' },
    { id: 'fill-risk-prompt', label: 'Riskli toollari listele' },
  ],
};
const SETTINGS_SECTIONS = [
  { id: 'general', labelKey: 'settings.section.general' },
  { id: 'mcp', labelKey: 'settings.section.mcp' },
  { id: 'appearance', labelKey: 'settings.section.appearance' },
  { id: 'about', labelKey: 'settings.section.about' },
];
const CONTEXT_LENGTH_OPTIONS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
const MUTATING_TOOL_NAMES = new Set(['fs_write', 'fs_patch', 'fs_mkdir', 'fs_delete']);
const EMPTY_MCP_DRAFT = Object.freeze({
  name: '',
  command: '',
  args: '',
  cwd: '',
  env: '',
});
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  'txt',
  'md',
  'json',
  'js',
  'jsx',
  'ts',
  'tsx',
  'css',
  'html',
  'xml',
  'yml',
  'yaml',
  'toml',
  'csv',
  'tsv',
  'log',
  'ini',
  'env',
  'py',
  'sh',
  'ps1',
  'java',
  'c',
  'cpp',
  'cs',
  'rs',
  'go',
  'php',
  'rb',
  'sql',
]);
const LIVE_STREAM_MAX_CHARS = 1200;
const LIVE_STREAM_MAX_LINES = 18;

function getThemeOptions(t) {
  return THEME_OPTIONS.map((theme) => ({
    ...theme,
    label: t(`theme.${theme.id}.label`),
    description: t(`theme.${theme.id}.description`),
  }));
}

function getQuickPrompts(t) {
  return [t('quick.summary'), t('quick.readme'), t('quick.tools')];
}

function getAutomationGroups(t) {
  return [
    {
      id: 'status-reports',
      title: t('automation.statusReports'),
      cards: [
        {
          id: 'daily-standup',
          badge: 'DS',
          tone: 'violet',
          description: t('automation.dailyStandup'),
          prompt: t('automation.dailyStandup'),
        },
        {
          id: 'weekly-digest',
          badge: 'WD',
          tone: 'mint',
          description: t('automation.weeklyDigest'),
          prompt: t('automation.weeklyDigest'),
        },
        {
          id: 'review-brief',
          badge: 'RB',
          tone: 'slate',
          description: t('automation.reviewBrief'),
          prompt: t('automation.reviewBrief'),
        },
      ],
    },
    {
      id: 'release-prep',
      title: t('automation.releasePrep'),
      cards: [
        {
          id: 'release-notes',
          badge: 'RN',
          tone: 'amber',
          description: t('automation.releaseNotes'),
          prompt: t('automation.releaseNotes'),
        },
        {
          id: 'ship-checklist',
          badge: 'QC',
          tone: 'green',
          description: t('automation.shipChecklist'),
          prompt: t('automation.shipChecklist'),
        },
        {
          id: 'changelog-refresh',
          badge: 'CL',
          tone: 'rose',
          description: t('automation.changelog'),
          prompt: t('automation.changelog'),
        },
      ],
    },
    {
      id: 'incidents',
      title: t('automation.incidents'),
      cards: [
        {
          id: 'failure-scan',
          badge: 'CI',
          tone: 'cyan',
          description: t('automation.failureScan'),
          prompt: t('automation.failureScan'),
        },
        {
          id: 'minimal-fix',
          badge: 'MF',
          tone: 'slate',
          description: t('automation.minimalFix'),
          prompt: t('automation.minimalFix'),
        },
        {
          id: 'regression-guard',
          badge: 'RG',
          tone: 'indigo',
          description: t('automation.regressionGuard'),
          prompt: t('automation.regressionGuard'),
        },
      ],
    },
  ];
}

function getPermissionLabel(t, presetId) {
  return t(`permission.${presetId}.label`);
}

function getPermissionDescription(t, presetId) {
  return t(`permission.${presetId}.description`);
}

function resolveUiErrorText(t, errorCode, errorVariables = {}, fallbackMessage = '') {
  if (errorCode) {
    const localized = t(errorCode, errorVariables);
    if (localized && localized !== errorCode) {
      return localized;
    }
  }

  return String(fallbackMessage ?? '').trim();
}

function createPreviewApi() {
  const previewProviders = [
    {
      id: 'ollama',
      label: 'Ollama',
      description: 'Yerel Ollama runtime',
      configFields: [{ key: 'baseUrl', label: 'Base URL', type: 'text' }],
    },
    {
      id: 'openai',
      label: 'OpenAI',
      description: 'Official OpenAI API',
      configFields: [
        { key: 'apiKey', label: 'API Key', type: 'password' },
        { key: 'baseUrl', label: 'Base URL', type: 'text' },
        { key: 'forceEmulatedTools', label: 'Force emulated tools', type: 'boolean' },
      ],
    },
    {
      id: 'openai_compatible',
      label: 'OpenAI Compatible',
      description: 'LM Studio, OpenRouter, Groq, Together, DeepSeek, vLLM ve benzeri',
      configFields: [
        { key: 'baseUrl', label: 'Base URL', type: 'text' },
        { key: 'apiKey', label: 'API Key', type: 'password' },
        { key: 'forceEmulatedTools', label: 'Force emulated tools', type: 'boolean' },
      ],
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      description: 'Claude Messages API',
      configFields: [
        { key: 'apiKey', label: 'API Key', type: 'password' },
        { key: 'baseUrl', label: 'Base URL', type: 'text' },
        { key: 'apiVersion', label: 'API Version', type: 'text' },
        { key: 'maxTokens', label: 'Max output tokens', type: 'number' },
        { key: 'forceEmulatedTools', label: 'Force emulated tools', type: 'boolean' },
      ],
    },
  ];
  const previewModelsByProvider = {
    ollama: [
      {
        name: 'preview/qwen3-coder-next',
        capabilities: { nativeTools: true, structuredOutput: true, streaming: true },
      },
      {
        name: 'preview/qwen3-coder-abliterated',
        capabilities: { nativeTools: false, structuredOutput: true, streaming: true },
      },
    ],
    openai: [
      {
        name: 'gpt-4.1',
        capabilities: { nativeTools: true, structuredOutput: true, streaming: true },
      },
      {
        name: 'gpt-4o-mini',
        capabilities: { nativeTools: true, structuredOutput: true, streaming: true },
      },
    ],
    openai_compatible: [
      {
        name: 'deepseek-chat',
        capabilities: { nativeTools: true, structuredOutput: true, streaming: true },
      },
      {
        name: 'lmstudio-local',
        capabilities: { nativeTools: false, structuredOutput: true, streaming: true },
      },
    ],
    anthropic: [
      {
        name: 'claude-sonnet-4-20250514',
        capabilities: { nativeTools: true, structuredOutput: true, streaming: true },
      },
      {
        name: 'claude-3-5-haiku-20241022',
        capabilities: { nativeTools: true, structuredOutput: true, streaming: true },
      },
    ],
  };

  let currentSession = null;
  let previewRunTimer = null;
  let previewAppState = {
    preferences: {
      language: DEFAULT_LANGUAGE,
      workspaceRoot: 'C:\\preview\\workspace',
      providerId: 'ollama',
      providerConfigs: {
        ollama: { baseUrl: 'http://127.0.0.1:11434' },
        openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', forceEmulatedTools: false },
        openai_compatible: {
          apiKey: '',
          baseUrl: 'http://127.0.0.1:1234/v1',
          forceEmulatedTools: false,
        },
        anthropic: {
          apiKey: '',
          baseUrl: 'https://api.anthropic.com',
          apiVersion: '2023-06-01',
          maxTokens: 4096,
          forceEmulatedTools: false,
        },
      },
      model: previewModelsByProvider.ollama[0].name,
      permissionPreset: 'full_access',
      modelSettings: DEFAULT_MODEL_SETTINGS,
      showRuntimeSettings: false,
      mcpServers: [],
    },
    lastSessionId: null,
  };

  function iso(offset = 0) {
    return new Date(Date.now() + offset).toISOString();
  }

  function makeSession(payload) {
    const providerModels = previewModelsByProvider[payload.providerId] ?? previewModelsByProvider.ollama;
    return {
      id: 'preview-session',
      workspaceRoot: payload.workspaceRoot,
      providerId: payload.providerId,
      model: payload.model,
      permissionPreset: payload.permissionPreset,
      modelSettings: normalizeModelSettings(payload.modelSettings),
      createdAt: iso(),
      updatedAt: iso(),
      capabilities:
        providerModels.find((item) => item.name === payload.model)?.capabilities ??
        providerModels[0].capabilities,
      pendingApproval: null,
      attachments: [],
      messages: [
        {
          id: 'preview-assistant',
          role: 'assistant',
          content:
            'Preview mode aktif. Electron preload baglantisi olmadan da genel arayuzu gozden gecirebilmen icin sahte veri kullaniyorum.',
          rawContent:
            'Preview mode aktif. Electron preload baglantisi olmadan da genel arayuzu gozden gecirebilmen icin sahte veri kullaniyorum.',
          thinking: '',
          toolCalls: [],
          createdAt: iso(1),
        },
      ],
      toolEvents: [
        {
          id: 'preview-tool',
          toolName: 'fs_read',
          source: 'preview-runtime',
          status: 'completed',
          arguments: { path: 'README.md' },
          createdAt: iso(2),
          completedAt: iso(3),
          resultPreview: 'Arayuz preview modunda; bu nedenle burada sadece sahte tool ciktisi gosteriliyor.',
          diffText: '',
          result: { path: 'README.md', content: 'Preview mode' },
        },
      ],
      availableTools: [
        { name: 'fs_list', description: 'List files' },
        { name: 'fs_read', description: 'Read files' },
        { name: 'fs_write', description: 'Write files' },
        { name: 'search_text', description: 'Search text' },
        { name: 'web_search', description: 'Search the web' },
        { name: 'web_fetch', description: 'Fetch a web page' },
        { name: 'browser_fetch', description: 'Render and fetch a page in a browser' },
        { name: 'run_command', description: 'Run shell command' },
      ],
      plugins: [
        {
          name: 'echo-tools',
          description: 'Preview plugin surface',
          tools: [{ name: 'plugin_echo', description: 'Echo text back.' }],
        },
      ],
    };
  }

  return {
    async bootstrap() {
      return {
        appName: 'ForgePilot',
        defaultLanguage: previewAppState.preferences.language,
        languageWasExplicit: true,
        supportedLanguages: LANGUAGE_OPTIONS.map((option) => option.id),
        defaultWorkspace: previewAppState.preferences.workspaceRoot,
        defaultProviderId: previewAppState.preferences.providerId,
        providerConfigs: previewAppState.preferences.providerConfigs,
        providers: previewProviders,
        defaultModel: previewAppState.preferences.model,
        defaultPermissionPreset: previewAppState.preferences.permissionPreset,
        defaultModelSettings: previewAppState.preferences.modelSettings,
        defaultShowRuntimeSettings: previewAppState.preferences.showRuntimeSettings,
        mcpServers: previewAppState.preferences.mcpServers,
        permissionPresets: [
          {
            id: 'full_access',
            label: 'Full Access',
            description: 'Tools run directly inside the selected workspace.',
          },
          {
            id: 'ask',
            label: 'Ask',
            description: 'Writing, deleting, and command tools require approval first.',
          },
          {
            id: 'read_only',
            label: 'Read Only',
            description: 'Only read and inspection tools stay available.',
          },
        ],
        loadedModelsProviderId: previewAppState.preferences.providerId,
        models: previewModelsByProvider[previewAppState.preferences.providerId] ?? [],
        providerError: null,
        previewMode: true,
        sessionSummaries: currentSession
          ? [
              {
                id: currentSession.id,
                sessionId: currentSession.id,
                title: 'Hazir oturum',
                prompt:
                  currentSession.messages.filter((message) => message.role === 'user').at(-1)
                    ?.content ?? '',
                updatedAt: currentSession.updatedAt,
                workspaceRoot: currentSession.workspaceRoot,
                providerId: currentSession.providerId,
                model: currentSession.model,
              },
            ]
          : [],
        activeSession:
          previewAppState.lastSessionId && currentSession?.id === previewAppState.lastSessionId
            ? currentSession
            : null,
      };
    },
    async chooseWorkspace(defaultPath) {
      return defaultPath ?? 'C:\\preview\\workspace';
    },
    async refreshModels(payload = {}) {
      const providerId = payload?.providerId ?? previewAppState.preferences.providerId;
      return {
        ok: true,
        providerId,
        models: previewModelsByProvider[providerId] ?? [],
        errorMessage: null,
      };
    },
    async createSession(payload) {
      previewAppState = {
        ...previewAppState,
        preferences: {
          ...previewAppState.preferences,
          workspaceRoot: payload.workspaceRoot,
          providerId: payload.providerId,
          providerConfigs: {
            ...previewAppState.preferences.providerConfigs,
            [payload.providerId]: {
              ...(previewAppState.preferences.providerConfigs?.[payload.providerId] ?? {}),
              ...(payload.providerConfig ?? {}),
            },
          },
          model: payload.model,
          permissionPreset: payload.permissionPreset,
          modelSettings: normalizeModelSettings(payload.modelSettings),
          mcpServers: previewAppState.preferences.mcpServers,
        },
        lastSessionId: 'preview-session',
      };
      currentSession = makeSession(payload);
      return { status: 'created', session: currentSession };
    },
    async getSession() {
      return { session: currentSession };
    },
    async importAttachments(_sessionId, attachments = []) {
      if (!currentSession) {
        return { status: 'noop', attachments: [], session: currentSession };
      }

      const imported = attachments.map((attachment, index) => ({
        id: `preview-attachment-${index + 1}`,
        clientId: attachment.clientId ?? null,
        name: attachment.name,
        originalName: attachment.name,
        path: `.cokgizlicoder/attachments/${currentSession.id}/${attachment.name}`,
        mimeType: attachment.type ?? '',
        size: attachment.size ?? 0,
        attachedAt: iso(index + 20),
      }));

      currentSession = {
        ...currentSession,
        attachments: [...(currentSession.attachments ?? []), ...imported],
        updatedAt: iso(9),
      };

      return {
        status: imported.length > 0 ? 'imported' : 'noop',
        attachments: imported,
        session: currentSession,
      };
    },
    async updateSessionConfig(_sessionId, payload) {
      if (!currentSession) {
        currentSession = makeSession({
          workspaceRoot: payload.workspaceRoot ?? previewAppState.preferences.workspaceRoot,
          providerId: payload.providerId ?? previewAppState.preferences.providerId,
          model: payload.model ?? previewAppState.preferences.model,
          permissionPreset:
            payload.permissionPreset ?? previewAppState.preferences.permissionPreset,
          modelSettings:
            payload.modelSettings ?? previewAppState.preferences.modelSettings,
        });
      }

      currentSession = {
        ...currentSession,
        workspaceRoot: payload.workspaceRoot ?? currentSession.workspaceRoot,
        providerId: payload.providerId ?? currentSession.providerId,
        model: payload.model ?? currentSession.model,
        permissionPreset: payload.permissionPreset ?? currentSession.permissionPreset,
        modelSettings: normalizeModelSettings(
          payload.modelSettings ?? currentSession.modelSettings
        ),
        updatedAt: iso(9),
      };

      previewAppState = {
        ...previewAppState,
        preferences: {
          ...previewAppState.preferences,
          workspaceRoot: currentSession.workspaceRoot,
          providerId: currentSession.providerId,
          providerConfigs: {
            ...previewAppState.preferences.providerConfigs,
            [currentSession.providerId]: {
              ...(previewAppState.preferences.providerConfigs?.[currentSession.providerId] ?? {}),
              ...(payload.providerConfig ?? {}),
            },
          },
          model: currentSession.model,
          permissionPreset: currentSession.permissionPreset,
          modelSettings: currentSession.modelSettings,
          mcpServers: previewAppState.preferences.mcpServers,
        },
        lastSessionId: currentSession.id,
      };

      return {
        status: 'updated',
        session: currentSession,
      };
    },
    async sendUserMessage(_sessionId, content) {
      if (!currentSession) {
        currentSession = makeSession({
          workspaceRoot: 'C:\\preview\\workspace',
          providerId: previewAppState.preferences.providerId,
          model:
            previewModelsByProvider[previewAppState.preferences.providerId]?.[0]?.name ??
            previewAppState.preferences.model,
          permissionPreset: 'full_access',
          modelSettings: DEFAULT_MODEL_SETTINGS,
        });
      }

      const now = Date.now();

      currentSession.messages = [
        ...currentSession.messages,
        {
          id: `preview-user-${now}`,
          role: 'user',
          content,
          rawContent: content,
          thinking: '',
          toolCalls: [],
          createdAt: iso(4),
        },
        {
          id: `preview-assistant-${now}`,
          role: 'assistant',
          content:
            'Bu sadece arayuz preview cevabi. Gercek masaustu uygulamasinda burada yerel Ollama agent dongusu ve workspace tool sonucu gorunecek.',
          rawContent:
            'Bu sadece arayuz preview cevabi. Gercek masaustu uygulamasinda burada yerel Ollama agent dongusu ve workspace tool sonucu gorunecek.',
          thinking:
            'Preview modunun amaci, Electron baglantisi olmadan layout ve gorunumu dogrulayabilmek.',
          toolCalls: [],
          createdAt: iso(5),
        },
      ];

      currentSession.toolEvents = [
        ...currentSession.toolEvents,
        {
          id: `preview-event-${now}`,
          toolName: 'search_text',
          source: 'preview-runtime',
          status: 'completed',
          arguments: { query: 'tool definitions', path: '.' },
          createdAt: iso(6),
          completedAt: iso(7),
          resultPreview:
            'Gercek bir arama kosulmadi; bu satir timeline panelinin dolu gorunmesi icin eklendi.',
          diffText: '',
          result: { query: 'tool definitions', results: [] },
        },
      ];

      currentSession.updatedAt = iso(8);
      return { status: 'completed', session: currentSession };
    },
    async cancelActiveRun() {
      if (previewRunTimer) {
        clearTimeout(previewRunTimer);
        previewRunTimer = null;
      }

      return { status: 'idle', session: currentSession };
    },
    async resolveApproval() {
      return { status: 'completed', session: currentSession };
    },
    onSessionStateChange() {
      return () => {};
    },
    async deleteSession(sessionId) {
      if (currentSession?.id === sessionId) {
        currentSession = null;
      }

      previewAppState = {
        ...previewAppState,
        lastSessionId: currentSession?.id ?? null,
      };

      return {
        status: 'deleted',
        deletedSessionId: sessionId,
        sessionSummaries: currentSession
          ? [
              {
                id: currentSession.id,
                sessionId: currentSession.id,
                title: 'Hazir oturum',
                prompt:
                  currentSession.messages.filter((message) => message.role === 'user').at(-1)
                    ?.content ?? '',
                updatedAt: currentSession.updatedAt,
                workspaceRoot: currentSession.workspaceRoot,
                providerId: currentSession.providerId,
                model: currentSession.model,
              },
            ]
          : [],
        activeSession: currentSession,
      };
    },
    async saveAppState(payload = {}) {
      const nextMcpServers = Array.isArray(payload.preferences?.mcpServers)
        ? payload.preferences.mcpServers.map((server, index) => ({
            id: server.id ?? `preview-mcp-${index + 1}`,
            name: server.name || server.command || `Preview MCP ${index + 1}`,
            command: server.command || '',
            args: Array.isArray(server.args) ? server.args : [],
            cwd: server.cwd || '',
            env:
              server.env && typeof server.env === 'object' && !Array.isArray(server.env)
                ? server.env
                : {},
            enabled: server.enabled !== false,
            status: server.enabled === false ? 'disabled' : 'connected',
            error: null,
            protocolVersion: '2025-11-25',
            serverInfo: server.command
              ? {
                  name: server.name || server.command,
                  version: 'preview',
                }
              : null,
            instructions: '',
            tools: [],
            toolCount: 0,
          }))
        : previewAppState.preferences.mcpServers;

      previewAppState = {
        preferences: {
          ...previewAppState.preferences,
          ...(payload.preferences ?? {}),
          providerId:
            payload.preferences?.providerId ?? previewAppState.preferences.providerId,
          providerConfigs:
            payload.preferences?.providerConfigs ?? previewAppState.preferences.providerConfigs,
          language: payload.preferences?.language ?? previewAppState.preferences.language,
          modelSettings: normalizeModelSettings(
            payload.preferences?.modelSettings ?? previewAppState.preferences.modelSettings
          ),
          mcpServers: nextMcpServers,
        },
        lastSessionId:
          payload.lastSessionId === undefined
            ? previewAppState.lastSessionId
            : payload.lastSessionId,
      };
      return {
        status: 'saved',
        preferences: previewAppState.preferences,
        mcpServers: nextMcpServers,
        activeSession: currentSession,
      };
    },
    async exportProgressReport(payload = {}) {
      const sessionId = payload?.sessionId ?? currentSession?.id ?? 'preview-session';
      const content = [
        '# ForgePilot Preview Progress Debug Report',
        '',
        `Session: ${sessionId}`,
        `Generated at: ${new Date().toISOString()}`,
        '',
        'Preview mode does not have native save dialogs, so this file was prepared in-browser.',
        '',
        '## Recent tool events',
        ...((currentSession?.toolEvents ?? []).map(
          (event) => `- ${event.toolName} [${event.status}] ${event.resultPreview ?? ''}`
        )),
      ].join('\n');

      return {
        status: 'preview',
        fileName: `forgepilot-progress-${sessionId}-preview.md`,
        content,
      };
    },
    windowControls: {
      minimize: async () => {},
      toggleMaximize: async () => ({ isMaximized: false, isFocused: true, bottomSafeArea: 0 }),
      close: async () => {},
      getState: async () => ({ isMaximized: false, isFocused: true, bottomSafeArea: 0 }),
      onStateChange: () => () => {},
    },
  };
}

const api = globalThis.cokgizlicoder ?? createPreviewApi();

function downloadTextFile(fileName, content) {
  const blob = new Blob([String(content ?? '')], { type: 'text/markdown;charset=utf-8' });
  const url = globalThis.URL.createObjectURL(blob);
  const anchor = globalThis.document.createElement('a');
  anchor.href = url;
  anchor.download = fileName || 'forgepilot-progress-report.md';
  anchor.style.display = 'none';
  globalThis.document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 0);
}

function normalizeModelSettings(modelSettings = DEFAULT_MODEL_SETTINGS) {
  const contextLength = Number.parseInt(
    modelSettings.contextLength ?? DEFAULT_MODEL_SETTINGS.contextLength,
    10
  );
  const temperature = Number.parseFloat(
    modelSettings.temperature ?? DEFAULT_MODEL_SETTINGS.temperature
  );

  return {
    contextLength:
      Number.isFinite(contextLength) && contextLength >= 1024
        ? contextLength
        : DEFAULT_MODEL_SETTINGS.contextLength,
    temperature:
      Number.isFinite(temperature)
        ? Math.min(2, Math.max(0, temperature))
        : DEFAULT_MODEL_SETTINGS.temperature,
    systemPrompt: String(modelSettings.systemPrompt ?? '').trim(),
  };
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

function normalizeProviderConfigs(providerConfigs = {}) {
  return providerConfigs && typeof providerConfigs === 'object' && !Array.isArray(providerConfigs)
    ? providerConfigs
    : {};
}

function getProviderConfig(providerConfigs, providerId) {
  return normalizeProviderConfigs(providerConfigs)?.[providerId] ?? {};
}

function updateProviderConfigMap(providerConfigs, providerId, patch) {
  return {
    ...normalizeProviderConfigs(providerConfigs),
    [providerId]: {
      ...getProviderConfig(providerConfigs, providerId),
      ...patch,
    },
  };
}

function formatContextLength(value) {
  const normalized = Number(value ?? 0);
  return normalized >= 1024 ? `${Math.round(normalized / 1024)}k` : String(normalized);
}

function formatBytes(bytes = 0) {
  const normalized = Number(bytes ?? 0);

  if (!Number.isFinite(normalized) || normalized <= 0) {
    return '0 B';
  }

  if (normalized < 1024) {
    return `${normalized} B`;
  }

  if (normalized < 1024 * 1024) {
    return `${(normalized / 1024).toFixed(1)} KB`;
  }

  return `${(normalized / (1024 * 1024)).toFixed(1)} MB`;
}

function isTextLikeAttachment(file) {
  if (!file) {
    return false;
  }

  if (String(file.type ?? '').startsWith('text/')) {
    return true;
  }

  const extension = String(file.name ?? '')
    .split('.')
    .at(-1)
    ?.toLowerCase();

  return TEXT_ATTACHMENT_EXTENSIONS.has(extension);
}

async function buildAttachmentUploadPayload(attachment) {
  const bytes = new Uint8Array(await attachment.file.arrayBuffer());
  return {
    clientId: attachment.id,
    name: attachment.name,
    type: attachment.type,
    size: attachment.size,
    lastModified: attachment.file.lastModified ?? 0,
    bytes,
  };
}

function getContextLengthOptionIndex(value) {
  const normalized = Number(value ?? DEFAULT_MODEL_SETTINGS.contextLength);
  let closestIndex = 0;
  let closestDelta = Number.POSITIVE_INFINITY;

  for (let index = 0; index < CONTEXT_LENGTH_OPTIONS.length; index += 1) {
    const delta = Math.abs(CONTEXT_LENGTH_OPTIONS[index] - normalized);
    if (delta < closestDelta) {
      closestDelta = delta;
      closestIndex = index;
    }
  }

  return closestIndex;
}

function getInitialTheme() {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return THEME_OPTIONS.some((theme) => theme.id === stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function capabilityTag(model, permissionPreset, t) {
  if (!model?.capabilities) {
    return { label: t('capability.unknown'), className: '' };
  }

  if (permissionPreset === 'read_only') {
    return { label: getPermissionLabel(t, 'read_only').toLowerCase(), className: 'readonly' };
  }

  return model.capabilities.nativeTools
    ? { label: t('capability.native'), className: 'native' }
    : { label: t('capability.emulated'), className: 'emulated' };
}

function formatTimestamp(value, language = DEFAULT_LANGUAGE) {
  if (!value) {
    return '';
  }

  const locale = getLanguageLocale(language);
  return new Date(value).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncate(value, maxLength = 44) {
  const text = String(value ?? '').trim();
  if (!text) {
    return 'New chat';
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function prettyToolName(toolName = '') {
  return String(toolName)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function clampLivePreview(value = '', maxChars = LIVE_STREAM_MAX_CHARS, maxLines = LIVE_STREAM_MAX_LINES) {
  const normalized = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return '';
  }

  const lines = normalized.split('\n');
  const lineLimited = lines.length > maxLines
    ? `${lines.slice(0, maxLines).join('\n')}\n…`
    : normalized;

  if (lineLimited.length <= maxChars) {
    return lineLimited;
  }

  return `${lineLimited.slice(0, maxChars - 1).trimEnd()}…`;
}

function extractProtocolToolNames(rawValue = '') {
  const matches = [...String(rawValue ?? '').matchAll(/"name"\s*:\s*"([^"]+)"/g)];
  return [...new Set(matches.map((match) => prettyToolName(match[1])).filter(Boolean))];
}

function extractProtocolTarget(rawValue = '') {
  const patterns = [
    /"path"\s*:\s*"([^"]+)"/,
    /"url"\s*:\s*"([^"]+)"/,
    /"query"\s*:\s*"([^"]+)"/,
    /"command"\s*:\s*"([^"]+)"/,
  ];

  for (const pattern of patterns) {
    const match = String(rawValue ?? '').match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return '';
}

function summarizeLiveStreamContent(value, t) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return '';
  }

  const parsed = parseAgentEnvelope(normalized);
  if (parsed.ok) {
    if (parsed.envelope.mode === 'tool') {
      const toolNames = parsed.envelope.calls.map((call) => prettyToolName(call.name)).join(', ');
      const firstCall = parsed.envelope.calls[0];
      const target =
        firstCall?.arguments?.path ??
        firstCall?.arguments?.url ??
        firstCall?.arguments?.query ??
        firstCall?.arguments?.command ??
        '';
      return [t('status.toolPlan', { tools: toolNames || t('status.toolPlanGeneric') }), target]
        .filter(Boolean)
        .join('\n');
    }

    return clampLivePreview(parsed.envelope.message);
  }

  if (/<agent-response[\s>]/i.test(normalized)) {
    const toolNames = extractProtocolToolNames(normalized);
    const target = extractProtocolTarget(normalized);
    return [
      toolNames.length > 0
        ? t('status.toolPlan', { tools: toolNames.join(', ') })
        : t('status.toolPlanGeneric'),
      target,
    ]
      .filter(Boolean)
      .join('\n');
  }

  return clampLivePreview(normalized);
}

function summarizeEvent(event) {
  if (!event) {
    return '';
  }

  if (event.status === 'blocked' && event.arguments?.path) {
    return `Undiscovered path: ${event.arguments.path}`;
  }

  if (event.result?.error) {
    if (event.toolName === 'fs_read' && event.arguments?.path) {
      return `Missing path: ${event.arguments.path}`;
    }

    return String(event.result.error);
  }

  if (event.result?.warning) {
    return String(event.result.warning);
  }

  return event.resultPreview ?? event.status;
}

function summarizeEventMeta(event) {
  if (!event) {
    return '';
  }

  switch (event.toolName) {
    case 'fs_list':
    case 'search_text':
    case 'fs_read':
    case 'fs_write':
    case 'fs_patch':
    case 'fs_mkdir':
    case 'fs_delete':
      return event.result?.path ?? event.arguments?.path ?? '';
    case 'web_search':
      return event.result?.query ?? event.arguments?.query ?? '';
    case 'web_fetch':
    case 'browser_fetch':
      return event.result?.url ?? event.arguments?.url ?? '';
    case 'run_command':
      return event.result?.command ?? event.arguments?.command ?? '';
    default:
      return event.source ?? '';
  }
}

function formatPhaseLabel(t, phase = '') {
  const normalized = String(phase ?? '').trim();
  if (!normalized) {
    return '';
  }

  const translated = t(`status.phase.${normalized}`);
  return translated === `status.phase.${normalized}` ? normalized.replace(/_/g, ' ') : translated;
}

function parseDiffLineCounts(diffText = '') {
  const lines = String(diffText ?? '').split('\n');
  let added = 0;
  let removed = 0;

  for (const line of lines) {
    if (!line || line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
      continue;
    }

    if (line.startsWith('+')) {
      added += 1;
      continue;
    }

    if (line.startsWith('-')) {
      removed += 1;
    }
  }

  return { added, removed };
}

function getChangeBadge(toolName, fileChange) {
  if (fileChange.added > 0 || fileChange.removed > 0) {
    return '';
  }

  switch (toolName) {
    case 'fs_write':
      return fileChange.created ? 'created' : 'updated';
    case 'fs_mkdir':
      return 'created';
    case 'fs_delete':
      return 'deleted';
    default:
      return 'updated';
  }
}

function buildMessageChangeCards(session) {
  const rawMessages = session?.messages ?? [];
  const toolEvents = (session?.toolEvents ?? []).filter(
    (event) => MUTATING_TOOL_NAMES.has(event.toolName) && event.status === 'completed'
  );

  if (rawMessages.length === 0 || toolEvents.length === 0) {
    return new Map();
  }

  const userMessages = rawMessages.filter((message) => message.role === 'user');
  const cards = new Map();

  for (let index = 0; index < userMessages.length; index += 1) {
    const currentUser = userMessages[index];
    const nextUser = userMessages[index + 1];
    const startMarker = currentUser.createdAt ?? '';
    const endMarker = nextUser?.createdAt ?? '9999-12-31T23:59:59.999Z';
    const assistantMessages = rawMessages.filter(
      (message) =>
        message.role === 'assistant' &&
        !message.isToolTrace &&
        (message.createdAt ?? '') >= startMarker &&
        (message.createdAt ?? '') < endMarker
    );
    const finalAssistant = assistantMessages.at(-1);

    if (!finalAssistant) {
      continue;
    }

    const turnEvents = toolEvents.filter((event) => {
      const marker = event.completedAt ?? event.createdAt ?? '';
      return marker >= startMarker && marker < endMarker;
    });

    if (turnEvents.length === 0) {
      continue;
    }

    const files = new Map();
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const event of turnEvents) {
      const filePath = event.result?.path ?? event.arguments?.path ?? event.toolName;
      const diffCounts = parseDiffLineCounts(event.diffText ?? '');
      totalAdded += diffCounts.added;
      totalRemoved += diffCounts.removed;

      const previous = files.get(filePath) ?? {
        path: filePath,
        added: 0,
        removed: 0,
        badge: '',
        created: false,
        eventId: event.id,
      };

      previous.added += diffCounts.added;
      previous.removed += diffCounts.removed;
      previous.created = previous.created || Boolean(event.result?.created);
      previous.eventId = event.id;
      previous.badge =
        previous.badge ||
        getChangeBadge(event.toolName, {
          added: diffCounts.added,
          removed: diffCounts.removed,
          created: Boolean(event.result?.created),
        });

      files.set(filePath, previous);
    }

    cards.set(finalAssistant.id, {
      totalFiles: files.size,
      totalAdded,
      totalRemoved,
      files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
    });
  }

  return cards;
}

function summarizeSourceSnippet(value = '', maxLength = 180) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function buildMessageSourceCards(session) {
  const rawMessages = session?.messages ?? [];
  const toolEvents = (session?.toolEvents ?? []).filter(
    (event) =>
      ['web_search', 'web_fetch', 'browser_fetch'].includes(event.toolName) &&
      event.status === 'completed'
  );

  if (rawMessages.length === 0 || toolEvents.length === 0) {
    return new Map();
  }

  const userMessages = rawMessages.filter((message) => message.role === 'user');
  const cards = new Map();

  for (let index = 0; index < userMessages.length; index += 1) {
    const currentUser = userMessages[index];
    const nextUser = userMessages[index + 1];
    const startMarker = currentUser.createdAt ?? '';
    const endMarker = nextUser?.createdAt ?? '9999-12-31T23:59:59.999Z';
    const assistantMessages = rawMessages.filter(
      (message) =>
        message.role === 'assistant' &&
        !message.isToolTrace &&
        (message.createdAt ?? '') >= startMarker &&
        (message.createdAt ?? '') < endMarker
    );
    const finalAssistant = assistantMessages.at(-1);

    if (!finalAssistant) {
      continue;
    }

    const turnEvents = toolEvents.filter((event) => {
      const marker = event.completedAt ?? event.createdAt ?? '';
      return marker >= startMarker && marker < endMarker;
    });

    if (turnEvents.length === 0) {
      continue;
    }

    const sources = [];
    const seenUrls = new Set();

    for (const event of turnEvents) {
      if (event.toolName === 'web_search') {
        for (const result of event.result?.results ?? []) {
          const url = result?.url ? String(result.url) : '';
          if (!url || seenUrls.has(url)) {
            continue;
          }

          seenUrls.add(url);
          sources.push({
            id: `${event.id}-${url}`,
            kind: 'search',
            eventId: event.id,
            title: result?.title || url,
            url,
            snippet: summarizeSourceSnippet(result?.snippet ?? ''),
          });
        }
        continue;
      }

      const url = String(event.result?.canonicalUrl ?? event.result?.url ?? event.arguments?.url ?? '').trim();
      if (!url || seenUrls.has(url)) {
        continue;
      }

      seenUrls.add(url);
      sources.push({
        id: `${event.id}-${url}`,
        kind: event.toolName === 'browser_fetch' ? 'browser' : 'fetch',
        eventId: event.id,
        title: event.result?.title || url,
        url,
        snippet: summarizeSourceSnippet(event.result?.description || event.result?.content || ''),
        screenshotPath: event.result?.screenshotPath || '',
      });
    }

    if (sources.length === 0) {
      continue;
    }

    cards.set(finalAssistant.id, {
      totalSources: sources.length,
      sources: sources.slice(0, 8),
    });
  }

  return cards;
}

function baseName(absolutePath) {
  const normalized = String(absolutePath ?? '').replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? absolutePath ?? 'workspace';
}

function buildThreadSummary(session) {
  const userMessages = session?.messages?.filter((message) => message.role === 'user') ?? [];
  const firstPrompt = userMessages[0]?.content ?? '';
  const lastPrompt = userMessages.at(-1)?.content ?? '';
  const title = truncate(firstPrompt || lastPrompt || 'Ready session', 38);
  const timeLabel = formatTimestamp(session?.updatedAt) || 'now';

  return {
    id: session.id,
    sessionId: session.id,
    title,
    age: `${baseName(session.workspaceRoot)} · ${timeLabel}`,
    active: false,
    prompt: lastPrompt,
    updatedAt: session.updatedAt,
    workspaceRoot: session.workspaceRoot,
    providerId: session.providerId,
    model: session.model,
  };
}

function normalizeThreadSummary(thread) {
  return {
    id: thread.id,
    sessionId: thread.sessionId ?? thread.id,
    title: thread.title ?? truncate(thread.prompt || 'Ready session', 38),
    age:
      thread.age ??
      `${baseName(thread.workspaceRoot)} · ${formatTimestamp(thread.updatedAt) || 'now'}`,
    active: false,
    prompt: thread.prompt ?? '',
    updatedAt: thread.updatedAt,
    workspaceRoot: thread.workspaceRoot,
    providerId: thread.providerId,
    model: thread.model,
  };
}

function buildSessionConfigPayload(form, providerConfigs = {}) {
  return {
    workspaceRoot: form.workspaceRoot,
    providerId: form.providerId,
    providerConfig: getProviderConfig(providerConfigs, form.providerId),
    model: form.model,
    permissionPreset: form.permissionPreset,
    modelSettings: normalizeModelSettings(form.modelSettings),
  };
}

function isSessionConfigDirty(session, form) {
  if (!session) {
    return false;
  }

  const nextConfig = buildSessionConfigPayload(form);
  return (
    session.workspaceRoot !== nextConfig.workspaceRoot ||
    (session.providerId ?? 'ollama') !== nextConfig.providerId ||
    session.model !== nextConfig.model ||
    session.permissionPreset !== nextConfig.permissionPreset ||
    !areModelSettingsEqual(session.modelSettings, nextConfig.modelSettings)
  );
}

function upsertThread(threads, session) {
  const nextThread = buildThreadSummary(session);
  return [nextThread, ...threads.filter((thread) => thread.sessionId !== session.id)].sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );
}

function buildProjectRows(session, form, previewMode, quickPrompts, t) {
  const activeWorkspace = session?.workspaceRoot ?? form.workspaceRoot;

  return [
    {
      id: 'workspace-main',
      label: baseName(activeWorkspace),
      note: previewMode ? t('settings.previewMode') : t('left.activeWorkspace'),
      active: true,
      prompt: quickPrompts[0],
    },
  ];
}

function buildConversationRows(threads, activeThreadId, hasDraft, t, quickPrompts) {
  const rows = [...threads].map((thread) => ({
    ...thread,
    active: thread.sessionId === activeThreadId,
    kind: 'thread',
  }));

  if (hasDraft) {
    rows.unshift({
      id: 'conversation-draft',
      title: t('chat.untitled'),
      age: t('time.ready'),
      active: true,
      prompt: '',
      kind: 'draft',
    });
  }

  if (rows.length === 0) {
    return [
      {
        id: 'conversation-empty',
        title: t('thread.emptyTitle'),
        age: t('time.now'),
        active: true,
        prompt: quickPrompts[0],
        kind: 'draft',
      },
    ];
  }

  return rows;
}

function scoreConversationSearchMatch(thread, normalizedQuery, locale) {
  if (!normalizedQuery) {
    return 1;
  }

  const title = String(thread.title ?? '').toLocaleLowerCase(locale);
  const prompt = String(thread.prompt ?? '').toLocaleLowerCase(locale);
  const workspaceLabel = baseName(thread.workspaceRoot).toLocaleLowerCase(locale);
  const model = String(thread.model ?? '').toLocaleLowerCase(locale);

  let score = 0;

  if (title.startsWith(normalizedQuery)) {
    score += 6;
  } else if (title.includes(normalizedQuery)) {
    score += 4;
  }

  if (prompt.includes(normalizedQuery)) {
    score += 3;
  }

  if (workspaceLabel.includes(normalizedQuery)) {
    score += 2;
  }

  if (model.includes(normalizedQuery)) {
    score += 1;
  }

  return score;
}

function buildConversationSearchRows(threads, query, language = DEFAULT_LANGUAGE) {
  const locale = getLanguageLocale(language);
  const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase(locale);
  const sourceRows = [...threads].sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  );

  return sourceRows
    .map((thread) => {
      const workspaceLabel = baseName(thread.workspaceRoot);
      const preview = truncate(thread.prompt || thread.title, 78);
      return {
        ...thread,
        workspaceLabel,
        preview,
        score: scoreConversationSearchMatch(thread, normalizedQuery, locale),
      };
    })
    .filter((thread) => (!normalizedQuery ? true : thread.score > 0))
    .sort(
      (left, right) =>
        right.score - left.score ||
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    )
    .slice(0, normalizedQuery ? 12 : 9)
    .map((thread, index) => ({
      ...thread,
      shortcut: index < 9 ? `Ctrl+${index + 1}` : '',
    }));
}

function parseMcpArgsInput(value = '') {
  return String(value)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMcpEnvInput(value = '') {
  const entries = String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const env = {};

  for (const entry of entries) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = entry.slice(0, separatorIndex).trim();
    const envValue = entry.slice(separatorIndex + 1).trim();

    if (!key) {
      continue;
    }

    env[key] = envValue;
  }

  return env;
}

function formatMcpArgs(args = []) {
  return Array.isArray(args) ? args.join(', ') : '';
}

function formatMcpEnv(env = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return '';
  }

  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function ThemeOption({ theme, selectedTheme, onSelect }) {
  const active = theme.id === selectedTheme;

  return html`
    <button
      type="button"
      className=${`theme-option ${active ? 'active' : ''}`}
      onClick=${() => onSelect(theme.id)}
      aria-pressed=${active}
    >
      <div className="theme-swatches">
        ${theme.swatches.map(
          (swatch) => html`<span key=${swatch} style=${{ background: swatch }}></span>`
        )}
      </div>
      <div className="theme-copy">
        <strong>${theme.label}</strong>
        <span>${theme.description}</span>
      </div>
    </button>
  `;
}

function AutomationExplorer({ onSelectCard, t, automationGroups }) {
  return html`
    <div className="automation-column">
      <div className="automation-scroller">
        <header className="automation-hero">
          <div className="automation-hero-copy">
            <h1>${t('automation.title')}</h1>
            <p>
              ${t('automation.copy')}
              <button type="button" className="automation-link" onClick=${() => onSelectCard({
                prompt: t('automation.morePrompt')
              })}>
                ${t('automation.more')}
              </button>
            </p>
          </div>
        </header>

        <div className="automation-stack">
          ${automationGroups.map(
            (group) => html`
              <section key=${group.id} className="automation-section">
                <div className="automation-section-header">
                  <strong>${group.title}</strong>
                </div>
                <div className="automation-grid">
                  ${group.cards.map(
                    (card) => html`
                      <button
                        key=${card.id}
                        type="button"
                        className="automation-card"
                        onClick=${() => onSelectCard(card)}
                      >
                        <span className=${`automation-card-badge ${card.tone}`}>${card.badge}</span>
                        <div className="automation-card-copy">
                          <strong>${card.description}</strong>
                          <span>${t('automation.cardReady')}</span>
                        </div>
                      </button>
                    `
                  )}
                </div>
              </section>
            `
          )}
        </div>
      </div>
    </div>
  `;
}

function SettingsModal({
  open,
  section,
  onSectionChange,
  onClose,
  language,
  onLanguageChange,
  t,
  form,
  providers,
  providerConfigs,
  bootstrap,
  permissionDescription,
  theme,
  themeOptions,
  onThemeChange,
  onChooseWorkspace,
  onUpdateForm,
  onUpdateProviderId,
  onUpdateProviderConfig,
  onUpdateModelSetting,
  onRefreshModels,
  showRuntimeSettings,
  onToggleRuntimeSettings,
  previewMode,
  busy,
  loadingModels,
  modelStatusMessage,
  session,
  autoSyncingSettings,
  onExportProgressReport,
  exportingProgressReport,
  mcpServers,
  mcpDraft,
  onUpdateMcpDraft,
  onAddMcpServer,
  onRemoveMcpServer,
  onToggleMcpServer,
  savingMcp,
}) {
  if (!open) {
    return null;
  }

  const selectedProviderDefinition =
    providers.find((provider) => provider.id === form.providerId) ?? providers[0] ?? null;
  const selectedProviderConfig = getProviderConfig(providerConfigs, form.providerId);
  const settingsProviderLabel =
    selectedProviderDefinition?.label ?? t('settings.about.notSelected');

  return html`
    <div className="settings-overlay" onClick=${onClose}>
      <div className="settings-modal" onClick=${(event) => event.stopPropagation()}>
        <aside className="settings-sidebar">
          <div className="settings-sidebar-header">
            <strong>${t('settings.title')}</strong>
            <span>${previewMode ? t('settings.previewMode') : t('settings.localRuntime')}</span>
          </div>

          <div className="settings-nav">
            ${SETTINGS_SECTIONS.map(
              (item) => html`
                <button
                  key=${item.id}
                  type="button"
                  className=${`settings-nav-button ${section === item.id ? 'active' : ''}`}
                  onClick=${() => onSectionChange(item.id)}
                >
                  ${t(`settings.section.${item.id}`)}
                </button>
              `
            )}
          </div>
        </aside>

        <div className="settings-content">
          <div className="settings-header">
            <div className="settings-header-copy">
              <strong>
                ${section === 'general'
                  ? t('settings.header.general')
                  : section === 'mcp'
                    ? t('settings.header.mcp')
                  : section === 'appearance'
                    ? t('settings.header.appearance')
                    : t('settings.header.about')}
              </strong>
              <span>
                ${section === 'general'
                  ? t('settings.header.generalCopy')
                  : section === 'mcp'
                    ? t('settings.header.mcpCopy')
                  : section === 'appearance'
                    ? t('settings.header.appearanceCopy')
                    : t('settings.header.aboutCopy')}
              </span>
            </div>
            <button type="button" className="settings-close-button" onClick=${onClose}>
              ${t('settings.close')}
            </button>
          </div>

          ${section === 'general'
            ? html`
                <div className="settings-stack">
                  <section className="settings-card settings-card-spacious">
                    <div className="settings-card-header">
                      <strong>${t('settings.app.title')}</strong>
                      <span>${t('settings.app.copy')}</span>
                    </div>
                    <div className="field-grid settings-field-grid">
                      <div className="field">
                        <label>${t('settings.language.label')}</label>
                        <select value=${language} onChange=${(event) => onLanguageChange(event.target.value)}>
                          ${LANGUAGE_OPTIONS.map(
                            (option) => html`
                              <option key=${option.id} value=${option.id}>${option.label}</option>
                            `
                          )}
                        </select>
                        <small>${t('settings.language.help')}</small>
                      </div>
                    </div>
                  </section>

                  <section className="settings-card settings-card-spacious">
                    <div className="settings-card-header">
                      <strong>${t('settings.workspace.title')}</strong>
                      <span>${t('settings.workspace.copy')}</span>
                    </div>
                    <div className="split-row settings-split-row">
                      <div className="settings-input-shell">
                        <span className="settings-input-label">${t('settings.workspace.currentFolder')}</span>
                        <input value=${form.workspaceRoot} readOnly />
                      </div>
                      <button
                        type="button"
                        className="compact-button settings-folder-button"
                        onClick=${onChooseWorkspace}
                      >
                        ${t('settings.workspace.openFolder')}
                      </button>
                    </div>
                  </section>

                  <section className="settings-card settings-card-spacious">
                    <div className="settings-card-header settings-card-header-split">
                      <div className="settings-card-copy">
                        <strong>${t('settings.provider.title')}</strong>
                        <span>${t('settings.provider.copy')}</span>
                      </div>
                      <button
                        type="button"
                        className="compact-button settings-refresh-button"
                        disabled=${busy || loadingModels}
                        onClick=${() => void onRefreshModels(form.providerId)}
                      >
                        ${loadingModels ? t('settings.provider.loading') : t('settings.provider.refresh')}
                      </button>
                    </div>

                    <div className="field-grid settings-field-grid">
                      <div className="field">
                        <label>${t('settings.provider.select')}</label>
                        <select
                          value=${form.providerId}
                          onChange=${(event) => onUpdateProviderId(event.target.value)}
                        >
                          ${providers.map(
                            (provider) => html`
                              <option key=${provider.id} value=${provider.id}>
                                ${provider.label}
                              </option>
                            `
                          )}
                        </select>
                      </div>
                    </div>

                    ${selectedProviderDefinition
                      ? html`
                          <div className="settings-note settings-note-compact">
                            ${selectedProviderDefinition.description}
                          </div>
                        `
                      : null}

                    ${selectedProviderDefinition?.configFields?.length > 0
                      ? html`
                          <div className="field-grid settings-field-grid">
                            ${selectedProviderDefinition.configFields.map((field) =>
                              field.type === 'boolean'
                                ? html`
                                    <label key=${field.key} className="toggle-row">
                                      <span>${field.label}</span>
                                      <input
                                        type="checkbox"
                                        checked=${Boolean(selectedProviderConfig[field.key])}
                                        onChange=${(event) =>
                                          onUpdateProviderConfig(
                                            form.providerId,
                                            field.key,
                                            event.target.checked
                                          )}
                                      />
                                    </label>
                                  `
                                : html`
                                    <div key=${field.key} className="field">
                                      <label>${field.label}</label>
                                      <input
                                        type=${field.type === 'password' ? 'password' : field.type ?? 'text'}
                                        value=${selectedProviderConfig[field.key] ?? ''}
                                        placeholder=${field.placeholder ?? ''}
                                        onInput=${(event) =>
                                          onUpdateProviderConfig(
                                            form.providerId,
                                            field.key,
                                            field.type === 'number'
                                              ? Number(event.target.value)
                                              : event.target.value
                                          )}
                                      />
                                    </div>
                                  `
                            )}
                          </div>
                        `
                      : null}

                    <div className="settings-note settings-note-compact">
                      ${modelStatusMessage}
                    </div>
                  </section>

                  <section className="settings-card settings-card-spacious">
                    <div className="settings-card-header settings-card-header-split">
                      <div className="settings-card-copy">
                        <strong>${t('settings.runtimeDefaults.title')}</strong>
                        <span>${t('settings.runtimeDefaults.copy')}</span>
                      </div>
                      <button
                        type="button"
                        className="compact-button settings-refresh-button"
                        disabled=${busy || loadingModels}
                        onClick=${() => void onRefreshModels()}
                      >
                        ${loadingModels ? t('settings.provider.loading') : t('settings.provider.refresh')}
                      </button>
                    </div>

                    <div className="settings-note settings-note-compact">
                      ${t('settings.runtimeDefaults.note')} ${modelStatusMessage}
                    </div>

                    <div className="settings-runtime-toggle">
                      <div className="settings-runtime-copy">
                        <strong>${t('settings.runtime.title')}</strong>
                        <span>${t('settings.runtime.copy')}</span>
                      </div>
                      <button
                        type="button"
                        className="ghost-link"
                        onClick=${onToggleRuntimeSettings}
                      >
                        ${showRuntimeSettings
                          ? t('settings.runtime.hide')
                          : t('settings.runtime.show')}
                      </button>
                    </div>

                    ${showRuntimeSettings
                      ? html`
                          <div className="runtime-box settings-runtime-box">
                            <div className="field-grid settings-field-grid settings-runtime-grid">
                              <div className="field context-length-field settings-span-2">
                                <div className="settings-range-header">
                                  <label>${t('settings.runtime.contextLength')}</label>
                                  <strong>${formatContextLength(form.modelSettings.contextLength)}</strong>
                                </div>
                                <span className="settings-range-help">
                                  ${t('settings.runtime.contextHelp')}
                                </span>
                                <input
                                  type="range"
                                  min="0"
                                  max=${String(CONTEXT_LENGTH_OPTIONS.length - 1)}
                                  step="1"
                                  className="settings-range-slider"
                                  value=${String(
                                    getContextLengthOptionIndex(form.modelSettings.contextLength)
                                  )}
                                  onInput=${(event) =>
                                    onUpdateModelSetting(
                                      'contextLength',
                                      CONTEXT_LENGTH_OPTIONS[Number(event.target.value)] ??
                                        DEFAULT_MODEL_SETTINGS.contextLength
                                    )}
                                />
                                <div className="settings-range-scale">
                                  ${CONTEXT_LENGTH_OPTIONS.map(
                                    (option) => html`
                                      <span
                                        key=${option}
                                        className=${`settings-range-mark ${
                                          option ===
                                          CONTEXT_LENGTH_OPTIONS[
                                            getContextLengthOptionIndex(
                                              form.modelSettings.contextLength
                                            )
                                          ]
                                            ? 'active'
                                            : ''
                                        }`}
                                      >
                                        ${formatContextLength(option)}
                                      </span>
                                    `
                                  )}
                                </div>
                              </div>

                              <div className="field">
                                <label>${t('settings.runtime.temperature')}</label>
                                <input
                                  type="number"
                                  min="0"
                                  max="2"
                                  step="0.1"
                                  value=${form.modelSettings.temperature}
                                  onInput=${(event) =>
                                    onUpdateModelSetting(
                                      'temperature',
                                      Number(event.target.value)
                                    )}
                                />
                              </div>
                            </div>

                            <div className="field">
                              <label>${t('settings.runtime.systemPrompt')}</label>
                              <textarea
                                rows="6"
                                value=${form.modelSettings.systemPrompt}
                                onInput=${(event) =>
                                  onUpdateModelSetting('systemPrompt', event.target.value)}
                              ></textarea>
                            </div>
                          </div>
                        `
                      : null}

                    <div className="settings-note">
                      ${session
                        ? autoSyncingSettings
                          ? t('settings.runtime.syncing')
                          : t('settings.runtime.synced')
                        : t('settings.runtime.newChats')}
                    </div>
                  </section>
                </div>
              `
            : null}

          ${section === 'mcp'
            ? html`
                <div className="settings-stack">
                  <section className="settings-card settings-card-spacious">
                    <div className="settings-card-header">
                      <strong>${t('settings.mcp.title')}</strong>
                      <span>${t('settings.mcp.copy')}</span>
                    </div>

                    <div className="settings-note settings-note-compact">
                      ${t('settings.mcp.note')}
                    </div>

                    <div className="mcp-server-list">
                      ${mcpServers.length > 0
                        ? mcpServers.map(
                            (server) => html`
                              <div key=${server.id} className="mcp-server-row">
                                <div className="mcp-server-copy">
                                  <div className="mcp-server-title-row">
                                    <strong>${server.name}</strong>
                                    <span className=${`mcp-server-status ${server.status || 'unknown'}`}>
                                      ${server.status === 'connected'
                                        ? t('settings.mcp.connected')
                                        : server.status === 'disabled'
                                          ? t('settings.mcp.disabled')
                                          : t('settings.mcp.error')}
                                    </span>
                                  </div>
                                  <span>${server.command}${server.args?.length ? ` ${server.args.join(' ')}` : ''}</span>
                                  ${server.cwd
                                    ? html`<small>CWD: ${server.cwd}</small>`
                                    : null}
                                  ${server.error
                                    ? html`<small className="mcp-server-error">${server.error}</small>`
                                    : html`
                                        <small>
                                          ${server.toolCount ?? 0} tool${server.protocolVersion
                                            ? ` · MCP ${server.protocolVersion}`
                                            : ''}
                                        </small>
                                      `}
                                </div>
                                <div className="mcp-server-actions">
                                  <button
                                    type="button"
                                    className="compact-button"
                                    disabled=${savingMcp}
                                    onClick=${() => onToggleMcpServer(server.id, !(server.enabled !== false))}
                                  >
                                    ${server.enabled === false ? t('settings.mcp.enable') : t('settings.mcp.disable')}
                                  </button>
                                  <button
                                    type="button"
                                    className="danger-action"
                                    disabled=${savingMcp}
                                    onClick=${() => onRemoveMcpServer(server.id)}
                                  >
                                    ${t('settings.mcp.remove')}
                                  </button>
                                </div>
                              </div>
                            `
                          )
                        : html`
                            <div className="mcp-empty-state">
                              ${t('settings.mcp.empty')}
                            </div>
                          `}
                    </div>
                  </section>

                  <section className="settings-card settings-card-spacious">
                    <div className="settings-card-header">
                      <strong>${t('settings.mcp.newTitle')}</strong>
                      <span>${t('settings.mcp.copy')}</span>
                    </div>

                    <div className="field-grid settings-field-grid">
                      <div className="field">
                        <label>${t('settings.mcp.name')}</label>
                        <input
                          value=${mcpDraft.name}
                          placeholder=${t('settings.mcp.placeholder.name')}
                          onInput=${(event) => onUpdateMcpDraft('name', event.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label>${t('settings.mcp.command')}</label>
                        <input
                          value=${mcpDraft.command}
                          placeholder=${t('settings.mcp.placeholder.command')}
                          onInput=${(event) => onUpdateMcpDraft('command', event.target.value)}
                        />
                      </div>
                      <div className="field settings-span-2">
                        <label>${t('settings.mcp.args')}</label>
                        <input
                          value=${mcpDraft.args}
                          placeholder=${t('settings.mcp.placeholder.args')}
                          onInput=${(event) => onUpdateMcpDraft('args', event.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label>${t('settings.mcp.cwd')}</label>
                        <input
                          value=${mcpDraft.cwd}
                          placeholder=${t('settings.mcp.placeholder.cwd')}
                          onInput=${(event) => onUpdateMcpDraft('cwd', event.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label>${t('settings.mcp.env')}</label>
                        <textarea
                          rows="4"
                          placeholder=${t('settings.mcp.placeholder.env')}
                          value=${mcpDraft.env}
                          onInput=${(event) => onUpdateMcpDraft('env', event.target.value)}
                        ></textarea>
                      </div>
                    </div>

                    <div className="settings-actions-row">
                      <button
                        type="button"
                        className="primary-action"
                        disabled=${savingMcp}
                        onClick=${onAddMcpServer}
                      >
                        ${savingMcp ? t('settings.mcp.connecting') : t('settings.mcp.add')}
                      </button>
                    </div>
                  </section>
                </div>
              `
            : null}

          ${section === 'appearance'
            ? html`
                <div className="settings-stack">
                  <section className="settings-card">
                    <div className="settings-card-header">
                      <strong>${t('settings.appearance.title')}</strong>
                      <span>${t('settings.appearance.copy')}</span>
                    </div>
                    <div className="theme-option-list">
                      ${themeOptions.map(
                        (themeOption) => html`
                          <${ThemeOption}
                            key=${themeOption.id}
                            theme=${themeOption}
                            selectedTheme=${theme}
                            onSelect=${onThemeChange}
                          />
                        `
                      )}
                    </div>
                  </section>
                </div>
              `
            : null}

          ${section === 'about'
            ? html`
                <div className="settings-stack">
                  <section className="settings-card settings-card-spacious">
                    <div className="settings-card-header">
                      <strong>ForgePilot</strong>
                      <span>${t('settings.about.copy')}</span>
                    </div>
                    <div className="summary-list">
                      <div className="summary-row">
                        <span>${t('settings.about.mode')}</span>
                        <strong>${previewMode ? t('settings.previewMode') : t('settings.about.desktopRuntime')}</strong>
                      </div>
                      <div className="summary-row">
                        <span>${t('settings.about.workspace')}</span>
                        <strong>${form.workspaceRoot || t('settings.about.notSelected')}</strong>
                      </div>
                      <div className="summary-row">
                        <span>${t('settings.about.provider')}</span>
                        <strong>${settingsProviderLabel}</strong>
                      </div>
                      <div className="summary-row">
                        <span>${t('settings.about.model')}</span>
                        <strong>${form.model || t('settings.about.notSelected')}</strong>
                      </div>
                    </div>
                  </section>

                  <section className="settings-card settings-card-spacious">
                    <div className="settings-card-header">
                      <strong>${t('settings.about.highlightsTitle')}</strong>
                      <span>${t('settings.about.highlightsCopy')}</span>
                    </div>
                    <div className="summary-list">
                      <div className="summary-row">
                        <strong>${t('settings.about.providersTitle')}</strong>
                        <span>${t('settings.about.providersCopy')}</span>
                      </div>
                      <div className="summary-row">
                        <strong>${t('settings.about.toolsTitle')}</strong>
                        <span>${t('settings.about.toolsCopy')}</span>
                      </div>
                      <div className="summary-row">
                        <strong>${t('settings.about.documentsTitle')}</strong>
                        <span>${t('settings.about.documentsCopy')}</span>
                      </div>
                    </div>
                    <div className="settings-actions-row">
                      <button
                        type="button"
                        className="primary-action"
                        disabled=${exportingProgressReport}
                        onClick=${() => void onExportProgressReport()}
                      >
                        ${exportingProgressReport
                          ? t('settings.about.exportProgressBusy')
                          : t('settings.about.exportProgress')}
                      </button>
                    </div>
                  </section>
                </div>
              `
            : null}
        </div>
      </div>
    </div>
  `;
}

function App() {
  const [bootstrap, setBootstrap] = useState(null);
  const [session, setSession] = useState(null);
  const [threads, setThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [activeWorkspaceView, setActiveWorkspaceView] = useState('chat');
  const [theme, setTheme] = useState(getInitialTheme);
  const [language, setLanguage] = useState(DEFAULT_LANGUAGE);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [activeRequest, setActiveRequest] = useState(null);
  const [activeRunSessionId, setActiveRunSessionId] = useState(null);
  const [error, setError] = useState('');
  const [notifications, setNotifications] = useState([]);
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [showRuntimeSettings, setShowRuntimeSettings] = useState(false);
  const [livePhase, setLivePhase] = useState('');
  const [liveStreamText, setLiveStreamText] = useState('');
  const [liveStreamThinking, setLiveStreamThinking] = useState('');
  const [lastRecoverableError, setLastRecoverableError] = useState('');
  const [windowState, setWindowState] = useState({
    isMaximized: false,
    isFocused: true,
    bottomSafeArea: 0,
  });
  const [activeTopMenu, setActiveTopMenu] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState('general');
  const [showConversationSearch, setShowConversationSearch] = useState(false);
  const [conversationSearchQuery, setConversationSearchQuery] = useState('');
  const [conversationSearchIndex, setConversationSearchIndex] = useState(0);
  const [loadingModels, setLoadingModels] = useState(false);
  const [exportingProgressReport, setExportingProgressReport] = useState(false);
  const [autoSyncingSettings, setAutoSyncingSettings] = useState(false);
  const [savingMcp, setSavingMcp] = useState(false);
  const [deletingThreadId, setDeletingThreadId] = useState(null);
  const [mcpDraft, setMcpDraft] = useState(EMPTY_MCP_DRAFT);
  const [providerConfigs, setProviderConfigs] = useState({});
  const [form, setForm] = useState({
    workspaceRoot: '',
    providerId: 'ollama',
    model: '',
    permissionPreset: 'full_access',
    modelSettings: {
      contextLength: DEFAULT_MODEL_SETTINGS.contextLength,
      temperature: DEFAULT_MODEL_SETTINGS.temperature,
      systemPrompt: DEFAULT_MODEL_SETTINGS.systemPrompt,
    },
  });

  const messagesRef = useRef(null);
  const composerRef = useRef(null);
  const attachmentInputRef = useRef(null);
  const conversationSearchInputRef = useRef(null);
  const topbarMenuRef = useRef(null);
  const sessionSyncPromiseRef = useRef(null);
  const lastAutoRefreshProviderRef = useRef(null);
  const notificationTimeoutsRef = useRef(new Map());
  const deferredMessages = useDeferredValue(
    session?.messages?.filter((message) => message.role !== 'tool' && !message.isToolTrace) ?? []
  );
  const t = (key, variables) => translate(language, key, variables);
  const quickPrompts = getQuickPrompts(t);
  const themeOptions = getThemeOptions(t);
  const automationGroups = getAutomationGroups(t);

  const previewMode = Boolean(bootstrap?.previewMode);
  const configuredMcpServers = bootstrap?.mcpServers ?? [];
  const providerOptions = bootstrap?.providers ?? [];
  const loadedModelsProviderId =
    bootstrap?.loadedModelsProviderId ?? bootstrap?.defaultProviderId ?? form.providerId;
  const isTurnRunning = activeRequest === 'send';
  const isStopPending = activeRequest === 'stopping';
  const availableModels =
    loadedModelsProviderId === form.providerId ? bootstrap?.models ?? [] : [];
  const hasModels = availableModels.length > 0;
  const selectedProviderDefinition =
    providerOptions.find((provider) => provider.id === form.providerId) ?? providerOptions[0] ?? null;
  const providerLabel = selectedProviderDefinition?.label ?? 'Provider';
  const sessionBackfillModel = session?.providerId === form.providerId ? session?.model : '';
  const effectiveModelName =
    form.model ||
    sessionBackfillModel ||
    (bootstrap?.defaultProviderId === form.providerId ? bootstrap?.defaultModel : '') ||
    (bootstrap?.activeSession?.providerId === form.providerId ? bootstrap?.activeSession?.model : '') ||
    '';
  const modelOptions = hasModels
    ? availableModels.some((item) => item.name === effectiveModelName) || !effectiveModelName
      ? availableModels
      : [
          {
            name: effectiveModelName,
            capabilities: session?.capabilities ?? null,
            isFallback: true,
          },
          ...availableModels,
        ]
    : effectiveModelName
      ? [
          {
            name: effectiveModelName,
            capabilities: session?.capabilities ?? null,
            isFallback: true,
          },
        ]
      : [];
  const selectedModel =
    modelOptions.find((item) => item.name === effectiveModelName) ??
    (session?.providerId === form.providerId && session?.model === effectiveModelName
      ? {
          name: session.model,
          capabilities: session.capabilities ?? null,
        }
      : null);
  const capability = capabilityTag(selectedModel, form.permissionPreset, t);
  const selectedEvent =
    session?.toolEvents?.find((event) => event.id === selectedEventId) ??
    session?.toolEvents?.at(-1) ??
    null;
  const permissionDescription = getPermissionDescription(t, form.permissionPreset);
  const permissionLabel = getPermissionLabel(t, form.permissionPreset);
  const completedEvents =
    session?.toolEvents?.filter((event) => event.status === 'completed').length ?? 0;
  const progressRows = session?.toolEvents?.slice(-5).reverse() ?? [];
  const liveToolRows = (session?.toolEvents ?? [])
    .filter((event) => ['queued', 'running', 'pending_approval'].includes(event.status))
    .slice(-4)
    .reverse();
  const messageChangeCards = buildMessageChangeCards(session);
  const messageSourceCards = buildMessageSourceCards(session);
  const attachmentShelfItems = (session?.attachments ?? []).slice(-8).reverse();
  const projectRows = buildProjectRows(session, form, previewMode, quickPrompts, t);
  const conversationRows = buildConversationRows(threads, activeThreadId, !session, t, quickPrompts);
  const conversationSearchRows = buildConversationSearchRows(
    threads,
    conversationSearchQuery,
    language
  );
  const activeThread = threads.find((thread) => thread.sessionId === activeThreadId) ?? null;
  const threadTitle = activeThread?.title ?? t('chat.untitled');
  const toolEvents = session?.toolEvents ?? [];
  const isAutomationsView = activeWorkspaceView === 'automations';
  const modelStatusMessage = loadingModels
    ? t('status.providerLoading', { provider: providerLabel })
    : bootstrap?.providerError
      ? effectiveModelName
        ? t('status.providerPreserved', { model: effectiveModelName })
        : t('status.providerError', { provider: providerLabel, message: bootstrap.providerError })
      : loadedModelsProviderId !== form.providerId
        ? t('status.providerNotLoaded', { provider: providerLabel })
      : hasModels
        ? t('status.providerLoaded', { count: availableModels.length })
        : effectiveModelName
          ? t('status.providerCached', { model: effectiveModelName })
          : t('status.providerUnknown');
  const selectedEventIndex = selectedEvent
    ? toolEvents.findIndex((event) => event.id === selectedEvent.id)
    : -1;
  const canGoBack = selectedEventIndex > 0;
  const canGoForward =
    selectedEventIndex !== -1 && selectedEventIndex < Math.max(toolEvents.length - 1, 0);
  const liveStatusLabel = session?.pendingApproval
    ? t('status.pendingApproval')
    : isStopPending
      ? t('status.stopping')
      : liveToolRows.some((event) => event.status === 'running')
        ? t('status.running')
        : liveToolRows.some((event) => event.status === 'queued')
          ? t('status.queued')
          : isTurnRunning
            ? t('status.thinking')
            : '';
  const diagnosticsProviderState =
    loadedModelsProviderId === form.providerId && !bootstrap?.providerError ? 'online' : 'attention';
  const shouldShowLiveActivity = Boolean(
    liveStatusLabel || liveToolRows.length > 0 || isTurnRunning || isStopPending || liveStreamText || liveStreamThinking
  );

  useEffect(() => {
    void loadBootstrap();
  }, []);

  useEffect(() => {
    document.body.dataset.theme = theme;
    try {
      globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage failures.
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(
    () => () => {
      for (const timer of notificationTimeoutsRef.current.values()) {
        globalThis.clearTimeout(timer);
      }
      notificationTimeoutsRef.current.clear();
    },
    []
  );

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--window-bottom-safe-area',
      `${Math.max(0, Number(windowState.bottomSafeArea ?? 0))}px`
    );
  }, [windowState.bottomSafeArea]);

  useEffect(() => {
    if (typeof api.onSessionStateChange !== 'function') {
      return undefined;
    }

    const unsubscribe = api.onSessionStateChange((payload) => {
      if (!payload?.session?.id) {
        return;
      }

      if (payload.phase === 'assistant_stream') {
        setLivePhase(payload.phase);
        setLiveStreamText(summarizeLiveStreamContent(payload.streamText ?? '', t));
        setLiveStreamThinking(clampLivePreview(String(payload.streamThinking ?? ''), 800, 10));
      } else if (
        ['completed', 'error', 'cancelled', 'approval_required', 'tool_completed', 'tool_failed', 'tool_blocked'].includes(
          payload.phase
        )
      ) {
        if (payload.phase !== 'approval_required') {
          setLiveStreamText('');
          setLiveStreamThinking('');
        }
        setLivePhase(payload.phase);
      } else if (payload.phase) {
        setLivePhase(payload.phase);
      }

      if (payload.errorMessage) {
        setLastRecoverableError(String(payload.errorMessage));
      }

      startTransition(() => {
        if (
          payload.session.id === activeThreadId ||
          payload.session.id === session?.id
        ) {
          applySessionState(payload.session);
          return;
        }

        setThreads((previous) => upsertThread(previous, payload.session));
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [activeThreadId, session?.id]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [deferredMessages, session?.pendingApproval]);

  useEffect(() => {
    const pendingEventId = session?.pendingApproval?.eventId ?? null;
    if (pendingEventId && selectedEventId !== pendingEventId) {
      setSelectedEventId(pendingEventId);
    }
  }, [selectedEventId, session?.pendingApproval?.eventId]);

  useEffect(() => {
    if (!hasModels) {
      return;
    }

    if (!availableModels.some((model) => model.name === form.model)) {
      setForm((previous) => ({
        ...previous,
        model:
          availableModels.find((model) => model.name === session?.model)?.name ??
          availableModels[0]?.name ??
          '',
      }));
    }
  }, [availableModels, form.model, hasModels, session?.model]);

  useEffect(() => {
    if (!bootstrap || !form.providerId) {
      return;
    }

    if (loadedModelsProviderId === form.providerId) {
      lastAutoRefreshProviderRef.current = null;
      return;
    }

    if (lastAutoRefreshProviderRef.current === form.providerId) {
      return;
    }

    lastAutoRefreshProviderRef.current = form.providerId;
    void handleRefreshModels(form.providerId);
  }, [bootstrap, form.providerId, loadedModelsProviderId]);

  useEffect(() => {
    if (!toolEvents.length) {
      if (selectedEventId !== null) {
        setSelectedEventId(null);
      }
      return;
    }

    if (!selectedEventId || !toolEvents.some((event) => event.id === selectedEventId)) {
      setSelectedEventId(toolEvents.at(-1)?.id ?? null);
    }
  }, [selectedEventId, toolEvents]);

  useEffect(() => {
    let disposed = false;
    const controls = api.windowControls;

    if (!controls) {
      return undefined;
    }

    void controls.getState?.().then((state) => {
      if (!disposed && state) {
        setWindowState(state);
      }
    });

    const unsubscribe = controls.onStateChange?.((state) => {
      if (!disposed && state) {
        setWindowState(state);
      }
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!activeTopMenu) {
      return undefined;
    }

    function handlePointerDown(event) {
      if (!topbarMenuRef.current?.contains(event.target)) {
        setActiveTopMenu(null);
      }
    }

    function handleEscape(event) {
      if (event.key === 'Escape') {
        setActiveTopMenu(null);
      }
    }

    globalThis.addEventListener('pointerdown', handlePointerDown);
    globalThis.addEventListener('keydown', handleEscape);
    return () => {
      globalThis.removeEventListener('pointerdown', handlePointerDown);
      globalThis.removeEventListener('keydown', handleEscape);
    };
  }, [activeTopMenu]);

  useEffect(() => {
    if (!showSettings) {
      return undefined;
    }

    function handleEscape(event) {
      if (event.key === 'Escape') {
        setShowSettings(false);
      }
    }

    globalThis.addEventListener('keydown', handleEscape);
    return () => {
      globalThis.removeEventListener('keydown', handleEscape);
    };
  }, [showSettings]);

  useEffect(() => {
    if (!showConversationSearch) {
      return undefined;
    }

    const frameId = globalThis.requestAnimationFrame?.(() => {
      conversationSearchInputRef.current?.focus();
      conversationSearchInputRef.current?.select?.();
    });

    return () => {
      if (typeof frameId === 'number') {
        globalThis.cancelAnimationFrame?.(frameId);
      }
    };
  }, [showConversationSearch]);

  useEffect(() => {
    if (!showConversationSearch) {
      return undefined;
    }

    function handleSearchShortcuts(event) {
      const isModifierPressed = event.ctrlKey || event.metaKey;

      if (event.key === 'Escape') {
        event.preventDefault();
        setShowConversationSearch(false);
        return;
      }

      if (!isModifierPressed) {
        return;
      }

      if (/^[1-9]$/.test(event.key)) {
        const nextRow = conversationSearchRows[Number(event.key) - 1];
        if (!nextRow) {
          return;
        }

        event.preventDefault();
        void handleLoadThread(nextRow.sessionId);
        setShowConversationSearch(false);
      }
    }

    globalThis.addEventListener('keydown', handleSearchShortcuts);
    return () => {
      globalThis.removeEventListener('keydown', handleSearchShortcuts);
    };
  }, [conversationSearchRows, showConversationSearch]);

  useEffect(() => {
    function handlePaletteShortcut(event) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') {
        return;
      }

      event.preventDefault();
      setActiveWorkspaceView('chat');
      setActiveTopMenu(null);
      setShowSettings(false);
      setShowConversationSearch(true);
    }

    globalThis.addEventListener('keydown', handlePaletteShortcut);
    return () => {
      globalThis.removeEventListener('keydown', handlePaletteShortcut);
    };
  }, []);

  useEffect(() => {
    if (!showConversationSearch) {
      return;
    }

    setConversationSearchIndex((currentIndex) =>
      Math.min(currentIndex, Math.max(0, conversationSearchRows.length - 1))
    );
  }, [conversationSearchRows.length, showConversationSearch]);

  useEffect(() => {
    if (!bootstrap || typeof api.saveAppState !== 'function') {
      return undefined;
    }

    const timeoutId = globalThis.setTimeout(() => {
      void api.saveAppState({
        preferences: {
          language,
          workspaceRoot: form.workspaceRoot,
          providerId: form.providerId,
          providerConfigs,
          model: form.model,
          permissionPreset: form.permissionPreset,
          modelSettings: normalizeModelSettings(form.modelSettings),
          showRuntimeSettings,
        },
        lastSessionId: activeThreadId,
      });
    }, 180);

    return () => {
      globalThis.clearTimeout(timeoutId);
    };
  }, [activeThreadId, bootstrap, form, language, providerConfigs, showRuntimeSettings]);

  useEffect(() => {
    if (
      !session ||
      session.pendingApproval ||
      busy ||
      autoSyncingSettings ||
      !form.workspaceRoot ||
      !form.providerId ||
      !form.model
    ) {
      return undefined;
    }

    if (!isSessionConfigDirty(session, form)) {
      if (autoSyncingSettings) {
        setAutoSyncingSettings(false);
      }
      return undefined;
    }

    const timeoutId = globalThis.setTimeout(() => {
      void syncActiveSessionConfig();
    }, 220);

    return () => {
      globalThis.clearTimeout(timeoutId);
    };
  }, [
    autoSyncingSettings,
    busy,
    form,
    session,
  ]);

  function updateForm(field, value) {
    setForm((previous) => ({
      ...previous,
      [field]: value,
    }));
  }

  function updateModelSetting(field, value) {
    setForm((previous) => ({
      ...previous,
      modelSettings: {
        ...previous.modelSettings,
        [field]: value,
      },
    }));
  }

  function updateProviderId(providerId) {
    setError('');
    setBootstrap((previous) =>
      previous
        ? {
            ...previous,
            providerError: null,
          }
        : previous
    );
    setForm((previous) => ({
      ...previous,
      providerId,
      model: '',
    }));
  }

  function updateProviderConfig(providerId, field, value) {
    setProviderConfigs((previous) => updateProviderConfigMap(previous, providerId, {
      [field]: value,
    }));
  }

  function dismissNotification(notificationId) {
    const timer = notificationTimeoutsRef.current.get(notificationId);
    if (timer) {
      globalThis.clearTimeout(timer);
      notificationTimeoutsRef.current.delete(notificationId);
    }

    setNotifications((previous) => previous.filter((item) => item.id !== notificationId));
  }

  function pushNotification(message, tone = 'error') {
    const normalizedMessage = String(message ?? '').trim();
    if (!normalizedMessage) {
      return;
    }

    const existing = notifications.find(
      (item) => item.message === normalizedMessage && item.tone === tone
    );
    const notificationId = existing?.id ?? `${Date.now()}-${Math.random()}`;

    if (!existing) {
      setNotifications((previous) => [
        ...previous.slice(-2),
        { id: notificationId, message: normalizedMessage, tone },
      ]);
    }

    const previousTimer = notificationTimeoutsRef.current.get(notificationId);
    if (previousTimer) {
      globalThis.clearTimeout(previousTimer);
    }

    const timer = globalThis.setTimeout(() => {
      notificationTimeoutsRef.current.delete(notificationId);
      setNotifications((previous) => previous.filter((item) => item.id !== notificationId));
    }, 7000);

    notificationTimeoutsRef.current.set(notificationId, timer);
  }

  function syncFormWithSession(nextSession) {
    setForm({
      workspaceRoot: nextSession.workspaceRoot,
      providerId: nextSession.providerId ?? form.providerId ?? 'ollama',
      model: nextSession.model,
      permissionPreset: nextSession.permissionPreset,
      modelSettings: normalizeModelSettings(nextSession.modelSettings),
    });
  }

  function applySessionState(nextSession) {
    setSession(nextSession);
    setActiveThreadId(nextSession.id);
    setActiveWorkspaceView('chat');
    setSelectedEventId(nextSession.toolEvents.at(-1)?.id ?? null);
    syncFormWithSession(nextSession);
    setThreads((previous) => upsertThread(previous, nextSession));
  }

  async function refreshSessionState(sessionId) {
    if (!sessionId || typeof api.getSession !== 'function') {
      return null;
    }

    const response = await api.getSession(sessionId);
    startTransition(() => {
      applySessionState(response.session);
    });
    return response.session;
  }

  async function syncActiveSessionConfig() {
    if (
      !session ||
      !form.workspaceRoot ||
      !form.providerId ||
      !form.model ||
      typeof api.updateSessionConfig !== 'function'
    ) {
      return session;
    }

    if (sessionSyncPromiseRef.current) {
      return sessionSyncPromiseRef.current;
    }

    if (!isSessionConfigDirty(session, form)) {
      if (autoSyncingSettings) {
        setAutoSyncingSettings(false);
      }
      return session;
    }

    setAutoSyncingSettings(true);

    const syncPromise = (async () => {
      try {
        const response = await api.updateSessionConfig(
          session.id,
          buildSessionConfigPayload(form, providerConfigs)
        );
        startTransition(() => {
          applySessionState(response.session);
        });
        return response.session;
      } catch (syncError) {
        setError(syncError instanceof Error ? syncError.message : String(syncError));
        return session;
      } finally {
        sessionSyncPromiseRef.current = null;
        setAutoSyncingSettings(false);
      }
    })();

    sessionSyncPromiseRef.current = syncPromise;
    return syncPromise;
  }

  function openSettings(section = 'general') {
    setActiveTopMenu(null);
    setShowConversationSearch(false);
    setShowSettings(true);
    setSettingsSection(section);

    if (!hasModels || bootstrap?.providerError || loadedModelsProviderId !== form.providerId) {
      void handleRefreshModels(form.providerId);
    }
  }

  function closeSettings() {
    setShowSettings(false);
  }

  function openConversationSearch() {
    setActiveTopMenu(null);
    setActiveWorkspaceView('chat');
    setShowSettings(false);
    setConversationSearchQuery('');
    setConversationSearchIndex(0);
    setShowConversationSearch(true);
  }

  function closeConversationSearch() {
    setShowConversationSearch(false);
    setConversationSearchQuery('');
    setConversationSearchIndex(0);
  }

  function updateMcpDraft(field, value) {
    setMcpDraft((previous) => ({
      ...previous,
      [field]: value,
    }));
  }

  async function persistMcpServers(nextServers) {
    if (typeof api.saveAppState !== 'function') {
      return false;
    }

    setSavingMcp(true);
    setError('');

    try {
      const response = await api.saveAppState({
        preferences: {
          mcpServers: nextServers,
        },
      });

      startTransition(() => {
        setBootstrap((previous) =>
          previous
            ? {
                ...previous,
                mcpServers: response?.mcpServers ?? nextServers,
              }
            : previous
        );

        if (response?.activeSession) {
          applySessionState(response.activeSession);
        }
      });
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      return false;
    } finally {
      setSavingMcp(false);
    }
  }

  async function handleAddMcpServer() {
    const command = mcpDraft.command.trim();
    if (!command) {
      setError(t('mcp.commandRequired'));
      return;
    }

    const nextServer = {
      id: globalThis.crypto?.randomUUID?.() ?? `mcp-${Date.now()}`,
      name: mcpDraft.name.trim() || command,
      command,
      args: parseMcpArgsInput(mcpDraft.args),
      cwd: mcpDraft.cwd.trim(),
      env: parseMcpEnvInput(mcpDraft.env),
      enabled: true,
    };

    const saved = await persistMcpServers([...configuredMcpServers, nextServer]);
    if (saved) {
      setMcpDraft(EMPTY_MCP_DRAFT);
    }
  }

  async function handleRemoveMcpServer(serverId) {
    await persistMcpServers(configuredMcpServers.filter((server) => server.id !== serverId));
  }

  async function handleToggleMcpServer(serverId, enabled) {
    await persistMcpServers(
      configuredMcpServers.map((server) =>
        server.id === serverId
          ? {
              ...server,
              enabled,
            }
          : server
      )
    );
  }

  async function loadBootstrap() {
    setBusy(true);
    setError('');

    try {
      const data = await api.bootstrap();
      const bootstrapProviderError = data.providerError
        ? resolveUiErrorText(
            t,
            data.providerErrorCode,
            data.providerErrorVariables,
            data.providerError
          )
        : null;
      const initialForm = data.activeSession
        ? {
            workspaceRoot: data.activeSession.workspaceRoot,
            providerId:
              data.activeSession.providerId ??
              data.defaultProviderId ??
              data.providers?.[0]?.id ??
              'ollama',
            model:
              data.activeSession.model ||
              data.defaultModel ||
              data.models[0]?.name ||
              '',
            permissionPreset:
              data.activeSession.permissionPreset ?? data.defaultPermissionPreset,
            modelSettings: normalizeModelSettings(
              data.activeSession.modelSettings ?? data.defaultModelSettings
            ),
          }
        : {
            workspaceRoot: data.defaultWorkspace,
            providerId: data.defaultProviderId ?? data.providers?.[0]?.id ?? 'ollama',
            model: data.defaultModel || data.models[0]?.name || '',
            permissionPreset: data.defaultPermissionPreset,
            modelSettings: normalizeModelSettings(data.defaultModelSettings),
          };

      const systemLanguage = resolveLanguageFromLocale(globalThis.navigator?.language ?? '');
      const nextLanguage = data.languageWasExplicit
        ? resolveLanguage(data.defaultLanguage ?? DEFAULT_LANGUAGE)
        : systemLanguage;

      startTransition(() => {
        setBootstrap({
          ...data,
          providerError: bootstrapProviderError,
        });
        setThreads(
          Array.isArray(data.sessionSummaries)
            ? data.sessionSummaries.map(normalizeThreadSummary)
            : []
        );
        setProviderConfigs(normalizeProviderConfigs(data.providerConfigs));
        setLanguage(nextLanguage);
        setShowRuntimeSettings(Boolean(data.defaultShowRuntimeSettings));
        setForm(initialForm);
        setSession(data.activeSession ?? null);
        setActiveThreadId(data.activeSession?.id ?? null);
        setSelectedEventId(data.activeSession?.toolEvents?.at(-1)?.id ?? null);
      });

      if (bootstrapProviderError) {
        pushNotification(bootstrapProviderError);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(false);
    }
  }

  async function handleChooseWorkspace() {
    setActiveTopMenu(null);
    const selectedPath = await api.chooseWorkspace(form.workspaceRoot);
    if (selectedPath) {
      updateForm('workspaceRoot', selectedPath);
    }
  }

  async function handleCreateSession() {
    setBusy(true);
    setError('');
    setActiveTopMenu(null);

    try {
      const response = await api.createSession({
        ...buildSessionConfigPayload(form, providerConfigs),
      });
      startTransition(() => {
        applySessionState(response.session);
      });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy(false);
    }
  }

  async function handleLoadThread(sessionId) {
    if (!sessionId) {
      resetConversation();
      return;
    }

    setBusy(true);
    setError('');
    setActiveTopMenu(null);
    closeConversationSearch();

    try {
      const response = await api.getSession(sessionId);
      startTransition(() => {
        applySessionState(response.session);
        setInput('');
        setAttachments([]);
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(false);
    }
  }

  function resetConversation() {
    closeConversationSearch();
    startTransition(() => {
      setSession(null);
      setActiveThreadId(null);
      setActiveWorkspaceView('chat');
      setSelectedEventId(null);
      setInput('');
      setAttachments([]);
    });
  }

  async function ensureSession() {
    if (session) {
      return syncActiveSessionConfig();
    }

    const response = await api.createSession({
      ...buildSessionConfigPayload(form, providerConfigs),
    });
    startTransition(() => {
      applySessionState(response.session);
    });
    return response.session;
  }

  async function handleDeleteThread(event, sessionId) {
    event.stopPropagation();

    if (!sessionId || typeof api.deleteSession !== 'function') {
      return;
    }

    setDeletingThreadId(sessionId);
    setError('');

    try {
      const wasActive = activeThreadId === sessionId;
      const response = await api.deleteSession(sessionId);

      startTransition(() => {
        setThreads(
          Array.isArray(response.sessionSummaries)
            ? response.sessionSummaries.map(normalizeThreadSummary)
            : []
        );

        if (!wasActive) {
          return;
        }

        if (response.activeSession) {
          applySessionState(response.activeSession);
          setInput('');
          setAttachments([]);
          return;
        }

        setSession(null);
        setActiveThreadId(null);
        setSelectedEventId(null);
        setInput('');
        setAttachments([]);
      });
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setDeletingThreadId(null);
    }
  }

  async function handleSend(event) {
    event.preventDefault();
    if (!input.trim() && attachments.length === 0) {
      return;
    }

    setBusy(true);
    setActiveRequest('send');
    setError('');

    let ensuredSessionId = session?.id ?? null;

    try {
      const activeSession = await ensureSession();
      ensuredSessionId = activeSession.id;
      setActiveRunSessionId(activeSession.id);
      let importedAttachments = [];

      if (attachments.length > 0 && typeof api.importAttachments === 'function') {
        const uploadPayload = await Promise.all(
          attachments.map((attachment) => buildAttachmentUploadPayload(attachment))
        );
        const importResponse = await api.importAttachments(activeSession.id, uploadPayload);
        importedAttachments = Array.isArray(importResponse?.attachments)
          ? importResponse.attachments
          : [];

        if (importResponse?.session) {
          startTransition(() => {
            applySessionState(importResponse.session);
          });
        }
      }

      const composedMessage = await buildComposedMessage(importedAttachments);
      const response = await api.sendUserMessage(activeSession.id, composedMessage);

      startTransition(() => {
        applySessionState(response.session);
        setInput('');
        setAttachments([]);
      });

      if (response?.status === 'error' && response?.errorMessage) {
        setError(response.errorMessage);
      }
    } catch (sendError) {
      const errorMessage = sendError instanceof Error ? sendError.message : String(sendError);

      if (errorMessage.includes('Resolve the pending approval')) {
        try {
          await refreshSessionState(ensuredSessionId);
        } catch {
          // Best effort refresh. The original error message is replaced below either way.
        }

        setError(t('composer.pendingPlaceholder'));
      } else {
        setError(errorMessage);
      }
    } finally {
      setActiveRequest(null);
      setActiveRunSessionId(null);
      setBusy(false);
    }
  }

  async function handleStopRequest() {
    const sessionId = activeRunSessionId ?? session?.id ?? null;
    if (!sessionId || typeof api.cancelActiveRun !== 'function' || isStopPending) {
      return;
    }

    setActiveRequest('stopping');
    setError('');

    try {
      const response = await api.cancelActiveRun(sessionId);
      if (response?.session) {
        startTransition(() => {
          applySessionState(response.session);
        });
      }

      if (response?.status === 'idle' || response?.status === 'cancelled') {
        setActiveRequest(null);
        setActiveRunSessionId(null);
        setBusy(false);
      }
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
      setActiveRequest('send');
    }
  }

  async function handleApproval(approved) {
    if (!session?.pendingApproval) {
      return;
    }

    setBusy(true);
    setActiveRequest('send');
    setActiveRunSessionId(session.id);
    setError('');

    try {
      const response = await api.resolveApproval(session.id, approved);
      startTransition(() => {
        applySessionState(response.session);
      });

      if (response?.status === 'error' && response?.errorMessage) {
        setError(response.errorMessage);
      }
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : String(approvalError));
    } finally {
      setActiveRequest(null);
      setActiveRunSessionId(null);
      setBusy(false);
    }
  }

  async function handleRefreshModels(targetProviderId = form.providerId) {
    setBusy(true);
    setLoadingModels(true);
    setActiveTopMenu(null);

    try {
      const response = await api.refreshModels({
        providerId: targetProviderId,
        providerConfig: getProviderConfig(providerConfigs, targetProviderId),
      });
      const models = response?.models ?? [];
      const errorMessage = response?.errorMessage
        ? resolveUiErrorText(
            t,
            response.errorCode,
            response.errorVariables,
            String(response.errorMessage)
          )
        : '';

      startTransition(() => {
        setBootstrap((previous) =>
          previous
            ? {
                ...previous,
                loadedModelsProviderId: targetProviderId,
                models,
                providerError: response?.ok === false ? errorMessage : null,
              }
            : {
                appName: 'ForgePilot',
                defaultWorkspace: form.workspaceRoot,
                defaultProviderId: targetProviderId,
                defaultLanguage: language,
                defaultPermissionPreset: form.permissionPreset,
                defaultModelSettings: normalizeModelSettings(form.modelSettings),
                permissionPresets: [],
                loadedModelsProviderId: targetProviderId,
                models,
                providerError: response?.ok === false ? errorMessage : null,
              }
        );
        setForm((previous) => ({
          ...previous,
          model:
            previous.providerId !== targetProviderId
              ? models[0]?.name ?? ''
              : models.some((model) => model.name === previous.model)
                ? previous.model
                : session?.providerId === targetProviderId &&
                    models.some((model) => model.name === session?.model)
                  ? session.model
                  : (models[0]?.name ?? previous.model),
        }));
      });

      if (response?.ok === false && errorMessage) {
        pushNotification(errorMessage);
      }
    } catch (refreshError) {
      pushNotification(
        refreshError instanceof Error ? refreshError.message : String(refreshError)
      );
    } finally {
      setBusy(false);
      setLoadingModels(false);
    }
  }

  async function handleExportProgressReport() {
    const targetSessionId = session?.id ?? activeThreadId ?? null;
    if (!targetSessionId || typeof api.exportProgressReport !== 'function') {
      pushNotification(t('errors.progress.noSession'));
      setActiveTopMenu(null);
      return;
    }

    setExportingProgressReport(true);
    setActiveTopMenu(null);
    setError('');

    try {
      const response = await api.exportProgressReport({ sessionId: targetSessionId });

      if (response?.status === 'saved' && response.filePath) {
        pushNotification(
          t('status.progressReportSaved', {
            path: response.filePath,
          }),
          'success'
        );
        return;
      }

      if (response?.status === 'preview' && response?.content) {
        downloadTextFile(response.fileName, response.content);
        pushNotification(
          t('status.progressReportDownloaded', {
            fileName: response.fileName || 'forgepilot-progress-report.md',
          }),
          'success'
        );
      }
    } catch (exportError) {
      const message = exportError instanceof Error ? exportError.message : String(exportError);
      setError(message);
      pushNotification(message);
    } finally {
      setExportingProgressReport(false);
    }
  }

  async function handleWindowAction(action) {
    setActiveTopMenu(null);

    try {
      const controls = api.windowControls;

      if (!controls) {
        return;
      }

      if (action === 'minimize') {
        await controls.minimize?.();
        return;
      }

      if (action === 'toggleMaximize') {
        const nextState = await controls.toggleMaximize?.();
        if (nextState) {
          setWindowState(nextState);
        }
        return;
      }

      if (action === 'close') {
        await controls.close?.();
      }
    } catch (windowError) {
      setError(windowError instanceof Error ? windowError.message : String(windowError));
    }
  }

  async function handleTopMenuAction(actionId) {
    switch (actionId) {
      case 'new-thread':
        resetConversation();
        setActiveTopMenu(null);
        return;
      case 'refresh-models':
        await handleRefreshModels();
        return;
      case 'quick-chat':
        fillPrompt(t('prompt.quickChat'));
        return;
      case 'choose-workspace':
        setActiveTopMenu(null);
        await handleChooseWorkspace();
        return;
      case 'open-settings':
        openSettings('general');
        return;
      case 'open-about':
        openSettings('about');
        return;
      case 'create-session':
        await handleCreateSession();
        return;
      case 'clear-composer':
        setInput('');
        setActiveTopMenu(null);
        return;
      case 'fill-summary-prompt':
        fillPrompt(quickPrompts[0]);
        return;
      case 'fill-readme-prompt':
        fillPrompt(quickPrompts[1]);
        return;
      case 'toggle-runtime-settings':
        setShowRuntimeSettings((value) => !value);
        openSettings('general');
        return;
      case 'open-appearance-settings':
        openSettings('appearance');
        return;
      case 'focus-last-event':
        setSelectedEventId(toolEvents.at(-1)?.id ?? null);
        setActiveTopMenu(null);
        return;
      case 'window-minimize':
        await handleWindowAction('minimize');
        return;
      case 'window-toggle-maximize':
        await handleWindowAction('toggleMaximize');
        return;
      case 'window-close':
        await handleWindowAction('close');
        return;
      case 'fill-tool-prompt':
        fillPrompt(t('prompt.toolSummary'));
        return;
      case 'fill-command-prompt':
        fillPrompt(t('prompt.commandTask'));
        return;
      case 'fill-risk-prompt':
        fillPrompt(quickPrompts[2]);
        return;
      case 'export-progress-report':
        await handleExportProgressReport();
        return;
      case 'window-close':
        await handleWindowAction('close');
        return;
      default:
        setActiveTopMenu(null);
    }
  }

  function toggleTopMenu(menuId) {
    setActiveTopMenu((currentMenu) => (currentMenu === menuId ? null : menuId));
  }

  function selectEvent(eventId) {
    setSelectedEventId(eventId);
  }

  function navigateEvents(direction) {
    if (!toolEvents.length || selectedEventIndex === -1) {
      return;
    }

    const nextIndex = Math.min(
      toolEvents.length - 1,
      Math.max(0, selectedEventIndex + direction)
    );
    setSelectedEventId(toolEvents[nextIndex]?.id ?? null);
  }

  function handleProjectClick(row) {
    setActiveWorkspaceView('chat');
    fillPrompt(row.prompt);
  }

  async function handleConversationClick(row) {
    if (row.kind === 'draft') {
      resetConversation();
      return;
    }

    await handleLoadThread(row.sessionId);
  }

  async function handleConversationSearchSelect(row) {
    if (!row?.sessionId) {
      return;
    }

    await handleLoadThread(row.sessionId);
  }

  function handleConversationSearchKeyDown(event) {
    if (!showConversationSearch) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setConversationSearchIndex((currentIndex) =>
        Math.min(currentIndex + 1, Math.max(0, conversationSearchRows.length - 1))
      );
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setConversationSearchIndex((currentIndex) => Math.max(currentIndex - 1, 0));
      return;
    }

    if (event.key === 'Enter') {
      const selectedRow = conversationSearchRows[conversationSearchIndex] ?? conversationSearchRows[0];
      if (!selectedRow) {
        return;
      }

      event.preventDefault();
      void handleConversationSearchSelect(selectedRow);
    }
  }

  function fillPrompt(prompt) {
    closeConversationSearch();
    setActiveWorkspaceView('chat');
    setInput(prompt);
    setActiveTopMenu(null);
    globalThis.requestAnimationFrame?.(() => composerRef.current?.focus());
  }

  function openAutomationsView() {
    closeConversationSearch();
    setActiveTopMenu(null);
    setActiveWorkspaceView('automations');
  }

  function handleAutomationCardSelect(card) {
    fillPrompt(card.prompt);
  }

  function openAttachmentPicker() {
    attachmentInputRef.current?.click();
  }

  function handleAttachmentSelection(event) {
    const selectedFiles = Array.from(event.target.files ?? []);

    if (selectedFiles.length === 0) {
      return;
    }

    setAttachments((previous) => {
      const existingIds = new Set(previous.map((item) => item.id));
      const nextItems = selectedFiles
        .map((file) => ({
          id: `${file.name}-${file.size}-${file.lastModified}`,
          name: file.name,
          size: file.size,
          type: file.type,
          kind: String(file.type ?? '').startsWith('image/') ? 'image' : 'file',
          file,
        }))
        .filter((item) => !existingIds.has(item.id));

      return [...previous, ...nextItems].slice(0, 6);
    });

    event.target.value = '';
  }

  function removeAttachment(attachmentId) {
    setAttachments((previous) => previous.filter((item) => item.id !== attachmentId));
  }

  async function buildComposedMessage(importedAttachments = []) {
    const trimmedInput = input.trim();
    const importedByClientId = new Map(
      importedAttachments.map((attachment) => [attachment.clientId, attachment])
    );

    if (attachments.length === 0) {
      return trimmedInput;
    }

    const attachmentBlocks = await Promise.all(
      attachments.map(async (attachment) => {
        const importedAttachment = importedByClientId.get(attachment.id);
        const referenceLines = importedAttachment
          ? [
              `Attached ${attachment.kind}: ${attachment.name}`,
              `Workspace path: ${importedAttachment.path}`,
              'Use this workspace path later. Do not use the original absolute source location.',
            ]
          : [
              `Attached ${attachment.kind}: ${attachment.name} (${formatBytes(attachment.size)})`,
            ];

        try {
          if (isTextLikeAttachment(attachment.file) && attachment.file.size <= 24 * 1024) {
            const text = await attachment.file.text();
            return [
              ...referenceLines,
              text.length > 3500 ? `${text.slice(0, 3500)}\n...` : text,
            ].join('\n');
          }
        } catch {
          return referenceLines.join('\n');
        }

        return referenceLines.join('\n');
      })
    );

    const baseMessage = trimmedInput || 'Ekli dosya veya gorselleri dikkate alarak yardim et.';

    return [
      baseMessage,
      'Attached items:',
      attachmentBlocks.map((block, index) => `${index + 1}. ${block}`).join('\n\n'),
    ].join('\n\n');
  }

  function insertAttachmentReference(attachment) {
    if (!attachment?.path) {
      return;
    }

    const reference = t('attachments.referencePrompt', {
      name: attachment.originalName || attachment.name,
      path: attachment.path,
    });
    setInput((previous) => (previous.trim() ? `${previous.trim()}\n\n${reference}` : reference));
    globalThis.requestAnimationFrame?.(() => composerRef.current?.focus());
  }

  return html`
    <div className="app-frame">
      <${SettingsModal}
        open=${showSettings}
        section=${settingsSection}
        onSectionChange=${setSettingsSection}
        onClose=${closeSettings}
        language=${language}
        onLanguageChange=${setLanguage}
        t=${t}
        form=${form}
        providers=${providerOptions}
        providerConfigs=${providerConfigs}
        bootstrap=${bootstrap}
        permissionDescription=${permissionDescription}
        theme=${theme}
        themeOptions=${themeOptions}
        onThemeChange=${setTheme}
        onChooseWorkspace=${handleChooseWorkspace}
        onUpdateForm=${updateForm}
        onUpdateProviderId=${updateProviderId}
        onUpdateProviderConfig=${updateProviderConfig}
        onUpdateModelSetting=${updateModelSetting}
        onRefreshModels=${handleRefreshModels}
        showRuntimeSettings=${showRuntimeSettings}
        onToggleRuntimeSettings=${() => setShowRuntimeSettings((value) => !value)}
        previewMode=${previewMode}
        busy=${busy}
        loadingModels=${loadingModels}
        modelStatusMessage=${modelStatusMessage}
        session=${session}
        autoSyncingSettings=${autoSyncingSettings}
        onExportProgressReport=${handleExportProgressReport}
        exportingProgressReport=${exportingProgressReport}
        mcpServers=${configuredMcpServers}
        mcpDraft=${mcpDraft}
        onUpdateMcpDraft=${updateMcpDraft}
        onAddMcpServer=${() => void handleAddMcpServer()}
        onRemoveMcpServer=${(serverId) => void handleRemoveMcpServer(serverId)}
        onToggleMcpServer=${(serverId, enabled) => void handleToggleMcpServer(serverId, enabled)}
        savingMcp=${savingMcp}
      />

      ${notifications.length > 0
        ? html`
            <div className="notification-stack">
              ${notifications.map(
                (notification) => html`
                  <div key=${notification.id} className=${`notification-toast ${notification.tone}`}>
                    <div className="notification-copy">
                      <strong>${t('status.notificationTitle')}</strong>
                      <span>${notification.message}</span>
                    </div>
                    <button
                      type="button"
                      className="notification-dismiss"
                      aria-label=${t('notification.dismiss')}
                      onClick=${() => dismissNotification(notification.id)}
                    >
                      ×
                    </button>
                  </div>
                `
              )}
            </div>
          `
        : null}

      ${showConversationSearch
        ? html`
            <div className="conversation-search-overlay" onClick=${closeConversationSearch}>
              <div className="conversation-search-modal" onClick=${(event) => event.stopPropagation()}>
                <div className="conversation-search-input-shell">
                  <input
                    ref=${conversationSearchInputRef}
                    type="text"
                    className="conversation-search-input"
                    placeholder=${t('search.placeholder')}
                    value=${conversationSearchQuery}
                    onInput=${(event) => {
                      setConversationSearchQuery(event.currentTarget.value);
                      setConversationSearchIndex(0);
                    }}
                    onKeyDown=${handleConversationSearchKeyDown}
                  />
                </div>

                <div className="conversation-search-section">
                  <div className="conversation-search-section-label">
                    ${conversationSearchQuery.trim() ? t('search.matches') : t('search.recent')}
                  </div>

                  <div className="conversation-search-list">
                    ${conversationSearchRows.length > 0
                      ? conversationSearchRows.map(
                          (row, index) => html`
                            <button
                              key=${row.sessionId}
                              type="button"
                              className=${`conversation-search-row ${
                                index === conversationSearchIndex ? 'active' : ''
                              }`}
                              onMouseEnter=${() => setConversationSearchIndex(index)}
                              onClick=${() => void handleConversationSearchSelect(row)}
                            >
                              <div className="conversation-search-row-main">
                                <strong>${row.title}</strong>
                                <span>${row.workspaceLabel}</span>
                              </div>
                              <div className="conversation-search-row-meta">
                                <span>${row.preview || row.age}</span>
                                ${row.shortcut
                                  ? html`
                                      <kbd className="conversation-search-shortcut"
                                        >${row.shortcut}</kbd
                                      >
                                    `
                                  : null}
                              </div>
                            </button>
                          `
                        )
                      : html`
                          <div className="conversation-search-empty">
                            ${t('search.empty')}
                          </div>
                        `}
                  </div>
                </div>
              </div>
            </div>
          `
        : null}

      <header className="codex-topbar" ref=${topbarMenuRef}>
        <div className="topbar-left">
          <div className="topbar-menu-slot">
            <button
              type="button"
              className=${`topbar-icon-button ${activeTopMenu === 'app' ? 'active' : ''}`}
              aria-label=${t('window.appMenu')}
              aria-expanded=${activeTopMenu === 'app'}
              onClick=${() => toggleTopMenu('app')}
            >
              <span className="topbar-app-dot"></span>
            </button>
            ${activeTopMenu === 'app'
              ? html`
                  <div className="topbar-dropdown">
                    ${TOP_MENU_ACTIONS.app.map(
                      (action) =>
                        action.type === 'separator'
                          ? html`<div key=${action.id} className="topbar-dropdown-separator"></div>`
                          : html`
                              <button
                                key=${action.id}
                                type="button"
                                className="topbar-dropdown-item"
                                onClick=${() => void handleTopMenuAction(action.id)}
                              >
                                ${t(`menu.action.${action.id}`)}
                              </button>
                            `
                    )}
                  </div>
                `
              : null}
          </div>
          <button
            type="button"
            className="topbar-icon-button"
            aria-label=${t('window.back')}
            disabled=${!canGoBack}
            onClick=${() => navigateEvents(-1)}
          >
            ←
          </button>
          <button
            type="button"
            className="topbar-icon-button"
            aria-label=${t('window.forward')}
            disabled=${!canGoForward}
            onClick=${() => navigateEvents(1)}
          >
            →
          </button>
          <nav className="topbar-menu">
            ${TOP_MENU_ITEMS.map(
              (item) => html`
                <div key=${item.id} className="topbar-menu-slot">
                  <button
                    type="button"
                    className=${`topbar-menu-button ${activeTopMenu === item.id ? 'active' : ''}`}
                    aria-expanded=${activeTopMenu === item.id}
                    onClick=${() => toggleTopMenu(item.id)}
                  >
                    ${t(`menu.top.${item.id}`)}
                  </button>
                  ${activeTopMenu === item.id
                    ? html`
                        <div className="topbar-dropdown">
                          ${TOP_MENU_ACTIONS[item.id].map(
                            (action) => html`
                              <button
                                key=${action.id}
                                type="button"
                                className="topbar-dropdown-item"
                                onClick=${() => void handleTopMenuAction(action.id)}
                              >
                                ${t(`menu.action.${action.id}`)}
                              </button>
                            `
                          )}
                        </div>
                      `
                    : null}
                </div>
              `
            )}
          </nav>
        </div>

        <div className="topbar-center">
          <span className="topbar-center-label">${previewMode ? t('settings.previewMode') : t('settings.about.workspace')}</span>
          <strong>${baseName(session?.workspaceRoot ?? form.workspaceRoot)}</strong>
        </div>

        <div className="topbar-window-controls">
          <button
            type="button"
            className="window-control-button"
            aria-label=${t('window.minimize')}
            onClick=${() => void handleWindowAction('minimize')}
          >
            ─
          </button>
          <button
            type="button"
            className="window-control-button"
            aria-label=${windowState.isMaximized ? t('window.restore') : t('window.maximize')}
            onClick=${() => void handleWindowAction('toggleMaximize')}
          >
            ${windowState.isMaximized ? '❐' : '□'}
          </button>
          <button
            type="button"
            className="window-control-button close"
            aria-label=${t('window.close')}
            onClick=${() => void handleWindowAction('close')}
          >
            ×
          </button>
        </div>
      </header>

      <div className=${`codex-shell ${isAutomationsView ? 'automations-open' : ''}`}>
      <aside className="left-rail">
        <div className="left-topbar">
          <div className="product-mark">CG</div>
          <div className="product-copy">
            <strong>ForgePilot</strong>
            <span>${previewMode ? t('settings.previewMode') : t('settings.localRuntime')}</span>
          </div>
        </div>

        <div className="rail-section">
          ${NAV_ITEMS.map(
            (item) => html`
              <button
                key=${item.id}
                type="button"
                className=${`nav-row ${
                  (item.id === 'search' && showConversationSearch) ||
                  (item.id === 'automations' && isAutomationsView) ||
                  (item.id === 'new' && !isAutomationsView && !showConversationSearch && !session)
                    ? 'active'
                    : ''
                }`}
                onClick=${() => {
                  if (item.id === 'new') {
                    resetConversation();
                    return;
                  }

                  if (item.id === 'search') {
                    openConversationSearch();
                    return;
                  }

                  if (item.id === 'automations') {
                    openAutomationsView();
                    return;
                  }
                }}
              >
                <span className="nav-badge">${item.badge}</span>
                <span className="nav-label">${t(`nav.${item.id}`)}</span>
              </button>
            `
          )}
        </div>

        <div className="rail-section">
          <div className="rail-heading">${t('left.projects')}</div>
          <div className="rail-list">
            ${projectRows.map(
              (item) => html`
                <button
                  key=${item.id}
                  type="button"
                  className=${`rail-item ${item.active ? 'active' : ''}`}
                  onClick=${() => handleProjectClick(item)}
                >
                  <div className="rail-item-title">${item.label}</div>
                  <div className="rail-item-meta">${item.note}</div>
                </button>
              `
            )}
          </div>
        </div>

        <div className="rail-section rail-grow">
          <div className="rail-heading">${t('left.chats')}</div>
          <div className="rail-list">
            ${conversationRows.map(
              (item) => html`
                <div key=${item.id} className="rail-item-shell">
                  <button
                    type="button"
                    className=${`rail-item rail-item-button ${item.active ? 'active' : ''}`}
                    onClick=${() => void handleConversationClick(item)}
                  >
                    <div className="rail-item-title">${item.title}</div>
                    <div className="rail-item-meta">${item.age}</div>
                  </button>
                  ${item.kind === 'thread'
                    ? html`
                        <button
                          type="button"
                          className="rail-item-delete"
                          aria-label=${t('left.deleteChatLabel', { title: item.title })}
                          title=${t('left.deleteChat')}
                          disabled=${deletingThreadId === item.sessionId}
                          onClick=${(event) => void handleDeleteThread(event, item.sessionId)}
                        >
                          ×
                        </button>
                      `
                    : null}
                </div>
              `
            )}
          </div>
        </div>

        <div className="left-footer">
          <div className="settings-row passive">
            <span>${t('left.theme')}</span>
            <span>${themeOptions.find((item) => item.id === theme)?.label ?? t('left.theme')}</span>
          </div>
        </div>
      </aside>

      ${isAutomationsView
        ? html`
            <main className="thread-column automation-main">
              <${AutomationExplorer}
                onSelectCard=${handleAutomationCardSelect}
                t=${t}
                automationGroups=${automationGroups}
              />
            </main>
          `
        : html`
      <main className="thread-column">
        <header className="thread-header">
          <div className="thread-header-copy">
            <div className="thread-kicker">${t('thread.kicker')}</div>
            <h1>${threadTitle}</h1>
          </div>
          <div className="thread-header-meta">
            <span className=${`capability-pill ${capability.className}`}>${capability.label}</span>
            <span className="meta-pill">${permissionLabel}</span>
            <span className="meta-pill">ctx ${formatContextLength(form.modelSettings.contextLength)}</span>
          </div>
        </header>

        ${attachmentShelfItems.length > 0
          ? html`
              <section className="thread-attachment-shelf">
                <div className="thread-attachment-shelf-header">
                  <strong>${t('attachments.shelfTitle')}</strong>
                  <span>${t('attachments.shelfCopy')}</span>
                </div>
                <div className="thread-attachment-shelf-list">
                  ${attachmentShelfItems.map(
                    (attachment) => html`
                      <button
                        key=${attachment.id}
                        type="button"
                        className="thread-attachment-pill"
                        onClick=${() => insertAttachmentReference(attachment)}
                      >
                        <strong>${attachment.originalName || attachment.name}</strong>
                        <small>${attachment.path}</small>
                      </button>
                    `
                  )}
                </div>
              </section>
            `
          : null}

        <section className="thread-body" ref=${messagesRef}>
          ${error ? html`<div className="status-banner error">${error}</div>` : null}

          ${deferredMessages.length > 0
            ? deferredMessages.map(
                (message) => html`
                  <article key=${message.id} className=${`chat-message ${message.role}`}>
                    <div className="chat-meta">
                      <span>${message.role === 'user' ? t('chat.you') : t('chat.agent')}</span>
                      <span>${formatTimestamp(message.createdAt, language)}</span>
                    </div>
                    <div className="chat-content">${message.content}</div>
                    ${message.thinking
                      ? html`<div className="chat-thinking">${message.thinking}</div>`
                      : null}
                    ${message.role === 'assistant' && messageSourceCards.has(message.id)
                      ? (() => {
                          const sourceCard = messageSourceCards.get(message.id);
                          return html`
                            <div className="source-card">
                              <div className="source-card-header">
                                <strong>${t('sources.usedSources')}</strong>
                                <span>${t('sources.count', { count: sourceCard.totalSources })}</span>
                              </div>
                              <div className="source-card-list">
                                ${sourceCard.sources.map(
                                  (source) => html`
                                    <button
                                      key=${source.id}
                                      type="button"
                                      className="source-card-row"
                                      onClick=${() => source.eventId && selectEvent(source.eventId)}
                                    >
                                      <div className="source-card-row-copy">
                                        <strong>${source.title}</strong>
                                        <span>${source.url}</span>
                                        ${source.snippet
                                          ? html`<small>${source.snippet}</small>`
                                          : null}
                                      </div>
                                      <span className="source-card-kind">
                                        ${source.kind === 'browser'
                                          ? t('sources.browserFetch')
                                          : source.kind === 'fetch'
                                            ? t('sources.webFetch')
                                            : t('sources.webSearch')}
                                      </span>
                                    </button>
                                  `
                                )}
                              </div>
                            </div>
                          `;
                        })()
                      : null}
                    ${message.role === 'assistant' && messageChangeCards.has(message.id)
                      ? (() => {
                          const changeCard = messageChangeCards.get(message.id);
                          const firstEventId = changeCard.files[0]?.eventId ?? null;
                          return html`
                            <div className="change-card">
                              <div className="change-card-header">
                                <div className="change-card-summary">
                                  <strong>${t('change.filesChanged', { count: changeCard.totalFiles })}</strong>
                                  <span className="change-card-added">+${changeCard.totalAdded}</span>
                                  <span className="change-card-removed">-${changeCard.totalRemoved}</span>
                                </div>
                                <div className="change-card-actions">
                                  <button
                                    type="button"
                                    className="change-card-action"
                                  disabled=${!firstEventId}
                                  onClick=${() => firstEventId && selectEvent(firstEventId)}
                                >
                                    ${t('change.inspect')}
                                  </button>
                                </div>
                              </div>
                              <div className="change-card-list">
                                ${changeCard.files.map(
                                  (fileChange) => html`
                                    <button
                                      key=${`${message.id}-${fileChange.path}`}
                                      type="button"
                                      className="change-card-row"
                                      onClick=${() => fileChange.eventId && selectEvent(fileChange.eventId)}
                                    >
                                      <strong>${fileChange.path}</strong>
                                      <div className="change-card-row-meta">
                                        ${fileChange.badge
                                          ? html`<span className="change-card-badge">${fileChange.badge}</span>`
                                          : html`
                                              <span className="change-card-added">+${fileChange.added}</span>
                                              <span className="change-card-removed">-${fileChange.removed}</span>
                                            `}
                                      </div>
                                    </button>
                                  `
                                )}
                              </div>
                            </div>
                          `;
                        })()
                      : null}
                  </article>
                `
              )
            : html`
                <div className="empty-thread">
                  <strong>${t('thread.emptyTitle')}</strong>
                  <span>
                    ${t('thread.emptyCopy')}
                  </span>
                  <div className="quick-grid">
                    ${quickPrompts.map(
                      (prompt) => html`
                        <button key=${prompt} type="button" className="quick-card" onClick=${() => fillPrompt(prompt)}>
                          ${prompt}
                        </button>
                      `
                    )}
                  </div>
                </div>
              `}
        </section>

        <form className="composer-dock" onSubmit=${handleSend}>
          ${shouldShowLiveActivity
            ? html`
                <div className="live-activity-panel">
                  <div className="live-activity-header">
                    <strong>${t('status.liveActivity')}</strong>
                    <span>${liveStatusLabel || t('status.preparing')}</span>
                  </div>
                  <div className="live-activity-list">
                    ${liveToolRows.length > 0
                      ? liveToolRows.map(
                          (event) => html`
                            <button
                              key=${event.id}
                              type="button"
                              className=${`progress-row interactive ${selectedEvent?.id === event.id ? 'active' : ''}`}
                              onClick=${() => selectEvent(event.id)}
                            >
                              <span className=${`progress-dot ${event.status}`}></span>
                              <div className="progress-copy">
                                <strong>${prettyToolName(event.toolName)}</strong>
                                <span>${summarizeEvent(event)}</span>
                                ${summarizeEventMeta(event)
                                  ? html`<small>${summarizeEventMeta(event)}</small>`
                                  : null}
                              </div>
                            </button>
                          `
                        )
                      : html`<div className="live-activity-empty">${t('status.working')}</div>`}
                    ${liveStreamThinking
                      ? html`<div className="live-stream-preview subtle">${liveStreamThinking}</div>`
                      : null}
                    ${liveStreamText
                      ? html`<div className="live-stream-preview">${liveStreamText}</div>`
                      : null}
                  </div>
                </div>
              `
            : null}
          ${session?.pendingApproval
            ? html`
                <div className="approval-panel composer-approval-panel">
                  <div className="approval-title">
                    <strong>${t('approval.required')}</strong>
                    <span>${session.pendingApproval.toolName}</span>
                  </div>
                  <div className="approval-copy">
                    ${t('approval.copy')}
                  </div>
                  <pre>${JSON.stringify(session.pendingApproval.arguments, null, 2)}</pre>
                  <div className="inline-actions">
                    <button type="button" className="primary-action" disabled=${busy} onClick=${() => handleApproval(true)}>
                      ${t('approval.approve')}
                    </button>
                    <button type="button" className="danger-action" disabled=${busy} onClick=${() => handleApproval(false)}>
                      ${t('approval.deny')}
                    </button>
                  </div>
                </div>
              `
            : null}
          <div className="composer-box">
            <textarea
              ref=${composerRef}
              value=${input}
              placeholder=${
                session?.pendingApproval
                  ? t('composer.pendingPlaceholder')
                  : t('composer.placeholder')
              }
              onInput=${(event) => setInput(event.target.value)}
            ></textarea>
            ${attachments.length > 0
              ? html`
                  <div className="composer-attachments">
                    ${attachments.map(
                      (attachment) => html`
                        <div key=${attachment.id} className="composer-attachment-chip">
                          <span>
                            ${attachment.kind === 'image'
                              ? t('composer.attachmentImage')
                              : t('composer.attachmentFile')} · ${attachment.name}
                          </span>
                          <small>${formatBytes(attachment.size)}</small>
                          <button
                            type="button"
                            className="composer-attachment-remove"
                            aria-label=${t('composer.removeAttachment', { name: attachment.name })}
                            onClick=${() => removeAttachment(attachment.id)}
                          >
                            ×
                          </button>
                        </div>
                      `
                    )}
                  </div>
                `
              : null}
            <div className="composer-footer composer-footer-rich">
              <div className="composer-inline-controls">
                <input
                  ref=${attachmentInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange=${handleAttachmentSelection}
                />
                <button
                  type="button"
                  className="composer-plus-button"
                  aria-label=${t('composer.addAttachment')}
                  title=${t('composer.addAttachment')}
                  onClick=${openAttachmentPicker}
                >
                  +
                </button>
                <select
                  className="composer-inline-select composer-inline-select-compact"
                  value=${form.providerId}
                  title=${selectedProviderDefinition?.description ?? t('composer.providerTitle')}
                  onChange=${(event) => updateProviderId(event.target.value)}
                >
                  ${providerOptions.map(
                    (provider) => html`
                      <option key=${provider.id} value=${provider.id}>
                        ${provider.label}
                      </option>
                    `
                  )}
                </select>
                <select
                  className="composer-inline-select composer-inline-select-compact"
                  value=${form.permissionPreset}
                  title=${permissionDescription}
                  onChange=${(event) => updateForm('permissionPreset', event.target.value)}
                >
                  ${bootstrap?.permissionPresets?.map(
                    (preset) => html`
                      <option key=${preset.id} value=${preset.id}>
                        ${getPermissionLabel(t, preset.id)}
                      </option>
                    `
                  )}
                </select>
                <select
                  className="composer-inline-select composer-inline-select-wide"
                  value=${effectiveModelName}
                  title=${modelStatusMessage}
                  disabled=${loadingModels || modelOptions.length === 0}
                  onChange=${(event) => updateForm('model', event.target.value)}
                >
                  ${modelOptions.length === 0
                    ? html`<option value="">${t('composer.modelMissing')}</option>`
                    : null}
                  ${modelOptions.map(
                    (model) => html`
                      <option key=${model.name} value=${model.name}>
                        ${model.name}
                      </option>
                    `
                  )}
                </select>
              </div>
              <div className="composer-inline-meta">
                <span className="meta-pill">${t('composer.toolsCount', { count: session?.availableTools?.length ?? 0 })}</span>
                <button
                  type=${isTurnRunning || isStopPending ? 'button' : 'submit'}
                  className=${`send-action send-action-icon ${
                    isTurnRunning || isStopPending ? 'stop' : ''
                  }`}
                  aria-label=${isTurnRunning || isStopPending ? t('composer.stop') : t('composer.send')}
                  title=${isTurnRunning || isStopPending ? t('composer.stop') : t('composer.send')}
                  disabled=${
                    (busy && !isTurnRunning && !isStopPending) ||
                    !form.workspaceRoot ||
                    !effectiveModelName ||
                    session?.pendingApproval
                  }
                  onClick=${isTurnRunning || isStopPending ? () => void handleStopRequest() : undefined}
                >
                  ${isStopPending ? '…' : isTurnRunning ? '■' : busy ? '…' : '↑'}
                </button>
              </div>
            </div>
          </div>
        </form>

        <div className="diagnostics-footer">
          <span className=${`diagnostic-pill ${diagnosticsProviderState}`}>
            ${t('diagnostics.provider')}: ${providerLabel} · ${
              diagnosticsProviderState === 'online' ? t('diagnostics.online') : t('diagnostics.attention')
            }
          </span>
          <span className="diagnostic-pill">
            ${t('diagnostics.activeTools')}: ${liveToolRows.length}
          </span>
          <span className="diagnostic-pill">
            ${t('diagnostics.phase')}: ${formatPhaseLabel(t, livePhase) || t('diagnostics.idle')}
          </span>
          ${lastRecoverableError
            ? html`
                <span className="diagnostic-pill warning" title=${lastRecoverableError}>
                  ${t('diagnostics.lastError')}: ${summarizeSourceSnippet(lastRecoverableError, 80)}
                </span>
              `
            : null}
        </div>
      </main>
        `}

      ${isAutomationsView
        ? null
        : html`<aside className="context-panel">
        <section className="context-section progress-panel">
          <div className="context-header">
            <strong>${t('status.progress')}</strong>
          </div>
          <div className="progress-list">
            ${progressRows.length > 0
              ? progressRows.map(
                  (event) => html`
                    <button
                      key=${event.id}
                      type="button"
                      className=${`progress-row interactive ${selectedEvent?.id === event.id ? 'active' : ''}`}
                      onClick=${() => selectEvent(event.id)}
                    >
                      <span className=${`progress-dot ${event.status}`}></span>
                      <div className="progress-copy">
                        <strong>${prettyToolName(event.toolName)}</strong>
                        <span>${summarizeEvent(event)}</span>
                        ${summarizeEventMeta(event)
                          ? html`<small>${summarizeEventMeta(event)}</small>`
                          : null}
                      </div>
                    </button>
                  `
                )
              : html`
                  <div className="progress-row">
                    <span className="progress-dot pending"></span>
                    <div className="progress-copy">
                      <strong>${t('status.workspaceReady')}</strong>
                      <span>${t('status.firstToolCall')}</span>
                    </div>
                  </div>
                `}
          </div>
          <div className="metric-strip">
            <div className="metric-cell">
              <span>${t('status.completed')}</span>
              <strong>${completedEvents}</strong>
            </div>
            <div className="metric-cell">
              <span>${t('status.plugins')}</span>
              <strong>${session?.plugins?.length ?? 0}</strong>
            </div>
          </div>

          ${selectedEvent
            ? html`
                <div className="inspector-card progress-detail-card">
                  <div className="inspector-title">
                    <strong>${prettyToolName(selectedEvent.toolName)}</strong>
                    <span>${selectedEvent.status}</span>
                  </div>
                  <div className="inspector-summary">
                    <span className="inspector-label">${t('status.summary')}</span>
                    <strong>${summarizeEvent(selectedEvent)}</strong>
                    ${summarizeEventMeta(selectedEvent)
                      ? html`<span className="inspector-meta">${summarizeEventMeta(selectedEvent)}</span>`
                      : null}
                  </div>
                  <details className="inspector-disclosure">
                    <summary>${t('status.arguments')}</summary>
                    <pre>${JSON.stringify(selectedEvent.arguments, null, 2)}</pre>
                  </details>
                  <details className="inspector-disclosure">
                  <summary>${t('status.rawResult')}</summary>
                  <pre>${JSON.stringify(selectedEvent.result ?? {}, null, 2)}</pre>
                </details>
                  ${selectedEvent.diffText
                    ? html`
                        <details className="inspector-disclosure" open>
                          <summary>${t('status.diff')}</summary>
                          <pre>${selectedEvent.diffText}</pre>
                        </details>
                      `
                    : null}
                </div>
              `
            : html`<div className="empty-context">${t('status.noSelectedTool')}</div>`}
        </section>
      </aside>`}
      </div>
    </div>
  `;
}

createRoot(document.getElementById('root')).render(html`<${App} />`);
