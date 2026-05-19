import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { bindAbortSignal, createAbortError, isAbortError, throwIfAborted } from '../abort.js';
import { createToolDefinition } from '../contracts.js';
import { resolveWorkspacePath, relativizeWorkspacePath } from '../path-guard.js';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const DEFAULT_MAX_SEARCH_RESULTS = 6;
const DEFAULT_MAX_PROBED_SEARCH_RESULTS = 8;
const DEFAULT_MAX_FETCH_CHARS = 12_000;
const DEFAULT_BROWSER_WAIT_MS = 600;
const DEFAULT_BROWSER_LOAD_TIMEOUT_MS = 6_000;
const DEFAULT_HEADERS = Object.freeze({
  'user-agent': 'ForgePilot/1.0 (+local desktop agent workspace)',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
});

function decodeHtmlEntities(value = '') {
  return String(value).replace(
    /&(#x?[0-9a-f]+|[a-z]+);/gi,
    (entity, token) => {
      const normalized = token.toLowerCase();

      if (normalized === 'amp') {
        return '&';
      }

      if (normalized === 'lt') {
        return '<';
      }

      if (normalized === 'gt') {
        return '>';
      }

      if (normalized === 'quot') {
        return '"';
      }

      if (normalized === 'apos' || normalized === '#39') {
        return "'";
      }

      if (normalized.startsWith('#x')) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
      }

      if (normalized.startsWith('#')) {
        return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
      }

      return entity;
    }
  );
}

function stripTags(value = '') {
  return decodeHtmlEntities(String(value).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeQuery(args) {
  const query = String(args?.query ?? '').trim();
  const site = String(args?.site ?? '').trim();

  if (!query) {
    throw new Error('web_search requires a non-empty query.');
  }

  return {
    rawQuery: query,
    composedQuery: [query, site ? `site:${site}` : ''].filter(Boolean).join(' '),
    site,
  };
}

function unwrapDuckDuckGoUrl(rawUrl = '') {
  let decoded = decodeHtmlEntities(String(rawUrl).trim());

  if (!decoded) {
    return '';
  }

  if (decoded.startsWith('//')) {
    decoded = `https:${decoded}`;
  }

  if (decoded.startsWith('/l/?')) {
    const params = new URLSearchParams(decoded.slice(decoded.indexOf('?') + 1));
    const redirected = params.get('uddg');
    if (redirected) {
      return decodeURIComponent(redirected);
    }
  }

  try {
    const parsed = new URL(decoded, 'https://duckduckgo.com');
    const isDuckDuckGoRedirect =
      /(^|\.)duckduckgo\.com$/i.test(parsed.hostname) &&
      parsed.pathname.startsWith('/l/');

    if (isDuckDuckGoRedirect) {
      const redirected = parsed.searchParams.get('uddg');
      if (redirected) {
        return decodeURIComponent(redirected);
      }
    }

    return parsed.toString();
  } catch {
    return decoded;
  }
}

async function fetchText(url, { fetchImpl, signal, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is not available.');
  }

  throwIfAborted(signal, 'Web request stopped by user.');

  const controller = new AbortController();
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const disposeAbort = bindAbortSignal(signal, () => controller.abort());

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        ...DEFAULT_HEADERS,
        ...headers,
      },
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      const finalUrl = response.url || url;
      if (response.status === 403) {
        throw new Error(
          `Web request was blocked with status 403 at ${finalUrl}. The site may require a real browser or anti-bot clearance. Try web_search and fetch a different source.`
        );
      }

      if (response.status === 404) {
        throw new Error(
          `Web request failed with status 404 at ${finalUrl}. The page may have moved or been removed. Try web_search to find an updated URL.`
        );
      }

      throw new Error(`Web request failed with status ${response.status} at ${finalUrl}.`);
    }

    return { response, text };
  } catch (error) {
    if (timedOut) {
      throw createAbortError('Web request timed out.');
    }

    if (isAbortError(error) || controller.signal.aborted) {
      throw createAbortError('Web request stopped by user.');
    }

    const networkCode = error?.cause?.code ?? error?.code ?? null;
    if (networkCode === 'ENOTFOUND') {
      throw new Error(
        `Web request failed because the domain could not be resolved for ${url}. The site may be unavailable, misspelled, or blocked by DNS. Try web_search to find an alternative source.`
      );
    }

    if (networkCode === 'ECONNREFUSED') {
      throw new Error(
        `Web request was refused by ${url}. The site may be blocking automated requests. Try browser_fetch or find another source with web_search.`
      );
    }

    if (networkCode === 'ECONNRESET' || networkCode === 'UND_ERR_SOCKET') {
      throw new Error(
        `Web request connection was interrupted while loading ${url}. Try browser_fetch or pick another source from web_search.`
      );
    }

    if (error?.message === 'fetch failed') {
      throw new Error(
        `Web request failed while loading ${url}. The site may be blocking the request or may be temporarily unavailable. Try browser_fetch or find another source with web_search.`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
    disposeAbort();
  }
}

async function probeWebUrl(
  fetchImpl,
  rawUrl,
  signal,
  { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}
) {
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      status: null,
      url: String(rawUrl ?? ''),
      reason: 'fetch_unavailable',
    };
  }

  throwIfAborted(signal, 'Web request stopped by user.');

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const disposeAbort = bindAbortSignal(signal, () => controller.abort());

  async function performProbe(method) {
    const response = await fetchImpl(rawUrl, {
      method,
      redirect: 'follow',
      headers: {
        ...DEFAULT_HEADERS,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.6',
      },
      signal: controller.signal,
    });

    try {
      await response.body?.cancel?.();
    } catch {
      // Ignore body cancellation failures for probe requests.
    }

    return response;
  }

  try {
    const response = await performProbe('GET');

    return {
      ok: response.ok,
      status: response.status,
      url: response.url || String(rawUrl ?? ''),
      reason: response.ok ? 'ok' : 'http_error',
    };
  } catch (error) {
    if (timedOut) {
      return {
        ok: false,
        status: null,
        url: String(rawUrl ?? ''),
        reason: 'timeout',
      };
    }

    if (isAbortError(error) || controller.signal.aborted) {
      throwIfAborted(signal, 'Web request stopped by user.');
      return {
        ok: false,
        status: null,
        url: String(rawUrl ?? ''),
        reason: 'aborted',
      };
    }

    return {
      ok: false,
      status: null,
      url: String(rawUrl ?? ''),
      reason: error?.cause?.code ?? error?.code ?? 'network_error',
    };
  } finally {
    clearTimeout(timeoutId);
    disposeAbort();
  }
}

function flattenDuckDuckGoTopics(topics = []) {
  const flattened = [];

  for (const topic of topics) {
    if (Array.isArray(topic?.Topics)) {
      flattened.push(...flattenDuckDuckGoTopics(topic.Topics));
      continue;
    }

    if (topic?.FirstURL && topic?.Text) {
      flattened.push(topic);
    }
  }

  return flattened;
}

function parseDuckDuckGoHtml(rawHtml, maxResults) {
  const results = [];
  const seenUrls = new Set();
  const anchorPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorPattern.exec(rawHtml)) && results.length < maxResults) {
    const url = unwrapDuckDuckGoUrl(match[1]);
    const title = stripTags(match[2]);

    if (!url || !title || seenUrls.has(url)) {
      continue;
    }

    const windowHtml = rawHtml.slice(match.index, Math.min(rawHtml.length, anchorPattern.lastIndex + 1600));
    const snippetMatch = windowHtml.match(/result__snippet[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);

    seenUrls.add(url);
    results.push({
      id: `web_result_${randomUUID()}`,
      title,
      url,
      snippet: stripTags(snippetMatch?.[1] ?? ''),
    });
  }

  return results;
}

async function searchWithInstantAnswerApi(fetchImpl, args, signal) {
  const query = normalizeQuery(args);
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query.composedQuery)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
  const { text } = await fetchText(url, {
    fetchImpl,
    signal,
    headers: {
      accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
    },
  });
  const payload = JSON.parse(text);
  const maxResults = Math.max(1, Math.min(10, Number(args?.maxResults) || DEFAULT_MAX_SEARCH_RESULTS));
  const flattened = flattenDuckDuckGoTopics([
    ...(payload.Results ?? []),
    ...(payload.RelatedTopics ?? []),
  ]);
  const results = flattened.slice(0, maxResults).map((item) => ({
    id: `web_result_${randomUUID()}`,
    title: stripTags(String(item.Text ?? '').split(' - ')[0] || item.FirstURL || 'Web result'),
    url: item.FirstURL,
    snippet: stripTags(item.Text ?? ''),
  }));

  return {
    query: query.rawQuery,
    site: query.site || undefined,
    provider: 'duckduckgo',
    results,
    truncated: flattened.length > results.length,
  };
}

async function searchTheWeb(fetchImpl, args, signal) {
  const query = normalizeQuery(args);
  const maxResults = Math.max(1, Math.min(10, Number(args?.maxResults) || DEFAULT_MAX_SEARCH_RESULTS));
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.composedQuery)}`;
  const { text } = await fetchText(url, { fetchImpl, signal });
  const results = parseDuckDuckGoHtml(
    text,
    Math.max(maxResults, DEFAULT_MAX_PROBED_SEARCH_RESULTS)
  );

  if (results.length > 0) {
    const probedCount = Math.min(results.length, DEFAULT_MAX_PROBED_SEARCH_RESULTS);
    const probedResults = await Promise.all(
      results.slice(0, probedCount).map(async (result) => ({
        ...result,
        availability: await probeWebUrl(fetchImpl, result.url, signal),
      }))
    );
    const remainingResults = results.slice(probedCount).map((result) => ({
      ...result,
      availability: null,
    }));
    const combinedResults = [...probedResults, ...remainingResults];
    const preferredResults = combinedResults.filter((result) => {
      const status = Number(result.availability?.status);
      return !Number.isFinite(status) || ![403, 404].includes(status);
    });
    const finalResults = preferredResults.slice(0, maxResults);

    return {
      query: query.rawQuery,
      site: query.site || undefined,
      provider: 'duckduckgo',
      results: finalResults,
      filteredInaccessibleResults: combinedResults.length - finalResults.length,
      inaccessibleResultsDetected:
        combinedResults.length > 0 && finalResults.length === 0,
      truncated: combinedResults.length > finalResults.length,
    };
  }

  return searchWithInstantAnswerApi(fetchImpl, args, signal);
}

function extractHtmlTitle(rawHtml) {
  const titleMatch = String(rawHtml).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return stripTags(titleMatch?.[1] ?? '');
}

function extractMetaDescription(rawHtml) {
  const match = String(rawHtml).match(
    /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i
  );
  return stripTags(match?.[1] ?? '');
}

function extractCanonicalUrl(rawHtml, baseUrl) {
  const match = String(rawHtml).match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([\s\S]*?)["'][^>]*>/i
  );
  const rawValue = decodeHtmlEntities(match?.[1] ?? '').trim();

  if (!rawValue) {
    return baseUrl;
  }

  try {
    return new URL(rawValue, baseUrl).toString();
  } catch {
    return baseUrl;
  }
}

function extractHtmlHeadings(rawHtml, limit = 12) {
  const headings = [];
  const pattern = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;

  while ((match = pattern.exec(String(rawHtml))) && headings.length < limit) {
    const text = stripTags(match[2]);
    if (!text) {
      continue;
    }

    headings.push({
      level: Number(match[1][1]),
      text,
    });
  }

  return headings;
}

function extractHtmlLinks(rawHtml, baseUrl, limit = 12) {
  const links = [];
  const seen = new Set();
  const pattern = /<a[^>]+href=["']([\s\S]*?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = pattern.exec(String(rawHtml))) && links.length < limit) {
    const href = decodeHtmlEntities(match[1]).trim();
    const text = stripTags(match[2]);
    if (!href) {
      continue;
    }

    let url = href;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    if (seen.has(url)) {
      continue;
    }

    seen.add(url);
    links.push({
      text: text || url,
      url,
    });
  }

  return links;
}

function htmlToText(rawHtml = '') {
  return decodeHtmlEntities(
    String(rawHtml)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|aside|main|header|footer|li|ul|ol|h1|h2|h3|h4|h5|h6|pre|blockquote|tr|table)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function validateWebUrl(rawUrl) {
  let parsedUrl;

  try {
    parsedUrl = new URL(String(rawUrl ?? ''));
  } catch {
    throw new Error('web_fetch requires a valid absolute URL.');
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('web_fetch only supports http and https URLs.');
  }

  return parsedUrl;
}

function shouldAutoBrowserFallback(error) {
  const message = String(error?.message ?? '').trim();

  if (!message) {
    return false;
  }

  if (/status 404/i.test(message) || /domain could not be resolved/i.test(message)) {
    return false;
  }

  return /status 403|blocking automated requests|connection was interrupted|was refused/i.test(
    message
  );
}

async function fetchWebPage(fetchImpl, browserFetchImpl, context, args, signal) {
  const parsedUrl = validateWebUrl(args?.url);
  const maxChars = Math.max(
    500,
    Math.min(50_000, Number(args?.maxChars) || DEFAULT_MAX_FETCH_CHARS)
  );
  try {
    const { response, text } = await fetchText(parsedUrl.toString(), {
      fetchImpl,
      signal,
      headers: {
        accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.8',
      },
    });
    const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
    const isHtml = contentType.includes('text/html');
    const finalUrl = response.url || parsedUrl.toString();
    const title = isHtml ? extractHtmlTitle(text) || parsedUrl.hostname : parsedUrl.hostname;
    const content = isHtml ? htmlToText(text) : text.trim();
    const description = isHtml ? extractMetaDescription(text) : '';
    const canonicalUrl = isHtml ? extractCanonicalUrl(text, finalUrl) : finalUrl;
    const headings = isHtml ? extractHtmlHeadings(text) : [];
    const links = isHtml ? extractHtmlLinks(text, finalUrl) : [];

    return {
      url: finalUrl,
      title,
      description,
      canonicalUrl,
      content: content.slice(0, maxChars),
      contentType,
      totalChars: content.length,
      truncated: content.length > maxChars,
      headings,
      links,
    };
  } catch (error) {
    if (
      typeof browserFetchImpl === 'function' &&
      shouldAutoBrowserFallback(error)
    ) {
      try {
        return await browserFetchImpl(context, {
          url: parsedUrl.toString(),
          maxChars,
          waitMs: DEFAULT_BROWSER_WAIT_MS,
          captureScreenshot: false,
        });
      } catch {
        // Fall back to the original fetch error if browser rendering also fails.
      }
    }

    throw error;
  }
}

function clampInteger(value, fallback, min, max) {
  const normalized = Number.parseInt(value ?? fallback, 10);
  if (!Number.isFinite(normalized)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, normalized));
}

function sanitizeBrowserArtifactName(value = '') {
  return String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'page';
}

async function createBrowserFetchScreenshot(context, imageBuffer, pageUrl) {
  if (!context?.workspaceRoot || !imageBuffer) {
    return null;
  }

  const relativeDirectory = path.join(
    '.cokgizlicoder',
    'browser-fetch',
    context.sessionId || 'session'
  );
  const absoluteDirectory = resolveWorkspacePath(context.workspaceRoot, relativeDirectory);
  await fs.mkdir(absoluteDirectory, { recursive: true });

  const fileName = `${sanitizeBrowserArtifactName(new URL(pageUrl).hostname)}-${randomUUID()}.png`;
  const absolutePath = path.join(absoluteDirectory, fileName);
  await fs.writeFile(absolutePath, imageBuffer);
  return relativizeWorkspacePath(context.workspaceRoot, absolutePath).replace(/\\/g, '/');
}

async function browserFetchWithElectron(context, args) {
  const { BrowserWindow, app } = await import('electron');
  if (!BrowserWindow || !app) {
    throw new Error('browser_fetch is only available inside the desktop runtime.');
  }

  await app.whenReady();
  throwIfAborted(context.signal, 'Browser fetch stopped by user.');

  const parsedUrl = validateWebUrl(args?.url);
  const maxChars = Math.max(
    500,
    Math.min(50_000, Number(args?.maxChars) || DEFAULT_MAX_FETCH_CHARS)
  );
  const waitMs = clampInteger(args?.waitMs, DEFAULT_BROWSER_WAIT_MS, 0, 10_000);

  const browserWindow = new BrowserWindow({
    show: false,
    width: 1440,
    height: 1100,
    backgroundColor: '#111317',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      javascript: true,
      images: true,
      offscreen: true,
    },
  });

  let aborted = false;
  const disposeAbort = bindAbortSignal(context.signal, () => {
    aborted = true;
    try {
      browserWindow.destroy();
    } catch {
      // Ignore cleanup failures.
    }
  });

  try {
    await new Promise((resolve, reject) => {
      const loadTimeoutId = setTimeout(() => {
        browserWindow.webContents.removeListener('did-fail-load', handleFail);
        browserWindow.webContents.removeListener('did-finish-load', handleReady);
        reject(
          new Error(
            `Browser fetch timed out while loading ${parsedUrl.toString()}. The site may be too slow or blocked.`
          )
        );
      }, DEFAULT_BROWSER_LOAD_TIMEOUT_MS);

      const handleFail = (_event, _code, description, validatedUrl, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }
        clearTimeout(loadTimeoutId);
        reject(new Error(`Browser fetch failed to load ${validatedUrl || parsedUrl.toString()}: ${description}`));
      };

      const handleReady = () => {
        clearTimeout(loadTimeoutId);
        browserWindow.webContents.removeListener('did-fail-load', handleFail);
        resolve();
      };

      browserWindow.webContents.once('did-finish-load', handleReady);
      browserWindow.webContents.on('did-fail-load', handleFail);
      void browserWindow.loadURL(parsedUrl.toString()).catch(reject);
    });

    throwIfAborted(context.signal, 'Browser fetch stopped by user.');

    if (waitMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, waitMs);
      });
    }

    const extracted = await browserWindow.webContents.executeJavaScript(
      `(() => {
        const pickText = (selector) => {
          const node = document.querySelector(selector);
          return node?.textContent?.replace(/\\s+/g, ' ').trim() || '';
        };
        const canonicalNode = document.querySelector('link[rel="canonical"]');
        const descriptionNode =
          document.querySelector('meta[name="description"]') ||
          document.querySelector('meta[property="og:description"]');
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
          .map((node) => ({
            level: Number(node.tagName.slice(1)),
            text: node.textContent?.replace(/\\s+/g, ' ').trim() || '',
          }))
          .filter((item) => item.text)
          .slice(0, 16);
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map((node) => ({
            text: node.textContent?.replace(/\\s+/g, ' ').trim() || node.href,
            url: node.href,
          }))
          .filter((item) => item.url)
          .slice(0, 16);
        const readableRoot =
          document.querySelector('main') ||
          document.querySelector('article') ||
          document.querySelector('[role="main"]') ||
          document.body;
        const text = readableRoot?.innerText?.replace(/\\u00a0/g, ' ')?.replace(/\\s+\\n/g, '\\n')?.replace(/\\n{3,}/g, '\\n\\n')?.trim() || '';
        return {
          url: location.href,
          title: document.title || location.hostname,
          description: descriptionNode?.getAttribute('content')?.replace(/\\s+/g, ' ').trim() || '',
          canonicalUrl: canonicalNode?.href || location.href,
          content: text,
          headings,
          links,
        };
      })();`,
      true
    );

    let screenshotPath = null;
    if (args?.captureScreenshot !== false) {
      try {
        const image = await browserWindow.webContents.capturePage();
        screenshotPath = await createBrowserFetchScreenshot(
          context,
          image.toPNG(),
          extracted.url || parsedUrl.toString()
        );
      } catch {
        screenshotPath = null;
      }
    }

    const content = String(extracted?.content ?? '').trim();
    return {
      url: extracted?.url || parsedUrl.toString(),
      title: extracted?.title || parsedUrl.hostname,
      description: extracted?.description || '',
      canonicalUrl: extracted?.canonicalUrl || extracted?.url || parsedUrl.toString(),
      content: content.slice(0, maxChars),
      totalChars: content.length,
      truncated: content.length > maxChars,
      headings: Array.isArray(extracted?.headings) ? extracted.headings : [],
      links: Array.isArray(extracted?.links) ? extracted.links : [],
      contentType: 'text/html',
      browserRendered: true,
      screenshotPath,
      engine: 'electron-browserwindow',
      waitMs,
    };
  } catch (error) {
    if (aborted || isAbortError(error)) {
      throw createAbortError('Browser fetch stopped by user.');
    }
    throw error;
  } finally {
    disposeAbort();
    if (!browserWindow.isDestroyed()) {
      browserWindow.destroy();
    }
  }
}

export function createWebTools({
  fetchImpl = globalThis.fetch,
  browserFetchImpl = browserFetchWithElectron,
} = {}) {
  return [
    createToolDefinition({
      name: 'web_search',
      description: 'Search the public web for articles, docs, and references.',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query to run on the public web.' },
          site: { type: 'string', description: 'Optional domain filter such as docs.python.org.' },
          maxResults: { type: 'integer', description: 'Maximum number of returned search results.' },
        },
      },
      async handler(context, args) {
        return searchTheWeb(fetchImpl, args, context.signal);
      },
    }),
    createToolDefinition({
      name: 'web_fetch',
      description: 'Fetch and read the contents of a public web page by URL.',
      inputSchema: {
        type: 'object',
        anyOf: [{ required: ['url'] }, { required: ['resultId'] }],
        properties: {
          url: { type: 'string', description: 'Absolute http or https URL to fetch.' },
          resultId: {
            type: 'string',
            description:
              'Preferred: a result id returned earlier by web_search. Use this instead of copying the URL manually when possible.',
          },
          maxChars: { type: 'integer', description: 'Maximum number of characters to return from the page.' },
        },
      },
      async handler(context, args) {
        return fetchWebPage(fetchImpl, browserFetchImpl, context, args, context.signal);
      },
    }),
    createToolDefinition({
      name: 'browser_fetch',
      description:
        'Open a public web page in a hidden browser for JavaScript-rendered or blocked pages and extract readable content.',
      inputSchema: {
        type: 'object',
        anyOf: [{ required: ['url'] }, { required: ['resultId'] }],
        properties: {
          url: { type: 'string', description: 'Absolute http or https URL to load in the browser.' },
          resultId: {
            type: 'string',
            description:
              'Preferred: a result id returned earlier by web_search. Use this instead of copying the URL manually when possible.',
          },
          maxChars: { type: 'integer', description: 'Maximum number of characters to return from the rendered page.' },
          waitMs: { type: 'integer', description: 'How long to wait after load before extracting the page.' },
          captureScreenshot: { type: 'boolean', description: 'Whether to save a screenshot of the rendered page.' },
        },
      },
      async handler(context, args) {
        return browserFetchImpl(context, args);
      },
    }),
  ];
}

export const __testables = {
  decodeHtmlEntities,
  extractCanonicalUrl,
  extractHtmlHeadings,
  extractHtmlLinks,
  extractMetaDescription,
  htmlToText,
  parseDuckDuckGoHtml,
  unwrapDuckDuckGoUrl,
  browserFetchWithElectron,
};
