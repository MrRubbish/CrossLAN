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

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  await acceptP2pRequest(engine, signaling, 0);
  await waitFor(() => FakePeerConnection.instances.length === 1);
  assert.equal(messagesOfType(signaling, 'offer').length, 1);
  assert.equal(progress.filter(item => !item.done).length, 1);

  FakePeerConnection.instances[0].dataChannel.open();
  await first;

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 2);
  await acceptP2pRequest(engine, signaling, 1);
  await waitFor(() => FakePeerConnection.instances.length === 2);
  assert.equal(messagesOfType(signaling, 'offer').length, 2);
  FakePeerConnection.instances[1].dataChannel.open();
  await second;

  const completed = progress.filter(item => item.done && item.direction === 'send');
  assert.deepEqual(completed.map(item => item.fileName), ['first.bin', 'second.bin']);
  assert.ok(completed.every(item => item.bytesTransferred === item.totalBytes));
});

test('outgoing WebRTC waits for receiver confirmation before creating an offer', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const transfer = engine.sendFile('receiver', createFile('preflight.bin', 160 * 1024));

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  const request = messagesOfType(signaling, 'p2p-transfer-request')[0];
  assert.equal(FakePeerConnection.instances.length, 0);

  await engine.handleSignal({
    type: 'p2p-transfer-accept',
    from: 'receiver',
    transferId: request.fileMeta.transferId
  });
  await waitFor(() => FakePeerConnection.instances.length === 1);
  await waitFor(() => messagesOfType(signaling, 'offer').length === 1);
  assert.equal(messagesOfType(signaling, 'offer').length, 1);

  FakePeerConnection.instances[0].dataChannel.open();
  await transfer;
});

test('incoming P2P confirmation is not shown again when the offer arrives', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'receiver');
  let promptCount = 0;
  engine.onIncoming(() => {
    promptCount += 1;
    return true;
  });
  const meta = {
    transferId: 'preflight-incoming-1',
    name: 'large.bin',
    size: 1024,
    type: 'application/octet-stream',
    lastModified: 1
  };

  await engine.handleSignal({
    type: 'p2p-transfer-request',
    from: 'sender',
    fileMeta: meta
  });
  assert.equal(promptCount, 1);
  assert.equal(messagesOfType(signaling, 'p2p-transfer-accept').length, 1);
  assert.equal(FakePeerConnection.instances.length, 0);

  await engine.handleSignal({
    type: 'offer',
    from: 'sender',
    transferId: meta.transferId,
    description: { type: 'offer', sdp: 'test-offer' },
    fileMeta: meta
  });
  assert.equal(promptCount, 1);
  assert.equal(messagesOfType(signaling, 'answer').length, 1);
  engine.cancelTransfer(meta.transferId);
});

test('incoming P2P save preparation failure sends a rejection to the sender', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'receiver');
  engine.onIncoming(async meta => {
    await engine.prepareIncomingTransfer(meta);
    return true;
  });

  const meta = {
    transferId: 'preflight-failed-1',
    name: 'too-large-for-http.bin',
    size: 513 * 1024 * 1024,
    type: 'application/octet-stream',
    lastModified: 1
  };

  await engine.handleSignal({
    type: 'p2p-transfer-request',
    from: 'sender',
    fileMeta: meta
  });

  assert.equal(messagesOfType(signaling, 'p2p-transfer-accept').length, 0);
  assert.equal(messagesOfType(signaling, 'p2p-transfer-reject').length, 1);
  assert.equal(messagesOfType(signaling, 'p2p-transfer-reject')[0].transferId, meta.transferId);
});

test('batch P2P preparation uses one browser download without reopening the save picker', async () => {
  installBrowserGlobals();
  let pickerCalls = 0;
  window.isSecureContext = true;
  window.showSaveFilePicker = async () => {
    pickerCalls += 1;
    throw new Error('The batch must not open the native save picker.');
  };
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'receiver');
  const meta = {
    transferId: 'batch-p2p-1',
    name: 'CrossLAN-batch.zip',
    size: 16 * 1024 * 1024,
    type: 'application/zip',
    lastModified: 1,
    batchId: 'batch-1',
    batchIndex: 0,
    batchTotal: 1
  };

  await engine.prepareIncomingTransfer(meta);

  assert.equal(pickerCalls, 0);
  assert.equal(engine.preparedReceiveStates.get(meta.transferId)?.mode, 'blob');
  engine.cancelTransfer(meta.transferId);
});

test('a synchronous incoming P2P decision error still sends a rejection', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'receiver');
  engine.onIncoming(() => {
    throw new Error('prompt handler failed');
  });

  const meta = {
    transferId: 'preflight-sync-failed-1',
    name: 'small.bin',
    size: 1024,
    type: 'application/octet-stream',
    lastModified: 1
  };

  await engine.handleSignal({
    type: 'p2p-transfer-request',
    from: 'sender',
    fileMeta: meta
  });

  assert.equal(messagesOfType(signaling, 'p2p-transfer-reject').length, 1);
  assert.equal(messagesOfType(signaling, 'p2p-transfer-reject')[0].transferId, meta.transferId);
});

test('ignores an accept from an unexpected peer until the expected peer responds', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const transfer = engine.sendFile('receiver', createFile('source-check.bin', 96 * 1024));

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  const transferId = messagesOfType(signaling, 'p2p-transfer-request')[0].fileMeta.transferId;

  await engine.handleSignal({
    type: 'p2p-transfer-accept',
    from: 'unexpected-peer',
    transferId
  });
  assert.equal(FakePeerConnection.instances.length, 0);
  assert.equal(messagesOfType(signaling, 'offer').length, 0);

  await engine.handleSignal({
    type: 'p2p-transfer-accept',
    from: 'receiver',
    transferId
  });
  await waitFor(() => FakePeerConnection.instances.length === 1);
  FakePeerConnection.instances[0].dataChannel.open();
  await transfer;
});

test('ignores a rejection from an unexpected peer', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const transfer = engine.sendFile('receiver', createFile('reject-source-check.bin', 96 * 1024));

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  const transferId = messagesOfType(signaling, 'p2p-transfer-request')[0].fileMeta.transferId;

  await engine.handleSignal({
    type: 'p2p-transfer-reject',
    from: 'unexpected-peer',
    transferId,
    reason: 'Unexpected rejection'
  });
  assert.equal(FakePeerConnection.instances.length, 0);

  await engine.handleSignal({
    type: 'p2p-transfer-reject',
    from: 'receiver',
    transferId,
    reason: 'Receiver rejected the transfer'
  });
  await assert.rejects(transfer, /Receiver rejected the transfer/);
});

test('rejects the sender when the data channel closes before completion', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const transfer = engine.sendFile('receiver', createFile('channel-close.bin', 512 * 1024));

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  await acceptP2pRequest(engine, signaling, 0);
  await waitFor(() => FakePeerConnection.instances.length === 1);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.closeAfterBinarySend = true;
  channel.open();

  await assert.rejects(transfer, /channel closed|session is no longer active/i);
  assert.equal(channel.readyState, 'closed');
  assert.ok(channel.sentBinarySizes.length >= 1);
});

test('cancelling an active send prevents later data channel sends', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const transfer = engine.sendFile('receiver', createFile('cancel-before-send.bin', 512 * 1024));

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  const transferId = messagesOfType(signaling, 'p2p-transfer-request')[0].fileMeta.transferId;
  await acceptP2pRequest(engine, signaling, 0);
  await waitFor(() => FakePeerConnection.instances.length === 1);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.open();
  engine.cancelTransfer(transferId);

  await assert.rejects(transfer, error => error?.name === 'TransferCancelledError');
  const sentBeforeWait = channel.sentBinarySizes.length;
  await delay(20);
  assert.equal(channel.sentBinarySizes.length, sentBeforeWait);
});

test('backpressure wait ends when the data channel closes', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const transfer = engine.sendFile('receiver', createFile('backpressure-close.bin', 96 * 1024));

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  await acceptP2pRequest(engine, signaling, 0);
  await waitFor(() => FakePeerConnection.instances.length === 1);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.bufferedAmount = 20 * 1024 * 1024;
  channel.open();
  await delay(5);
  channel.close();

  await assert.rejects(withTimeout(transfer), /closed|capacity/i);
});

test('backpressure wait ends when the data channel reports an error', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const transfer = engine.sendFile('receiver', createFile('backpressure-error.bin', 96 * 1024));

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  await acceptP2pRequest(engine, signaling, 0);
  await waitFor(() => FakePeerConnection.instances.length === 1);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.bufferedAmount = 20 * 1024 * 1024;
  channel.open();
  await delay(5);
  channel.fail();

  await assert.rejects(withTimeout(transfer), /failed|capacity/i);
});

test('malformed receiver control data is handled without an uncaught exception', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'receiver');
  const meta = {
    transferId: 'malformed-control-transfer',
    name: 'malformed.bin',
    size: 1024,
    type: 'application/octet-stream',
    lastModified: 1
  };

  await engine.handleSignal({
    type: 'offer',
    from: 'sender',
    transferId: meta.transferId,
    description: { type: 'offer', sdp: 'test-offer' },
    fileMeta: meta
  });
  const peer = FakePeerConnection.instances[0];
  const channel = peer.dataChannel;
  peer.deliverDataChannel();
  channel.open();

  const uncaught = [];
  const unhandled = [];
  const onUncaught = error => uncaught.push(error);
  const onUnhandled = error => unhandled.push(error);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  try {
    channel.receive('{not-json');
    await waitFor(() => peer.connectionState === 'closed');
    await delay(10);
  } finally {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(uncaught, []);
  assert.deepEqual(unhandled, []);
  assert.equal(peer.connectionState, 'closed');
});

test('malformed sender control data is handled without an uncaught exception', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const transfer = engine.sendFile('receiver', createFile('malformed-sender-control.bin', 96 * 1024));

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  await acceptP2pRequest(engine, signaling, 0);
  await waitFor(() => FakePeerConnection.instances.length === 1);
  const peer = FakePeerConnection.instances[0];
  const channel = peer.dataChannel;
  channel.open();

  const uncaught = [];
  const unhandled = [];
  const onUncaught = error => uncaught.push(error);
  const onUnhandled = error => unhandled.push(error);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  const transferRejection = assert.rejects(withTimeout(transfer), /invalid transfer control/i);
  try {
    channel.receive('null');
    await delay(10);
  } finally {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);
  }

  await transferRejection;
  assert.deepEqual(uncaught, []);
  assert.deepEqual(unhandled, []);
  assert.equal(peer.connectionState, 'closed');
});

test('cancelling while the save picker is resolving aborts the eventual receive writer', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  let resolvePicker;
  const abortReasons = [];
  globalThis.window.isSecureContext = true;
  globalThis.window.showSaveFilePicker = () => new Promise(resolve => {
    resolvePicker = resolve;
  });
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'receiver');
  const meta = {
    transferId: 'picker-cancel-race',
    name: 'picker-race.bin',
    size: 1024,
    type: 'application/octet-stream',
    lastModified: 1
  };

  const preparing = engine.prepareIncomingTransfer(meta);
  await waitFor(() => typeof resolvePicker === 'function');
  engine.cancelTransfer(meta.transferId, 'Cancelled while choosing a save location.', true);

  const writer = {
    write: async () => undefined,
    close: async () => undefined,
    abort: async reason => abortReasons.push(reason)
  };
  resolvePicker({
    createWritable: async () => ({ getWriter: () => writer })
  });

  await assert.rejects(preparing, error => error?.name === 'TransferCancelledError');
  assert.deepEqual(abortReasons, ['Cancelled while choosing a save location.']);
});

test('retries a binary send when the browser reports a full data channel queue', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const transfer = engine.sendFile('receiver', createFile('queue-retry.bin', 512 * 1024));

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  await acceptP2pRequest(engine, signaling, 0);
  await waitFor(() => FakePeerConnection.instances.length === 1);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.queueFullErrors = 1;
  channel.open();

  await transfer;
  assert.equal(channel.queueFullErrors, 0);
  assert.equal(channel.sentBinarySizes.reduce((total, size) => total + size, 0), 512 * 1024);
  assert.ok(channel.binarySendAttempts > channel.sentBinarySizes.length);
});

test('WebRTC sender uses larger chunks to reduce per-message overhead', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const transfer = engine.sendFile('receiver', createFile('chunked.bin', 768 * 1024));

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  await acceptP2pRequest(engine, signaling, 0);
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

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  await acceptP2pRequest(engine, signaling, 0);
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

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  await acceptP2pRequest(engine, signaling, 0);
  await waitFor(() => FakePeerConnection.instances.length === 1);
  const firstTask = progress.find(item => item.fileName === 'cancelled.bin' && !item.done);
  assert.ok(firstTask);
  engine.cancelTransfer(firstTask.id);

  await assert.rejects(first, error => error?.name === 'TransferCancelledError');
  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 2);
  await acceptP2pRequest(engine, signaling, 1);
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

  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  await acceptP2pRequest(engine, signaling, 0);
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
    setTimeout: unrefSetTimeout,
    clearTimeout,
    setInterval: unrefSetInterval,
    clearInterval
  };
  globalThis.requestAnimationFrame = callback => {
    callback(performance.now());
    return 1;
  };
  globalThis.RTCPeerConnection = FakePeerConnection;
}

function unrefSetTimeout(callback, delay, ...args) {
  const timer = setTimeout(callback, delay, ...args);
  timer.unref?.();
  return timer;
}

function unrefSetInterval(callback, delay, ...args) {
  const timer = setInterval(callback, delay, ...args);
  timer.unref?.();
  return timer;
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

async function delay(timeoutMs) {
  await new Promise(resolve => setTimeout(resolve, timeoutMs));
}

async function withTimeout(promise, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for transfer rejection.')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function acceptP2pRequest(engine, signaling, index) {
  const request = messagesOfType(signaling, 'p2p-transfer-request')[index];
  assert.ok(request);
  await engine.handleSignal({
    type: 'p2p-transfer-accept',
    from: 'receiver',
    transferId: request.fileMeta.transferId
  });
}

class FakeDataChannel {
  constructor() {
    this.binaryType = 'arraybuffer';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.readyState = 'connecting';
    this.bytesReceived = 0;
    this.sentBinarySizes = [];
    this.binarySendAttempts = 0;
    this.queueFullErrors = 0;
    this.closeAfterBinarySend = false;
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

    this.binarySendAttempts += 1;
    if (this.queueFullErrors > 0) {
      this.queueFullErrors -= 1;
      throw new Error('RTCDataChannel send queue is full');
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
    if (this.closeAfterBinarySend) {
      this.closeAfterBinarySend = false;
      this.close();
    }
  }

  open() {
    this.readyState = 'open';
    this.onopen?.();
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatch('close');
    queueMicrotask(() => this.onclose?.());
  }

  fail() {
    this.dispatch('error');
    queueMicrotask(() => this.onerror?.(new Error('Fake data channel failed.')));
  }

  receive(data) {
    this.onmessage?.({ data });
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) listener();
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

  deliverDataChannel() {
    this.ondatachannel?.({ channel: this.dataChannel });
  }
}
