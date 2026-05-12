import path from 'node:path';

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

export function resolveWorkspacePath(workspaceRoot, requestedPath = '.') {
  const root = assertWorkspaceRoot(workspaceRoot);
  const resolvedTarget = path.resolve(root, requestedPath);
  const relativePath = path.relative(root, resolvedTarget);

  if (
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath)
  ) {
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
