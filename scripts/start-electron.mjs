import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');

function resolveElectronBinary(rootDir) {
  if (process.env.ELECTRON_BINARY && fs.existsSync(process.env.ELECTRON_BINARY)) {
    return process.env.ELECTRON_BINARY;
  }

  const binaryByPlatform = {
    win32: path.join(rootDir, 'node_modules', 'electron', 'dist', 'electron.exe'),
    linux: path.join(rootDir, 'node_modules', 'electron', 'dist', 'electron'),
    darwin: path.join(
      rootDir,
      'node_modules',
      'electron',
      'dist',
      'Electron.app',
      'Contents',
      'MacOS',
      'Electron'
    ),
  };

  return binaryByPlatform[process.platform];
}

const electronBinary = resolveElectronBinary(projectRoot);

if (!electronBinary || !fs.existsSync(electronBinary)) {
  console.error('Electron binary was not found.');
  console.error('Install dependencies with a package manager that can resolve devDependencies,');
  console.error('or set ELECTRON_BINARY to an existing Electron executable.');
  process.exit(1);
}

const child = spawn(electronBinary, [projectRoot], {
  cwd: projectRoot,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
