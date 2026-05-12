export function createAbortError(message = 'Request stopped by user.') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error) {
  return (
    error?.name === 'AbortError' ||
    error?.code === 'ABORT_ERR' ||
    error?.cause?.name === 'AbortError'
  );
}

export function throwIfAborted(signal, message = 'Request stopped by user.') {
  if (signal?.aborted) {
    throw createAbortError(message);
  }
}

export function bindAbortSignal(signal, onAbort) {
  if (!signal) {
    return () => {};
  }

  if (signal.aborted) {
    onAbort();
    return () => {};
  }

  signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    signal.removeEventListener('abort', onAbort);
  };
}
