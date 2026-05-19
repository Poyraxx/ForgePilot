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

test('browser_fetch uses the browser-backed implementation when requested', async () => {
  const registry = new ToolRegistry(
    createWebTools({
      browserFetchImpl: async (_context, args) => ({
        url: args.url,
        title: 'Rendered ForgePilot Guide',
        description: 'A browser-rendered page.',
        canonicalUrl: args.url,
        content: 'Rendered content from a JavaScript-heavy page.',
        totalChars: 42,
        truncated: false,
        headings: [{ level: 1, text: 'Rendered ForgePilot Guide' }],
        links: [{ text: 'Docs', url: 'https://example.com/docs' }],
        contentType: 'text/html',
        browserRendered: true,
        screenshotPath: '.cokgizlicoder/browser-fetch/web-structure-test/rendered.png',
        engine: 'electron',
        waitMs: 1500,
      }),
    })
  );

  const result = await registry.execute(
    'browser_fetch',
    { url: 'https://example.com/heavy-page', captureScreenshot: true },
    createContext()
  );

  assert.equal(result.browserRendered, true);
  assert.equal(result.engine, 'electron');
  assert.equal(result.title, 'Rendered ForgePilot Guide');
  assert.equal(result.screenshotPath, '.cokgizlicoder/browser-fetch/web-structure-test/rendered.png');
  assert.deepEqual(result.headings, [{ level: 1, text: 'Rendered ForgePilot Guide' }]);
});

test('web_search filters out 403 and 404 results when a healthy source exists', async () => {
  const searchHtml = `
    <html>
      <body>
        <a class="result__a" href="https://good.example.com/article">Healthy source</a>
        <a class="result__a" href="https://missing.example.com/article">Missing source</a>
        <a class="result__a" href="https://blocked.example.com/article">Blocked source</a>
      </body>
    </html>
  `;

  const registry = new ToolRegistry(
    createWebTools({
      fetchImpl: async (url, options = {}) => {
        if (String(url).startsWith('https://html.duckduckgo.com/html/')) {
          return {
            ok: true,
            status: 200,
            url,
            text: async () => searchHtml,
            headers: { get: () => 'text/html; charset=utf-8' },
          };
        }

        const method = String(options.method ?? 'GET').toUpperCase();
        const responseByUrl = {
          'https://good.example.com/article': 200,
          'https://missing.example.com/article': 404,
          'https://blocked.example.com/article': 403,
        };
        const status = responseByUrl[String(url)] ?? 500;

        return {
          ok: status >= 200 && status < 300,
          status,
          url,
          body: {
            cancel: async () => {},
          },
          text: async () => '',
          headers: { get: () => (method === 'HEAD' ? '' : 'text/html; charset=utf-8') },
        };
      },
    })
  );

  const result = await registry.execute(
    'web_search',
    { query: 'referee technology', maxResults: 3 },
    createContext()
  );

  assert.deepEqual(result.results.map((item) => item.url), ['https://good.example.com/article']);
  assert.equal(result.filteredInaccessibleResults, 2);
});

test('web_search returns no results when every probed result is blocked or missing', async () => {
  const searchHtml = `
    <html>
      <body>
        <a class="result__a" href="https://missing.example.com/article">Missing source</a>
        <a class="result__a" href="https://blocked.example.com/article">Blocked source</a>
      </body>
    </html>
  `;

  const registry = new ToolRegistry(
    createWebTools({
      fetchImpl: async (url) => {
        if (String(url).startsWith('https://html.duckduckgo.com/html/')) {
          return {
            ok: true,
            status: 200,
            url,
            text: async () => searchHtml,
            headers: { get: () => 'text/html; charset=utf-8' },
          };
        }

        const responseByUrl = {
          'https://missing.example.com/article': 404,
          'https://blocked.example.com/article': 403,
        };
        const status = responseByUrl[String(url)] ?? 500;

        return {
          ok: status >= 200 && status < 300,
          status,
          url,
          body: {
            cancel: async () => {},
          },
          text: async () => '',
          headers: { get: () => 'text/html; charset=utf-8' },
        };
      },
    })
  );

  const result = await registry.execute(
    'web_search',
    { query: 'football referee technology', maxResults: 3 },
    createContext()
  );

  assert.deepEqual(result.results, []);
  assert.equal(result.filteredInaccessibleResults, 2);
  assert.equal(result.inaccessibleResultsDetected, true);
});

test('web_fetch falls back to browser_fetch when a page blocks normal requests', async () => {
  const registry = new ToolRegistry(
    createWebTools({
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        url: 'https://example.com/protected',
        text: async () => '',
        headers: { get: () => 'text/html; charset=utf-8' },
      }),
      browserFetchImpl: async (_context, args) => ({
        url: args.url,
        title: 'Rendered protected page',
        description: 'Recovered through the browser fallback.',
        canonicalUrl: args.url,
        content: 'Readable content from a protected page.',
        totalChars: 39,
        truncated: false,
        headings: [{ level: 1, text: 'Rendered protected page' }],
        links: [],
        contentType: 'text/html',
        browserRendered: true,
        screenshotPath: null,
        engine: 'electron',
        waitMs: 1500,
      }),
    })
  );

  const result = await registry.execute(
    'web_fetch',
    { url: 'https://example.com/protected' },
    createContext()
  );

  assert.equal(result.browserRendered, true);
  assert.equal(result.title, 'Rendered protected page');
  assert.match(result.content, /Readable content/);
});

test('web_fetch explains DNS resolution failures with a source-hunting hint', async () => {
  const registry = new ToolRegistry(
    createWebTools({
      fetchImpl: async () => {
        const error = new Error('fetch failed');
        error.cause = { code: 'ENOTFOUND' };
        throw error;
      },
    })
  );

  await assert.rejects(
    () =>
      registry.execute(
        'web_fetch',
        { url: 'https://www.courts.gov/about/technology/innovation/innovation-initiatives' },
        createContext()
      ),
    /domain could not be resolved|alternative source/i
  );
});

test('web_search unwraps DuckDuckGo redirect links into the real target URL', async () => {
  const searchHtml = `
    <html>
      <body>
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Freal-article&rut=test">Real source</a>
      </body>
    </html>
  `;

  const registry = new ToolRegistry(
    createWebTools({
      fetchImpl: async (url) => {
        if (String(url).startsWith('https://html.duckduckgo.com/html/')) {
          return {
            ok: true,
            status: 200,
            url,
            text: async () => searchHtml,
            headers: { get: () => 'text/html; charset=utf-8' },
          };
        }

        return {
          ok: true,
          status: 200,
          url,
          body: {
            cancel: async () => {},
          },
          text: async () => '',
          headers: { get: () => 'text/html; charset=utf-8' },
        };
      },
    })
  );

  const result = await registry.execute(
    'web_search',
    { query: 'redirect unwrap', maxResults: 3 },
    createContext()
  );

  assert.equal(result.results[0]?.url, 'https://example.com/real-article');
});
