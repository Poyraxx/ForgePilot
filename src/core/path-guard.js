import path from 'node:path';
import fs from 'node:fs';

export class WorkspaceBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceBoundaryError';
  }
}

export function assertWorkspaceRoot(workspaceRoot) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new WorkspaceBoundaryError('A valid workspace root is required.');
  }

  return path.resolve(workspaceRoot);
}

function staysInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolvePhysicalPath(targetPath) {
  let existingPath = targetPath;
  const missingParts = [];

  while (true) {
    try {
      fs.lstatSync(existingPath);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    const parent = path.dirname(existingPath);
    if (parent === existingPath) {
      return targetPath;
    }
    missingParts.unshift(path.basename(existingPath));
    existingPath = parent;
  }

  return path.resolve(fs.realpathSync(existingPath), ...missingParts);
}

export function resolveWorkspacePath(workspaceRoot, requestedPath = '.') {
  const root = assertWorkspaceRoot(workspaceRoot);
  const resolvedTarget = path.resolve(root, requestedPath);
  if (!staysInside(root, resolvedTarget) ||
      !staysInside(resolvePhysicalPath(root), resolvePhysicalPath(resolvedTarget))) {
    throw new WorkspaceBoundaryError(
      `Path "${requestedPath}" resolves outside of the current workspace.`
    );
  }

  return resolvedTarget;
}

export function relativizeWorkspacePath(workspaceRoot, targetPath) {
  const root = assertWorkspaceRoot(workspaceRoot);
  return path.relative(root, targetPath) || '.';
}
