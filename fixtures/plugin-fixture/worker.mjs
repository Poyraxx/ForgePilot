import process from 'node:process';

let rawInput = '';
for await (const chunk of process.stdin) {
  rawInput += chunk.toString();
}

const request = JSON.parse(rawInput || '{}');

process.stdout.write(
  JSON.stringify({
    echoed: request.arguments?.text ?? '',
    sessionId: request.context?.sessionId ?? '',
  })
);
