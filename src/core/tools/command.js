import { spawn } from 'node:child_process';

import { bindAbortSignal, createAbortError, throwIfAborted } from '../abort.js';
import { createToolDefinition, RiskLevel } from '../contracts.js';

function runShellCommand(command, workspaceRoot, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal, 'Command stopped by user.');
    const executable = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const args =
      process.platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
        : ['-lc', command];

    const child = spawn(executable, args, {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
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
      child.kill();
    }, timeoutMs);

    const disposeAbort = bindAbortSignal(signal, () => {
      aborted = true;
      child.kill();
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
