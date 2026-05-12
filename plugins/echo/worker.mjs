import process from 'node:process';

let rawInput = '';
for await (const chunk of process.stdin) {
  rawInput += chunk.toString();
}

const request = JSON.parse(rawInput || '{}');

if (request.tool === 'plugin_echo') {
  const text = String(request.arguments?.text ?? '');
  const value = request.arguments?.uppercase ? text.toUpperCase() : text;
  process.stdout.write(
    JSON.stringify({
      echoed: value,
      workspaceRoot: request.context?.workspaceRoot ?? '',
    })
  );
} else {
  process.stdout.write(
    JSON.stringify({
      error: `Unknown plugin tool ${request.tool}`,
    })
  );
  process.exitCode = 1;
}
