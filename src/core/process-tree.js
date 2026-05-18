import { spawn } from 'node:child_process';

export function getDetachedSpawnOption() {
  return process.platform !== 'win32';
}

export function terminateProcessTree(childProcess) {
  if (!childProcess || childProcess.killed) {
    return;
  }

  if (process.platform === 'win32') {
    if (typeof childProcess.pid !== 'number') {
      childProcess.kill();
      return;
    }

    const killer = spawn('taskkill', ['/PID', String(childProcess.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      try {
        childProcess.kill();
      } catch {
        // Best effort cleanup only.
      }
    });
    return;
  }

  try {
    process.kill(-childProcess.pid, 'SIGTERM');
  } catch {
    try {
      childProcess.kill('SIGTERM');
    } catch {
      // Best effort cleanup only.
    }
  }
}
