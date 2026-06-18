import { RingBuffer } from './ring-buffer.js';

export function findMatchingLogLine(lines: string[], needle: string): string | null {
  const pattern = needle.trim();
  if (!pattern) {
    return null;
  }

  for (const line of lines) {
    if (line.includes(pattern)) {
      return line;
    }
  }

  return null;
}

export async function waitForLogReadySignal(
  process: NodeJS.EventEmitter,
  output: RingBuffer<string>,
  errors: RingBuffer<string>,
  pattern: string,
  timeoutMs: number
): Promise<
  | { ok: true; matchedLine: string }
  | { ok: false; reason: 'timeout' | 'exit'; code?: number | null; signal?: NodeJS.Signals | null }
> {
  const initialMatch = findMatchingLogLine([...output.toArray(), ...errors.toArray()], pattern);
  if (initialMatch) {
    return { ok: true, matchedLine: initialMatch };
  }

  return await new Promise((resolve) => {
    const interval = setInterval(() => {
      const match = findMatchingLogLine([...output.toArray(), ...errors.toArray()], pattern);
      if (match) {
        cleanup();
        resolve({ ok: true, matchedLine: match });
      }
    }, 100);

    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ ok: false, reason: 'exit', code, signal });
    };

    const cleanup = () => {
      clearInterval(interval);
      clearTimeout(timer);
      process.off('exit', onExit);
    };

    process.on('exit', onExit);
  });
}
