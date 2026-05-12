import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { AgentEnvelopeMode } from '../contracts.js';
import { requiresApprovalForTool } from '../permissions.js';
import { isAbortError, throwIfAborted } from '../abort.js';
import { resolveWorkspacePath } from '../path-guard.js';

const CONTEXT_COMPACTION_TRIGGER_MESSAGE_COUNT = 36;
const CONTEXT_COMPACTION_RECENT_MESSAGE_COUNT = 20;
const CONTEXT_COMPACTION_CHECKPOINT_LIMIT = 8;
const CONTEXT_COMPACTION_TOOL_LIMIT = 8;
const EXPLORATORY_TOOL_NAMES = new Set(['fs_list', 'search_text', 'web_search', 'web_fetch']);

function nowIso() {
  return new Date().toISOString();
}

function humanPath(value) {
  return value === '.' ? 'workspace root' : value;
}

function shortenInline(value, maxLength = 40) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }

  const head = Math.max(12, Math.floor((maxLength - 1) / 2));
  const tail = Math.max(8, maxLength - head - 1);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function summarizeToolResult(toolName, result) {
  if (result?.error) {
    return String(result.error);
  }

  if (result?.warning) {
    return String(result.warning);
  }

  switch (toolName) {
    case 'fs_list':
      return `Listed ${result?.entries?.length ?? 0} entries in ${humanPath(result?.path ?? '.')}${
        result?.truncated ? ' (truncated)' : ''
      }.`;
    case 'fs_read':
      return `${result?.extracted ? 'Extracted text from' : 'Read'} ${humanPath(
        result?.path ?? 'file'
      )}${
        Number.isInteger(result?.totalLines)
          ? ` (${result.startLine}-${result.endLine} of ${result.totalLines} lines)`
          : ''
      }${
        result?.extracted && result?.format
          ? ` [${String(result.format).toUpperCase()}${
              Number.isInteger(result?.metadata?.pages)
                ? `, ${result.metadata.pages} pages`
                : Number.isInteger(result?.metadata?.sheetCount)
                  ? `, ${result.metadata.sheetCount} sheets`
                  : Number.isInteger(result?.metadata?.slides)
                    ? `, ${result.metadata.slides} slides`
                    : ''
            }]`
          : ''
      }.`;
    case 'fs_write':
      return `${result?.created ? 'Created' : 'Updated'} ${humanPath(result?.path ?? 'file')} (${result?.bytesWritten ?? 0} bytes).`;
    case 'fs_patch':
      return `Patched ${humanPath(result?.path ?? 'file')} (${result?.replacements ?? 0} replacements).`;
    case 'fs_mkdir':
      return `Created directory ${humanPath(result?.path ?? '.')}.`;
    case 'fs_delete':
      return `Deleted ${result?.type ?? 'item'} ${humanPath(result?.path ?? '.')}.`;
    case 'search_text':
      return `Found ${result?.results?.length ?? 0} matches for "${shortenInline(
        result?.query ?? '',
        36
      )}" in ${humanPath(result?.path ?? '.')}${result?.truncated ? ' (truncated)' : ''}.`;
    case 'web_search':
      return `Found ${result?.results?.length ?? 0} web results for "${shortenInline(
        result?.query ?? '',
        36
      )}"${result?.site ? ` on ${result.site}` : ''}${result?.truncated ? ' (truncated)' : ''}.`;
    case 'web_fetch':
      return `Fetched ${result?.title ? `"${shortenInline(result.title, 52)}"` : 'web page'} from ${shortenInline(
        result?.url ?? '',
        52
      )}${result?.truncated ? ' (truncated)' : ''}.`;
    case 'run_command':
      return result?.timedOut
        ? `Command timed out${Number.isInteger(result?.exitCode) ? ` (exit ${result.exitCode})` : ''}.`
        : `Command finished with exit code ${result?.exitCode ?? 0}.`;
    default:
      break;
  }

  const raw = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return raw.length > 900 ? `${raw.slice(0, 900)}\n…` : raw;
}

function toolMessageContent(result) {
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

function summarizeToolCall(toolCall) {
  return `Requested tools: ${toolCall.map((item) => item.name).join(', ')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function toolCallSignature(toolCalls) {
  return stableStringify(
    toolCalls.map((call) => ({
      name: call.name,
      arguments: call.arguments ?? {},
    }))
  );
}

function isExploratoryToolBatch(toolCalls = []) {
  return toolCalls.length > 0 && toolCalls.every((call) => EXPLORATORY_TOOL_NAMES.has(call?.name));
}

function normalizeWorkspacePath(value) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');

  return normalized || '.';
}

function trackKnownPath(session, value) {
  if (!value) {
    return;
  }

  session.knownPaths ??= new Set(['.']);
  session.knownPaths.add(normalizeWorkspacePath(value));
}

function trackKnownPathsFromResult(session, toolName, result) {
  if (!result || typeof result !== 'object') {
    return;
  }

  if (result.path) {
    trackKnownPath(session, result.path);
  }

  if (toolName === 'fs_list' && Array.isArray(result.entries)) {
    for (const entry of result.entries) {
      trackKnownPath(session, entry?.path);
    }
  }

  if (toolName === 'search_text' && Array.isArray(result.results)) {
    for (const entry of result.results) {
      trackKnownPath(session, entry?.path);
    }
  }
}

function getNearbyKnownPaths(session, requestedPath) {
  const normalized = normalizeWorkspacePath(requestedPath);
  const prefix = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
  const candidates = [...(session.knownPaths ?? new Set(['.']))].filter((item) => item !== '.');

  const prioritized = prefix
    ? candidates.filter((item) => item.startsWith(`${prefix}/`) || item === prefix)
    : candidates;

  return prioritized.slice(0, 10);
}

function buildAttachmentInventoryMessage(session) {
  const attachments = Array.isArray(session.attachments) ? session.attachments : [];
  if (attachments.length === 0) {
    return null;
  }

  const lines = [
    'Thread attachments currently available inside the workspace. If the user refers to an earlier attached file, reuse one of these exact paths with fs_read.',
    'Files that were originally attached from outside the workspace have already been copied into the workspace paths below.',
    'The original absolute source location is not valid anymore. Do not use the old source location; use only the workspace paths listed below.',
  ];

  for (const attachment of attachments.slice(-16)) {
    const label = attachment.originalName || attachment.name || attachment.path;
    const mimeType = attachment.mimeType ? `, ${attachment.mimeType}` : '';
    const byteCount =
      Number.isFinite(Number(attachment.size)) && Number(attachment.size) > 0
        ? `, ${attachment.size} bytes`
        : '';
    lines.push(`- ${attachment.path} (${label}${mimeType}${byteCount})`);
  }

  lines.push('Do not invent a different path for these files.');
  return {
    role: 'system',
    content: lines.join('\n'),
  };
}

function pathExistsInsideWorkspace(workspaceRoot, requestedPath) {
  try {
    const absolutePath = resolveWorkspacePath(workspaceRoot, requestedPath);
    return fs.existsSync(absolutePath);
  } catch {
    return false;
  }
}

function matchesAttachmentAlias(session, requestedPath) {
  const normalized = normalizeWorkspacePath(requestedPath);
  const basename = path.posix.basename(normalized);
  const attachments = Array.isArray(session.attachments) ? session.attachments : [];

  return attachments.some((attachment) => {
    const aliases = [
      attachment?.path,
      attachment?.name,
      attachment?.originalName,
      attachment?.path ? path.posix.basename(normalizeWorkspacePath(attachment.path)) : '',
    ]
      .map(normalizeWorkspacePath)
      .filter(Boolean);

    return (
      aliases.includes(normalized) ||
      aliases.includes(basename) ||
      aliases.some((alias) => normalized.endsWith(`/${alias}`))
    );
  });
}

function buildCompactedConversationSummary(session, compactedMessages, recentMessages) {
  const visibleMessages = compactedMessages.filter(
    (message) => message.role !== 'tool' && !message.isToolTrace
  );
  const firstUserMessage = visibleMessages.find((message) => message.role === 'user');
  const recentCheckpoints = visibleMessages.slice(-CONTEXT_COMPACTION_CHECKPOINT_LIMIT);
  const cutoffCreatedAt = recentMessages[0]?.createdAt ?? null;
  const historicalToolEvents = session.toolEvents
    .filter((event) => {
      const marker = event.completedAt ?? event.createdAt ?? '';
      return cutoffCreatedAt ? marker < cutoffCreatedAt : true;
    })
    .slice(-CONTEXT_COMPACTION_TOOL_LIMIT);
  const lines = ['Compressed conversation memory from earlier in this thread.'];

  if (firstUserMessage?.content) {
    lines.push(`Original user goal: ${shortenInline(firstUserMessage.content, 240)}`);
  }

  if (recentCheckpoints.length > 0) {
    lines.push('Earlier conversation checkpoints:');

    for (const message of recentCheckpoints) {
      const label = message.role === 'user' ? 'User' : 'Agent';
      lines.push(`- ${label}: ${shortenInline(message.content, 220)}`);
    }
  }

  if (historicalToolEvents.length > 0) {
    lines.push('Earlier important tool outcomes:');

    for (const event of historicalToolEvents) {
      lines.push(
        `- ${event.toolName}: ${shortenInline(event.resultPreview ?? event.status, 220)}`
      );
    }
  }

  lines.push(
    'Use this summary as the older thread memory. Rely on the recent raw messages below for the latest details.'
  );

  return {
    role: 'system',
    content: lines.join('\n'),
  };
}

function buildContextMessages(session) {
  const sourceMessages = session.messages ?? [];
  const attachmentInventoryMessage = buildAttachmentInventoryMessage(session);

  if (sourceMessages.length <= CONTEXT_COMPACTION_TRIGGER_MESSAGE_COUNT) {
    session.contextCompression = null;
    return attachmentInventoryMessage
      ? [attachmentInventoryMessage, ...sourceMessages]
      : sourceMessages;
  }

  const cutoffIndex = Math.max(
    0,
    sourceMessages.length - CONTEXT_COMPACTION_RECENT_MESSAGE_COUNT
  );
  const compactedMessages = sourceMessages.slice(0, cutoffIndex);
  const recentMessages = sourceMessages.slice(cutoffIndex);

  if (compactedMessages.length === 0) {
    session.contextCompression = null;
    return sourceMessages;
  }

  const summaryMessage = buildCompactedConversationSummary(
    session,
    compactedMessages,
    recentMessages
  );

  session.contextCompression = {
    compressedMessageCount: compactedMessages.length,
    keptMessageCount: recentMessages.length,
    summary: summaryMessage.content,
    updatedAt: nowIso(),
  };

  return attachmentInventoryMessage
    ? [attachmentInventoryMessage, summaryMessage, ...recentMessages]
    : [summaryMessage, ...recentMessages];
}

export class AgentRuntime {
  constructor({ provider, maxIterations = 12 } = {}) {
    this.provider = provider;
    this.maxIterations = maxIterations;
  }

  async runUserTurn(session, content, { signal, onProgress } = {}) {
    if (session.pendingApproval) {
      throw new Error('Resolve the pending approval before sending another message.');
    }

    this.#resetLoopTracker(session);
    throwIfAborted(signal);
    session.messages.push({
      id: randomUUID(),
      role: 'user',
      content,
      createdAt: nowIso(),
    });
    this.#notifyProgress(session, onProgress, { phase: 'user_message' });

    return this.#driveLoop(session, signal, onProgress);
  }

  async resolvePendingApproval(session, approved, { signal, onProgress } = {}) {
    if (!session.pendingApproval) {
      throw new Error('There is no pending approval for this session.');
    }

    throwIfAborted(signal);
    const pending = session.pendingApproval;
    session.pendingApproval = null;
    this.#notifyProgress(session, onProgress, { phase: 'approval_resolved', eventId: pending.eventId });

    const event = session.toolEvents.find((item) => item.id === pending.eventId);
    const toolDefinition = session.toolRegistry.get(pending.call.name);

    if (!toolDefinition) {
      throw new Error(`Tool "${pending.call.name}" no longer exists.`);
    }

    try {
      if (!approved) {
        const denial = { denied: true, message: `User denied ${pending.call.name}.` };
        session.messages.push({
          id: randomUUID(),
          role: 'tool',
          toolName: pending.call.name,
          content: JSON.stringify(denial),
          createdAt: nowIso(),
        });

        if (event) {
          event.status = 'denied';
          event.completedAt = nowIso();
          event.resultPreview = denial.message;
        }
        this.#notifyProgress(session, onProgress, { phase: 'approval_denied', eventId: pending.eventId });

        return this.#processRemainingToolCalls(session, pending.remainingCalls, signal, onProgress);
      }

      await this.#executeToolCall(session, pending.call, toolDefinition, event, signal, onProgress);
      return this.#processRemainingToolCalls(session, pending.remainingCalls, signal, onProgress);
    } catch (error) {
      if (!isAbortError(error)) {
        throw error;
      }

      this.#clearLoopTracker(session);
      this.#recordCancellation(session);
      this.#notifyProgress(session, onProgress, { phase: 'cancelled' });
      return { status: 'cancelled', session };
    }
  }

  async #processRemainingToolCalls(session, remainingCalls, signal, onProgress) {
    const processed = await this.#processToolCalls(session, remainingCalls, signal, onProgress);
    if (processed.status === 'approval_required') {
      return { status: 'approval_required', session };
    }

    return this.#driveLoop(session, signal, onProgress);
  }

  async #driveLoop(session, signal, onProgress) {
    const tracker = this.#getLoopTracker(session);
    let previousSignature = tracker.previousSignature;
    let repeatedSignatureCount = tracker.repeatedSignatureCount;
    let countedIterations = tracker.countedIterations;

    try {
      while (countedIterations < this.maxIterations) {
        throwIfAborted(signal);
        const visibleTools = session.toolRegistry.listVisibleDefinitions(session.permissionPreset);
        const contextMessages = buildContextMessages(session);
        const capabilities = await this.provider.getCapabilities(
          session.model,
          session.capabilityOverride ?? {}
        );

        throwIfAborted(signal);
        session.capabilities = capabilities;

        const turn = await this.provider.runTurn({
          model: session.model,
          messages: contextMessages,
          tools: visibleTools,
          useNativeTools: capabilities.nativeTools,
          workspaceRoot: session.workspaceRoot,
          knownPaths: [...(session.knownPaths ?? new Set(['.']))],
          systemPrompt: session.modelSettings?.systemPrompt ?? '',
          runtimeOptions: {
            numCtx: session.modelSettings?.contextLength,
            temperature: session.modelSettings?.temperature,
          },
          signal,
        });

        throwIfAborted(signal);

        if (capabilities.nativeTools) {
          const assistantMessage = {
            id: randomUUID(),
            role: 'assistant',
            content: turn.message ?? '',
            displayContent:
              turn.toolCalls?.length > 0 ? summarizeToolCall(turn.toolCalls) : turn.message ?? '',
            thinking: turn.thinking ?? '',
            toolCalls: turn.toolCalls ?? [],
            isToolTrace: (turn.toolCalls?.length ?? 0) > 0,
            createdAt: nowIso(),
          };

          session.messages.push(assistantMessage);
          this.#notifyProgress(session, onProgress, { phase: 'assistant_tool_plan' });

          if (assistantMessage.toolCalls.length === 0) {
            this.#clearLoopTracker(session);
            this.#notifyProgress(session, onProgress, { phase: 'completed' });
            return { status: 'completed', session };
          }
          const exploratoryBatch = isExploratoryToolBatch(assistantMessage.toolCalls);

          const signature = toolCallSignature(assistantMessage.toolCalls);
          if (signature === previousSignature) {
            repeatedSignatureCount += 1;
          } else {
            previousSignature = signature;
            repeatedSignatureCount = 0;
          }
          this.#setLoopTracker(session, {
            previousSignature,
            repeatedSignatureCount,
            countedIterations,
          });

          if (repeatedSignatureCount >= 1) {
            this.#recordRepeatedToolWarning(session, assistantMessage.toolCalls);

            if (repeatedSignatureCount >= 2) {
              return this.#stopForRepeatedToolLoop(session);
            }

            continue;
          }

          const processed = await this.#processToolCalls(
            session,
            assistantMessage.toolCalls,
            signal,
            onProgress
          );
          if (processed.status === 'approval_required') {
            return { status: 'approval_required', session };
          }
          if (!exploratoryBatch) {
            countedIterations += 1;
            this.#setLoopTracker(session, {
              previousSignature,
              repeatedSignatureCount,
              countedIterations,
            });
          }

          continue;
        }

        if (turn.envelope.mode === AgentEnvelopeMode.TOOL) {
          session.messages.push({
            id: randomUUID(),
            role: 'assistant',
            content: turn.message,
            displayContent: summarizeToolCall(turn.envelope.calls),
            thinking: turn.thinking ?? '',
            isToolTrace: true,
            createdAt: nowIso(),
          });
          this.#notifyProgress(session, onProgress, { phase: 'assistant_tool_plan' });
          const exploratoryBatch = isExploratoryToolBatch(turn.envelope.calls);

          const signature = toolCallSignature(turn.envelope.calls);
          if (signature === previousSignature) {
            repeatedSignatureCount += 1;
          } else {
            previousSignature = signature;
            repeatedSignatureCount = 0;
          }
          this.#setLoopTracker(session, {
            previousSignature,
            repeatedSignatureCount,
            countedIterations,
          });

          if (repeatedSignatureCount >= 1) {
            this.#recordRepeatedToolWarning(session, turn.envelope.calls);

            if (repeatedSignatureCount >= 2) {
              return this.#stopForRepeatedToolLoop(session);
            }

            continue;
          }

          const processed = await this.#processToolCalls(
            session,
            turn.envelope.calls,
            signal,
            onProgress
          );
          if (processed.status === 'approval_required') {
            return { status: 'approval_required', session };
          }
          if (!exploratoryBatch) {
            countedIterations += 1;
            this.#setLoopTracker(session, {
              previousSignature,
              repeatedSignatureCount,
              countedIterations,
            });
          }

          continue;
        }

        session.messages.push({
          id: randomUUID(),
          role: 'assistant',
          content: turn.envelope.message,
          thinking: turn.thinking ?? '',
          createdAt: nowIso(),
        });

        this.#clearLoopTracker(session);
        this.#notifyProgress(session, onProgress, {
          phase: turn.envelope.mode === AgentEnvelopeMode.ERROR ? 'error' : 'completed',
        });
        return {
          status: turn.envelope.mode === AgentEnvelopeMode.ERROR ? 'error' : 'completed',
          session,
        };
      }

      return this.#synthesizeFinalAnswer(
        session,
        `The model used tools for ${this.maxIterations} turns without concluding. Provide the best final answer from the gathered evidence now.`,
        signal,
        onProgress
      );
    } catch (error) {
      if (!isAbortError(error)) {
        throw error;
      }

      this.#clearLoopTracker(session);
      this.#recordCancellation(session);
      this.#notifyProgress(session, onProgress, { phase: 'cancelled' });
      return { status: 'cancelled', session };
    }
  }

  #getLoopTracker(session) {
    session.loopTracker ??= {
      previousSignature: null,
      repeatedSignatureCount: 0,
      countedIterations: 0,
    };
    return session.loopTracker;
  }

  #setLoopTracker(session, tracker) {
    session.loopTracker = {
      previousSignature: tracker.previousSignature ?? null,
      repeatedSignatureCount: tracker.repeatedSignatureCount ?? 0,
      countedIterations: tracker.countedIterations ?? 0,
    };
  }

  #resetLoopTracker(session) {
    this.#setLoopTracker(session, {
      previousSignature: null,
      repeatedSignatureCount: 0,
      countedIterations: 0,
    });
  }

  #clearLoopTracker(session) {
    delete session.loopTracker;
  }

  #notifyProgress(session, onProgress, meta = {}) {
    if (typeof onProgress !== 'function') {
      return;
    }

    try {
      onProgress({
        session,
        ...meta,
      });
    } catch {
      // Ignore progress notification failures so the runtime can continue.
    }
  }

  #recordRepeatedToolWarning(session, toolCalls) {
    const warning =
      'This exact tool request was already executed. Reuse prior tool results or choose a different tool/path instead of repeating the same call.';

    for (const call of toolCalls) {
      session.toolEvents.push({
        id: randomUUID(),
        toolName: call.name,
        arguments: call.arguments,
        status: 'skipped',
        createdAt: nowIso(),
        completedAt: nowIso(),
        source: session.toolRegistry.get(call.name)?.source ?? 'runtime',
        resultPreview: warning,
        result: { warning },
      });

      session.messages.push({
        id: randomUUID(),
        role: 'tool',
        toolName: call.name,
        content: JSON.stringify({
          warning,
          repeated: true,
        }),
        createdAt: nowIso(),
      });
    }
  }

  #stopForRepeatedToolLoop(session) {
    this.#clearLoopTracker(session);
    session.messages.push({
      id: randomUUID(),
      role: 'assistant',
      content:
        'Stopped because the model kept repeating the same tool request. Try a more specific prompt or switch to a stronger model for repository analysis.',
      createdAt: nowIso(),
    });

    return { status: 'error', session };
  }

  async #synthesizeFinalAnswer(session, reason, signal, onProgress) {
    throwIfAborted(signal);
    const capabilities =
      session.capabilities ??
      (await this.provider.getCapabilities(session.model, session.capabilityOverride ?? {}));
    const recentResults = session.toolEvents
      .slice(-6)
      .map((event) => `- ${event.toolName}: ${event.resultPreview ?? event.status}`)
      .join('\n');
    const synthesisPrompt = [
      reason,
      'Do not call any more tools.',
      'Use only the tool results already gathered in this thread.',
      recentResults ? `Recent tool results:\n${recentResults}` : '',
      'Reply with your best final answer now. If evidence is partial, say what is still uncertain.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const turn = await this.provider.runTurn({
      model: session.model,
      messages: [...buildContextMessages(session), { role: 'user', content: synthesisPrompt }],
      tools: [],
      useNativeTools: capabilities.nativeTools,
      workspaceRoot: session.workspaceRoot,
      knownPaths: [...(session.knownPaths ?? new Set(['.']))],
      systemPrompt: session.modelSettings?.systemPrompt ?? '',
      runtimeOptions: {
        numCtx: session.modelSettings?.contextLength,
        temperature: session.modelSettings?.temperature,
      },
      signal,
    });

    if (capabilities.nativeTools) {
      if (turn.toolCalls?.length) {
        return this.#recordSynthesisFallback(session);
      }

      session.messages.push({
        id: randomUUID(),
        role: 'assistant',
        content: String(turn.message ?? '').trim() || this.#buildFallbackSummary(session),
        thinking: turn.thinking ?? '',
        createdAt: nowIso(),
      });
      this.#clearLoopTracker(session);
      this.#notifyProgress(session, onProgress, { phase: 'completed' });
      return { status: 'completed', session };
    }

    if (turn.envelope.mode === AgentEnvelopeMode.TOOL) {
      return this.#recordSynthesisFallback(session);
    }

    session.messages.push({
      id: randomUUID(),
      role: 'assistant',
      content:
        String(turn.envelope.message ?? '').trim() || this.#buildFallbackSummary(session),
      thinking: turn.thinking ?? '',
      createdAt: nowIso(),
    });

    this.#clearLoopTracker(session);
    this.#notifyProgress(session, onProgress, {
      phase: turn.envelope.mode === AgentEnvelopeMode.ERROR ? 'error' : 'completed',
    });
    return { status: turn.envelope.mode === AgentEnvelopeMode.ERROR ? 'error' : 'completed', session };
  }

  #recordSynthesisFallback(session) {
    this.#clearLoopTracker(session);
    session.messages.push({
      id: randomUUID(),
      role: 'assistant',
      content: this.#buildFallbackSummary(session),
      createdAt: nowIso(),
    });

    return { status: 'completed', session };
  }

  #buildFallbackSummary(session) {
    const recentResults = session.toolEvents
      .slice(-6)
      .map((event) => `${event.toolName}: ${event.resultPreview ?? event.status}`);

    if (recentResults.length === 0) {
      return 'Tool loop durduruldu. Model bir sonuca baglanamadi; daha spesifik bir istek veya daha guclu bir modelle devam etmek daha saglikli olur.';
    }

    return [
      'Tool dongusu sonuca baglanmadigi icin eldeki bulgularla burada durdum.',
      'Son toplanan ipuclari:',
      ...recentResults.map((line) => `- ${line}`),
    ].join('\n');
  }

  async #processToolCalls(session, toolCalls, signal, onProgress) {
    for (let index = 0; index < toolCalls.length; index += 1) {
      throwIfAborted(signal);
      const call = toolCalls[index];
      const toolDefinition = session.toolRegistry.get(call.name);
      const event = {
        id: randomUUID(),
        toolName: call.name,
        arguments: call.arguments,
        status: 'queued',
        createdAt: nowIso(),
        source: toolDefinition?.source ?? 'unknown',
      };

      session.toolEvents.push(event);
      this.#notifyProgress(session, onProgress, {
        phase: 'tool_queued',
        eventId: event.id,
      });

      if (!toolDefinition) {
        const result = { error: `Unknown tool "${call.name}".` };
        session.messages.push({
          id: randomUUID(),
          role: 'tool',
          toolName: call.name,
          content: JSON.stringify(result),
          createdAt: nowIso(),
        });

        event.status = 'failed';
        event.completedAt = nowIso();
        event.resultPreview = result.error;
        this.#notifyProgress(session, onProgress, {
          phase: 'tool_failed',
          eventId: event.id,
        });
        continue;
      }

      if (requiresApprovalForTool(session.permissionPreset, toolDefinition)) {
        event.status = 'pending_approval';
        session.pendingApproval = {
          call,
          eventId: event.id,
          remainingCalls: toolCalls.slice(index + 1),
        };
        this.#notifyProgress(session, onProgress, {
          phase: 'approval_required',
          eventId: event.id,
        });
        return { status: 'approval_required' };
      }

      if (this.#shouldBlockUndiscoveredPath(session, call)) {
        const warning = this.#buildUndiscoveredPathWarning(session, call);

        session.messages.push({
          id: randomUUID(),
          role: 'tool',
          toolName: call.name,
          content: JSON.stringify({
            warning,
            blocked: true,
            path: call.arguments?.path ?? '',
          }),
          createdAt: nowIso(),
        });

        event.status = 'blocked';
        event.completedAt = nowIso();
        event.resultPreview = warning;
        event.result = {
          warning,
          blocked: true,
          path: call.arguments?.path ?? '',
        };
        this.#notifyProgress(session, onProgress, {
          phase: 'tool_blocked',
          eventId: event.id,
        });
        continue;
      }

      await this.#executeToolCall(session, call, toolDefinition, event, signal, onProgress);
    }

    return { status: 'completed' };
  }

  async #executeToolCall(session, call, toolDefinition, event, signal, onProgress) {
    event.status = 'running';
    event.startedAt = nowIso();
    this.#notifyProgress(session, onProgress, {
      phase: 'tool_running',
      eventId: event.id,
    });

    try {
      const result = await session.toolRegistry.execute(call.name, call.arguments, {
        workspaceRoot: session.workspaceRoot,
        permissionPreset: session.permissionPreset,
        sessionId: session.id,
        attachments: session.attachments ?? [],
        signal,
      });

      session.messages.push({
        id: randomUUID(),
        role: 'tool',
        toolName: call.name,
        content: toolMessageContent(result),
        createdAt: nowIso(),
      });

      event.status = 'completed';
      event.completedAt = nowIso();
      event.resultPreview = summarizeToolResult(call.name, result);
      event.diffText = result?.diff ?? result?.diffText ?? '';
      event.result = result;
      trackKnownPathsFromResult(session, call.name, result);
      this.#notifyProgress(session, onProgress, {
        phase: 'tool_completed',
        eventId: event.id,
      });
    } catch (error) {
      if (isAbortError(error)) {
        const result = {
          cancelled: true,
          message: 'Request stopped by user.',
        };

        session.messages.push({
          id: randomUUID(),
          role: 'tool',
          toolName: call.name,
          content: JSON.stringify(result),
          createdAt: nowIso(),
        });

        event.status = 'cancelled';
        event.completedAt = nowIso();
        event.resultPreview = result.message;
        event.result = result;
        this.#notifyProgress(session, onProgress, {
          phase: 'tool_cancelled',
          eventId: event.id,
        });
        throw error;
      }

      const failureMessage = error instanceof Error ? error.message : String(error);
      const result = { error: failureMessage };

      session.messages.push({
        id: randomUUID(),
        role: 'tool',
        toolName: call.name,
        content: JSON.stringify(result),
        createdAt: nowIso(),
      });

      event.status = 'failed';
      event.completedAt = nowIso();
      event.resultPreview = failureMessage;
      event.result = result;
      this.#notifyProgress(session, onProgress, {
        phase: 'tool_failed',
        eventId: event.id,
      });
    }
  }

  #recordCancellation(session) {
    session.messages.push({
      id: randomUUID(),
      role: 'assistant',
      content: 'İstek durduruldu.',
      createdAt: nowIso(),
    });
  }

  #shouldBlockUndiscoveredPath(session, call) {
    if (session.capabilities?.nativeTools) {
      return false;
    }

    if (!['fs_read', 'fs_patch', 'fs_delete'].includes(call.name)) {
      return false;
    }

    const requestedPath = call.arguments?.path;
    if (!requestedPath || typeof requestedPath !== 'string') {
      return false;
    }

    const normalizedPath = normalizeWorkspacePath(requestedPath);
    if (
      call.name === 'fs_read' &&
      (pathExistsInsideWorkspace(session.workspaceRoot, normalizedPath) ||
        matchesAttachmentAlias(session, normalizedPath))
    ) {
      return false;
    }

    return !(session.knownPaths ?? new Set(['.'])).has(normalizedPath);
  }

  #buildUndiscoveredPathWarning(session, call) {
    const requestedPath = normalizeWorkspacePath(call.arguments?.path ?? '');
    const nearbyPaths = getNearbyKnownPaths(session, requestedPath);
    const nearbyText =
      nearbyPaths.length > 0 ? ` Known paths nearby: ${nearbyPaths.join(', ')}.` : '';

    return `Path "${requestedPath}" has not been discovered in this thread yet.${nearbyText} Use fs_list or search_text first, then read one of the returned paths exactly.`;
  }
}
