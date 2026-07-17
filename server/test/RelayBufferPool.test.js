import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RelayBufferPool } from '../src/relay/RelayBufferPool.js';

function createPool() {
  return new RelayBufferPool({
    targetBytes: 32,
    highWaterBytes: 64,
    lowWaterBytes: 24,
    totalBytes: 256
  });
}

async function remainsPending(promise, waitMs = 20) {
  return Promise.race([
    promise.then(() => false, () => false),
    new Promise(resolve => setTimeout(() => resolve(true), waitMs))
  ]);
}

test('a session pauses at high water and resumes only at low water', async () => {
  const pool = createPool();
  pool.register('one');
  const initial = await pool.reserve('one', 64);
  pool.commit('one', initial);

  const waiting = pool.reserve('one', 1);
  assert.equal(await remainsPending(waiting), true);
  assert.equal(pool.snapshot('one').backpressured, true);

  pool.release('one', 39);
  assert.equal(pool.snapshot('one').bufferedBytes, 25);
  assert.equal(await remainsPending(waiting), true);

  pool.release('one', 1);
  assert.equal(await waiting, 1);
  assert.equal(pool.snapshot('one').totalBufferedBytes, 25);
  pool.rollback('one', 1);
});

test('concurrent sessions stay within the global memory budget', async () => {
  const pool = new RelayBufferPool({
    targetBytes: 30,
    highWaterBytes: 80,
    lowWaterBytes: 20,
    totalBytes: 100
  });
  pool.register('one');
  pool.register('two');
  pool.register('three');

  const first = await pool.reserve('one', 80);
  pool.commit('one', first);
  const second = await pool.reserve('two', 80);
  pool.commit('two', second);
  assert.equal(second, 20);
  assert.equal(pool.totalBufferedBytes, 100);

  const waiting = pool.reserve('three', 1);
  assert.equal(await remainsPending(waiting), true);
  pool.release('one', 1);
  assert.equal(await waiting, 1);
  assert.equal(pool.totalBufferedBytes, 100);
  pool.rollback('three', 1);
});

test('woken writers reserve global capacity atomically', async () => {
  const pool = new RelayBufferPool({
    targetBytes: 4,
    highWaterBytes: 8,
    lowWaterBytes: 2,
    totalBytes: 8
  });
  pool.register('one');
  pool.register('two');
  pool.register('three');
  const filled = await pool.reserve('one', 8);
  pool.commit('one', filled);

  const second = pool.reserve('two', 1);
  const third = pool.reserve('three', 1);
  pool.release('one', 1);
  const winner = await Promise.race([
    second.then(bytes => ({ id: 'two', bytes })),
    third.then(bytes => ({ id: 'three', bytes }))
  ]);
  assert.equal(winner.bytes, 1);
  assert.equal(pool.totalBufferedBytes, 8);
  const loser = winner.id === 'two' ? third : second;
  assert.equal(await remainsPending(loser), true);
  pool.close(winner.id);
  assert.equal(await loser, 1);
});

test('cancelling a paused session rejects its waiting writer and releases memory', async () => {
  const pool = createPool();
  pool.register('one');
  const reserved = await pool.reserve('one', 64);
  pool.commit('one', reserved);
  const waiting = pool.reserve('one', 1);
  assert.equal(await remainsPending(waiting), true);

  pool.close('one', new Error('Transfer cancelled.'));
  await assert.rejects(waiting, /cancelled/i);
  assert.equal(pool.totalBufferedBytes, 0);
  assert.equal(pool.snapshot('one'), null);
});

test('relay buffer operations do not create temporary files', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'crosslan-relay-buffer-test-'));
  try {
    const before = await readdir(tempDir);
    const pool = createPool();
    pool.register('one');
    const reserved = await pool.reserve('one', 16);
    pool.commit('one', reserved);
    pool.release('one', reserved);
    pool.close('one');
    const after = await readdir(tempDir);
    assert.deepEqual(after, before);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
