import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const {
  BlobReceiveSink,
  FileSystemReceiveSink
} = await loadReceiveSink();

test('Blob sink returns a browser download result and tracks written bytes', async () => {
  let capturedBlob;
  const sink = new BlobReceiveSink({
    size: 4,
    type: 'application/octet-stream',
    createObjectUrl(blob) {
      capturedBlob = blob;
      return 'blob:crosslan-test';
    }
  });

  await sink.prepare();
  await sink.write(new Uint8Array([1, 2]));
  await sink.write(new Uint8Array([3, 4]));
  const result = await sink.close();

  assert.equal(sink.bytesWritten, 4);
  assert.equal(result.downloadUrl, 'blob:crosslan-test');
  assert.equal(result.needsUserSave, true);
  assert.equal(capturedBlob.size, 4);
  assert.deepEqual([...new Uint8Array(await capturedBlob.arrayBuffer())], [1, 2, 3, 4]);
});

test('Blob sink preserves a full 64 MiB file and a short final part', async () => {
  const size = 64 * 1024 * 1024 + 3;
  let captured;
  const sink = new BlobReceiveSink({
    size, type: 'application/octet-stream',
    createObjectUrl: blob => { captured = blob; return 'blob:large'; }
  });
  const chunk = new Uint8Array(1024 * 1024).fill(17);
  for (let index = 0; index < 64; index++) await sink.write(chunk);
  await sink.write(new Uint8Array([1, 2, 3]));
  const result = await sink.close();
  assert.equal(sink.bytesWritten, size);
  assert.equal(captured.size, size);
  assert.deepEqual([...new Uint8Array(await captured.slice(-3).arrayBuffer())], [1, 2, 3]);
  assert.equal(result.needsUserSave, true);
  assert.equal(result.downloadUrl, 'blob:large');
});

test('Blob sink has no application file-size cap and validates declared sizes', () => {
  const sink = new BlobReceiveSink({ size: 5 * 1024 ** 3, type: 'application/octet-stream' });
  assert.equal(sink.bytesWritten, 0);
  for (const size of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new BlobReceiveSink({ size, type: '' }), /invalid declared/i);
  }
});

test('Blob chunks snapshot incoming data before the sender can reuse its buffer', async () => {
  let captured;
  const sink = new BlobReceiveSink({
    size: 4, type: '', createObjectUrl: blob => { captured = blob; return 'blob:snapshot'; }
  });
  const buffer = new Uint8Array([0, 1, 2, 0]);
  await sink.write(buffer.subarray(1, 3));
  buffer.fill(9);
  await sink.write(new Uint8Array([3, 4]));
  await sink.close();
  assert.deepEqual([...new Uint8Array(await captured.arrayBuffer())], [1, 2, 3, 4]);
});

test('Blob receive batches small messages into MiB parts and releases its staging buffer', async () => {
  const MiB = 1024 * 1024;
  const sink = new BlobReceiveSink({ size: 2 * MiB + 3, type: '', createObjectUrl: () => 'blob:batched' });
  const chunk = new Uint8Array(64 * 1024).fill(8);
  for (let index = 0; index < 32; index++) await sink.write(chunk);
  assert.equal(sink.chunks.length, 2);
  assert.equal(sink.pending.byteLength, MiB);
  await sink.write(new Uint8Array([1, 2, 3]));
  assert.equal(sink.pendingBytes, 3);
  await sink.close();
  assert.equal(sink.chunks.length, 0);
  assert.equal(sink.pending.byteLength, 0);
});

test('Blob batching preserves data across part boundaries and repeated buffer reuse', async () => {
  const MiB = 1024 * 1024;
  let captured;
  const sink = new BlobReceiveSink({
    size: MiB + 9, type: '', createObjectUrl: blob => { captured = blob; return 'blob:boundary'; }
  });
  await sink.write(new Uint8Array(MiB - 3).fill(7));
  await sink.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  await sink.close();
  assert.equal(captured.size, MiB + 9);
  assert.deepEqual([...new Uint8Array(await captured.slice(0, 12).arrayBuffer())], Array(12).fill(7));
  assert.deepEqual([...new Uint8Array(await captured.slice(MiB - 3).arrayBuffer())], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('Blob abort releases both staging bytes and complete parts', async () => {
  const sink = new BlobReceiveSink({ size: 3 * 1024 * 1024, type: '' });
  await sink.write(new Uint8Array(1024 * 1024 + 1));
  assert.equal(sink.chunks.length, 1);
  assert.equal(sink.pendingBytes, 1);
  await sink.abort();
  assert.equal(sink.chunks.length, 0);
  assert.equal(sink.pendingBytes, 0);
  assert.equal(sink.pending.byteLength, 0);
});

test('Blob sink rejects non-sequential, excess, and incomplete writes', async () => {
  const sink = new BlobReceiveSink({ size: 4, type: '' });
  await assert.rejects(sink.write(new Uint8Array([1]), 1), /sequential/);
  await assert.rejects(sink.write(new Uint8Array(5)), /more data/);
  await sink.write(new Uint8Array([1]));
  await assert.rejects(sink.close(), /size mismatch/);
  await sink.abort();
});

test('Blob abort during close cannot create a late download URL', async () => {
  let urls = 0;
  const sink = new BlobReceiveSink({
    size: 1, type: '', createObjectUrl: () => { urls++; return 'blob:late'; }
  });
  await sink.write(new Uint8Array([1]));
  const close = sink.close();
  const rejected = assert.rejects(close, /aborted/);
  await sink.abort();
  await rejected;
  assert.equal(urls, 0);
  await assert.rejects(sink.write(new Uint8Array([2])), /aborted/);
});

test('File System sink serializes writes and tracks persisted bytes', async () => {
  const writes = [];
  const releases = [];
  const writable = {
    write(payload) {
      writes.push(payload);
      return new Promise(resolve => releases.push(resolve));
    },
    async close() {},
    async abort() {}
  };
  const sink = new FileSystemReceiveSink(writable);

  const first = sink.write(new Uint8Array([1, 2]));
  const second = sink.write(new Uint8Array([3, 4, 5]));
  await Promise.resolve();

  assert.equal(writes.length, 1);
  releases.shift()();
  await first;
  await Promise.resolve();
  assert.equal(writes.length, 2);
  releases.shift()();
  await second;

  assert.equal(sink.bytesWritten, 5);
  assert.deepEqual([...writes[0]], [1, 2]);
  assert.deepEqual([...writes[1]], [3, 4, 5]);
});

test('sink close is idempotent', async () => {
  let closes = 0;
  const sink = new FileSystemReceiveSink({
    async write() {},
    async close() {
      closes += 1;
    },
    async abort() {}
  });

  const first = await sink.close();
  const second = await sink.close();

  assert.deepEqual(first, second);
  assert.equal(closes, 1);
});

test('abort releases Blob URLs and aborts File System writers', async () => {
  const revoked = [];
  const blobSink = new BlobReceiveSink({
    size: 1,
    type: 'application/octet-stream',
    createObjectUrl: () => 'blob:cleanup',
    revokeObjectUrl: url => revoked.push(url)
  });
  await blobSink.write(new Uint8Array([1]));
  await blobSink.close();
  await blobSink.abort('cancelled');
  assert.deepEqual(revoked, ['blob:cleanup']);

  const abortReasons = [];
  const fileSink = new FileSystemReceiveSink({
    async write() {},
    async close() {},
    async abort(reason) {
      abortReasons.push(reason);
    }
  });
  await fileSink.abort('cancelled');
  await fileSink.abort('ignored duplicate');
  assert.deepEqual(abortReasons, ['cancelled']);
});

test('browser download ACK bytes advance only when stream backpressure releases', async () => {
  const { BrowserDownloadReceiveSink } = await loadReceiveSink();
  let release;
  let closed = 0;
  const sink = new BrowserDownloadReceiveSink({
    closed: new Promise(() => {}),
    write: () => new Promise(resolve => { release = resolve; }),
    async close() { closed++; },
    async abort() {}
  }, 3);
  const write = sink.write(new Uint8Array([1, 2, 3]));
  assert.equal(sink.bytesWritten, 0);
  release();
  await write;
  assert.equal(sink.bytesWritten, 3);
  await sink.close();
  await sink.close();
  assert.equal(closed, 1);
});

test('browser download abort rejects a pending write without acknowledging bytes', async () => {
  const { BrowserDownloadReceiveSink } = await loadReceiveSink();
  let rejectWrite;
  let aborted = 0;
  const sink = new BrowserDownloadReceiveSink({
    closed: new Promise(() => {}),
    write: () => new Promise((_, reject) => { rejectWrite = reject; }),
    async close() {},
    async abort() { aborted++; rejectWrite(new Error('Download cancelled')); }
  }, 3);
  const write = sink.write(new Uint8Array([1, 2, 3]));
  const rejected = assert.rejects(write, /cancelled/);
  await sink.abort();
  await sink.abort();
  await rejected;
  assert.equal(aborted, 1);
  assert.equal(sink.bytesWritten, 0);
});

async function loadReceiveSink() {
  const source = await readFile(
    new URL('../src/transfer/ReceiveSink.ts', import.meta.url),
    'utf8'
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
}
