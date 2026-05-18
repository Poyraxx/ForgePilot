import { spawn } from 'node:child_process';

import { bindAbortSignal, createAbortError, throwIfAborted } from '../abort.js';
import { createToolDefinition, RiskLevel } from '../contracts.js';
import { resolveShellCandidates } from '../platform.js';
import { getDetachedSpawnOption, terminateProcessTree } from '../process-tree.js';

function runCommandWithShell(shell, command, workspaceRoot, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal, 'Command stopped by user.');
    const args = [...shell.args, command];

    const child = spawn(shell.command, args, {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      detached: getDetachedSpawnOption(),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    function finish(callback, value) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      disposeAbort();
      callback(value);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);

    const disposeAbort = bindAbortSignal(signal, () => {
      aborted = true;
      terminateProcessTree(child);
    });

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      finish(reject, error);
    });

    child.on('close', (code) => {
      if (aborted) {
        finish(reject, createAbortError('Command stopped by user.'));
        return;
      }

      finish(resolve, {
        command,
        exitCode: code ?? -1,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        timedOut,
      });
    });
  });
}

async function runShellCommand(command, workspaceRoot, timeoutMs, signal) {
  const candidates = resolveShellCandidates();
  let lastError = null;

  for (const candidate of candidates) {
    try {
      return await runCommandWithShell(candidate, command, workspaceRoot, timeoutMs, signal);
    } catch (error) {
      lastError = error;
      const message = String(error?.message ?? '');
      const isMissingShell =
        error?.code === 'ENOENT' ||
        /spawn .* ENOENT/i.test(message) ||
        /not found/i.test(message);

      if (isMissingShell) {
        continue;
      }

      throw error;
    }
  }

  throw (
    lastError ??
    new Error('No supported shell was found. Install PowerShell, bash, or sh to use run_command.')
  );
}

export function createCommandTool() {
  return createToolDefinition({
    name: 'run_command',
    description: 'Run a shell command inside the current workspace.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Command line to execute.' },
        timeoutMs: { type: 'integer', description: 'Optional execution timeout in milliseconds.' },
      },
    },
    riskLevel: RiskLevel.HIGH,
    requiresApproval: true,
    async handler(context, args) {
      return runShellCommand(
        String(args.command),
        context.workspaceRoot,
        args.timeoutMs ?? 15_000,
        context.signal
      );
    },
  });
}
