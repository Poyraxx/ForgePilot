import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolRegistry } from '../src/core/tool-registry.js';
import { createWebTools } from '../src/core/tools/web.js';

function createContext() {
  return {
    workspaceRoot: process.cwd(),
    permissionPreset: 'full_access',
    sessionId: 'web-test-session',
  };
}

test('web_fetch reports a helpful 403 message', async () => {
  const registry = new ToolRegistry(
    createWebTools({
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        url: 'https://example.com/protected',
        text: async () => 'forbidden',
        headers: { get: () => 'text/html' },
      }),
    })
  );

  await assert.rejects(
    () => registry.execute('web_fetch', { url: 'https://example.com/protected' }, createContext()),
    /blocked with status 403/i
  );
});

test('web_fetch reports a helpful 404 message', async () => {
  const registry = new ToolRegistry(
    createWebTools({
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        url: 'https://example.com/missing',
        text: async () => 'missing',
        headers: { get: () => 'text/html' },
      }),
    })
  );

  await assert.rejects(
    () => registry.execute('web_fetch', { url: 'https://example.com/missing' }, createContext()),
    /failed with status 404/i
  );
});
