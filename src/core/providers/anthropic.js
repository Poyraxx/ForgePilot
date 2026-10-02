import { ProviderName, safeJsonParse } from '../contracts.js';
import {
  buildEmulationPromptBundle,
  buildEnvelopeRepairPrompt,
  parseEmulatedEnvelopeWithRepair,
} from './emulation.js';
import { throwIfAborted } from '../abort.js';
import { readSseEvents } from './sse.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

function normalizeBaseUrl(baseUrl = DEFAULT_BASE_URL) {
  return String(baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/$/, '') || DEFAULT_BASE_URL;
}

function normalizeProviderError(error, baseUrl, action = 'request') {
  const cause = error?.cause ?? error;
  const target = String(baseUrl ?? DEFAULT_BASE_URL);
  let host = target;

  try {
    const parsed = new URL(target);
    host = `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    // Keep original text.
  }

  if (cause?.code === 'ECONNREFUSED') {
    return new Error(`Anthropic baglantisi kurulamadi (${host}). Servis ya da proxy erisilemiyor.`);
  }

  if (cause?.code === 'ETIMEDOUT' || cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new Error(`Anthropic baglantisi zaman asimina ugradi (${host}). Biraz sonra tekrar dene.`);
  }

  if (error?.message === 'fetch failed') {
    return new Error(`Anthropic erisilemedi (${host}). Ag, proxy veya base URL ayarini kontrol et.`);
  }

  return error instanceof Error
    ? new Error(`Anthropic ${action} failed: ${error.message}`)
    : new Error(`Anthropic ${action} failed.`);
}

function normalizeArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value;
}

function mapCapabilities(modelName, forceEmulatedTools = false) {
  return {
    nativeTools: !forceEmulatedTools,
    structuredOutput: true,
    streaming: true,
  };
}

function buildHeaders(apiKey, apiVersion) {
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': apiVersion,
  };

  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  return headers;
}

function stringifyContent(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item?.type === 'text') {
          return item.text ?? '';
        }

        return '';
      })
      .join('\n')
      .trim();
  }

  return value ? JSON.stringify(value) : '';
}

function pushAnthropicMessage(messages, role, blocks) {
  const normalizedBlocks = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  if (normalizedBlocks.length === 0) {
    return;
  }

  const lastMessage = messages.at(-1);
  if (lastMessage?.role === role) {
    lastMessage.content.push(...normalizedBlocks);
    return;
  }

  messages.push({
    role,
    content: normalizedBlocks,
  });
}

function toAnthropicMessages(messages, systemPrompt = '') {
  const systemParts = [];
  const conversation = [];
  const pendingToolCalls = [];
  let pendingToolResultBlocks = [];

  const flushToolResults = () => {
    if (pendingToolResultBlocks.length > 0) {
      pushAnthropicMessage(conversation, 'user', pendingToolResultBlocks);
      pendingToolResultBlocks = [];
    }
  };

  const normalizedSystemPrompt = String(systemPrompt ?? '').trim();
  if (normalizedSystemPrompt) {
    systemParts.push(normalizedSystemPrompt);
  }

  for (const message of messages) {
    if (message.role === 'system') {
      const text = stringifyContent(message.content);
      if (text) {
        systemParts.push(text);
      }
      continue;
    }

    if (message.role === 'tool') {
      const toolCall = pendingToolCalls.shift();
      pendingToolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: toolCall?.id ?? `tool_result_${conversation.length + pendingToolResultBlocks.length + 1}`,
        content: stringifyContent(message.content),
      });
      continue;
    }

    flushToolResults();

    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      const blocks = [];
      if (String(message.content ?? '').trim()) {
        blocks.push({
          type: 'text',
          text: String(message.content ?? ''),
        });
      }

      for (let index = 0; index < message.toolCalls.length; index += 1) {
        const call = message.toolCalls[index];
        const id = call.id ?? `tool_use_${conversation.length + 1}_${index + 1}`;
        pendingToolCalls.push({
          id,
          name: call.name,
          input: normalizeArguments(call.arguments),
        });
        blocks.push({
          type: 'tool_use',
          id,
          name: call.name,
          input: normalizeArguments(call.arguments),
        });
      }

      pushAnthropicMessage(conversation, 'assistant', blocks);
      continue;
    }

    pushAnthropicMessage(conversation, message.role, [
      {
        type: 'text',
        text: stringifyContent(message.content),
      },
    ]);
  }

  flushToolResults();

  return {
    system: systemParts.join('\n\n').trim() || undefined,
    messages: conversation,
  };
}

function extractAnthropicText(contentBlocks = []) {
  return contentBlocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
}

function extractAnthropicToolCalls(contentBlocks = []) {
  return contentBlocks
    .filter((block) => block?.type === 'tool_use')
    .map((block, index) => ({
      id: block.id ?? `native_call_${index + 1}`,
      name: block.name,
      arguments: normalizeArguments(block.input),
    }));
}

function toAnthropicTool(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

export class AnthropicProvider {
  constructor({
    name = ProviderName.ANTHROPIC,
    baseUrl = DEFAULT_BASE_URL,
    apiKey = '',
    apiVersion = DEFAULT_API_VERSION,
    maxTokens = DEFAULT_MAX_TOKENS,
    forceEmulatedTools = false,
    capabilityOverrides = {},
  } = {}) {
    this.name = name;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = String(apiKey ?? '').trim();
    this.apiVersion = String(apiVersion ?? DEFAULT_API_VERSION).trim() || DEFAULT_API_VERSION;
    this.maxTokens = Number.isFinite(Number(maxTokens))
      ? Math.max(256, Number(maxTokens))
      : DEFAULT_MAX_TOKENS;
    this.forceEmulatedTools = Boolean(forceEmulatedTools);
    this.capabilityOverrides = capabilityOverrides;
    this.capabilityCache = new Map();
  }

  async listModels() {
    const payload = await this.#request('/v1/models?limit=1000', { method: 'GET' }, 'model listing');
    const models = Array.isArray(payload?.data) ? payload.data : [];

    return Promise.all(
      models.map(async (model) => ({
        ...model,
        name: model.id ?? model.name,
        capabilities: await this.getCapabilities(model.id ?? model.name),
      }))
    );
  }

  async getCapabilities(modelName, override = {}) {
    const cacheKey = `${modelName}:${JSON.stringify(override)}`;
    if (this.capabilityCache.has(cacheKey)) {
      return this.capabilityCache.get(cacheKey);
    }

    const mapped = {
      ...mapCapabilities(modelName, this.forceEmulatedTools),
      ...(this.capabilityOverrides[modelName] ?? {}),
      ...override,
    };

    this.capabilityCache.set(cacheKey, mapped);
    return mapped;
  }

  async runTurn({
    model,
    messages,
    tools,
    useNativeTools,
    workspaceRoot = '',
    knownPaths = [],
    systemPrompt = '',
    runtimeOptions = {},
    signal,
  }) {
    throwIfAborted(signal);

    if (useNativeTools) {
      const normalized = toAnthropicMessages(messages, systemPrompt);
      const payload = await this.#request(
        '/v1/messages',
        {
          method: 'POST',
          body: {
            model,
            max_tokens: this.maxTokens,
            temperature: Number.isFinite(runtimeOptions?.temperature)
              ? runtimeOptions.temperature
              : undefined,
            system: normalized.system,
            messages: normalized.messages,
            tools: tools.map(toAnthropicTool),
          },
          signal,
        },
        'messages request'
      );

      return {
        provider: this.name,
        nativeTools: true,
        message: extractAnthropicText(payload.content),
        thinking: '',
        toolCalls: extractAnthropicToolCalls(payload.content),
        raw: payload,
      };
    }

    const emulation = buildEmulationPromptBundle(
      messages,
      tools,
      workspaceRoot,
      systemPrompt,
      knownPaths
    );
    const normalized = toAnthropicMessages(emulation.messages, emulation.systemPrompt);
    const response = await this.#request(
      '/v1/messages',
      {
        method: 'POST',
        body: {
          model,
          max_tokens: this.maxTokens,
          temperature: Number.isFinite(runtimeOptions?.temperature)
            ? runtimeOptions.temperature
            : undefined,
          system: normalized.system,
          messages: normalized.messages,
        },
        signal,
      },
      'messages request'
    );

    const rawMessage = extractAnthropicText(response.content);
    const parsed = await parseEmulatedEnvelopeWithRepair({
      rawMessage,
      fallbackThinking: '',
      repair: async (parseFailure) => {
        const repairMessages = toAnthropicMessages(
          [
            ...emulation.messages,
            { role: 'assistant', content: rawMessage },
            { role: 'user', content: buildEnvelopeRepairPrompt(parseFailure) },
          ],
          emulation.systemPrompt
        );

        const repairResponse = await this.#request(
          '/v1/messages',
          {
            method: 'POST',
            body: {
              model,
              max_tokens: this.maxTokens,
              temperature: Number.isFinite(runtimeOptions?.temperature)
                ? runtimeOptions.temperature
                : undefined,
              system: repairMessages.system,
              messages: repairMessages.messages,
            },
            signal,
          },
          'envelope repair'
        );

        return {
          message: extractAnthropicText(repairResponse.content),
          thinking: '',
          raw: repairResponse,
        };
      },
    });

    return {
      provider: this.name,
      nativeTools: false,
      message: parsed.message,
      thinking: parsed.thinking,
      envelope: parsed.envelope,
      raw: parsed.raw ?? response,
    };
  }

  async runStreamingTurn(payload) {
    const {
      model,
      messages,
      tools = [],
      useNativeTools,
      workspaceRoot = '',
      knownPaths = [],
      systemPrompt = '',
      runtimeOptions = {},
      signal,
      onChunk,
    } = payload;
    throwIfAborted(signal);
    const emulation = useNativeTools
      ? null
      : buildEmulationPromptBundle(messages, tools, workspaceRoot, systemPrompt, knownPaths);
    const normalized = toAnthropicMessages(
      emulation?.messages ?? messages,
      emulation?.systemPrompt ?? systemPrompt
    );
    const response = await this.#request('/v1/messages', {
      body: {
        model,
        max_tokens: this.maxTokens,
        temperature: Number.isFinite(runtimeOptions?.temperature)
          ? runtimeOptions.temperature
          : undefined,
        system: normalized.system,
        messages: normalized.messages,
        tools: useNativeTools ? tools.map(toAnthropicTool) : undefined,
        stream: true,
      },
      signal,
      streamResponse: true,
    }, 'messages request');

    const blocks = new Map();
    let content = '';
    let thinking = '';
    if (response.headers?.get('content-type')?.includes('application/json')) {
      const result = await response.json();
      for (const [index, block] of (result.content ?? []).entries()) {
        blocks.set(index, block);
      }
      content = extractAnthropicText(result.content ?? []);
      if (content) {
        onChunk?.({ content, thinking });
      }
    } else {
      for await (const event of readSseEvents(response)) {
        throwIfAborted(signal);
        const data = safeJsonParse(event.data);
        if (event.event === 'error' || data?.type === 'error') {
          throw new Error(data?.error?.message ?? 'Anthropic stream failed.');
        }

        if (data?.type === 'content_block_start') {
          const block = data.content_block ?? {};
          blocks.set(data.index, block.type === 'tool_use'
            ? { ...block, inputJson: '' }
            : { ...block, text: block.text ?? '' });
          if (block.type === 'text' && block.text) {
            content += block.text;
            onChunk?.({ content, thinking });
          }
        }

        if (data?.type !== 'content_block_delta') {
          continue;
        }

        const block = blocks.get(data.index);
        const delta = data.delta ?? {};
        if (delta.type === 'text_delta') {
          const text = delta.text ?? '';
          content += text;
          if (block) {
            block.text += text;
          }
          onChunk?.({ content, thinking });
        } else if (delta.type === 'thinking_delta') {
          thinking += delta.thinking ?? '';
          onChunk?.({ content, thinking });
        } else if (delta.type === 'input_json_delta' && block) {
          block.inputJson += delta.partial_json ?? '';
        }
      }
    }

    const contentBlocks = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) =>
      block.type === 'tool_use'
        ? { ...block, input: safeJsonParse(block.inputJson, block.input ?? {}) }
        : block
    );
    if (useNativeTools) {
      return {
        provider: this.name,
        nativeTools: true,
        message: extractAnthropicText(contentBlocks),
        thinking,
        toolCalls: extractAnthropicToolCalls(contentBlocks),
        raw: { streamed: true },
      };
    }

    const parsed = await parseEmulatedEnvelopeWithRepair({
      rawMessage: content,
      fallbackThinking: thinking,
      repair: async (parseFailure) => {
        const repairMessages = toAnthropicMessages([
          ...emulation.messages,
          { role: 'assistant', content },
          { role: 'user', content: buildEnvelopeRepairPrompt(parseFailure) },
        ], emulation.systemPrompt);
        const repairResponse = await this.#request('/v1/messages', {
          body: {
            model,
            max_tokens: this.maxTokens,
            temperature: Number.isFinite(runtimeOptions?.temperature)
              ? runtimeOptions.temperature
              : undefined,
            system: repairMessages.system,
            messages: repairMessages.messages,
          },
          signal,
        }, 'envelope repair');
        return {
          message: extractAnthropicText(repairResponse.content),
          thinking,
          raw: repairResponse,
        };
      },
    });

    return {
      provider: this.name,
      nativeTools: false,
      message: parsed.message,
      thinking: parsed.thinking,
      envelope: parsed.envelope,
      raw: parsed.raw ?? { streamed: true },
    };
  }

  async #request(endpoint, { method = 'POST', body, signal, streamResponse = false } = {}, action = 'request') {
    let response;

    try {
      response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: buildHeaders(this.apiKey, this.apiVersion),
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (error) {
      throw normalizeProviderError(error, this.baseUrl, action);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const message = errorBody || `Anthropic ${action} failed with status ${response.status}.`;
      throw new Error(message);
    }

    return streamResponse ? response : response.json();
  }
}
