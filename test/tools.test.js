import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PermissionPreset } from '../src/core/contracts.js';
import { ToolRegistry } from '../src/core/tool-registry.js';
import { resolveDocumentPythonRuntime } from '../src/core/tools/document-extractor.js';
import { createBuiltInTools } from '../src/core/tools/index.js';

async function createWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cokgizlicoder-tools-'));
}

function createContext(workspaceRoot, permissionPreset = PermissionPreset.FULL_ACCESS) {
  return {
    workspaceRoot,
    permissionPreset,
    sessionId: 'test-session',
  };
}

async function runPythonSnippet(source, args = []) {
  const runtime = await resolveDocumentPythonRuntime();

  return new Promise((resolve, reject) => {
    const child = spawn(runtime.command, [...runtime.args, '-', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Python exited with code ${code ?? -1}.`));
        return;
      }

      resolve({ stdout, stderr });
    });

    child.stdin.end(source);
  });
}

async function createStructuredFixtures(workspaceRoot) {
  const fixtureScript = `
import sys
from pathlib import Path

from docx import Document
from openpyxl import Workbook

def make_pdf(text, destination):
    objects = []

    def add(body):
        objects.append(body)

    add("<< /Type /Catalog /Pages 2 0 R >>")
    add("<< /Type /Pages /Count 1 /Kids [3 0 R] >>")
    add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>")
    stream = f"BT\\n/F1 18 Tf\\n72 720 Td\\n({text}) Tj\\nET"
    add(f"<< /Length {len(stream.encode('latin-1'))} >>\\nstream\\n{stream}\\nendstream")
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    pdf_lines = ["%PDF-1.4"]
    offsets = [0]

    for index, body in enumerate(objects, start=1):
        current_offset = sum(len((line + "\\n").encode("latin-1")) for line in pdf_lines)
        offsets.append(current_offset)
        pdf_lines.append(f"{index} 0 obj")
        pdf_lines.append(body)
        pdf_lines.append("endobj")

    xref_offset = sum(len((line + "\\n").encode("latin-1")) for line in pdf_lines)
    pdf_lines.append("xref")
    pdf_lines.append(f"0 {len(objects) + 1}")
    pdf_lines.append("0000000000 65535 f ")

    for offset in offsets[1:]:
        pdf_lines.append(f"{offset:010d} 00000 n ")

    pdf_lines.append("trailer")
    pdf_lines.append(f"<< /Root 1 0 R /Size {len(objects) + 1} >>")
    pdf_lines.append("startxref")
    pdf_lines.append(str(xref_offset))
    pdf_lines.append("%%EOF")
    destination.write_bytes("\\n".join(pdf_lines).encode("latin-1"))


root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)

document = Document()
document.add_paragraph("Hello DOCX world")
document.add_paragraph("Second document paragraph")
document.save(root / "report.docx")

workbook = Workbook()
sheet = workbook.active
sheet.title = "Summary"
sheet["A1"] = "Metric"
sheet["B1"] = "Value"
sheet["A2"] = "alpha"
sheet["B2"] = 42
workbook.save(root / "metrics.xlsx")

make_pdf("Hello PDF world", root / "manual.pdf")
`;

  await runPythonSnippet(fixtureScript, [workspaceRoot]);
}

test('built-in tools can write, read, patch, search, and delete files', async () => {
  const workspaceRoot = await createWorkspace();
  const registry = new ToolRegistry(createBuiltInTools());
  const context = createContext(workspaceRoot);

  const writeResult = await registry.execute(
    'fs_write',
    { path: 'notes.txt', content: 'alpha\nbeta' },
    context
  );
  assert.equal(writeResult.created, true);

  const readResult = await registry.execute('fs_read', { path: 'notes.txt' }, context);
  assert.match(readResult.content, /alpha/);

  const patchResult = await registry.execute(
    'fs_patch',
    { path: 'notes.txt', oldText: 'beta', newText: 'gamma' },
    context
  );
  assert.equal(patchResult.replacements, 1);

  const searchResult = await registry.execute(
    'search_text',
    { query: 'gamma', path: '.' },
    context
  );
  assert.equal(searchResult.results.length > 0, true);

  const commandResult = await registry.execute(
    'run_command',
    { command: process.platform === 'win32' ? 'Write-Output "ok"' : 'printf ok' },
    context
  );
  assert.equal(commandResult.exitCode, 0);
  assert.match(commandResult.stdout, /ok/);

  await registry.execute('fs_delete', { path: 'notes.txt' }, context);
  await assert.rejects(() => fs.readFile(path.join(workspaceRoot, 'notes.txt'), 'utf8'));
});

test('fs_patch rejects empty oldText and tells the model to use fs_write for full replacement', async () => {
  const workspaceRoot = await createWorkspace();
  const registry = new ToolRegistry(createBuiltInTools());
  const context = createContext(workspaceRoot);

  await registry.execute(
    'fs_write',
    { path: 'notes.txt', content: 'alpha\nbeta\ngamma' },
    context
  );

  await assert.rejects(
    () =>
      registry.execute(
        'fs_patch',
        { path: 'notes.txt', oldText: '', newText: 'completely replaced' },
        context
      ),
    /use fs_write if you want to replace the whole file/i
  );
});

test('fs_read reports a helpful error for missing files', async () => {
  const workspaceRoot = await createWorkspace();
  const registry = new ToolRegistry(createBuiltInTools());
  const context = createContext(workspaceRoot);

  await registry.execute('fs_write', { path: 'README.md', content: 'hello' }, context);

  await assert.rejects(
    () => registry.execute('fs_read', { path: 'main.py' }, context),
    /Use fs_list or search_text to discover real paths before calling fs_read/
  );
});

test('fs_read can extract text from PDF, DOCX, and XLSX files', async () => {
  const workspaceRoot = await createWorkspace();
  await createStructuredFixtures(workspaceRoot);

  const registry = new ToolRegistry(createBuiltInTools());
  const context = createContext(workspaceRoot);

  const pdfResult = await registry.execute('fs_read', { path: 'manual.pdf' }, context);
  assert.equal(pdfResult.extracted, true);
  assert.equal(pdfResult.format, 'pdf');
  assert.match(pdfResult.content, /Hello PDF world/);

  const docxResult = await registry.execute('fs_read', { path: 'report.docx' }, context);
  assert.equal(docxResult.extracted, true);
  assert.equal(docxResult.format, 'docx');
  assert.match(docxResult.content, /Hello DOCX world/);

  const xlsxResult = await registry.execute('fs_read', { path: 'metrics.xlsx' }, context);
  assert.equal(xlsxResult.extracted, true);
  assert.equal(xlsxResult.format, 'xlsx');
  assert.match(xlsxResult.content, /Metric/);
  assert.match(xlsxResult.content, /alpha/);
});

test('fs_read rejects unsupported binary files with a helpful message', async () => {
  const workspaceRoot = await createWorkspace();
  const registry = new ToolRegistry(createBuiltInTools());
  const context = createContext(workspaceRoot);

  await fs.writeFile(path.join(workspaceRoot, 'image.bin'), Buffer.from([0, 1, 2, 3, 255]));

  await assert.rejects(
    () => registry.execute('fs_read', { path: 'image.bin' }, context),
    /This file appears to be binary/
  );
});

test('fs_read and search_text can resolve attachment aliases', async () => {
  const workspaceRoot = await createWorkspace();
  const registry = new ToolRegistry(createBuiltInTools());
  const hiddenAttachmentPath = path.join(
    workspaceRoot,
    '.cokgizlicoder',
    'attachments',
    'session-1',
    'report.txt'
  );
  await fs.mkdir(path.dirname(hiddenAttachmentPath), { recursive: true });
  await fs.writeFile(hiddenAttachmentPath, 'alpha\nbeta\ngamma', 'utf8');

  const context = {
    ...createContext(workspaceRoot),
    attachments: [
      {
        id: 'attachment-1',
        name: 'report.txt',
        originalName: 'report.txt',
        path: '.cokgizlicoder/attachments/session-1/report.txt',
        mimeType: 'text/plain',
        size: 16,
      },
    ],
  };

  const readResult = await registry.execute(
    'fs_read',
    { path: 'C:\\external\\folder\\report.txt' },
    context
  );
  assert.match(readResult.content, /alpha/);

  const readByBasenameResult = await registry.execute('fs_read', { path: 'report.txt' }, context);
  assert.match(readByBasenameResult.content, /beta/);

  const searchResult = await registry.execute(
    'search_text',
    { query: 'gamma', path: 'C:\\external\\folder\\report.txt' },
    context
  );
  assert.equal(searchResult.results.length, 1);
  assert.equal(searchResult.results[0].path, '.cokgizlicoder/attachments/session-1/report.txt');
});
