import React, { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import { safeExternalUrl } from '../core/external-url.js';

const h = React.createElement;

function decodeText(value = '') {
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === 'x'
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

export function safeLink(value) {
  return safeExternalUrl(decodeText(value).trim());
}

export function CopyButton({ content, t }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return h('button', {
    type: 'button',
    className: 'message-copy',
    title: t(copied ? 'message.copied' : 'message.copy'),
    'aria-label': t(copied ? 'message.copied' : 'message.copy'),
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(String(content ?? ''));
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1600);
      } catch {
        setCopied(false);
      }
    },
  }, copied ? '✓' : h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
    h('rect', { x: 8, y: 8, width: 12, height: 12, rx: 2 }),
    h('path', { d: 'M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4' })));
}

function renderTokens(tokens, t, depth = 0) {
  if (depth > 40) return tokens.map((token) => token.raw ?? token.text ?? '').join('');
  return tokens.map((token, key) => {
    const children = () => renderTokens(token.tokens ?? [], t, depth + 1);
    switch (token.type) {
      case 'space':
      case 'checkbox': return null;
      case 'heading': return h(`h${token.depth}`, { key }, children());
      case 'paragraph': return h('p', { key }, children());
      case 'strong': return h('strong', { key }, children());
      case 'em': return h('em', { key }, children());
      case 'del': return h('del', { key }, children());
      case 'codespan': return h('code', { key }, decodeText(token.text));
      case 'br': return h('br', { key });
      case 'hr': return h('hr', { key });
      case 'blockquote': return h('blockquote', { key }, children());
      case 'code': return h('div', { key, className: 'message-code' },
        h('div', { className: 'message-code-header' },
          h('span', null, token.lang?.split(/\s/)[0] ?? ''),
          h(CopyButton, { content: token.text, t })),
        h('pre', null, h('code', null, token.text)));
      case 'link':
      case 'image': {
        const href = safeLink(token.href);
        const label = token.type === 'image' ? decodeText(token.text || token.href) : children();
        return href ? h('a', {
          key, href, target: '_blank', rel: 'noopener noreferrer',
          onClick: (event) => {
            if (globalThis.cokgizlicoder?.openExternal) {
              event.preventDefault();
              void globalThis.cokgizlicoder.openExternal(href).catch(() => {});
            }
          },
        }, label) : h('span', { key }, label);
      }
      case 'list': return h(token.ordered ? 'ol' : 'ul', { key, start: token.ordered ? token.start : undefined },
        token.items.map((item, index) => h('li', { key: index },
          item.task ? h('input', { type: 'checkbox', checked: item.checked, disabled: true }) : null,
          renderTokens(item.tokens ?? [], t, depth + 1))));
      case 'table': return h('div', { key, className: 'message-table' }, h('table', null,
        h('thead', null, h('tr', null, token.header.map((cell, index) =>
          h('th', { key: index, style: { textAlign: token.align[index] ?? undefined } }, renderTokens(cell.tokens, t, depth + 1))))),
        h('tbody', null, token.rows.map((row, index) => h('tr', { key: index }, row.map((cell, column) =>
          h('td', { key: column, style: { textAlign: token.align[column] ?? undefined } }, renderTokens(cell.tokens, t, depth + 1))))))));
      case 'text': return token.tokens ? h(React.Fragment, { key }, children()) : decodeText(token.text);
      default: return token.raw ?? token.text ?? '';
    }
  });
}

export const MessageContent = React.memo(function MessageContent({ content, t }) {
  const text = String(content ?? '');
  try {
    return h('div', { className: 'chat-content markdown-content' }, renderTokens(marked.lexer(text, { gfm: true, breaks: true }), t));
  } catch {
    return h('div', { className: 'chat-content' }, text);
  }
}, (previous, next) => previous.content === next.content && previous.language === next.language);
