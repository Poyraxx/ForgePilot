import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { bindAbortSignal, createAbortError, isAbortError, throwIfAborted } from '../abort.js';

const MCP_PROTOCOL_VERSION = '2025-11-25';
const CLIENT_INFO = {
  name: 'ForgePilot',
  version: '0.1.0',
};

function resolveCommand(command, cwd) {
  const rawCommand = String(command ?? '').trim();
  if (!rawCommand) {
    throw new Error('MCP server command is required.');
  }

  if (path.isAbsolute(rawCommand)) {
    return rawCommand;
  }

  if (rawCommand.startsWith('.') || rawCommand.includes('/') || rawCommand.includes('\\')) {
    return path.resolve(cwd, rawCommand);
  }

  return rawCommand;
}

function normalizeEnv(env = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(env)
      .filter(([key, value]) => String(key).trim())
      .map(([key, value]) => [String(key), String(value ?? '')])
  );
}

function normalizeArgs(args = []) {
  if (!Array.isArray(args)) {
    return [];
  }

  return args.map((item) => String(item));
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function extractTextContent(content = []) {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

function normalizeCallResult(serverName, toolName, result) {
  const text = extractTextContent(result?.content);
  const summary =
    text ||
    (isObject(result?.structuredContent)
      ? JSON.stringify(result.structuredContent)
      : `${serverName}.${toolName} completed.`);

  return {
    server: serverName,
    tool: toolName,
    text,
    summary,
    structuredContent: isObject(result?.structuredContent) ? result.structuredContent : null,
    content: Array.isArray(result?.content) ? result.content : [],
    isError: Boolean(result?.isError),
  };
}

class McpProcessClient {
  constructor(config) {
    this.config = config;
    this.cwd = config.cwd ? path.resolve(config.cwd) : process.cwd();
    this.command = resolveCommand(config.command, this.cwd);
    this.args = normalizeArgs(config.args);
    this.env = {
      ...process.env,
      ...normalizeEnv(config.env),
    };
    this.process = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.stderr = '';
  }

  async connect(signal) {
    throwIfAborted(signal, 'MCP connection stopped by user.');
    this.process = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout.setEncoding('utf8');
    this.process.stderr.setEncoding('utf8');

    this.process.stdout.on('data', (chunk) => {
      this.#handleStdout(chunk);
    });
    this.process.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
    });
    this.process.on('error', (error) => {
      this.#closeWithError(error);
    });
    this.process.on('close', (code) => {
      if (this.closed) {
        return;
      }

      const reason =
        code === 0
          ? new Error('MCP server closed unexpectedly.')
          : new Error(this.stderr.trim() || `MCP server exited with code ${code}.`);
      this.#closeWithError(reason);
    });

    const initializeResult = await this.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      { signal }
    );

    this.notify('notifications/initialized');
    return initializeResult;
  }

  async listTools(signal) {
    const tools = [];
    let cursor;

    do {
      const result = await this.request(
        'tools/list',
        cursor ? { cursor } : undefined,
        { signal }
      );
      tools.push(...(Array.isArray(result?.tools) ? result.tools : []));
      cursor = result?.nextCursor;
    } while (cursor);

    return tools;
  }

  async callTool(name, args, signal) {
    const result = await this.request(
      'tools/call',
      {
        name,
        arguments: isObject(args) ? args : {},
      },
      { signal }
    );

    const normalized = normalizeCallResult(this.config.name, name, result);

    if (normalized.isError) {
      throw new Error(normalized.text || normalized.summary || `${name} failed.`);
    }

    return normalized;
  }

  async request(method, params, { signal } = {}) {
    throwIfAborted(signal, 'MCP request stopped by user.');

    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
    };

    if (params !== undefined) {
      payload.params = params;
    }

    const raw = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const disposeAbort = bindAbortSignal(signal, () => {
        this.pending.delete(id);
        reject(createAbortError('MCP request stopped by user.'));
      });

      this.pending.set(id, {
        resolve: (value) => {
          disposeAbort();
          resolve(value);
        },
        reject: (error) => {
          disposeAbort();
          reject(error);
        },
      });

      this.process.stdin.write(`${raw}\n`, (error) => {
        if (!error) {
          return;
        }

        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }

        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  notify(method, params) {
    if (!this.process?.stdin || this.closed) {
      return;
    }

    const payload = {
      jsonrpc: '2.0',
      method,
    };

    if (params !== undefined) {
      payload.params = params;
    }

    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async close() {
    if (this.closed) {
      return;
    }

    this.closed = true;

    if (this.process && !this.process.killed) {
      this.process.kill();
    }

    for (const pending of this.pending.values()) {
      pending.reject(new Error('MCP server connection closed.'));
    }
    this.pending.clear();
  }

  #handleStdout(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        const pending = this.pending.get(message.id);
        if (!pending) {
          continue;
        }

        this.pending.delete(message.id);

        if (message.error) {
          pending.reject(
            new Error(message.error.message || `MCP request failed with code ${message.error.code}.`)
          );
          continue;
        }

        pending.resolve(message.result ?? {});
      }
    }
  }

  #closeWithError(error) {
    if (this.closed) {
      return;
    }

    this.closed = true;

    const normalizedError = isAbortError(error)
      ? error
      : error instanceof Error
        ? error
        : new Error(String(error));

    for (const pending of this.pending.values()) {
      pending.reject(normalizedError);
    }
    this.pending.clear();
  }
}

async function withMcpClient(config, operation, signal) {
  const client = new McpProcessClient(config);

  try {
    const initializeResult = await client.connect(signal);
    const result = await operation(client, initializeResult);
    await client.close();
    return result;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

export async function discoverMcpServer(config, { signal } = {}) {
  return withMcpClient(
    config,
    async (client, initializeResult) => {
      const tools = await client.listTools(signal);
      return {
        protocolVersion: initializeResult?.protocolVersion ?? MCP_PROTOCOL_VERSION,
        serverInfo: initializeResult?.serverInfo ?? {
          name: config.name,
          version: 'unknown',
        },
        instructions: String(initializeResult?.instructions ?? '').trim(),
        capabilities: initializeResult?.capabilities ?? {},
        tools,
      };
    },
    signal
  );
}

export async function callMcpServerTool(config, toolName, args, { signal } = {}) {
  return withMcpClient(
    config,
    async (client) => client.callTool(toolName, args, signal),
    signal
  );
}

export function createMcpServerId(name = 'server') {
  return `mcp-${String(name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || randomUUID()}`;
}
