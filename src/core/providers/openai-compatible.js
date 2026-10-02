import { ProviderName, safeJsonParse } from '../contracts.js';
import {
  buildEmulationPromptBundle,
  buildEnvelopeRepairPrompt,
  parseEmulatedEnvelopeWithRepair,
} from './emulation.js';
import { throwIfAborted } from '../abort.js';
import { readSseEvents } from './sse.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function normalizeBaseUrl(baseUrl = DEFAULT_BASE_URL) {
  return String(baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/$/, '') || DEFAULT_BASE_URL;
}

function normalizeProviderError(error, label, baseUrl, action = 'request') {
  const cause = error?.cause ?? error;
  const target = String(baseUrl ?? DEFAULT_BASE_URL);
  let host = target;

  try {
    const parsed = new URL(target);
    host = `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    // Keep original target text.
  }

  if (cause?.code === 'ECONNREFUSED') {
    return new Error(`${label} baglantisi kurulamadi (${host}). Servis calismiyor gibi gorunuyor.`);
  }

  if (cause?.code === 'ETIMEDOUT' || cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new Error(`${label} baglantisi zaman asimina ugradi (${host}). Biraz sonra tekrar dene.`);
  }

  if (error?.message === 'fetch failed') {
    return new Error(`${label} erisilemedi (${host}). Base URL ve servis durumunu kontrol et.`);
  }

  return error instanceof Error
    ? new Error(`${label} ${action} failed: ${error.message}`)
    : new Error(`${label} ${action} failed.`);
}

function mapCapabilities(modelName, forceEmulatedTools = false) {
  return {
    nativeTools: !forceEmulatedTools,
    structuredOutput: true,
    streaming: true,
  };
}

function normalizeArguments(value) {
  if (!value) {
    return {};
  }

  if (typeof value === 'string') {
    const parsed = safeJsonParse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  return {};
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

function toOpenAITool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function buildHeaders(apiKey) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function buildBodyOptions(runtimeOptions = {}) {
  const payload = {};

  if (Number.isFinite(runtimeOptions?.temperature)) {
    payload.temperature = runtimeOptions.temperature;
  }

  return payload;
}

function withSystemPrompt(messages, systemPrompt = '') {
  const normalizedPrompt = String(systemPrompt ?? '').trim();

  if (!normalizedPrompt) {
    return messages;
  }

  return [{ role: 'system', content: normalizedPrompt }, ...messages];
}

function toOpenAICompatibleMessages(messages) {
  const converted = [];
  const pendingToolCalls = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      const toolCall = pendingToolCalls.shift();
      converted.push({
        role: 'tool',
        tool_call_id: toolCall?.id ?? `tool_call_${converted.length + 1}`,
        name: message.toolName ?? toolCall?.name,
        content: stringifyContent(message.content),
      });
      continue;
    }

    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      const toolCalls = message.toolCalls.map((call, index) => {
        const id = call.id ?? `call_${converted.length + 1}_${index + 1}`;
        const normalized = {
          id,
          name: call.name,
          arguments: normalizeArguments(call.arguments),
        };
        pendingToolCalls.push(normalized);
        return {
          id,
          type: 'function',
          function: {
            name: normalized.name,
            arguments: JSON.stringify(normalized.arguments),
          },
        };
      });

      converted.push({
        role: 'assistant',
        content: message.content ?? '',
        tool_calls: toolCalls,
      });
      continue;
    }

    converted.push({
      role: message.role,
      content: stringifyContent(message.content),
    });
  }

  return converted;
}

function fromOpenAIToolCalls(toolCalls = []) {
  return toolCalls.map((call, index) => ({
    id: call.id ?? `native_call_${index + 1}`,
    name: call.function?.name,
    arguments: normalizeArguments(call.function?.arguments),
  }));
}

function extractChoiceMessage(payload) {
  return payload?.choices?.[0]?.message ?? {};
}

export class OpenAICompatibleProvider {
  constructor({
    name = ProviderName.OPENAI_COMPATIBLE,
    label = 'OpenAI-compatible provider',
    baseUrl = DEFAULT_BASE_URL,
    apiKey = '',
    forceEmulatedTools = false,
    capabilityOverrides = {},
  } = {}) {
    this.name = name;
    this.label = label;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = String(apiKey ?? '').trim();
    this.forceEmulatedTools = Boolean(forceEmulatedTools);
    this.capabilityOverrides = capabilityOverrides;
    this.capabilityCache = new Map();
  }

  async listModels() {
    const payload = await this.#request('/models', {
      method: 'GET',
    }, 'model listing');
    const models = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];

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
    const options = buildBodyOptions(runtimeOptions);

    if (useNativeTools) {
      const payload = await this.#request(
        '/chat/completions',
        {
          method: 'POST',
          body: {
            model,
            messages: toOpenAICompatibleMessages(withSystemPrompt(messages, systemPrompt)),
            tools: tools.map(toOpenAITool),
            tool_choice: tools.length > 0 ? 'auto' : undefined,
            stream: false,
            ...options,
          },
          signal,
        },
        'chat completion'
      );

      const message = extractChoiceMessage(payload);
      return {
        provider: this.name,
        nativeTools: true,
        message: stringifyContent(message.content),
        thinking: '',
        toolCalls: fromOpenAIToolCalls(message.tool_calls),
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

    const response = await this.#request(
      '/chat/completions',
      {
        method: 'POST',
        body: {
          model,
          messages: toOpenAICompatibleMessages(
            withSystemPrompt(emulation.messages, emulation.systemPrompt)
          ),
          stream: false,
          ...options,
        },
        signal,
      },
      'chat completion'
    );

    const rawMessage = stringifyContent(extractChoiceMessage(response).content);
    const parsed = await parseEmulatedEnvelopeWithRepair({
      rawMessage,
      fallbackThinking: '',
      repair: async (parseFailure) => {
        const repairResponse = await this.#request(
          '/chat/completions',
          {
            method: 'POST',
            body: {
              model,
              messages: toOpenAICompatibleMessages(
                withSystemPrompt(
                  [
                    ...emulation.messages,
                    { role: 'assistant', content: rawMessage },
                    { role: 'user', content: buildEnvelopeRepairPrompt(parseFailure) },
                  ],
                  emulation.systemPrompt
                )
              ),
              stream: false,
              ...options,
            },
            signal,
          },
          'envelope repair'
        );

        return {
          message: stringifyContent(extractChoiceMessage(repairResponse).content),
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
    const response = await this.#request('/chat/completions', {
      body: {
        model,
        messages: toOpenAICompatibleMessages(withSystemPrompt(
          emulation?.messages ?? messages,
          emulation?.systemPrompt ?? systemPrompt
        )),
        tools: useNativeTools ? tools.map(toOpenAITool) : undefined,
        tool_choice: useNativeTools && tools.length > 0 ? 'auto' : undefined,
        stream: true,
        ...buildBodyOptions(runtimeOptions),
      },
      signal,
      streamResponse: true,
    }, 'chat completion');

    let content = '';
    let thinking = '';
    const calls = new Map();
    if (response.headers?.get('content-type')?.includes('application/json')) {
      const message = extractChoiceMessage(await response.json());
      content = stringifyContent(message.content);
      for (const [index, call] of (message.tool_calls ?? []).entries()) {
        calls.set(index, call);
      }
      if (content) {
        onChunk?.({ content, thinking });
      }
    } else {
      for await (const event of readSseEvents(response)) {
        throwIfAborted(signal);
        if (event.data === '[DONE]') {
          break;
        }

        const data = safeJsonParse(event.data);
        if (data?.error) {
          throw new Error(data.error.message ?? JSON.stringify(data.error));
        }

        const delta = data?.choices?.[0]?.delta;
        if (!delta) {
          continue;
        }

        content += typeof delta.content === 'string' ? delta.content : stringifyContent(delta.content);
        thinking += delta.reasoning_content ?? delta.reasoning ?? '';
        for (const call of delta.tool_calls ?? []) {
          const index = Number.isInteger(call.index) ? call.index : calls.size;
          const current = calls.get(index) ?? { id: '', function: { name: '', arguments: '' } };
          current.id = call.id ?? current.id;
          current.function.name += call.function?.name ?? '';
          current.function.arguments += call.function?.arguments ?? '';
          calls.set(index, current);
        }

        if (delta.content || delta.reasoning_content || delta.reasoning) {
          onChunk?.({ content, thinking });
        }
      }
    }

    if (useNativeTools) {
      return {
        provider: this.name,
        nativeTools: true,
        message: content,
        thinking,
        toolCalls: fromOpenAIToolCalls([...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)),
        raw: { streamed: true },
      };
    }

    const parsed = await parseEmulatedEnvelopeWithRepair({
      rawMessage: content,
      fallbackThinking: thinking,
      repair: async (parseFailure) => {
        const repairResponse = await this.#request('/chat/completions', {
          body: {
            model,
            messages: toOpenAICompatibleMessages(withSystemPrompt([
              ...emulation.messages,
              { role: 'assistant', content },
              { role: 'user', content: buildEnvelopeRepairPrompt(parseFailure) },
            ], emulation.systemPrompt)),
            stream: false,
            ...buildBodyOptions(runtimeOptions),
          },
          signal,
        }, 'envelope repair');
        return {
          message: stringifyContent(extractChoiceMessage(repairResponse).content),
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
        headers: buildHeaders(this.apiKey),
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (error) {
      throw normalizeProviderError(error, this.label, this.baseUrl, action);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      const message = errorBody || `${this.label} ${action} failed with status ${response.status}.`;
      throw new Error(message);
    }

    return streamResponse ? response : response.json();
  }
}
