import { AgentEnvelopeMode, ensureObject } from './contracts.js';

const ENVELOPE_TAG = 'agent-response';
const ENVELOPE_PATTERN = new RegExp(`<${ENVELOPE_TAG}>([\\s\\S]*?)<\\/${ENVELOPE_TAG}>`, 'i');

function extractLeadingJsonValue(rawPayload) {
  const payload = String(rawPayload ?? '').trim();
  if (!payload) {
    throw new Error('Envelope payload is empty.');
  }

  const opening = payload[0];
  const closing = opening === '{' ? '}' : opening === '[' ? ']' : '';

  if (!closing) {
    return payload;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < payload.length; index += 1) {
    const character = payload[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === '\\') {
        escaped = true;
        continue;
      }

      if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === opening) {
      depth += 1;
      continue;
    }

    if (character === closing) {
      depth -= 1;

      if (depth === 0) {
        return payload.slice(0, index + 1);
      }
    }
  }

  return payload;
}

function parseEnvelopePayload(payload) {
  try {
    return {
      parsed: JSON.parse(payload),
      payload,
    };
  } catch (error) {
    const trimmedPayload = String(payload ?? '').trim();
    const salvagedPayload = extractLeadingJsonValue(trimmedPayload);

    if (salvagedPayload === trimmedPayload) {
      throw error;
    }

    return {
      parsed: JSON.parse(salvagedPayload),
      payload: salvagedPayload,
    };
  }
}

function normalizeToolCall(call, index) {
  ensureObject(call, `calls[${index}]`);

  if (!call.name || typeof call.name !== 'string') {
    throw new Error(`calls[${index}].name must be a string.`);
  }

  const argumentsValue = call.arguments ?? {};

  if (
    !argumentsValue ||
    typeof argumentsValue !== 'object' ||
    Array.isArray(argumentsValue)
  ) {
    throw new Error(`calls[${index}].arguments must be an object.`);
  }

  return {
    id: call.id ?? `call_${index + 1}`,
    name: call.name,
    arguments: argumentsValue,
  };
}

export function extractEnvelopePayload(rawResponse) {
  const trimmed = String(rawResponse ?? '').trim();
  const match = trimmed.match(ENVELOPE_PATTERN);

  if (match) {
    return match[1].trim();
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  throw new Error(`Response must contain a single <${ENVELOPE_TAG}>...</${ENVELOPE_TAG}> block.`);
}

export function parseAgentEnvelope(rawResponse) {
  try {
    const extractedPayload = extractEnvelopePayload(rawResponse);
    const { parsed, payload } = parseEnvelopePayload(extractedPayload);
    ensureObject(parsed, 'envelope');

    if (parsed.mode === AgentEnvelopeMode.TOOL) {
      if (!Array.isArray(parsed.calls) || parsed.calls.length === 0) {
        throw new Error('Tool envelopes must contain a non-empty calls array.');
      }

      return {
        ok: true,
        envelope: {
          mode: AgentEnvelopeMode.TOOL,
          calls: parsed.calls.map(normalizeToolCall),
        },
        payload,
      };
    }

    if (parsed.mode === AgentEnvelopeMode.FINAL || parsed.mode === AgentEnvelopeMode.ERROR) {
      const message = String(parsed.message ?? '').trim();

      if (!message) {
        throw new Error(`Envelope mode "${parsed.mode}" requires a non-empty message.`);
      }

      return {
        ok: true,
        envelope: {
          mode: parsed.mode,
          message,
        },
        payload,
      };
    }

    throw new Error(`Unsupported envelope mode "${parsed.mode}".`);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      rawResponse: String(rawResponse ?? ''),
    };
  }
}

export function buildEnvelopeRepairMessage(parseFailure) {
  return [
    'Your previous response did not follow the required protocol.',
    'Return exactly one <agent-response>...</agent-response> block containing valid JSON.',
    'Valid final example:',
    '<agent-response>{"mode":"final","message":"done"}</agent-response>',
    'Valid tool example:',
    '<agent-response>{"mode":"tool","calls":[{"name":"fs_read","arguments":{"path":"README.md"}}]}</agent-response>',
    `Parser error: ${parseFailure.error}`,
    `Previous response: ${parseFailure.rawResponse}`,
  ].join('\n');
}
