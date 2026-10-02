import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent, safeLink } from '../src/renderer/message-content.js';
import { safeExternalUrl } from '../src/core/external-url.js';

const render = (content) => renderToStaticMarkup(React.createElement(MessageContent, { content, t: (key) => key }));

test('messages render markdown, tables, tasks and copyable code blocks', () => {
  const output = render('# Result\n\n**Bold** and `inline`\n\n- [x] Done\n- Pending\n\n| Name | Value |\n| --- | --- |\n| A | 2 |\n\n```js\nconst a = "<script>";\n```');
  assert.match(output, /<h1>Result<\/h1>/);
  assert.match(output, /<strong>Bold<\/strong>/);
  assert.match(output, /<code>inline<\/code>/);
  assert.match(output, /type="checkbox" disabled="" checked=""/);
  assert.doesNotMatch(output, /\[x\]/);
  assert.match(output, /<table>/);
  assert.match(output, /message-code-header/);
  assert.match(output, /&lt;script&gt;/);
  assert.match(output, /aria-label="message.copy"/);
});

test('model HTML never becomes executable DOM and remote images are not loaded', () => {
  const output = render('<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n![Image](https://example.com/tracker.png)\n\n[bad](javascript:alert%281%29)');
  assert.doesNotMatch(output, /<script|<img|href="javascript:/);
  assert.match(output, /&lt;script&gt;/);
  assert.match(output, /rel="noopener noreferrer"/);
});

test('links permit only explicit HTTP URLs without credentials or control characters', () => {
  for (const value of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,test', '//example.com', 'https://a:b@example.com', 'https://example.com\n']) {
    assert.equal(safeExternalUrl(value), null);
  }
  assert.equal(safeLink('jav&#x61;script:alert(1)'), null);
  assert.equal(safeLink('https://example.com/?a=1&amp;b=2'), 'https://example.com/?a=1&b=2');
  assert.equal(safeExternalUrl('https://example.com/path'), 'https://example.com/path');
});

test('partial markdown and unicode content render without crashing', () => {
  assert.match(render('```py\nprint("hello")'), /print/);
  assert.match(render('Türkçe **yanıt** &amp; metin'), /Türkçe/);
  assert.match(render('3. Three\n4. Four'), /<ol start="3">/);
});
