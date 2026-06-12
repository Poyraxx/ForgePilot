import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { AgentEnvelopeMode, AgentMode } from '../contracts.js';
import { requiresApprovalForTool } from '../permissions.js';
import { isAbortError, throwIfAborted } from '../abort.js';
import { resolveWorkspacePath } from '../path-guard.js';

const CONTEXT_COMPACTION_TRIGGER_MESSAGE_COUNT = 36;
const CONTEXT_COMPACTION_RECENT_MESSAGE_COUNT = 20;
const CONTEXT_COMPACTION_CHECKPOINT_LIMIT = 8;
const CONTEXT_COMPACTION_TOOL_LIMIT = 8;
const EXPLORATORY_TOOL_NAMES = new Set([
  'fs_list',
  'search_text',
  'web_search',
  'web_fetch',
  'browser_fetch',
]);
const PLAN_MODE_BLOCKED_TOOL_NAMES = new Set([
  'fs_write',
  'fs_patch',
  'fs_mkdir',
  'fs_delete',
  'run_command',
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeAgentMode(value) {
  return Object.values(AgentMode).includes(value) ? value : AgentMode.BUILD;
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
      {
        const metadataDetails = [];
        if (Number.isInteger(result?.metadata?.pages)) {
          metadataDetails.push(`${result.metadata.pages} pages`);
        } else if (Number.isInteger(result?.metadata?.sheetCount)) {
          metadataDetails.push(`${result.metadata.sheetCount} sheets`);
        } else if (Number.isInteger(result?.metadata?.slides)) {
          metadataDetails.push(`${result.metadata.slides} slides`);
        }

        const headingPreview = Array.isArray(result?.metadata?.headings)
          ? result.metadata.headings.slice(0, 3).join(' | ')
          : Array.isArray(result?.metadata?.slideTitles)
            ? result.metadata.slideTitles.slice(0, 3).join(' | ')
            : '';

      return `${result?.extracted ? 'Extracted text from' : 'Read'} ${humanPath(
        result?.path ?? 'file'
      )}${
        Number.isInteger(result?.totalLines)
          ? ` (${result.startLine}-${result.endLine} of ${result.totalLines} lines)`
          : ''
      }${
        result?.extracted && result?.format
          ? ` [${String(result.format).toUpperCase()}${
              metadataDetails.length > 0 ? `, ${metadataDetails.join(', ')}` : ''
            }]`
          : ''
      }${headingPreview ? ` ${headingPreview}` : ''}.`;
      }
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
    case 'browser_fetch':
      return `Browser-fetched ${
        result?.title ? `"${shortenInline(result.title, 52)}"` : 'web page'
      } from ${shortenInline(result?.url ?? '', 52)}${
        result?.truncated ? ' (truncated)' : ''
      }${result?.screenshotPath ? ' with screenshot' : ''}.`;
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

function getAgentModePrompt(mode) {
  switch (normalizeAgentMode(mode)) {
    case AgentMode.PLAN:
      return [
        'Agent mode: plan.',
        'Focus on repository analysis, architecture, risk discovery, and step-by-step planning.',
        'Prefer read-only investigation and explicit recommendations.',
        'Do not modify files or run commands that can change the workspace state while plan mode is active.',
        'If implementation is needed, explain the recommended build-mode next steps first.',
      ].join('\n');
    case AgentMode.RESEARCH:
      return [
        'Agent mode: research.',
        'Prioritize source-backed investigation over quick generic answers.',
        'When using the web, search first, fetch exact discovered URLs, and synthesize only from gathered evidence.',
        'Aim to compare multiple sources before concluding and clearly note remaining uncertainty.',
      ].join('\n');
    case AgentMode.BUILD:
    default:
      return [
        'Agent mode: build.',
        'Prioritize direct implementation, grounded tool use, and concise progress toward a working result.',
      ].join('\n');
  }
}

function composeRuntimeSystemPrompt(session) {
  const sections = [
    getAgentModePrompt(session.agentMode),
    String(session.modelSettings?.systemPrompt ?? '').trim(),
  ].filter(Boolean);

  return sections.join('\n\n');
}

function getRequiredFetchedSourceCount(session) {
  return normalizeAgentMode(session.agentMode) === AgentMode.RESEARCH ? 2 : 1;
}

function filterVisibleToolsForAgentMode(toolDefinitions = [], agentMode) {
  if (normalizeAgentMode(agentMode) !== AgentMode.PLAN) {
    return toolDefinitions;
  }

  return toolDefinitions.filter((tool) => !PLAN_MODE_BLOCKED_TOOL_NAMES.has(tool?.name));
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

function normalizeWebUrl(value) {
  let normalized = String(value ?? '').trim();

  if (!normalized) {
    return '';
  }

  if (normalized.startsWith('//')) {
    normalized = `https:${normalized}`;
  }

  normalized = normalized.replace(/[)\],.;!?]+$/g, '');

  try {
    const parsed = new URL(normalized);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return normalized;
  }
}

function extractUrlsFromText(value) {
  const matches = String(value ?? '').match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  return matches.map((item) => normalizeWebUrl(item)).filter(Boolean);
}

function trackKnownPath(session, value) {
  if (!value) {
    return;
  }

  session.knownPaths ??= new Set(['.']);
  session.knownPaths.add(normalizeWorkspacePath(value));
}

function trackKnownWebUrl(session, value) {
  const normalized = normalizeWebUrl(value);
  if (!normalized) {
    return;
  }

  session.knownWebUrls ??= new Set();
  session.knownWebUrls.add(normalized);
}

function trackKnownWebResult(session, resultId, url) {
  const normalizedId = String(resultId ?? '').trim();
  const normalizedUrl = normalizeWebUrl(url);
  if (!normalizedId || !normalizedUrl) {
    return;
  }

  session.knownWebResultMap ??= new Map();
  session.knownWebResultMap.set(normalizedId, normalizedUrl);
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

function trackKnownWebUrlsFromResult(session, toolName, result) {
  if (!result || typeof result !== 'object') {
    return;
  }

  if (result.blocked) {
    return;
  }

  if (toolName === 'web_search' && Array.isArray(result.results)) {
    for (const entry of result.results) {
      trackKnownWebUrl(session, entry?.url);
      trackKnownWebResult(session, entry?.id, entry?.url);
    }
  }

  if (['web_fetch', 'browser_fetch'].includes(toolName) && result.url) {
    trackKnownWebUrl(session, result.url);
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

function resolveKnownWebResultUrl(session, resultId) {
  const normalizedId = String(resultId ?? '').trim();
  if (!normalizedId) {
    return '';
  }

  return String(session.knownWebResultMap?.get(normalizedId) ?? '').trim();
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

function collectKnownWebUrls(session) {
  const known = new Set(session.knownWebUrls ?? []);

  for (const message of session.messages ?? []) {
    if (message.role !== 'user') {
      continue;
    }

    for (const url of extractUrlsFromText(message.content)) {
      known.add(url);
    }
  }

  for (const event of session.toolEvents ?? []) {
    if (event.toolName === 'web_search' && Array.isArray(event.result?.results)) {
      for (const entry of event.result.results) {
        const url = normalizeWebUrl(entry?.url);
        if (url) {
          known.add(url);
        }
      }
    }

    if (['web_fetch', 'browser_fetch'].includes(event.toolName) && !event.result?.blocked) {
      const url = normalizeWebUrl(event.result?.url);
      if (url) {
        known.add(url);
      }
    }
  }

  return known;
}

function getCurrentTurnStartedAt(session) {
  const messages = session.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return messages[index]?.createdAt ?? null;
    }
  }

  return null;
}

function getCurrentTurnToolEvents(session) {
  const startedAt = getCurrentTurnStartedAt(session);
  const toolEvents = session.toolEvents ?? [];

  if (!startedAt) {
    return toolEvents;
  }

  return toolEvents.filter((event) => {
    const createdAt = event.createdAt ?? '';
    return createdAt >= startedAt;
  });
}

function getLatestSearchResultUrls(session, limit = 6) {
  return getLatestSearchResultCandidates(session)
    .map((entry) => entry.url)
    .slice(0, limit);
}

function getLatestSearchResultCandidates(session) {
  const currentTurnEvents = getCurrentTurnToolEvents(session);
  for (let index = currentTurnEvents.length - 1; index >= 0; index -= 1) {
    const event = currentTurnEvents[index];
    if (event.toolName !== 'web_search' || !Array.isArray(event.result?.results)) {
      continue;
    }

    return event.result.results
      .map((entry) => ({
        title: String(entry?.title ?? '').trim(),
        url: normalizeWebUrl(entry?.url),
        snippet: String(entry?.snippet ?? '').trim(),
        availability: entry?.availability ?? null,
      }))
      .filter((entry) => entry.url);
  }

  return [];
}

function pickRedirectedWebFetchCandidate(session) {
  const candidates = getLatestSearchResultCandidates(session);
  if (candidates.length === 0) {
    return null;
  }

  const currentTurnEvents = getCurrentTurnToolEvents(session);
  const alreadyFetched = new Set(
    currentTurnEvents
      .filter(
        (event) =>
          ['web_fetch', 'browser_fetch'].includes(event.toolName) &&
          event.status === 'completed' &&
          event.result?.url
      )
      .map((event) => normalizeWebUrl(event.result.url))
      .filter(Boolean)
  );

  const preferred = candidates.find(
    (candidate) =>
      candidate.availability?.ok === true &&
      !alreadyFetched.has(candidate.url)
  );
  if (preferred) {
    return preferred;
  }

  return candidates.find((candidate) => !alreadyFetched.has(candidate.url)) ?? candidates[0] ?? null;
}

function resolveWebCallArguments(session, call) {
  if (!['web_fetch', 'browser_fetch'].includes(call?.name)) {
    return call?.arguments ?? {};
  }

  const resultId = String(call?.arguments?.resultId ?? '').trim();
  if (!resultId) {
    return call?.arguments ?? {};
  }

  const resolvedUrl = resolveKnownWebResultUrl(session, resultId);
  if (!resolvedUrl) {
    return call?.arguments ?? {};
  }

  return {
    ...call.arguments,
    url: resolvedUrl,
    resolvedFromResultId: true,
  };
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
        const visibleTools = filterVisibleToolsForAgentMode(
          session.toolRegistry.listVisibleDefinitions(session.permissionPreset),
          session.agentMode
        );
        const contextMessages = buildContextMessages(session);
        const capabilities = await this.provider.getCapabilities(
          session.model,
          session.capabilityOverride ?? {}
        );

        throwIfAborted(signal);
        session.capabilities = capabilities;

        this.#notifyProgress(session, onProgress, { phase: 'analyzing' });

        const turnRunner =
          typeof this.provider.runStreamingTurn === 'function'
            ? this.provider.runStreamingTurn.bind(this.provider)
            : this.provider.runTurn.bind(this.provider);

        const turn = await turnRunner({
          model: session.model,
          messages: contextMessages,
          tools: visibleTools,
          useNativeTools: capabilities.nativeTools,
          workspaceRoot: session.workspaceRoot,
          knownPaths: [...(session.knownPaths ?? new Set(['.']))],
          systemPrompt: composeRuntimeSystemPrompt(session),
          runtimeOptions: {
            numCtx: session.modelSettings?.contextLength,
            temperature: session.modelSettings?.temperature,
          },
          signal,
          onChunk: (chunk) => {
            const nextContent = String(chunk?.content ?? '').trim();
            const nextThinking = String(chunk?.thinking ?? '').trim();
            if (!nextContent && !nextThinking) {
              return;
            }

            this.#notifyProgress(session, onProgress, {
              phase: 'assistant_stream',
              streamText: nextContent,
              streamThinking: nextThinking,
            });
          },
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
            if (this.#recordMissingWebEvidenceWarning(session, onProgress)) {
              countedIterations += 1;
              this.#setLoopTracker(session, {
                previousSignature,
                repeatedSignatureCount,
                countedIterations,
              });
              continue;
            }

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

        if (turn.envelope.mode === AgentEnvelopeMode.FINAL) {
          if (this.#recordMissingWebEvidenceWarning(session, onProgress)) {
            countedIterations += 1;
            this.#setLoopTracker(session, {
              previousSignature,
              repeatedSignatureCount,
              countedIterations,
            });
            continue;
          }
        }

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

  #buildMissingWebEvidenceWarning(session) {
    if (session.capabilities?.nativeTools) {
      return null;
    }

    const currentTurnEvents = getCurrentTurnToolEvents(session);
    const hasWebSearch = currentTurnEvents.some(
      (event) => event.toolName === 'web_search' && event.status === 'completed'
    );
    if (!hasWebSearch) {
      return null;
    }

    const successfulFetchCount = currentTurnEvents.filter(
      (event) =>
        ['web_fetch', 'browser_fetch'].includes(event.toolName) && event.status === 'completed'
    ).length;
    const requiredFetchCount = getRequiredFetchedSourceCount(session);
    if (successfulFetchCount >= requiredFetchCount) {
      return null;
    }

    const nearbyUrls = getLatestSearchResultUrls(session);
    const nearbyText =
      nearbyUrls.length > 0
        ? ` Latest exact search-result URLs: ${nearbyUrls.join(', ')}.`
        : '';

    const remainingFetches = Math.max(1, requiredFetchCount - successfulFetchCount);
    const sourceHint =
      requiredFetchCount > 1
        ? ` Gather at least ${requiredFetchCount} fetched sources before finalizing this research answer.`
        : '';

    return `This turn started web research but only ${successfulFetchCount} fetched source${successfulFetchCount === 1 ? '' : 's'} succeeded so far.${nearbyText}${sourceHint} Fetch ${remainingFetches} more exact source ${remainingFetches === 1 ? 'page' : 'pages'} from the latest web_search results, or use browser_fetch if a returned page needs JavaScript or blocks normal fetch.`;
  }

  #recordMissingWebEvidenceWarning(session, onProgress) {
    const warning = this.#buildMissingWebEvidenceWarning(session);
    if (!warning) {
      return false;
    }

    const event = {
      id: randomUUID(),
      toolName: 'web_fetch',
      arguments: {},
      status: 'blocked',
      createdAt: nowIso(),
      completedAt: nowIso(),
      source: 'runtime',
      resultPreview: warning,
      result: {
        warning,
        blocked: true,
        guard: 'missing_web_evidence',
      },
    };

    session.toolEvents.push(event);
    session.messages.push({
      id: randomUUID(),
      role: 'tool',
      toolName: 'web_fetch',
      content: JSON.stringify(event.result),
      createdAt: nowIso(),
    });
    this.#notifyProgress(session, onProgress, {
      phase: 'tool_blocked',
      eventId: event.id,
    });
    return true;
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
      normalizeAgentMode(session.agentMode) === AgentMode.RESEARCH
        ? 'Write a source-backed research summary. Reference the strongest fetched pages explicitly and call out uncertainty when evidence is thin.'
        : '',
      normalizeAgentMode(session.agentMode) === AgentMode.PLAN
        ? 'Stay in planning mode: summarize findings, risks, and next implementation steps without pretending changes were already made.'
        : '',
      recentResults ? `Recent tool results:\n${recentResults}` : '',
      'Reply with your best final answer now. If evidence is partial, say what is still uncertain.',
    ]
      .filter(Boolean)
      .join('\n\n');
    this.#notifyProgress(session, onProgress, { phase: 'analyzing' });
    const turnRunner =
      typeof this.provider.runStreamingTurn === 'function'
        ? this.provider.runStreamingTurn.bind(this.provider)
        : this.provider.runTurn.bind(this.provider);
    const turn = await turnRunner({
      model: session.model,
      messages: [...buildContextMessages(session), { role: 'user', content: synthesisPrompt }],
      tools: [],
      useNativeTools: capabilities.nativeTools,
      workspaceRoot: session.workspaceRoot,
      knownPaths: [...(session.knownPaths ?? new Set(['.']))],
      systemPrompt: composeRuntimeSystemPrompt(session),
      runtimeOptions: {
        numCtx: session.modelSettings?.contextLength,
        temperature: session.modelSettings?.temperature,
      },
      signal,
      onChunk: (chunk) => {
        const nextContent = String(chunk?.content ?? '').trim();
        const nextThinking = String(chunk?.thinking ?? '').trim();
        if (!nextContent && !nextThinking) {
          return;
        }

        this.#notifyProgress(session, onProgress, {
          phase: 'assistant_stream',
          streamText: nextContent,
          streamThinking: nextThinking,
        });
      },
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
      const resolvedArguments = resolveWebCallArguments(session, call);
      const resolvedCall =
        resolvedArguments === call.arguments ? call : { ...call, arguments: resolvedArguments };
      const toolDefinition = session.toolRegistry.get(call.name);
      const event = {
        id: randomUUID(),
        toolName: call.name,
        arguments: resolvedCall.arguments,
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

      const warning =
        this.#buildModeGuardWarning(session, resolvedCall) ??
        (['fs_write', 'fs_patch'].includes(call.name)
          ? this.#buildMissingWebEvidenceWarning(session)
          : null) ??
        this.#buildUndiscoveredPathWarning(session, resolvedCall) ??
        this.#buildUndiscoveredWebWarning(session, resolvedCall);

      if (warning) {
        if (['web_fetch', 'browser_fetch'].includes(call.name)) {
          const fallbackCandidate = pickRedirectedWebFetchCandidate(session);
          if (fallbackCandidate) {
            event.arguments = {
              ...call.arguments,
              url: fallbackCandidate.url,
              requestedUrl: call.arguments?.url ?? '',
              runtimeRedirected: true,
            };
            event.redirectedFromUrl = call.arguments?.url ?? '';
            event.redirectedToUrl = fallbackCandidate.url;
            event.redirectReason = warning;
            this.#notifyProgress(session, onProgress, {
              phase: 'tool_redirected',
              eventId: event.id,
            });

            await this.#executeToolCall(
              session,
              {
                ...call,
                arguments: {
                  ...call.arguments,
                  url: fallbackCandidate.url,
                },
              },
              toolDefinition,
              event,
              signal,
              onProgress,
              {
                redirectedFromUrl: resolvedCall.arguments?.url ?? call.arguments?.url ?? '',
                redirectedToUrl: fallbackCandidate.url,
                redirectTitle: fallbackCandidate.title,
                redirectReason: warning,
              }
            );
            continue;
          }
        }

        const blockedReference =
          typeof call.arguments?.path === 'string'
            ? { path: call.arguments.path }
            : typeof call.arguments?.url === 'string'
              ? { url: call.arguments.url }
              : {};

        session.messages.push({
          id: randomUUID(),
          role: 'tool',
          toolName: call.name,
          content: JSON.stringify({
            warning,
            blocked: true,
            ...blockedReference,
          }),
          createdAt: nowIso(),
        });

        event.status = 'blocked';
        event.completedAt = nowIso();
        event.resultPreview = warning;
        event.result = {
          warning,
          blocked: true,
          ...blockedReference,
        };
        this.#notifyProgress(session, onProgress, {
          phase: 'tool_blocked',
          eventId: event.id,
        });
        continue;
      }

      await this.#executeToolCall(session, resolvedCall, toolDefinition, event, signal, onProgress);
    }

    return { status: 'completed' };
  }

  async #executeToolCall(session, call, toolDefinition, event, signal, onProgress, executionMeta = null) {
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

      const decoratedResult =
        executionMeta?.redirectedFromUrl
          ? {
              ...result,
              requestedUrl: executionMeta.redirectedFromUrl,
              url: result?.url ?? executionMeta.redirectedToUrl,
              runtimeRedirected: true,
              redirectTitle: executionMeta.redirectTitle ?? '',
              redirectReason: executionMeta.redirectReason ?? '',
            }
          : result;

      session.messages.push({
        id: randomUUID(),
        role: 'tool',
        toolName: call.name,
        content: toolMessageContent(decoratedResult),
        createdAt: nowIso(),
      });

      event.status = 'completed';
      event.completedAt = nowIso();
      event.resultPreview = executionMeta?.redirectedFromUrl
        ? `Reused exact search-result URL ${shortenInline(
            executionMeta.redirectedToUrl,
            64
          )} instead of invented URL ${shortenInline(executionMeta.redirectedFromUrl, 52)}.`
        : summarizeToolResult(call.name, decoratedResult);
      event.diffText = decoratedResult?.diff ?? decoratedResult?.diffText ?? '';
      event.result = decoratedResult;
      trackKnownPathsFromResult(session, call.name, decoratedResult);
      trackKnownWebUrlsFromResult(session, call.name, decoratedResult);
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

  #buildModeGuardWarning(session, call) {
    if (normalizeAgentMode(session.agentMode) !== AgentMode.PLAN) {
      return null;
    }

    if (!PLAN_MODE_BLOCKED_TOOL_NAMES.has(call.name)) {
      return null;
    }

    return `Plan mode is analysis-first and currently blocks workspace-changing actions like ${call.name}. Switch the agent mode to Build if you want the agent to edit files or run commands.`;
  }

  #buildUndiscoveredPathWarning(session, call) {
    if (session.capabilities?.nativeTools) {
      return null;
    }

    if (!['fs_read', 'fs_patch', 'fs_delete'].includes(call.name)) {
      return null;
    }

    const requestedPath = call.arguments?.path;
    if (!requestedPath || typeof requestedPath !== 'string') {
      return null;
    }

    const normalizedPath = normalizeWorkspacePath(requestedPath);
    if (
      call.name === 'fs_read' &&
      (pathExistsInsideWorkspace(session.workspaceRoot, normalizedPath) ||
        matchesAttachmentAlias(session, normalizedPath))
    ) {
      return null;
    }

    if ((session.knownPaths ?? new Set(['.'])).has(normalizedPath)) {
      return null;
    }

    const nearbyPaths = getNearbyKnownPaths(session, normalizedPath);
    const nearbyText =
      nearbyPaths.length > 0 ? ` Known paths nearby: ${nearbyPaths.join(', ')}.` : '';

    return `Path "${normalizedPath}" has not been discovered in this thread yet.${nearbyText} Use fs_list or search_text first, then read one of the returned paths exactly.`;
  }

  #buildUndiscoveredWebWarning(session, call) {
    if (session.capabilities?.nativeTools) {
      return null;
    }

    if (!['web_fetch', 'browser_fetch'].includes(call.name)) {
      return null;
    }

    const requestedResultId = String(call.arguments?.resultId ?? '').trim();
    if (requestedResultId) {
      const resolvedUrl = resolveKnownWebResultUrl(session, requestedResultId);
      if (resolvedUrl) {
        return null;
      }

      return `Search result id "${requestedResultId}" is not known in this thread yet. Use web_search first, then reuse one exact resultId that appeared in the returned search results.`;
    }

    const requestedUrl = normalizeWebUrl(call.arguments?.url ?? '');
    if (!requestedUrl) {
      return null;
    }

    const knownUrls = collectKnownWebUrls(session);
    if (knownUrls.has(requestedUrl)) {
      return null;
    }

    const nearbyUrls = [...knownUrls].slice(-6);
    const nearbyText =
      nearbyUrls.length > 0
        ? ` Known URLs in this thread: ${nearbyUrls.join(', ')}.`
        : '';

    return `URL "${requestedUrl}" has not been discovered in this thread yet.${nearbyText} Do not guess or invent another URL from memory. Run web_search again with a better query, then reuse one exact URL that appeared in the search results or the user's message.`;
  }
}
