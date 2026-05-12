import fs from 'node:fs/promises';
import path from 'node:path';

import { throwIfAborted } from '../abort.js';
import { createToolDefinition, RiskLevel } from '../contracts.js';
import { createUnifiedDiff } from '../diff.js';
import { relativizeWorkspacePath, resolveWorkspacePath } from '../path-guard.js';
import { resolveAttachmentAwareWorkspacePath } from './attachment-paths.js';
import {
  describeReadableFormats,
  extractStructuredDocumentText,
  readUtf8FileWithBinaryGuard,
  supportsStructuredDocumentRead,
} from './document-extractor.js';

async function listEntries(targetPath, recursive, maxEntries, signal) {
  const entries = [];
  const queue = [targetPath];

  while (queue.length > 0 && entries.length < maxEntries) {
    throwIfAborted(signal, 'File listing stopped by user.');
    const currentPath = queue.shift();
    const directoryEntries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of directoryEntries) {
      throwIfAborted(signal, 'File listing stopped by user.');
      const absolutePath = path.join(currentPath, entry.name);
      const stat = await fs.stat(absolutePath);

      entries.push({
        name: entry.name,
        path: absolutePath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: stat.size,
      });

      if (recursive && entry.isDirectory()) {
        queue.push(absolutePath);
      }

      if (entries.length >= maxEntries) {
        break;
      }
    }
  }

  return entries;
}

function toWorkspaceEntries(workspaceRoot, entries) {
  return entries.map((entry) => ({
    ...entry,
    path: relativizeWorkspacePath(workspaceRoot, entry.path),
  }));
}

function getLineWindow(content, startLine, endLine) {
  const normalized = String(content).replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if (!Number.isInteger(startLine) && !Number.isInteger(endLine)) {
    return {
      content: normalized,
      startLine: 1,
      endLine: lines.length,
      totalLines: lines.length,
    };
  }

  const safeStart = Math.max(1, startLine ?? 1);
  const safeEnd = Math.min(lines.length, endLine ?? lines.length);

  return {
    content: lines.slice(safeStart - 1, safeEnd).join('\n'),
    startLine: safeStart,
    endLine: safeEnd,
    totalLines: lines.length,
  };
}

async function listNearbyEntries(workspaceRoot, requestedPath) {
  try {
    const parentPath = resolveWorkspacePath(
      workspaceRoot,
      path.dirname(requestedPath || '.')
    );
    const entries = await fs.readdir(parentPath, { withFileTypes: true });

    return entries
      .slice(0, 12)
      .map((entry) => {
        const absolutePath = path.join(parentPath, entry.name);
        return relativizeWorkspacePath(workspaceRoot, absolutePath);
      });
  } catch {
    return [];
  }
}

export function createFileTools() {
  return [
    createToolDefinition({
      name: 'fs_list',
      description: 'List files and directories under a workspace-relative path.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Workspace-relative directory path.' },
          recursive: { type: 'boolean', description: 'Whether to descend into subdirectories.' },
          maxEntries: { type: 'integer', description: 'Maximum number of returned entries.' },
        },
      },
      async handler(context, args) {
        throwIfAborted(context.signal, 'File listing stopped by user.');
        const requestedPath = args.path ?? '.';
        const targetPath = resolveWorkspacePath(context.workspaceRoot, requestedPath);
        const stat = await fs.stat(targetPath);

        if (!stat.isDirectory()) {
          throw new Error(`"${requestedPath}" is not a directory.`);
        }

        const entries = await listEntries(
          targetPath,
          Boolean(args.recursive),
          args.maxEntries ?? 200,
          context.signal
        );
        return {
          path: relativizeWorkspacePath(context.workspaceRoot, targetPath),
          entries: toWorkspaceEntries(context.workspaceRoot, entries),
          truncated: entries.length >= (args.maxEntries ?? 200),
        };
      },
    }),
    createToolDefinition({
      name: 'fs_read',
      description:
        'Read a workspace file as text, or extract text from common document formats such as PDF, DOCX, XLSX, and PPTX.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          startLine: { type: 'integer', description: 'Optional 1-based inclusive start line.' },
          endLine: { type: 'integer', description: 'Optional 1-based inclusive end line.' },
        },
      },
      async handler(context, args) {
        throwIfAborted(context.signal, 'File read stopped by user.');
        const targetPath = resolveAttachmentAwareWorkspacePath(
          context.workspaceRoot,
          args.path,
          context.attachments
        );
        let rawContent = '';
        let extracted = false;
        let format = null;
        let metadata = {};

        try {
          if (supportsStructuredDocumentRead(targetPath)) {
            const extractedDocument = await extractStructuredDocumentText(
              targetPath,
              context.signal
            );
            rawContent = extractedDocument.content;
            extracted = true;
            format = extractedDocument.format ?? null;
            metadata = extractedDocument.metadata ?? {};
          } else {
            rawContent = await readUtf8FileWithBinaryGuard(targetPath);
          }
        } catch (error) {
          if (error?.code === 'ENOENT') {
            const nearbyEntries = await listNearbyEntries(context.workspaceRoot, args.path);
            const nearbyText =
              nearbyEntries.length > 0
                ? ` Nearby entries: ${nearbyEntries.join(', ')}.`
                : '';
            throw new Error(
              `Path "${args.path}" was not found in the current workspace.${nearbyText} Use fs_list or search_text to discover real paths before calling fs_read.`
            );
          }

          throw error;
        }

        const lineWindow = getLineWindow(rawContent, args.startLine, args.endLine);

        return {
          path: relativizeWorkspacePath(context.workspaceRoot, targetPath),
          extracted,
          format,
          metadata,
          readableFormats: describeReadableFormats(),
          ...lineWindow,
        };
      },
    }),
    createToolDefinition({
      name: 'fs_write',
      description: 'Create or fully replace a UTF-8 text file inside the workspace.',
      inputSchema: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          content: { type: 'string', description: 'New full file contents.' },
        },
      },
      riskLevel: RiskLevel.MEDIUM,
      mutatesWorkspace: true,
      async handler(context, args) {
        throwIfAborted(context.signal, 'File write stopped by user.');
        const targetPath = resolveWorkspacePath(context.workspaceRoot, args.path);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });

        let previousContent = '';
        let created = false;

        try {
          previousContent = await fs.readFile(targetPath, 'utf8');
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            throw error;
          }

          created = true;
        }

        await fs.writeFile(targetPath, String(args.content ?? ''), 'utf8');

        return {
          path: relativizeWorkspacePath(context.workspaceRoot, targetPath),
          created,
          bytesWritten: Buffer.byteLength(String(args.content ?? ''), 'utf8'),
          diff: createUnifiedDiff(previousContent, String(args.content ?? ''), args.path),
        };
      },
    }),
    createToolDefinition({
      name: 'fs_patch',
      description: 'Replace part of a file by matching exact text.',
      inputSchema: {
        type: 'object',
        required: ['path', 'oldText', 'newText'],
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          oldText: { type: 'string', description: 'Exact text to replace.' },
          newText: { type: 'string', description: 'Replacement text.' },
          replaceAll: { type: 'boolean', description: 'Replace every matching occurrence.' },
        },
      },
      riskLevel: RiskLevel.MEDIUM,
      mutatesWorkspace: true,
      async handler(context, args) {
        throwIfAborted(context.signal, 'File patch stopped by user.');
        if (!args.oldText) {
          throw new Error('fs_patch requires a non-empty oldText value.');
        }

        const targetPath = resolveWorkspacePath(context.workspaceRoot, args.path);
        const previousContent = await fs.readFile(targetPath, 'utf8');
        const replaceAll = Boolean(args.replaceAll);
        const occurrences = previousContent.split(String(args.oldText)).length - 1;

        if (occurrences === 0) {
          throw new Error(`Text was not found in "${args.path}".`);
        }

        const nextContent = replaceAll
          ? previousContent.split(String(args.oldText)).join(String(args.newText))
          : previousContent.replace(String(args.oldText), String(args.newText));

        await fs.writeFile(targetPath, nextContent, 'utf8');

        return {
          path: relativizeWorkspacePath(context.workspaceRoot, targetPath),
          replacements: replaceAll ? occurrences : 1,
          diff: createUnifiedDiff(previousContent, nextContent, args.path),
        };
      },
    }),
    createToolDefinition({
      name: 'fs_mkdir',
      description: 'Create a directory inside the workspace.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Workspace-relative directory path.' },
        },
      },
      riskLevel: RiskLevel.MEDIUM,
      mutatesWorkspace: true,
      async handler(context, args) {
        throwIfAborted(context.signal, 'Directory creation stopped by user.');
        const targetPath = resolveWorkspacePath(context.workspaceRoot, args.path);
        await fs.mkdir(targetPath, { recursive: true });
        return {
          path: relativizeWorkspacePath(context.workspaceRoot, targetPath),
          created: true,
        };
      },
    }),
    createToolDefinition({
      name: 'fs_delete',
      description: 'Delete a file or directory inside the workspace.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Workspace-relative file or directory path.' },
          recursive: { type: 'boolean', description: 'Whether recursive directory removal is allowed.' },
        },
      },
      riskLevel: RiskLevel.HIGH,
      mutatesWorkspace: true,
      requiresApproval: true,
      async handler(context, args) {
        throwIfAborted(context.signal, 'Delete stopped by user.');
        const targetPath = resolveWorkspacePath(context.workspaceRoot, args.path);
        const stat = await fs.lstat(targetPath);

        if (stat.isDirectory()) {
          await fs.rm(targetPath, { recursive: Boolean(args.recursive), force: false });
        } else {
          await fs.unlink(targetPath);
        }

        return {
          path: relativizeWorkspacePath(context.workspaceRoot, targetPath),
          deleted: true,
          type: stat.isDirectory() ? 'directory' : 'file',
        };
      },
    }),
  ];
}
