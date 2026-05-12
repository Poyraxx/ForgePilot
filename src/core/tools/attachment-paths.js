import fs from 'node:fs';
import path from 'node:path';

import { resolveWorkspacePath } from '../path-guard.js';

function normalizeLoosePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function attachmentAliases(attachment) {
  const values = [
    attachment?.path,
    attachment?.name,
    attachment?.originalName,
    attachment?.path ? path.posix.basename(normalizeLoosePath(attachment.path)) : '',
  ];

  return [...new Set(values.map(normalizeLoosePath).filter(Boolean))];
}

export function matchAttachmentByRequestedPath(attachments = [], requestedPath = '') {
  const normalized = normalizeLoosePath(requestedPath);
  if (!normalized) {
    return null;
  }

  const normalizedBasename = path.posix.basename(normalized);

  return (
    attachments.find((attachment) => {
      const aliases = attachmentAliases(attachment);
      return (
        aliases.includes(normalized) ||
        aliases.includes(normalizedBasename) ||
        aliases.some((alias) => normalized.endsWith(`/${alias}`))
      );
    }) ?? null
  );
}

export function resolveAttachmentAwareWorkspacePath(
  workspaceRoot,
  requestedPath,
  attachments = []
) {
  try {
    const resolvedPath = resolveWorkspacePath(workspaceRoot, requestedPath);
    if (fs.existsSync(resolvedPath)) {
      return resolvedPath;
    }

    const matched = matchAttachmentByRequestedPath(attachments, requestedPath);
    if (matched?.path) {
      return resolveWorkspacePath(workspaceRoot, matched.path);
    }

    return resolvedPath;
  } catch {
    const matched = matchAttachmentByRequestedPath(attachments, requestedPath);
    if (!matched?.path) {
      throw new Error(`Attachment alias could not resolve "${requestedPath}".`);
    }

    return resolveWorkspacePath(workspaceRoot, matched.path);
  }
}
