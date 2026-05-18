import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry } from '../src/core/tool-registry.js';
import { createWebTools } from '../src/core/tools/web.js';

function createContext() {
  return {
    workspaceRoot: process.cwd(),
    permissionPreset: 'full_access',
    sessionId: 'web-structure-test',
  };
}

test('web_fetch returns structure-first metadata for HTML pages', async () => {
  const html = `
    <html>
      <head>
        <title>ForgePilot Docs</title>
        <meta name="description" content="Install and run ForgePilot on Linux and macOS." />
        <link rel="canonical" href="/docs/install" />
      </head>
      <body>
        <h1>Install ForgePilot</h1>
        <p>Use the matching package for your operating system.</p>
        <h2>Linux</h2>
        <a href="/docs/linux">Linux guide</a>
        <h2>macOS</h2>
        <a href="https://example.com/docs/macos">macOS guide</a>
      </body>
    </html>
  `;
  const registry = new ToolRegistry(
    createWebTools({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: 'https://example.com/docs/index',
        text: async () => html,
        headers: { get: () => 'text/html; charset=utf-8' },
      }),
    })
  );

  const result = await registry.execute(
    'web_fetch',
    { url: 'https://example.com/docs/index' },
    createContext()
  );

  assert.equal(result.title, 'ForgePilot Docs');
  assert.equal(result.description, 'Install and run ForgePilot on Linux and macOS.');
  assert.equal(result.canonicalUrl, 'https://example.com/docs/install');
  assert.deepEqual(result.headings, [
    { level: 1, text: 'Install ForgePilot' },
    { level: 2, text: 'Linux' },
    { level: 2, text: 'macOS' },
  ]);
  assert.deepEqual(result.links, [
    { text: 'Linux guide', url: 'https://example.com/docs/linux' },
    { text: 'macOS guide', url: 'https://example.com/docs/macos' },
  ]);
  assert.match(result.content, /Use the matching package/);
});
