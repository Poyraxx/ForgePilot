import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { bindAbortSignal, createAbortError, isAbortError, throwIfAborted } from '../abort.js';
import { createToolDefinition } from '../contracts.js';
import { relativizeWorkspacePath, resolveWorkspacePath } from '../path-guard.js';
import { resolveAttachmentAwareWorkspacePath } from './attachment-paths.js';

function normalizeResultPath(value) {
  return String(value ?? '.').replace(/\\/g, '/');
}

function collectProcess(childProcess, { allowNonZero = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let aborted = false;

    function finish(callback, value) {
      if (settled) {
        return;
      }

      settled = true;
      disposeAbort();
      callback(value);
    }

    const disposeAbort = bindAbortSignal(signal, () => {
      aborted = true;
      childProcess.kill();
    });

    childProcess.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    childProcess.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    childProcess.on('error', (error) => {
      finish(reject, error);
    });
    childProcess.on('close', (code) => {
      if (aborted) {
        finish(reject, createAbortError('Search stopped by user.'));
        return;
      }

      const allowedExitCodes = allowNonZero ? [0, 1] : [0];

      if (!allowedExitCodes.includes(code ?? -1)) {
        finish(reject, new Error(stderr.trim() || `Process exited with code ${code}.`));
        return;
      }

      finish(resolve, { stdout, stderr, code });
    });
  });
}

async function searchWithRipgrep(workspaceRoot, args, signal) {
  throwIfAborted(signal, 'Search stopped by user.');
  const targetPath = resolveAttachmentAwareWorkspacePath(
    workspaceRoot,
    args.path ?? '.',
    args.attachments ?? []
  );
  const rgArgs = ['--json', '--hidden', '-n', String(args.query), targetPath];

  if (args.glob) {
    rgArgs.unshift(args.glob);
    rgArgs.unshift('--glob');
  }

  const child = spawn('rg', rgArgs, {
    cwd: workspaceRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const { stdout } = await collectProcess(child, { allowNonZero: true, signal });
  const results = [];
  const maxResults = args.maxResults ?? 50;

  for (const line of stdout.split(/\r?\n/)) {
    throwIfAborted(signal, 'Search stopped by user.');
    if (!line.trim()) {
      continue;
    }

    const parsed = JSON.parse(line);

    if (parsed.type !== 'match') {
      continue;
    }

    results.push({
      path: normalizeResultPath(relativizeWorkspacePath(workspaceRoot, parsed.data.path.text)),
      line: parsed.data.line_number,
      text: parsed.data.lines.text.replace(/\r?\n$/, ''),
    });

    if (results.length >= maxResults) {
      break;
    }
  }

  return {
    path: normalizeResultPath(relativizeWorkspacePath(workspaceRoot, targetPath)),
    query: String(args.query),
    results,
    truncated: results.length >= maxResults,
  };
}

async function walkDirectory(rootPath, matcher, collected, maxResults, signal) {
  throwIfAborted(signal, 'Search stopped by user.');
  const entries = await fs.readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    throwIfAborted(signal, 'Search stopped by user.');
    const absolutePath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      await walkDirectory(absolutePath, matcher, collected, maxResults, signal);
    } else {
      const rawContent = await fs.readFile(absolutePath, 'utf8').catch(() => null);

      if (rawContent == null) {
        continue;
      }

      const lines = rawContent.replace(/\r\n/g, '\n').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        throwIfAborted(signal, 'Search stopped by user.');
        if (matcher.test(lines[index])) {
          collected.push({
            path: normalizeResultPath(absolutePath),
            line: index + 1,
            text: lines[index],
          });
        }

        if (collected.length >= maxResults) {
          return;
        }
      }
    }

    if (collected.length >= maxResults) {
      return;
    }
  }
}

async function searchSingleFile(workspaceRoot, targetPath, matcher, maxResults) {
  const rawContent = await fs.readFile(targetPath, 'utf8').catch(() => null);
  if (rawContent == null) {
    return [];
  }

  const lines = rawContent.replace(/\r\n/g, '\n').split('\n');
  const results = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (matcher.test(lines[index])) {
      results.push({
        path: normalizeResultPath(relativizeWorkspacePath(workspaceRoot, targetPath)),
        line: index + 1,
        text: lines[index],
      });
    }

    if (results.length >= maxResults) {
      break;
    }
  }

  return results;
}

async function searchWithNodeFallback(workspaceRoot, args, signal) {
  throwIfAborted(signal, 'Search stopped by user.');
  const targetPath = resolveAttachmentAwareWorkspacePath(
    workspaceRoot,
    args.path ?? '.',
    args.attachments ?? []
  );
  const matcher = new RegExp(String(args.query), 'i');
  const collected = [];
  const maxResults = args.maxResults ?? 50;
  const targetStat = await fs.stat(targetPath);

  if (targetStat.isFile()) {
    const results = await searchSingleFile(workspaceRoot, targetPath, matcher, maxResults);
    return {
      path: normalizeResultPath(relativizeWorkspacePath(workspaceRoot, targetPath)),
      query: String(args.query),
      results,
      truncated: results.length >= maxResults,
    };
  }

  await walkDirectory(targetPath, matcher, collected, maxResults, signal);

  return {
    path: normalizeResultPath(relativizeWorkspacePath(workspaceRoot, targetPath)),
    query: String(args.query),
    results: collected.map((entry) => ({
      ...entry,
      path: normalizeResultPath(relativizeWorkspacePath(workspaceRoot, entry.path)),
    })),
    truncated: collected.length >= maxResults,
  };
}

export function createSearchTool() {
  return createToolDefinition({
    name: 'search_text',
    description: 'Search for text matches inside files in the workspace.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Text or regex to search for.' },
        path: { type: 'string', description: 'Optional workspace-relative starting path.' },
        glob: { type: 'string', description: 'Optional glob filter for file names.' },
        maxResults: { type: 'integer', description: 'Maximum number of returned matches.' },
      },
    },
    async handler(context, args) {
      const effectiveArgs = {
        ...args,
        attachments: context.attachments ?? [],
      };
      try {
        return await searchWithRipgrep(context.workspaceRoot, effectiveArgs, context.signal);
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }

        return searchWithNodeFallback(context.workspaceRoot, effectiveArgs, context.signal);
      }
    },
  });
}
