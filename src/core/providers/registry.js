import { ProviderName } from '../contracts.js';
import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const COMPATIBLE_BASE_URL = 'http://127.0.0.1:1234/v1';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_MAX_TOKENS = 4096;

export const PROVIDER_CATALOG = Object.freeze([
  {
    id: ProviderName.OLLAMA,
    label: 'Ollama',
    description: 'Yerel Ollama runtime',
    configFields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'text',
        placeholder: OLLAMA_BASE_URL,
      },
    ],
  },
  {
    id: ProviderName.OPENAI,
    label: 'OpenAI',
    description: 'Official OpenAI Chat Completions API',
    configFields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        placeholder: 'sk-...',
      },
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'text',
        placeholder: OPENAI_BASE_URL,
      },
      {
        key: 'forceEmulatedTools',
        label: 'Force emulated tools',
        type: 'boolean',
      },
    ],
  },
  {
    id: ProviderName.OPENAI_COMPATIBLE,
    label: 'OpenAI Compatible',
    description: 'LM Studio, OpenRouter, Groq, Together, DeepSeek, vLLM ve benzeri',
    configFields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'text',
        placeholder: COMPATIBLE_BASE_URL,
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        placeholder: 'Opsiyonel / servis gerektiriyorsa',
      },
      {
        key: 'forceEmulatedTools',
        label: 'Force emulated tools',
        type: 'boolean',
      },
    ],
  },
  {
    id: ProviderName.ANTHROPIC,
    label: 'Anthropic',
    description: 'Claude Messages API',
    configFields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        placeholder: 'sk-ant-...',
      },
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'text',
        placeholder: ANTHROPIC_BASE_URL,
      },
      {
        key: 'apiVersion',
        label: 'API Version',
        type: 'text',
        placeholder: ANTHROPIC_API_VERSION,
      },
      {
        key: 'maxTokens',
        label: 'Max output tokens',
        type: 'number',
        placeholder: String(ANTHROPIC_MAX_TOKENS),
      },
      {
        key: 'forceEmulatedTools',
        label: 'Force emulated tools',
        type: 'boolean',
      },
    ],
  },
]);

export function createDefaultProviderConfigs() {
  return {
    [ProviderName.OLLAMA]: {
      baseUrl: OLLAMA_BASE_URL,
    },
    [ProviderName.OPENAI]: {
      baseUrl: OPENAI_BASE_URL,
      apiKey: '',
      forceEmulatedTools: false,
    },
    [ProviderName.OPENAI_COMPATIBLE]: {
      baseUrl: COMPATIBLE_BASE_URL,
      apiKey: '',
      forceEmulatedTools: false,
    },
    [ProviderName.ANTHROPIC]: {
      baseUrl: ANTHROPIC_BASE_URL,
      apiKey: '',
      apiVersion: ANTHROPIC_API_VERSION,
      maxTokens: ANTHROPIC_MAX_TOKENS,
      forceEmulatedTools: false,
    },
  };
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

export function normalizeProviderId(value, fallback = ProviderName.OLLAMA) {
  return PROVIDER_CATALOG.some((provider) => provider.id === value) ? value : fallback;
}

export function normalizeProviderConfigs(rawValue = {}) {
  const defaults = createDefaultProviderConfigs();
  const source = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) ? rawValue : {};

  return {
    [ProviderName.OLLAMA]: {
      baseUrl: normalizeText(source?.[ProviderName.OLLAMA]?.baseUrl, defaults[ProviderName.OLLAMA].baseUrl),
    },
    [ProviderName.OPENAI]: {
      baseUrl: normalizeText(source?.[ProviderName.OPENAI]?.baseUrl, defaults[ProviderName.OPENAI].baseUrl),
      apiKey: normalizeText(source?.[ProviderName.OPENAI]?.apiKey, defaults[ProviderName.OPENAI].apiKey),
      forceEmulatedTools: normalizeBoolean(
        source?.[ProviderName.OPENAI]?.forceEmulatedTools,
        defaults[ProviderName.OPENAI].forceEmulatedTools
      ),
    },
    [ProviderName.OPENAI_COMPATIBLE]: {
      baseUrl: normalizeText(
        source?.[ProviderName.OPENAI_COMPATIBLE]?.baseUrl,
        defaults[ProviderName.OPENAI_COMPATIBLE].baseUrl
      ),
      apiKey: normalizeText(
        source?.[ProviderName.OPENAI_COMPATIBLE]?.apiKey,
        defaults[ProviderName.OPENAI_COMPATIBLE].apiKey
      ),
      forceEmulatedTools: normalizeBoolean(
        source?.[ProviderName.OPENAI_COMPATIBLE]?.forceEmulatedTools,
        defaults[ProviderName.OPENAI_COMPATIBLE].forceEmulatedTools
      ),
    },
    [ProviderName.ANTHROPIC]: {
      baseUrl: normalizeText(
        source?.[ProviderName.ANTHROPIC]?.baseUrl,
        defaults[ProviderName.ANTHROPIC].baseUrl
      ),
      apiKey: normalizeText(
        source?.[ProviderName.ANTHROPIC]?.apiKey,
        defaults[ProviderName.ANTHROPIC].apiKey
      ),
      apiVersion: normalizeText(
        source?.[ProviderName.ANTHROPIC]?.apiVersion,
        defaults[ProviderName.ANTHROPIC].apiVersion
      ),
      maxTokens: normalizeNumber(
        source?.[ProviderName.ANTHROPIC]?.maxTokens,
        defaults[ProviderName.ANTHROPIC].maxTokens
      ),
      forceEmulatedTools: normalizeBoolean(
        source?.[ProviderName.ANTHROPIC]?.forceEmulatedTools,
        defaults[ProviderName.ANTHROPIC].forceEmulatedTools
      ),
    },
  };
}

function getCacheKey(providerId, config) {
  return `${providerId}:${JSON.stringify(config)}`;
}

export class ProviderRegistry {
  constructor() {
    this.providerCache = new Map();
  }

  getCatalog() {
    return PROVIDER_CATALOG.map((provider) => ({
      id: provider.id,
      label: provider.label,
      description: provider.description,
      configFields: provider.configFields,
    }));
  }

  getProvider(providerId, providerConfigs = {}) {
    const normalizedProviderId = normalizeProviderId(providerId);
    const normalizedConfigs = normalizeProviderConfigs(providerConfigs);
    const config = normalizedConfigs[normalizedProviderId] ?? createDefaultProviderConfigs()[normalizedProviderId];
    const cacheKey = getCacheKey(normalizedProviderId, config);

    if (this.providerCache.has(cacheKey)) {
      return this.providerCache.get(cacheKey);
    }

    let provider;

    switch (normalizedProviderId) {
      case ProviderName.OPENAI:
        provider = new OpenAICompatibleProvider({
          name: ProviderName.OPENAI,
          label: 'OpenAI',
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          forceEmulatedTools: config.forceEmulatedTools,
        });
        break;
      case ProviderName.OPENAI_COMPATIBLE:
        provider = new OpenAICompatibleProvider({
          name: ProviderName.OPENAI_COMPATIBLE,
          label: 'OpenAI-compatible provider',
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          forceEmulatedTools: config.forceEmulatedTools,
        });
        break;
      case ProviderName.ANTHROPIC:
        provider = new AnthropicProvider({
          name: ProviderName.ANTHROPIC,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          apiVersion: config.apiVersion,
          maxTokens: config.maxTokens,
          forceEmulatedTools: config.forceEmulatedTools,
        });
        break;
      case ProviderName.OLLAMA:
      default:
        provider = new OllamaProvider({
          baseUrl: config.baseUrl,
        });
        break;
    }

    this.providerCache.set(cacheKey, provider);
    return provider;
  }
}
