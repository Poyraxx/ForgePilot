import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_NAME = 'ForgePilot';
const LEGACY_WINDOWS_APP_NAME = 'CokGizliCoder';
const LEGACY_HOME_DIRECTORY = '.cokgizlicoder';
const STATE_FILE_NAME = 'desktop-state.json';

function pathExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function uniqueShellCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.command}\u0000${candidate.args.join('\u0000')}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function resolvePosixStateDirectory() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  }

  const configHome = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), '.config');
  return path.join(configHome, APP_NAME);
}

function resolveWindowsStateDirectory() {
  const appDataRoot =
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appDataRoot, APP_NAME);
}

export function resolveDefaultStatePath() {
  const legacyPath =
    process.platform === 'win32'
      ? path.join(
          process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
          LEGACY_WINDOWS_APP_NAME,
          STATE_FILE_NAME
        )
      : path.join(os.homedir(), LEGACY_HOME_DIRECTORY, STATE_FILE_NAME);
  const preferredPath = path.join(
    process.platform === 'win32'
      ? resolveWindowsStateDirectory()
      : resolvePosixStateDirectory(),
    STATE_FILE_NAME
  );

  return pathExists(legacyPath) ? legacyPath : preferredPath;
}

export function resolveExternalScriptPath(targetPath) {
  const normalizedTargetPath = path.resolve(targetPath);
  if (!normalizedTargetPath.includes('app.asar')) {
    return normalizedTargetPath;
  }

  const candidates = [
    normalizedTargetPath.replace(
      `${path.sep}app.asar${path.sep}`,
      `${path.sep}app.asar.unpacked${path.sep}`
    ),
    normalizedTargetPath.replace('app.asar', 'app.asar.unpacked'),
  ];

  return candidates.find(pathExists) ?? normalizedTargetPath;
}

function resolveShellArgs(command) {
  const shellName = path.basename(command).toLowerCase();
  if (['bash', 'zsh', 'ksh', 'fish'].includes(shellName)) {
    return ['-lc'];
  }

  return ['-c'];
}

export function resolveShellCandidates() {
  if (process.platform === 'win32') {
    return [
      {
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      },
    ];
  }

  return uniqueShellCandidates(
    [
      process.env.SHELL
        ? {
            command: process.env.SHELL,
            args: resolveShellArgs(process.env.SHELL),
          }
        : null,
      { command: 'bash', args: ['-lc'] },
      { command: 'sh', args: ['-c'] },
    ].filter(Boolean)
  );
}

export function resolveAppIconPath(appRoot) {
  const iconPath = path.join(appRoot, 'ForgePilot.ico');
  return pathExists(iconPath) ? iconPath : null;
}
