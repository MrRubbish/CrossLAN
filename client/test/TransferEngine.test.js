import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const { TransferEngine } = await loadTransferEngine();

test('outgoing WebRTC files to one peer are serialized until receiver save acknowledgement', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const progress = [];
  engine.onProgress(item => progress.push(item));

  const first = engine.sendFile('receiver', createFile('first.bin', 160 * 1024));
  const second = engine.sendFile('receiver', createFile('second.bin', 96 * 1024));

  await waitFor(() => FakePeerConnection.instances.length === 1);
  assert.equal(messagesOfType(signaling, 'offer').length, 1);
  assert.equal(progress.filter(item => !item.done).length, 1);

  FakePeerConnection.instances[0].dataChannel.open();
  await first;

  await waitFor(() => FakePeerConnection.instances.length === 2);
  assert.equal(messagesOfType(signaling, 'offer').length, 2);
  FakePeerConnection.instances[1].dataChannel.open();
  await second;

  const completed = progress.filter(item => item.done && item.direction === 'send');
  assert.deepEqual(completed.map(item => item.fileName), ['first.bin', 'second.bin']);
  assert.ok(completed.every(item => item.bytesTransferred === item.totalBytes));
});

test('WebRTC sender uses larger chunks to reduce per-message overhead', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const transfer = engine.sendFile('receiver', createFile('chunked.bin', 768 * 1024));

  await waitFor(() => FakePeerConnection.instances.length === 1);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.open();
  await transfer;

  assert.deepEqual(channel.sentBinarySizes, [256 * 1024, 256 * 1024, 256 * 1024]);
});

test('outgoing WebRTC offers preserve batch metadata for mixed-size selections', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const file = createFile('small.bin', 96 * 1024);

  const transfer = engine.sendFile('receiver', file, {
    batchId: 'mixed-selection',
    batchIndex: 1,
    batchTotal: 3
  });

  await waitFor(() => messagesOfType(signaling, 'offer').length === 1);
  assert.deepEqual(messagesOfType(signaling, 'offer')[0].fileMeta, {
    transferId: messagesOfType(signaling, 'offer')[0].fileMeta.transferId,
    name: 'small.bin',
    size: 96 * 1024,
    type: 'application/octet-stream',
    lastModified: 1,
    batchId: 'mixed-selection',
    batchIndex: 1,
    batchTotal: 3
  });

  FakePeerConnection.instances[0].dataChannel.open();
  await transfer;
});

test('packaged WebRTC batches use the larger sender buffer profile', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const debug = [];
  engine.onDebug((message, details) => debug.push({ message, details }));

  const transfer = engine.sendFile('receiver', createFile('CrossLAN-batch.zip', 768 * 1024), {
    batchId: 'batch-buffer-profile',
    batchIndex: 0,
    batchTotal: 1,
    packageType: 'crosslan-zip',
    packageCount: 12
  });

  await waitFor(() => FakePeerConnection.instances.length === 1);
  FakePeerConnection.instances[0].dataChannel.open();
  await transfer;

  const start = debug.find(item => item.message === 'p2p stream start');
  assert.equal(start?.details?.highWater, 32 * 1024 * 1024);
  assert.equal(start?.details?.lowWater, 16 * 1024 * 1024);
  assert.equal(messagesOfType(signaling, 'offer')[0].fileMeta.packageType, 'crosslan-zip');
  assert.equal(messagesOfType(signaling, 'offer')[0].fileMeta.packageCount, 12);
});

test('WebRTC backpressure resumes only after the sender buffer reaches low water', async () => {
  installBrowserGlobals();
  const engine = new TransferEngine(createSignaling(), () => 'sender');
  const channel = new FakeDataChannel();
  channel.readyState = 'open';
  channel.bufferedAmount = 32;
  let released = false;

  const waiting = engine.waitForBackpressure(channel, 32, 16).then(() => {
    released = true;
  });

  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(channel.bufferedAmountLowThreshold, 16);
  assert.equal(released, false);

  channel.bufferedAmount = 17;
  channel.emit('bufferedamountlow');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(released, false);

  channel.bufferedAmount = 16;
  channel.emit('bufferedamountlow');
  await waiting;
  assert.equal(released, true);
  assert.equal(channel.listeners.get('bufferedamountlow')?.size || 0, 0);
});

test('blob fallback retains WebRTC chunks without copying each payload', async () => {
  installBrowserGlobals();
  const engine = new TransferEngine(createSignaling(), () => 'receiver');
  const state = {
    mode: 'blob',
    meta: {
      transferId: 'blob-zero-copy',
      name: 'batch.zip',
      size: 4,
      type: 'application/zip',
      lastModified: 1
    },
    bytes: 0,
    chunks: [],
    lastAckAt: 0,
    lastAckBytes: 0
  };
  const chunk = new Uint8Array([1, 2, 3, 4]);

  await engine.writeChunk(state, chunk);

  assert.equal(state.chunks.length, 1);
  assert.equal(state.chunks[0], chunk.buffer);
});

test('ICE candidates received before an offer are applied after remote description', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'receiver');
  engine.onIncoming(() => true);

  const candidate = { candidate: 'candidate:1 1 UDP 1 192.168.1.20 5000 typ host' };
  await engine.handleSignal({
    type: 'ice-candidate',
    from: 'sender',
    candidate
  });
  assert.equal(FakePeerConnection.instances.length, 0);

  const meta = {
    transferId: 'early-ice-transfer',
    name: 'small.bin',
    size: 1024,
    type: 'application/octet-stream',
    lastModified: 1
  };
  await engine.handleSignal({
    type: 'offer',
    from: 'sender',
    description: { type: 'offer', sdp: 'test-offer' },
    fileMeta: meta
  });

  const peer = FakePeerConnection.instances[0];
  assert.deepEqual(peer.addedCandidates, [candidate]);
  assert.equal(messagesOfType(signaling, 'answer').length, 1);
  engine.cancelTransfer(meta.transferId);
});

test('cancelling an active WebRTC send releases the next queued file', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const progress = [];
  engine.onProgress(item => progress.push(item));

  const first = engine.sendFile('receiver', createFile('cancelled.bin', 160 * 1024));
  const second = engine.sendFile('receiver', createFile('next.bin', 96 * 1024));

  await waitFor(() => FakePeerConnection.instances.length === 1);
  const firstTask = progress.find(item => item.fileName === 'cancelled.bin' && !item.done);
  assert.ok(firstTask);
  engine.cancelTransfer(firstTask.id);

  await assert.rejects(first, error => error?.name === 'TransferCancelledError');
  await waitFor(() => FakePeerConnection.instances.length === 2);
  assert.equal(messagesOfType(signaling, 'offer').length, 2);

  FakePeerConnection.instances[1].dataChannel.open();
  await second;

  const cancelled = progress.find(item => item.id === firstTask.id && item.cancelled);
  const completed = progress.find(item => item.fileName === 'next.bin' && item.done);
  assert.ok(cancelled);
  assert.equal(completed?.bytesTransferred, completed?.totalBytes);
});

test('cancelling a queued WebRTC send prevents it from opening a peer session', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const progress = [];
  engine.onProgress(item => progress.push(item));

  const first = engine.sendFile('receiver', createFile('first.bin', 160 * 1024));
  const second = engine.sendFile('receiver', createFile('queued.bin', 96 * 1024));

  await waitFor(() => FakePeerConnection.instances.length === 1);
  const secondId = secondTransferId(progress, 'queued.bin');
  assert.equal(secondId, undefined);

  // The queued task is intentionally not visible until it reaches the active
  // slot, but the generated transfer id can be observed from the queued offer
  // metadata only after the first task has started. Cancel through the private
  // engine queue entry to exercise the race without changing the UI contract.
  const queuedId = [...engine.queuedTransfers.keys()][0];
  assert.ok(queuedId);
  engine.cancelTransfer(queuedId);

  FakePeerConnection.instances[0].dataChannel.open();
  await first;
  await assert.rejects(second, error => error?.name === 'TransferCancelledError');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(FakePeerConnection.instances.length, 1);
  assert.ok(progress.some(item => item.id === queuedId && item.cancelled));
});

test('a remote cancel while the receiver prompt is open prevents the offer from being accepted', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'receiver');
  let releasePrompt;
  engine.onIncoming(() => new Promise(resolve => {
    releasePrompt = resolve;
  }));

  const meta = {
    transferId: 'prompt-cancelled-transfer',
    name: 'large.bin',
    size: 1024,
    type: 'application/octet-stream',
    lastModified: 1
  };
  const offer = engine.handleSignal({
    type: 'offer',
    from: 'sender',
    description: { type: 'offer', sdp: 'test-offer' },
    fileMeta: meta
  });
  await waitFor(() => typeof releasePrompt === 'function');

  await engine.handleSignal({
    type: 'transfer-cancel',
    from: 'sender',
    transferId: meta.transferId,
    reason: 'Peer cancelled the transfer.'
  });
  releasePrompt(true);
  await offer;

  assert.equal(FakePeerConnection.instances.length, 0);
  assert.equal(messagesOfType(signaling, 'answer').length, 0);
});

async function loadTransferEngine() {
  const sourceUrl = new URL('../src/transfer/TransferEngine.ts', import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext
    },
    fileName: 'TransferEngine.ts'
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

function installBrowserGlobals() {
  globalThis.window = {
    isSecureContext: false,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  globalThis.requestAnimationFrame = callback => {
    callback(performance.now());
    return 1;
  };
  globalThis.RTCPeerConnection = FakePeerConnection;
}

function createSignaling() {
  return {
    messages: [],
    send(message) {
      this.messages.push(message);
    }
  };
}

function messagesOfType(signaling, type) {
  return signaling.messages.filter(message => message.type === type);
}

function createFile(name, size) {
  return new File([new Uint8Array(size)], name, {
    type: 'application/octet-stream',
    lastModified: 1
  });
}

function secondTransferId(progress, fileName) {
  return progress.find(item => item.fileName === fileName)?.id;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition.');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

class FakeDataChannel {
  constructor() {
    this.binaryType = 'arraybuffer';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.readyState = 'connecting';
    this.bytesReceived = 0;
    this.sentBinarySizes = [];
    this.meta = null;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type) {
    for (const listener of this.listeners.get(type) || []) listener();
  }

  send(payload) {
    if (this.readyState !== 'open') throw new Error('Fake data channel is not open.');
    if (typeof payload === 'string') {
      const control = JSON.parse(payload);
      if (control.type === 'meta') this.meta = control.meta;
      if (control.type === 'done') {
        queueMicrotask(() => {
          this.onmessage?.({
            data: JSON.stringify({
              type: 'saved',
              transferId: control.transferId
            })
          });
        });
      }
      return;
    }

    this.bytesReceived += payload.byteLength;
    this.sentBinarySizes.push(payload.byteLength);
    const transferId = this.meta?.transferId;
    queueMicrotask(() => {
      this.onmessage?.({
        data: JSON.stringify({
          type: 'progress-ack',
          transferId,
          bytesReceived: this.bytesReceived
        })
      });
    });
  }

  open() {
    this.readyState = 'open';
    this.onopen?.();
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    queueMicrotask(() => this.onclose?.());
  }
}

class FakePeerConnection {
  static instances = [];

  static reset() {
    this.instances = [];
  }

  constructor() {
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.remoteDescription = null;
    this.dataChannel = new FakeDataChannel();
    this.addedCandidates = [];
    FakePeerConnection.instances.push(this);
  }

  createDataChannel() {
    return this.dataChannel;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'test-offer' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'test-answer' };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate) {
    if (!this.remoteDescription) throw new Error('Remote description is required before ICE.');
    this.addedCandidates.push(candidate);
  }

  close() {
    if (this.connectionState === 'closed') return;
    this.connectionState = 'closed';
    queueMicrotask(() => this.onconnectionstatechange?.());
  }
}
