export async function* readSseEvents(response) {
  if (!response.body) {
    throw new Error('Streaming response has no body.');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  const parseBlock = (block) => {
    const lines = block.split('\n');
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart());
    if (data.length === 0) {
      return null;
    }

    return {
      event: lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? '',
      data: data.join('\n'),
    };
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const parsed = parseBlock(buffer.slice(0, boundary));
      if (parsed) {
        yield parsed;
      }
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }

  buffer += decoder.decode();
  const parsed = parseBlock(buffer.replace(/\r\n/g, '\n').trim());
  if (parsed) {
    yield parsed;
  }
}
