import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';

import { findMatchingLogLine, waitForLogReadySignal } from '../utils/log-ready.js';
import { RingBuffer } from '../utils/ring-buffer.js';

test('findMatchingLogLine returns the first matching line', () => {
  const line = findMatchingLogLine(
    ['[stdout] booting', '[stdout] server ready on port 1234'],
    'ready'
  );

  assert.equal(line, '[stdout] server ready on port 1234');
});

test('waitForLogReadySignal resolves when the pattern appears in buffered logs', async () => {
  const process = new EventEmitter();
  const output = new RingBuffer<string>(10);
  const errors = new RingBuffer<string>(10);

  const waiting = waitForLogReadySignal(process, output, errors, 'READY', 1000);
  setTimeout(() => {
    output.push('[stdout] READY for players');
  }, 50);

  const result = await waiting;
  assert.deepEqual(result, { ok: true, matchedLine: '[stdout] READY for players' });
});

test('waitForLogReadySignal reports timeout when the pattern never appears', async () => {
  const process = new EventEmitter();
  const output = new RingBuffer<string>(10);
  const errors = new RingBuffer<string>(10);

  const result = await waitForLogReadySignal(process, output, errors, 'READY', 50);
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
});
