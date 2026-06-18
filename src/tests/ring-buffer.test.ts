import test from 'node:test';
import assert from 'node:assert/strict';

import { RingBuffer } from '../utils/ring-buffer.js';

test('RingBuffer retains only the newest entries up to its limit', () => {
  const buffer = new RingBuffer<string>(3);

  buffer.push('a');
  buffer.push('b');
  buffer.push('c');
  buffer.push('d');

  assert.deepEqual(buffer.toArray(), ['b', 'c', 'd']);
});

test('RingBuffer tail returns the newest requested entries', () => {
  const buffer = new RingBuffer<number>(4);

  buffer.pushMany([1, 2, 3, 4]);

  assert.deepEqual(buffer.tail(2), [3, 4]);
  assert.deepEqual(buffer.tail(10), [1, 2, 3, 4]);
});
