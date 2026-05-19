import { ProviderName, safeJsonParse } from '../contracts.js';
import { isAbortError, throwIfAborted } from '../abort.js';
import {
  buildEmulationPromptBundle,
  buildEnvelopeRepairPrompt,
  parseEmulatedEnvelopeWithRepair,
} from './emulation.js';

function normalizeOllamaError(error, baseUrl, action = 'request') {
  if (isAbortError(error)) {
    return error;
  }

  const cause = error?.cause ?? error;
  const target = String(baseUrl ?? 'http://127.0.0.1:11434');
  const host = (() => {
    try {
      const parsed = new URL(target);
      return `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
    } catch {
      return target;
    }
  })();

  if (cause?.code === 'ECONNREFUSED') {
    return new Error(
      `Ollama baglantisi kurulamadi (${host}). Ollama kapali gibi gorunuyor. Once Ollama'yi baslat ve sonra tekrar dene.`
    );
  }

  if (cause?.code === 'ETIMEDOUT' || cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new Error(
      `Ollama baglantisi zaman asimina ugradi (${host}). Ollama calisiyorsa kisa bir sure sonra tekrar dene.`
    );
  }

  if (error?.message === 'fetch failed') {
    return new Error(
      `Ollama'ya erisilemedi (${host}). Servisin acik oldugundan emin ol ve tekrar dene.`
    );
  }

  return error instanceof Error
    ? new Error(`Ollama ${action} failed: ${error.message}`)
    : new Error(`Ollama ${action} failed.`);
}

function mapCapabilities(capabilities, modelName) {
  const rawCapabilities = Array.isArray(capabilities) ? capabilities : [];
  const fallbackNativeTools = /\b(tool|tools|coder-next)\b/i.test(modelName ?? '');

  return {
    nativeTools: rawCapabilities.includes('tools') || fallbackNativeTools,
    structuredOutput: true,
    streaming: true,
  };
}

function normalizeArguments(argumentsValue) {
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    return {};
  }

  return argumentsValue;
}

function toOllamaTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function buildOllamaOptions(runtimeOptions = {}) {
  const options = {};

  if (Number.isFinite(runtimeOptions?.numCtx)) {
    options.num_ctx = runtimeOptions.numCtx;
  }

  if (Number.isFinite(runtimeOptions?.temperature)) {
    options.temperature = runtimeOptions.temperature;
  }

  return options;
}

function toOllamaMessage(message) {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_name: message.toolName,
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    };
  }

  if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content ?? '',
      thinking: message.thinking,
      tool_calls: message.toolCalls.map((call, index) => ({
        type: 'function',
        function: {
          index,
          name: call.name,
          arguments: call.arguments,
        },
      })),
    };
  }

  return {
    role: message.role,
    content: message.content ?? '',
    thinking: message.thinking,
  };
}

function fromOllamaToolCalls(toolCalls) {
  return (toolCalls ?? []).map((call, index) => ({
    id: call.id ?? `native_call_${index + 1}`,
    name: call.function?.name,
    arguments: normalizeArguments(call.function?.arguments),
  }));
}

function buildEmulationSystemPrompt(tools, workspaceRoot, knownPaths = []) {
  const toolCatalog = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  const normalizedKnownPaths = knownPaths
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .slice(0, 120);

  return [
    'You are a local workspace coding agent.',
    `Workspace root: ${workspaceRoot}`,
    'You may call tools even though the model does not support native tool calling.',
    'When you need to use tools, respond with exactly one XML block named <agent-response> containing JSON.',
    'Tool response format:',
    '<agent-response>{"mode":"tool","calls":[{"name":"fs_read","arguments":{"path":"README.md"}}]}</agent-response>',
    'When the task is complete, respond with exactly:',
    '<agent-response>{"mode":"final","message":"short natural language answer"}</agent-response>',
    'If you cannot continue, respond with:',
    '<agent-response>{"mode":"error","message":"what went wrong"}</agent-response>',
    'Never include extra prose before or after the XML block.',
    'You can make multiple calls by returning multiple items in the calls array.',
    'Tool results will be sent back as role=tool messages.',
    'Never invent file or directory names.',
    'Only use a path after you have seen that exact path in a prior tool result.',
    'If an attached file was copied into the workspace, its old absolute source location is invalid. Reuse only the copied workspace path shown in context.',
    'If you need to discover files, use fs_list or search_text first and then read only returned paths.',
    'Use fs_patch only when you already know the exact existing text from fs_read.',
    'If you want to replace an entire file, prefer fs_write instead of fs_patch.',
    'If you need current public web information, use web_search first and then web_fetch one of the returned URLs.',
    'After web_search, prefer resultId-based fetching: pass the exact resultId from web_search into web_fetch or browser_fetch whenever available.',
    'Only web_fetch or browser_fetch an exact URL that appeared in web_search results or that the user explicitly pasted.',
    'Never invent, rewrite, shorten, or guess a web URL from memory, snippets, titles, or domain knowledge.',
    'If a web URL is blocked as undiscovered, do not try a different guessed URL. Run web_search again with a better query and copy one exact returned URL.',
    'If normal web_fetch is blocked, incomplete, or the page needs JavaScript, use browser_fetch for a browser-rendered read.',
    'Do not repeat the same exploratory tool call if the previous result already gave enough context.',
    'If a tool reports that a path was not found, choose a different path from prior tool output instead of guessing.',
    normalizedKnownPaths.length > 0
      ? `Known paths already discovered in this thread:\n${normalizedKnownPaths.join('\n')}`
      : 'Known paths already discovered in this thread:\n.',
    `Available tools:\n${JSON.stringify(toolCatalog, null, 2)}`,
  ].join('\n');
}

function withSystemPrompt(messages, systemPrompt = '') {
  const normalizedPrompt = String(systemPrompt ?? '').trim();
  const normalizedMessages = messages.map(toOllamaMessage);

  if (!normalizedPrompt) {
    return normalizedMessages;
  }

  return [
    {
      role: 'system',
      content: normalizedPrompt,
    },
    ...normalizedMessages,
  ];
}

async function readStreamingResponse(response, { onChunk } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let buffer = '';
  let content = '';
  let thinking = '';
  let toolCalls = [];
  let lastEnvelope = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const parsed = safeJsonParse(trimmed);
      if (!parsed) {
        continue;
      }

      chunks.push(parsed);
      content += parsed.message?.content ?? '';
      thinking += parsed.message?.thinking ?? '';
      if (Array.isArray(parsed.message?.tool_calls) && parsed.message.tool_calls.length > 0) {
        toolCalls = fromOllamaToolCalls(parsed.message.tool_calls);
      }
      lastEnvelope = parsed;
      onChunk?.({
        delta: parsed.message?.content ?? '',
        content,
        thinking,
        toolCalls,
        raw: parsed,
      });
    }
  }

  return { chunks, content, thinking, toolCalls, lastEnvelope };
}

export class OllamaProvider {
  constructor({ baseUrl = 'http://127.0.0.1:11434', capabilityOverrides = {} } = {}) {
    this.name = ProviderName.OLLAMA;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.capabilityOverrides = capabilityOverrides;
    this.capabilityCache = new Map();
  }

  async listModels() {
    let response;

    try {
      response = await fetch(`${this.baseUrl}/api/tags`);
    } catch (error) {
      throw normalizeOllamaError(error, this.baseUrl, 'model listing');
    }

    if (!response.ok) {
      throw new Error(`Ollama model listing failed with status ${response.status}.`);
    }

    const payload = await response.json();
    const models = payload.models ?? [];

    const hydrated = await Promise.all(
      models.map(async (model) => ({
        ...model,
        capabilities: await this.getCapabilities(model.name),
      }))
    );

    return hydrated;
  }

  async getCapabilities(modelName, override = {}) {
    const overrideKey = JSON.stringify(override);
    const cacheKey = `${modelName}:${overrideKey}`;

    if (this.capabilityCache.has(cacheKey)) {
      return this.capabilityCache.get(cacheKey);
    }

    try {
      const payload = await this.#postJson('/api/show', {
        name: modelName,
      });

      const mapped = {
        ...mapCapabilities(payload.capabilities, modelName),
        ...(this.capabilityOverrides[modelName] ?? {}),
        ...override,
      };

      this.capabilityCache.set(cacheKey, mapped);
      return mapped;
    } catch {
      const fallback = {
        ...mapCapabilities([], modelName),
        ...(this.capabilityOverrides[modelName] ?? {}),
        ...override,
      };

      this.capabilityCache.set(cacheKey, fallback);
      return fallback;
    }
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
    const options = buildOllamaOptions(runtimeOptions);

    if (useNativeTools) {
      const payload = await this.#postJson('/api/chat', {
        model,
        stream: false,
        messages: withSystemPrompt(messages, systemPrompt),
        tools: tools.map(toOllamaTool),
        options,
      }, { signal });

      return {
        provider: this.name,
        nativeTools: true,
        message: payload.message?.content ?? '',
        thinking: payload.message?.thinking ?? '',
        toolCalls: fromOllamaToolCalls(payload.message?.tool_calls),
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
    const emulationMessages = [
      {
        role: 'system',
        content: emulation.systemPrompt,
      },
      ...emulation.messages.map(toOllamaMessage),
    ];
    const response = await this.#postJson('/api/chat', {
      model,
      stream: false,
      messages: emulationMessages,
      options,
    }, { signal });

    const rawMessage = response.message?.content ?? '';
    const parsed = await parseEmulatedEnvelopeWithRepair({
      rawMessage,
      fallbackThinking: response.message?.thinking ?? '',
      repair: async (parseFailure) => {
        const repairResponse = await this.#postJson(
          '/api/chat',
          {
            model,
            stream: false,
            messages: [
              ...emulationMessages,
              { role: 'assistant', content: rawMessage },
              { role: 'user', content: buildEnvelopeRepairPrompt(parseFailure) },
            ],
            options,
          },
          { signal }
        );

        return {
          message: repairResponse.message?.content ?? '',
          thinking: repairResponse.message?.thinking ?? '',
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

  async runStreamingTurn({
    model,
    messages,
    tools,
    useNativeTools,
    workspaceRoot = '',
    knownPaths = [],
    systemPrompt = '',
    runtimeOptions = {},
    signal,
    onChunk,
  }) {
    throwIfAborted(signal);
    const options = buildOllamaOptions(runtimeOptions);
    const emulation = useNativeTools
      ? null
      : buildEmulationPromptBundle(messages, tools, workspaceRoot, systemPrompt, knownPaths);
    const body = useNativeTools
      ? {
          model,
          stream: true,
          messages: withSystemPrompt(messages, systemPrompt),
          tools: tools.map(toOllamaTool),
          options,
        }
      : {
          model,
          stream: true,
          messages: [
            {
              role: 'system',
              content: emulation.systemPrompt,
            },
            ...emulation.messages.map(toOllamaMessage),
          ],
          options,
        };

    let response;

    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw normalizeOllamaError(error, this.baseUrl, 'streaming chat');
    }

    if (!response.ok || !response.body) {
      throw new Error(`Ollama streaming chat failed with status ${response.status}.`);
    }

    const streamed = await readStreamingResponse(response, { onChunk });

    if (useNativeTools) {
      return {
        provider: this.name,
        nativeTools: true,
        message: streamed.content,
        thinking: streamed.thinking,
        toolCalls: streamed.toolCalls,
        raw: streamed.lastEnvelope,
        chunks: streamed.chunks,
      };
    }

    const parsed = await parseEmulatedEnvelopeWithRepair({
      rawMessage: streamed.content,
      fallbackThinking: streamed.thinking,
      repair: async (parseFailure) => {
        const repairResponse = await this.#postJson(
          '/api/chat',
          {
            model,
            stream: false,
            messages: [
              {
                role: 'system',
                content: emulation.systemPrompt,
              },
              ...emulation.messages.map(toOllamaMessage),
              { role: 'assistant', content: streamed.content },
              { role: 'user', content: buildEnvelopeRepairPrompt(parseFailure) },
            ],
            options,
          },
          { signal }
        );

        return {
          message: repairResponse.message?.content ?? '',
          thinking: repairResponse.message?.thinking ?? streamed.thinking ?? '',
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
      raw: parsed.raw ?? streamed.lastEnvelope,
      chunks: streamed.chunks,
    };
  }

  async #postJson(endpoint, payload, { signal } = {}) {
    let response;

    try {
      response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      throw normalizeOllamaError(error, this.baseUrl, 'request');
    }

    if (!response.ok) {
      throw new Error(`Ollama request failed with status ${response.status}.`);
    }

    return response.json();
  }
}
