import test from 'node:test';
import assert from 'node:assert/strict';

import { PermissionPreset } from '../src/core/contracts.js';
import { ToolRegistry } from '../src/core/tool-registry.js';
import { createWebTools } from '../src/core/tools/web.js';

function createContext() {
  return {
    workspaceRoot: process.cwd(),
    permissionPreset: PermissionPreset.FULL_ACCESS,
    sessionId: 'web-test-session',
  };
}

function createResponse({ text, url = 'https://example.com', status = 200, headers = {} }) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get(name) {
        return normalizedHeaders.get(String(name).toLowerCase()) ?? null;
      },
    },
    async text() {
      return text;
    },
  };
}

test('web_search parses public search results into tool output', async () => {
  const registry = new ToolRegistry(
    createWebTools({
      fetchImpl: async (url) => {
        assert.match(String(url), /duckduckgo/i);
        return createResponse({
          text: `
            <a class="result__a" href="https://example.com/alpha">Alpha result</a>
            <div class="result__snippet">Alpha snippet for the local agent workspace.</div>
            <a class="result__a" href="/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide">Docs guide</a>
            <div class="result__snippet">Official documentation guide.</div>
          `,
        });
      },
    })
  );

  const result = await registry.execute('web_search', { query: 'agent workspace' }, createContext());

  assert.equal(result.provider, 'duckduckgo');
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].title, 'Alpha result');
  assert.equal(result.results[0].url, 'https://example.com/alpha');
  assert.match(result.results[1].url, /docs\.example\.com\/guide/);
  assert.match(result.results[1].snippet, /Official documentation guide/i);
});

test('web_fetch converts html pages into readable text', async () => {
  const registry = new ToolRegistry(
    createWebTools({
      fetchImpl: async () =>
        createResponse({
          url: 'https://example.com/page',
          headers: {
            'content-type': 'text/html; charset=utf-8',
          },
          text: `
            <html>
              <head>
                <title>Example Page</title>
                <style>.hidden { display: none; }</style>
              </head>
              <body>
                <main>
                  <h1>Heading</h1>
                  <p>Hello <strong>world</strong>.</p>
                  <script>console.log('ignore me');</script>
                </main>
              </body>
            </html>
          `,
        }),
    })
  );

  const result = await registry.execute(
    'web_fetch',
    { url: 'https://example.com/page', maxChars: 2000 },
    createContext()
  );

  assert.equal(result.title, 'Example Page');
  assert.equal(result.url, 'https://example.com/page');
  assert.match(result.content, /Heading/);
  assert.match(result.content, /Hello world/);
  assert.doesNotMatch(result.content, /ignore me/);
});
