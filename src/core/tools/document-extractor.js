import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindAbortSignal, createAbortError, throwIfAborted } from '../abort.js';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCUMENT_READER_SCRIPT = path.join(TOOL_DIR, 'document-reader.py');
const STRUCTURED_DOCUMENT_FORMATS = new Map([
  ['.pdf', 'pdf'],
  ['.docx', 'docx'],
  ['.xlsx', 'xlsx'],
  ['.xlsm', 'xlsx'],
  ['.pptx', 'pptx'],
  ['.odt', 'odt'],
  ['.ods', 'ods'],
  ['.odp', 'odp'],
]);
const READABLE_FORMAT_DESCRIPTION =
  'PDF, DOCX, XLSX, PPTX, ODT/ODS/ODP, and plain-text files';

let pythonRuntimePromise = null;

function uniqueCandidates(candidates) {
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

function buildPythonCandidates() {
  const explicitPath = process.env.COKGIZLICODER_PYTHON_PATH ?? process.env.CODEX_PYTHON_PATH;
  const bundledBase = path.join(
    os.homedir(),
    '.cache',
    'codex-runtimes',
    'codex-primary-runtime',
    'dependencies',
    'python'
  );
  const bundledCandidates =
    process.platform === 'win32'
      ? [{ command: path.join(bundledBase, 'python.exe'), args: [] }]
      : [
          { command: path.join(bundledBase, 'bin', 'python3'), args: [] },
          { command: path.join(bundledBase, 'python3'), args: [] },
        ];
  const fallbackCandidates =
    process.platform === 'win32'
      ? [
          { command: 'python', args: [] },
          { command: 'py', args: ['-3'] },
        ]
      : [
          { command: 'python3', args: [] },
          { command: 'python', args: [] },
        ];

  return uniqueCandidates(
    [
      explicitPath ? { command: explicitPath, args: [] } : null,
      ...bundledCandidates,
      ...fallbackCandidates,
    ].filter(Boolean)
  );
}

function probePythonRuntime(candidate) {
  return new Promise((resolve) => {
    const child = spawn(
      candidate.command,
      [...candidate.args, '-c', 'import sys; print(sys.version_info[0])'],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env,
      }
    );

    let stdout = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.on('error', () => {
      resolve(false);
    });

    child.on('close', (code) => {
      resolve(code === 0 && stdout.trim() === '3');
    });
  });
}

async function locatePythonRuntime() {
  const candidates = buildPythonCandidates();

  for (const candidate of candidates) {
    if (await probePythonRuntime(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Structured document reading requires a Python 3 runtime. Set COKGIZLICODER_PYTHON_PATH or install Python 3.'
  );
}

export function getStructuredDocumentFormat(filePath) {
  return STRUCTURED_DOCUMENT_FORMATS.get(path.extname(filePath).toLowerCase()) ?? null;
}

export function supportsStructuredDocumentRead(filePath) {
  return Boolean(getStructuredDocumentFormat(filePath));
}

export function looksLikeBinary(buffer) {
  if (!buffer || buffer.length === 0) {
    return false;
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspiciousBytes = 0;

  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }

    const isControlCharacter = byte < 7 || (byte > 14 && byte < 32);
    if (isControlCharacter) {
      suspiciousBytes += 1;
    }
  }

  return suspiciousBytes / sample.length > 0.12;
}

export async function readUtf8FileWithBinaryGuard(targetPath) {
  const buffer = await fs.readFile(targetPath);

  if (looksLikeBinary(buffer)) {
    throw new Error(
      `This file appears to be binary. Use fs_read with ${READABLE_FORMAT_DESCRIPTION}, or convert the file to a text-friendly format first.`
    );
  }

  return buffer.toString('utf8');
}

export async function resolveDocumentPythonRuntime() {
  pythonRuntimePromise ??= locatePythonRuntime();
  return pythonRuntimePromise;
}

export async function extractStructuredDocumentText(targetPath, signal) {
  const runtime = await resolveDocumentPythonRuntime();

  return new Promise((resolve, reject) => {
    throwIfAborted(signal, 'Document read stopped by user.');

    const child = spawn(runtime.command, [...runtime.args, DOCUMENT_READER_SCRIPT, targetPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
    });

    let stdout = '';
    let stderr = '';
    let aborted = false;
    let settled = false;

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
        finish(reject, createAbortError('Document read stopped by user.'));
        return;
      }

      if (code !== 0) {
        finish(
          reject,
          new Error(stderr.trim() || `Document reader failed with exit code ${code ?? -1}.`)
        );
        return;
      }

      try {
        const payload = JSON.parse(stdout);
        if (!payload || typeof payload.content !== 'string') {
          throw new Error('Document reader returned an invalid payload.');
        }

        finish(resolve, payload);
      } catch (error) {
        finish(reject, error);
      }
    });
  });
}

export function describeReadableFormats() {
  return READABLE_FORMAT_DESCRIPTION;
}
