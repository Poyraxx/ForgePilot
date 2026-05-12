import readline from 'node:readline';

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) {
  send({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function fail(id, message) {
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message,
    },
  });
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  const message = JSON.parse(trimmed);

  if (message.method === 'initialize') {
    ok(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'fixture-mcp',
        version: '1.0.0',
      },
      instructions: 'Use the fixture MCP server for test tools.',
    });
    return;
  }

  if (message.method === 'notifications/initialized') {
    return;
  }

  if (message.method === 'tools/list') {
    ok(message.id, {
      tools: [
        {
          name: 'echo',
          description: 'Echo text back.',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
            },
            required: ['text'],
          },
          annotations: {
            readOnlyHint: true,
          },
        },
        {
          name: 'write_note',
          description: 'Pretend to write a note.',
          inputSchema: {
            type: 'object',
            properties: {
              body: { type: 'string' },
            },
            required: ['body'],
          },
        },
      ],
    });
    return;
  }

  if (message.method === 'tools/call') {
    const toolName = message.params?.name;
    const args = message.params?.arguments ?? {};

    if (toolName === 'echo') {
      ok(message.id, {
        content: [
          {
            type: 'text',
            text: `echo:${args.text}`,
          },
        ],
        structuredContent: {
          echoed: args.text,
        },
      });
      return;
    }

    if (toolName === 'write_note') {
      ok(message.id, {
        content: [
          {
            type: 'text',
            text: `note:${args.body}`,
          },
        ],
        structuredContent: {
          body: args.body,
          saved: true,
        },
      });
      return;
    }

    fail(message.id, `Unknown tool "${toolName}".`);
  }
});
