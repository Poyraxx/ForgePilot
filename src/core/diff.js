function splitLines(value) {
  return String(value).replace(/\r\n/g, '\n').split('\n');
}

function findCommonPrefix(beforeLines, afterLines) {
  let index = 0;

  while (
    index < beforeLines.length &&
    index < afterLines.length &&
    beforeLines[index] === afterLines[index]
  ) {
    index += 1;
  }

  return index;
}

function findCommonSuffix(beforeLines, afterLines, prefixLength) {
  let index = 0;

  while (
    beforeLines.length - 1 - index >= prefixLength &&
    afterLines.length - 1 - index >= prefixLength &&
    beforeLines[beforeLines.length - 1 - index] === afterLines[afterLines.length - 1 - index]
  ) {
    index += 1;
  }

  return index;
}

export function createUnifiedDiff(before, after, fileLabel = 'file') {
  if (before === after) {
    return `--- a/${fileLabel}\n+++ b/${fileLabel}\n@@\n No content changes\n`;
  }

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const prefixLength = findCommonPrefix(beforeLines, afterLines);
  const suffixLength = findCommonSuffix(beforeLines, afterLines, prefixLength);

  const beforeStart = Math.max(0, prefixLength - 2);
  const afterStart = Math.max(0, prefixLength - 2);
  const beforeEnd = Math.max(beforeStart, beforeLines.length - suffixLength + 2);
  const afterEnd = Math.max(afterStart, afterLines.length - suffixLength + 2);

  const beforeChunk = beforeLines.slice(beforeStart, beforeEnd);
  const afterChunk = afterLines.slice(afterStart, afterEnd);

  const header = [
    `--- a/${fileLabel}`,
    `+++ b/${fileLabel}`,
    `@@ -${beforeStart + 1},${beforeChunk.length} +${afterStart + 1},${afterChunk.length} @@`,
  ];

  const body = [];
  const removedLines = beforeLines.slice(prefixLength, beforeLines.length - suffixLength);
  const addedLines = afterLines.slice(prefixLength, afterLines.length - suffixLength);

  for (const line of beforeLines.slice(beforeStart, prefixLength)) {
    body.push(` ${line}`);
  }

  for (const line of removedLines) {
    body.push(`-${line}`);
  }

  for (const line of addedLines) {
    body.push(`+${line}`);
  }

  for (const line of afterLines.slice(afterLines.length - suffixLength, afterEnd)) {
    body.push(` ${line}`);
  }

  return `${header.join('\n')}\n${body.join('\n')}\n`;
}
