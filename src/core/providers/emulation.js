import { AgentEnvelopeMode } from '../contracts.js';
import { buildEnvelopeRepairMessage, parseAgentEnvelope } from '../envelope.js';

export function buildEmulationSystemPrompt(tools, workspaceRoot, knownPaths = []) {
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
    'If you need current public web information, use web_search first and then web_fetch one of the returned URLs.',
    'Do not repeat the same exploratory tool call if the previous result already gave enough context.',
    'If a tool reports that a path was not found, choose a different path from prior tool output instead of guessing.',
    normalizedKnownPaths.length > 0
      ? `Known paths already discovered in this thread:\n${normalizedKnownPaths.join('\n')}`
      : 'Known paths already discovered in this thread:\n.',
    `Available tools:\n${JSON.stringify(toolCatalog, null, 2)}`,
  ].join('\n');
}

export function toPlainTextFinalEnvelope(rawMessage = '') {
  const message = String(rawMessage ?? '').trim();

  if (!message) {
    return null;
  }

  if (/<agent-response[\s>]/i.test(message)) {
    return null;
  }

  if (
    (message.startsWith('{') && message.endsWith('}')) ||
    (message.startsWith('[') && message.endsWith(']'))
  ) {
    return null;
  }

  return {
    mode: AgentEnvelopeMode.FINAL,
    message,
  };
}

export function buildEmulationPromptBundle(
  messages,
  tools,
  workspaceRoot,
  systemPrompt = '',
  knownPaths = []
) {
  const sections = [];
  const normalizedPrompt = String(systemPrompt ?? '').trim();

  if (normalizedPrompt) {
    sections.push(`Additional agent behavior instructions:\n${normalizedPrompt}`);
  }

  sections.push(buildEmulationSystemPrompt(tools, workspaceRoot, knownPaths));

  return {
    systemPrompt: sections.join('\n\n'),
    messages,
  };
}

export async function parseEmulatedEnvelopeWithRepair({
  rawMessage,
  repair,
  fallbackThinking = '',
}) {
  let parsedEnvelope = parseAgentEnvelope(rawMessage);

  if (!parsedEnvelope.ok) {
    const repaired = await repair?.(parsedEnvelope);

    if (repaired) {
      parsedEnvelope = parseAgentEnvelope(repaired.message ?? '');

      if (!parsedEnvelope.ok) {
        const plainTextFallback =
          toPlainTextFinalEnvelope(repaired.message ?? '') ?? toPlainTextFinalEnvelope(rawMessage);

        if (plainTextFallback) {
          return {
            envelope: plainTextFallback,
            message: repaired.message ?? rawMessage,
            thinking: repaired.thinking ?? fallbackThinking,
            raw: repaired.raw,
          };
        }

        return {
          envelope: {
            mode: AgentEnvelopeMode.ERROR,
            message: `Protocol parse failure: ${parsedEnvelope.error}`,
          },
          message: rawMessage,
          thinking: repaired.thinking ?? fallbackThinking,
          raw: repaired.raw,
        };
      }

      return {
        envelope: parsedEnvelope.envelope,
        message: repaired.message ?? rawMessage,
        thinking: repaired.thinking ?? fallbackThinking,
        raw: repaired.raw,
      };
    }

    const plainTextFallback = toPlainTextFinalEnvelope(rawMessage);
    if (plainTextFallback) {
      return {
        envelope: plainTextFallback,
        message: rawMessage,
        thinking: fallbackThinking,
        raw: null,
      };
    }

    return {
      envelope: {
        mode: AgentEnvelopeMode.ERROR,
        message: `Protocol parse failure: ${parsedEnvelope.error}`,
      },
      message: rawMessage,
      thinking: fallbackThinking,
      raw: null,
    };
  }

  return {
    envelope: parsedEnvelope.envelope,
    message: rawMessage,
    thinking: fallbackThinking,
    raw: null,
  };
}

export function buildEnvelopeRepairPrompt(parsedEnvelope) {
  return buildEnvelopeRepairMessage(parsedEnvelope);
}
