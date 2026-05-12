import { createToolDefinition, RiskLevel, stripExecutableFields } from '../contracts.js';
import { callMcpServerTool, createMcpServerId, discoverMcpServer } from './stdio.js';

function sanitizeToolNamespace(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'server';
}

function normalizeInputSchema(inputSchema) {
  return inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)
    ? inputSchema
    : {
        type: 'object',
        additionalProperties: true,
      };
}

function inferToolSafety(tool) {
  const annotations = tool?.annotations ?? {};
  const readOnlyHint = annotations.readOnlyHint === true;
  const destructiveHint = annotations.destructiveHint === true;
  const openWorldHint = annotations.openWorldHint === true;

  if (readOnlyHint) {
    return {
      mutatesWorkspace: false,
      requiresApproval: false,
      riskLevel: openWorldHint ? RiskLevel.MEDIUM : RiskLevel.LOW,
    };
  }

  return {
    mutatesWorkspace: true,
    requiresApproval: true,
    riskLevel: destructiveHint ? RiskLevel.HIGH : RiskLevel.MEDIUM,
  };
}

function createMcpToolDefinition(serverConfig, discoveredTool) {
  const serverNamespace = sanitizeToolNamespace(serverConfig.id || serverConfig.name);
  const resolvedName = `mcp.${serverNamespace}.${discoveredTool.name}`;
  const safety = inferToolSafety(discoveredTool);

  return createToolDefinition({
    name: resolvedName,
    description: `[MCP: ${serverConfig.name}] ${discoveredTool.description || discoveredTool.title || discoveredTool.name}`,
    inputSchema: normalizeInputSchema(discoveredTool.inputSchema),
    source: `mcp:${serverConfig.name}`,
    mutatesWorkspace: safety.mutatesWorkspace,
    requiresApproval: safety.requiresApproval,
    riskLevel: safety.riskLevel,
    async handler(context, args) {
      return callMcpServerTool(serverConfig, discoveredTool.name, args, {
        signal: context.signal,
      });
    },
  });
}

export class McpRegistry {
  constructor() {
    this.servers = [];
    this.tools = [];
  }

  async loadFromConfigs(configs = []) {
    this.servers = [];
    this.tools = [];

    for (const config of configs) {
      if (!config?.command) {
        continue;
      }

      const normalizedConfig = {
        ...config,
        id: config.id || createMcpServerId(config.name || config.command),
      };

      if (!normalizedConfig.enabled) {
        this.servers.push({
          id: normalizedConfig.id,
          name: normalizedConfig.name,
          command: normalizedConfig.command,
          args: normalizedConfig.args,
          cwd: normalizedConfig.cwd,
          env: normalizedConfig.env,
          enabled: false,
          status: 'disabled',
          error: null,
          protocolVersion: null,
          serverInfo: null,
          instructions: '',
          tools: [],
          toolCount: 0,
        });
        continue;
      }

      try {
        const discovery = await discoverMcpServer(normalizedConfig);
        const serverTools = Array.isArray(discovery.tools) ? discovery.tools : [];
        const toolDefinitions = serverTools.map((tool) =>
          createMcpToolDefinition(normalizedConfig, tool)
        );

        this.servers.push({
          id: normalizedConfig.id,
          name: normalizedConfig.name,
          command: normalizedConfig.command,
          args: normalizedConfig.args,
          cwd: normalizedConfig.cwd,
          env: normalizedConfig.env,
          enabled: true,
          status: 'connected',
          error: null,
          protocolVersion: discovery.protocolVersion,
          serverInfo: discovery.serverInfo ?? null,
          instructions: discovery.instructions ?? '',
          tools: toolDefinitions.map((tool) => stripExecutableFields(tool)),
          toolCount: toolDefinitions.length,
        });
        this.tools.push(...toolDefinitions);
      } catch (error) {
        this.servers.push({
          id: normalizedConfig.id,
          name: normalizedConfig.name,
          command: normalizedConfig.command,
          args: normalizedConfig.args,
          cwd: normalizedConfig.cwd,
          env: normalizedConfig.env,
          enabled: true,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          protocolVersion: null,
          serverInfo: null,
          instructions: '',
          tools: [],
          toolCount: 0,
        });
      }
    }

    return this.servers;
  }

  getServers() {
    return this.servers.map((server) => ({
      ...server,
      tools: server.tools.map((tool) => stripExecutableFields(tool)),
    }));
  }

  getTools() {
    return [...this.tools];
  }
}
