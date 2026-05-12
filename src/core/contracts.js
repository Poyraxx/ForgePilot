export const ProviderName = Object.freeze({
  OLLAMA: 'ollama',
  OPENAI: 'openai',
  OPENAI_COMPATIBLE: 'openai_compatible',
  ANTHROPIC: 'anthropic',
});

export const PermissionPreset = Object.freeze({
  READ_ONLY: 'read_only',
  ASK: 'ask',
  FULL_ACCESS: 'full_access',
});

export const RiskLevel = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

export const AgentEnvelopeMode = Object.freeze({
  TOOL: 'tool',
  FINAL: 'final',
  ERROR: 'error',
});

export function createToolDefinition(definition) {
  if (!definition?.name) {
    throw new Error('Tool definition requires a name.');
  }

  if (!definition.description) {
    throw new Error(`Tool "${definition.name}" requires a description.`);
  }

  if (typeof definition.handler !== 'function') {
    throw new Error(`Tool "${definition.name}" requires a handler function.`);
  }

  return Object.freeze({
    riskLevel: RiskLevel.LOW,
    inputSchema: {
      type: 'object',
      properties: {},
    },
    mutatesWorkspace: false,
    requiresApproval: false,
    source: 'builtin',
    ...definition,
  });
}

export function stripExecutableFields(toolDefinition) {
  const { handler, ...rest } = toolDefinition;
  return rest;
}

export function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

export function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
