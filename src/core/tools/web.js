import { bindAbortSignal, createAbortError, isAbortError, throwIfAborted } from '../abort.js';
import { createToolDefinition } from '../contracts.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_SEARCH_RESULTS = 6;
const DEFAULT_MAX_FETCH_CHARS = 12_000;
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
  const decoded = decodeHtmlEntities(String(rawUrl).trim());

  if (!decoded) {
    return '';
  }

  if (decoded.startsWith('//')) {
    return `https:${decoded}`;
  }

  if (decoded.startsWith('/l/?')) {
    const params = new URLSearchParams(decoded.slice(decoded.indexOf('?') + 1));
    const redirected = params.get('uddg');
    if (redirected) {
      return decodeURIComponent(redirected);
    }
  }

  try {
    return new URL(decoded, 'https://duckduckgo.com').toString();
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
      throw new Error(`Web request failed with status ${response.status}.`);
    }

    return { response, text };
  } catch (error) {
    if (timedOut) {
      throw createAbortError('Web request timed out.');
    }

    if (isAbortError(error) || controller.signal.aborted) {
      throw createAbortError('Web request stopped by user.');
    }

    throw error;
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
  const results = parseDuckDuckGoHtml(text, maxResults);

  if (results.length > 0) {
    return {
      query: query.rawQuery,
      site: query.site || undefined,
      provider: 'duckduckgo',
      results,
      truncated: results.length >= maxResults,
    };
  }

  return searchWithInstantAnswerApi(fetchImpl, args, signal);
}

function extractHtmlTitle(rawHtml) {
  const titleMatch = String(rawHtml).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return stripTags(titleMatch?.[1] ?? '');
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

async function fetchWebPage(fetchImpl, args, signal) {
  const parsedUrl = validateWebUrl(args?.url);
  const maxChars = Math.max(
    500,
    Math.min(50_000, Number(args?.maxChars) || DEFAULT_MAX_FETCH_CHARS)
  );
  const { response, text } = await fetchText(parsedUrl.toString(), {
    fetchImpl,
    signal,
    headers: {
      accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.8',
    },
  });
  const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
  const isHtml = contentType.includes('text/html');
  const title = isHtml ? extractHtmlTitle(text) || parsedUrl.hostname : parsedUrl.hostname;
  const content = isHtml ? htmlToText(text) : text.trim();

  return {
    url: response.url || parsedUrl.toString(),
    title,
    content: content.slice(0, maxChars),
    contentType,
    totalChars: content.length,
    truncated: content.length > maxChars,
  };
}

export function createWebTools({ fetchImpl = globalThis.fetch } = {}) {
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
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'Absolute http or https URL to fetch.' },
          maxChars: { type: 'integer', description: 'Maximum number of characters to return from the page.' },
        },
      },
      async handler(context, args) {
        return fetchWebPage(fetchImpl, args, context.signal);
      },
    }),
  ];
}

export const __testables = {
  decodeHtmlEntities,
  htmlToText,
  parseDuckDuckGoHtml,
  unwrapDuckDuckGoUrl,
};
