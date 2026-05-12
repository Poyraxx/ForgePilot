import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEnvelopeRepairMessage, parseAgentEnvelope } from '../src/core/envelope.js';

test('parseAgentEnvelope extracts a tool envelope from XML-wrapped JSON', () => {
  const parsed = parseAgentEnvelope(
    '<agent-response>{"mode":"tool","calls":[{"name":"fs_read","arguments":{"path":"README.md"}}]}</agent-response>'
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.envelope.mode, 'tool');
  assert.equal(parsed.envelope.calls[0].name, 'fs_read');
});

test('parseAgentEnvelope accepts a direct JSON object as a fallback', () => {
  const parsed = parseAgentEnvelope('{"mode":"final","message":"done"}');

  assert.equal(parsed.ok, true);
  assert.equal(parsed.envelope.mode, 'final');
  assert.equal(parsed.envelope.message, 'done');
});

test('parseAgentEnvelope ignores trailing junk after a valid JSON payload', () => {
  const parsed = parseAgentEnvelope(
    '<agent-response>{"mode":"final","message":"done"}\nextra trailing text</agent-response>'
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.envelope.mode, 'final');
  assert.equal(parsed.envelope.message, 'done');
});

test('parseAgentEnvelope reports invalid responses', () => {
  const parsed = parseAgentEnvelope('hello world');

  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /agent-response/);
  assert.match(buildEnvelopeRepairMessage(parsed), /previous response did not follow/i);
});
