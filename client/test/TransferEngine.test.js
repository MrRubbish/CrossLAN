import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const { TransferEngine } = await loadTransferEngine();

test('sender waits for P2P receiver acceptance before creating an offer', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');

  const transfer = engine.sendFile('receiver', createFile('preflight.bin', 96 * 1024));
  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  const request = messagesOfType(signaling, 'p2p-transfer-request')[0];

  assert.equal(FakePeerConnection.instances.length, 0);
  assert.equal(messagesOfType(signaling, 'offer').length, 0);

  await engine.handleSignal({
    type: 'p2p-transfer-accept',
    from: 'receiver',
    transferId: request.fileMeta.transferId
  });
  await waitFor(() => FakePeerConnection.instances.length === 1);
  await waitFor(() => messagesOfType(signaling, 'offer').length === 1);

  const offer = messagesOfType(signaling, 'offer')[0];
  assert.equal(offer.transferId, request.fileMeta.transferId);
  FakePeerConnection.instances[0].dataChannel.open();
  await transfer;
});

test('P2P sessions use the ICE servers supplied by the signaling layer', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const iceServers = [{ urls: ['stun:192.168.1.10:6100'] }];
  const engine = new TransferEngine(signaling, () => 'sender', () => iceServers);

  const transfer = engine.sendFile('receiver', createFile('lan-stun.bin', 32 * 1024));
  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  const transferId = messagesOfType(signaling, 'p2p-transfer-request')[0].fileMeta.transferId;
  await engine.handleSignal({ type: 'p2p-transfer-accept', from: 'receiver', transferId });
  await waitFor(() => FakePeerConnection.instances.length === 1);

  assert.deepEqual(FakePeerConnection.instances[0].configuration, { iceServers });
  FakePeerConnection.instances[0].dataChannel.open();
  await transfer;
});

test('files to the same peer remain sequential until the first receive closes', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const batch = { batchId: 'sequential-batch', batchTotal: 2 };
  const first = engine.sendFile('receiver', createFile('first.bin', 1024), { ...batch, batchIndex: 0 });
  const second = engine.sendFile('receiver', createFile('second.bin', 2048), { ...batch, batchIndex: 1 });
  await acceptLatestRequest(engine, signaling);
  const firstChannel = FakePeerConnection.instances[0].dataChannel;
  firstChannel.autoSaved = false;
  firstChannel.open();
  await waitFor(() => firstChannel.pendingSavedTransferId);
  assert.equal(messagesOfType(signaling, 'p2p-transfer-request').length, 1);
  firstChannel.releaseSaved();
  await first;
  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 2);
  const request = messagesOfType(signaling, 'p2p-transfer-request')[1];
  assert.equal(request.fileMeta.batchId, batch.batchId);
  assert.equal(request.fileMeta.batchIndex, 1);
  await engine.handleSignal({ type: 'p2p-transfer-accept', from: 'receiver', transferId: request.fileMeta.transferId });
  await waitFor(() => FakePeerConnection.instances.length === 2);
  const secondChannel = FakePeerConnection.instances[1].dataChannel;
  secondChannel.autoSaved = false;
  secondChannel.open();
  await waitFor(() => secondChannel.pendingSavedTransferId);
  secondChannel.releaseSaved();
  await second;
  assert.equal(secondChannel.bytesReceived, 2048);
});

test('cancelling the first file releases the next same-peer preflight', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const first = engine.sendFile('receiver', createFile('cancel.bin', 1024));
  const second = engine.sendFile('receiver', createFile('next.bin', 1024));
  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  const firstId = messagesOfType(signaling, 'p2p-transfer-request')[0].fileMeta.transferId;
  const rejection = assert.rejects(first, /cancel/i);
  engine.cancelTransfer(firstId);
  await rejection;
  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 2);
  const next = messagesOfType(signaling, 'p2p-transfer-request')[1];
  await engine.handleSignal({ type: 'p2p-transfer-accept', from: 'receiver', transferId: next.fileMeta.transferId });
  await waitFor(() => FakePeerConnection.instances.length === 1);
  FakePeerConnection.instances[0].dataChannel.open();
  await second;
});

test('P2P preflight rejection fails the sender without creating a peer', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');

  const transfer = engine.sendFile('receiver', createFile('rejected.bin', 64 * 1024));
  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  const transferId = messagesOfType(signaling, 'p2p-transfer-request')[0].fileMeta.transferId;

  await engine.handleSignal({
    type: 'p2p-transfer-reject',
    from: 'receiver',
    transferId,
    reason: 'No thanks.'
  });

  await assert.rejects(transfer, error => {
    assert.equal(error.name, 'P2PRejectedError');
    assert.match(error.message, /No thanks/);
    return true;
  });
  assert.equal(FakePeerConnection.instances.length, 0);
});

test('P2P preflight timeout cancels the obsolete receiver request', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const nativeSetTimeout = window.setTimeout;
  window.setTimeout = (callback, delay) =>
    nativeSetTimeout(callback, delay === 120000 ? 0 : delay);

  const transfer = engine.sendFile('receiver', createFile('timeout.bin', 64 * 1024));
  await assert.rejects(transfer, error => {
    assert.match(error.message, /Timed out waiting for receiver confirmation/);
    assert.equal(error.p2pStage, 'preflight');
    return true;
  });

  const request = messagesOfType(signaling, 'p2p-transfer-request')[0];
  const cancellation = messagesOfType(signaling, 'p2p-transfer-cancel')[0];
  assert.equal(cancellation.to, 'receiver');
  assert.equal(cancellation.transferId, request.fileMeta.transferId);
  assert.equal(messagesOfType(signaling, 'transfer-cancel').length, 0);
});

test('P2P connection timeout cancels the prepared receiver and tombstones late ICE', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');

  const transfer = engine.sendFile('receiver', createFile('connection-timeout.bin', 64 * 1024));
  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  const transferId = messagesOfType(signaling, 'p2p-transfer-request')[0].fileMeta.transferId;
  const nativeSetTimeout = window.setTimeout;
  window.setTimeout = (callback, delay) =>
    nativeSetTimeout(callback, delay === 120000 ? 0 : delay);

  await engine.handleSignal({
    type: 'p2p-transfer-accept',
    from: 'receiver',
    transferId
  });

  await assert.rejects(transfer, error => {
    assert.match(error.message, /Timed out waiting for the peer connection/);
    assert.equal(error.p2pStage, 'connecting');
    return true;
  });
  const cancellation = messagesOfType(signaling, 'p2p-transfer-cancel')[0];
  assert.equal(cancellation.to, 'receiver');
  assert.equal(cancellation.transferId, transferId);

  await engine.handleSignal({
    type: 'ice-candidate',
    from: 'receiver',
    transferId,
    candidate: { candidate: 'candidate:late-after-timeout' }
  });
  assert.equal(engine.pendingIceByTransfer.has(transferId), false);
  assert.equal(engine.cancelledTransfers.has(transferId), true);
});

test('receiver accepts only after its receive sink is prepared', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'receiver');
  const sink = createSink();
  let resolveIncoming;
  let incomingContext;
  engine.onIncoming((meta, from, context) => {
    incomingContext = { meta, from, context };
    return new Promise(resolve => {
      resolveIncoming = resolve;
    });
  });
  const meta = createMeta('prepared-sink', 64 * 1024 * 1024);

  const request = engine.handleSignal({
    type: 'p2p-transfer-request',
    from: 'sender',
    fileMeta: meta
  });
  await waitFor(() => typeof resolveIncoming === 'function');

  assert.equal(messagesOfType(signaling, 'p2p-transfer-accept').length, 0);
  assert.equal(incomingContext.context.requiresLargeSink, false);

  resolveIncoming({ accepted: true, sink });
  await request;

  assert.equal(sink.prepared, 1);
  assert.equal(messagesOfType(signaling, 'p2p-transfer-accept')[0].transferId, meta.transferId);

  await engine.handleSignal({
    type: 'offer',
    from: 'sender',
    transferId: meta.transferId,
    description: { type: 'offer', sdp: 'test-offer' }
  });
  assert.equal(messagesOfType(signaling, 'answer')[0].transferId, meta.transferId);
});

test('offer, answer, and ICE signaling is scoped by transferId', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const sender = new TransferEngine(signaling, () => 'sender');

  const transfer = sender.sendFile('receiver', createFile('scoped.bin', 32 * 1024));
  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  const transferId = messagesOfType(signaling, 'p2p-transfer-request')[0].fileMeta.transferId;
  await sender.handleSignal({ type: 'p2p-transfer-accept', from: 'receiver', transferId });
  await waitFor(() => FakePeerConnection.instances.length === 1);
  const peer = FakePeerConnection.instances[0];

  peer.onicecandidate({
    candidate: {
      type: 'host',
      toJSON: () => ({ candidate: 'candidate:sender' })
    }
  });
  await sender.handleSignal({
    type: 'answer',
    from: 'receiver',
    transferId,
    description: { type: 'answer', sdp: 'test-answer' }
  });

  assert.equal(messagesOfType(signaling, 'offer')[0].transferId, transferId);
  assert.equal(messagesOfType(signaling, 'ice-candidate')[0].transferId, transferId);
  peer.dataChannel.open();
  await transfer;
});

test('two transferIds from the same peer keep independent receiver sessions', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const engine = new TransferEngine(createSignaling(), () => 'receiver');
  engine.onIncoming(() => ({ accepted: true, sink: createSink() }));
  const first = createMeta('same-peer-1', 1024);
  const second = createMeta('same-peer-2', 2048);

  await engine.handleSignal({ type: 'p2p-transfer-request', from: 'sender', fileMeta: first });
  await engine.handleSignal({ type: 'p2p-transfer-request', from: 'sender', fileMeta: second });
  await engine.handleSignal({
    type: 'offer',
    from: 'sender',
    transferId: first.transferId,
    description: { type: 'offer', sdp: 'one' }
  });
  await engine.handleSignal({
    type: 'offer',
    from: 'sender',
    transferId: second.transferId,
    description: { type: 'offer', sdp: 'two' }
  });

  assert.equal(FakePeerConnection.instances.length, 2);
  assert.equal(engine.sessions.size, 2);
  assert.ok(engine.sessions.has(first.transferId));
  assert.ok(engine.sessions.has(second.transferId));
});

test('early ICE candidates are applied only to their matching transfer', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const engine = new TransferEngine(createSignaling(), () => 'receiver');
  engine.onIncoming(() => ({ accepted: true, sink: createSink() }));
  const first = createMeta('ice-one', 1024);
  const second = createMeta('ice-two', 1024);
  const candidateOne = { candidate: 'candidate:one' };
  const candidateTwo = { candidate: 'candidate:two' };

  await engine.handleSignal({ type: 'ice-candidate', from: 'sender', transferId: first.transferId, candidate: candidateOne });
  await engine.handleSignal({ type: 'ice-candidate', from: 'sender', transferId: second.transferId, candidate: candidateTwo });
  await engine.handleSignal({ type: 'p2p-transfer-request', from: 'sender', fileMeta: first });
  await engine.handleSignal({ type: 'p2p-transfer-request', from: 'sender', fileMeta: second });
  await engine.handleSignal({
    type: 'offer',
    from: 'sender',
    transferId: first.transferId,
    description: { type: 'offer', sdp: 'one' }
  });
  await engine.handleSignal({
    type: 'offer',
    from: 'sender',
    transferId: second.transferId,
    description: { type: 'offer', sdp: 'two' }
  });

  assert.deepEqual(FakePeerConnection.instances[0].addedCandidates, [candidateOne]);
  assert.deepEqual(FakePeerConnection.instances[1].addedCandidates, [candidateTwo]);
});

test('sender adapts chunk size to SCTP maxMessageSize', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  FakePeerConnection.maxMessageSize = 64 * 1024;
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');

  const transfer = engine.sendFile('receiver', createFile('adaptive.bin', 160 * 1024));
  await acceptLatestRequest(engine, signaling);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.open();
  await transfer;

  assert.deepEqual(channel.sentBinarySizes, [64 * 1024, 64 * 1024, 32 * 1024]);
});

test('sender prefetches MiB read blocks but never more than four concurrently', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  FakePeerConnection.maxMessageSize = 64 * 1024;
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const tracked = createTrackedFile('prefetch.bin', 12 * 1024 * 1024);

  const transfer = engine.sendFile('receiver', tracked.file);
  await acceptLatestRequest(engine, signaling);
  FakePeerConnection.instances[0].dataChannel.open();
  await transfer;

  assert.ok(tracked.maxReads > 1);
  assert.ok(tracked.maxReads <= 4);
  assert.equal(tracked.readSizes.length, 12);
  assert.ok(tracked.readSizes.every(size => size === 1024 * 1024));
});

test('batched file reads preserve SCTP message offsets, content, and the short final read', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const size = 2 * 1024 * 1024 + 37;
  const content = new Uint8Array(size);
  for (let index = 0; index < size; index++) content[index] = index % 251;
  const file = new File([content], 'block-offsets.bin');
  const transfer = engine.sendFile('receiver', file);
  await acceptLatestRequest(engine, signaling);
  const channel = FakePeerConnection.instances[0].dataChannel;
  const send = channel.send.bind(channel);
  let received = 0;
  channel.send = payload => {
    if (typeof payload !== 'string') {
      const view = ArrayBuffer.isView(payload) ? payload : new Uint8Array(payload);
      assert.deepEqual(view, content.subarray(received, received + view.byteLength));
      received += view.byteLength;
    }
    return send(payload);
  };
  channel.open();
  await transfer;
  assert.equal(received, size);
  assert.equal(channel.sentBinarySizes.at(-1), 37);
});

test('sender completion waits for receiver saved acknowledgement', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const progress = [];
  engine.onProgress(item => progress.push(item));

  const transfer = engine.sendFile('receiver', createFile('saved-ack.bin', 64 * 1024));
  await acceptLatestRequest(engine, signaling);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.autoSaved = false;
  channel.open();
  await waitFor(() => channel.pendingSavedTransferId);

  assert.equal(progress.some(item => item.done), false);
  let settled = false;
  void transfer.finally(() => {
    settled = true;
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(settled, false);

  channel.releaseSaved();
  await transfer;
  assert.ok(progress.some(item => item.done && item.bytesTransferred === item.totalBytes));
});

test('sender failure preserves receiver-acknowledged bytes', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const progress = [];
  engine.onProgress(item => progress.push(item));
  const file = createFile('acknowledged-failure.bin', 64 * 1024);

  const transfer = engine.sendFile('receiver', file);
  await acceptLatestRequest(engine, signaling);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.autoSaved = false;
  channel.open();
  await waitFor(() => progress.some(item => item.bytesDelivered === file.size));
  channel.onerror?.();

  await assert.rejects(transfer, error => {
    assert.equal(error.bytesDelivered, file.size);
    assert.equal(error.p2pStage, 'transferring');
    return true;
  });
  const terminal = progress.at(-1);
  assert.equal(terminal.done, true);
  assert.equal(terminal.bytesDelivered, file.size);
  assert.equal(terminal.bytesTransferred, file.size);
});

test('P2P progress reports delivered-byte speed statistics', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  FakePeerConnection.maxMessageSize = 64 * 1024;
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const progress = [];
  engine.onProgress(item => progress.push(item));

  const transfer = engine.sendFile('receiver', createFile('stats.bin', 128 * 1024));
  await acceptLatestRequest(engine, signaling);
  FakePeerConnection.instances[0].dataChannel.open();
  await transfer;

  const delivered = progress.find(item =>
    item.bytesDelivered > 0 &&
    Number.isFinite(item.speedBytesPerSecond) &&
    Number.isFinite(item.averageBytesPerSecond) &&
    Number.isFinite(item.peakBytesPerSecond)
  );
  assert.ok(delivered);
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
});

test('sender recovers when the browser reports that the RTCDataChannel send queue is full', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  FakePeerConnection.maxMessageSize = 256 * 1024;
  FakePeerConnection.sendQueueCapacity = 512 * 1024;
  FakePeerConnection.sendQueueDrainDelayMs = 5;
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender', () => [], false,
    { sendBufferBytes: 2 * 1024 * 1024 });

  const transfer = engine.sendFile('receiver', createFile('mobile-queue.bin', 1024 * 1024));
  await acceptLatestRequest(engine, signaling);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.open();
  await transfer;

  assert.ok(channel.queueFullErrors > 0);
  assert.equal(channel.bytesReceived, 1024 * 1024);
});

test('closing a buffered channel wakes the sender even when background polls do not run', async () => {
  installBrowserGlobals();
  const engine = new TransferEngine(createSignaling(), () => 'sender');
  const channel = new FakeDataChannel();
  channel.readyState = 'open';
  channel.bufferedAmount = 32;
  const nativeSetInterval = window.setInterval;
  window.setInterval = () => 0;
  try {
    let released = false;
    const waiting = engine.waitForBackpressure(channel, 32, 16).then(() => { released = true; });
    channel.readyState = 'closed';
    channel.emit('close');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(released, true);
    await waiting;
    assert.equal(channel.listeners.get('bufferedamountlow').size, 0);
    assert.equal(channel.listeners.get('close').size, 0);
  } finally {
    window.setInterval = nativeSetInterval;
  }
});

test('a small sender queue override applies real backpressure without losing bytes', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  FakePeerConnection.sendQueueCapacity = 2 * 1024 * 1024;
  FakePeerConnection.sendQueueDrainDelayMs = 5;
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender', () => [], true,
    { sendBufferBytes: 2 * 1024 * 1024 });
  const reports = [];
  engine.onDebug((message, details) => { if (message === 'p2p performance') reports.push(details); });
  const transfer = engine.sendFile('receiver', createFile('small-queue.bin', 4 * 1024 * 1024));
  await acceptLatestRequest(engine, signaling);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.open();
  await transfer;
  assert.equal(channel.queueFullErrors, 0);
  assert.equal(channel.bytesReceived, 4 * 1024 * 1024);
  assert.equal(reports[0].sendBufferHighWater, 2 * 1024 * 1024);
  assert.ok(reports[0].maxBufferedAmount <= 2 * 1024 * 1024);
});

test('the default sender keeps native buffered bytes within 512 KiB', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  FakePeerConnection.sendQueueCapacity = 2 * 1024 * 1024;
  FakePeerConnection.sendQueueDrainDelayMs = 5;
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender', () => [], true);
  const reports = [];
  engine.onDebug((message, details) => { if (message === 'p2p performance') reports.push(details); });
  const transfer = engine.sendFile('receiver', createFile('default-bounded.bin', 4 * 1024 * 1024));
  await acceptLatestRequest(engine, signaling);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.open();
  await transfer;
  assert.equal(channel.queueFullErrors, 0);
  assert.equal(channel.bytesReceived, 4 * 1024 * 1024);
  assert.equal(reports[0].sendBufferHighWater, 512 * 1024);
  assert.ok(reports[0].maxBufferedAmount <= 512 * 1024);
});

test('invalid sender queue overrides retain the bounded default profile', async () => {
  for (const sendBufferBytes of [0, -1, 1024, 33 * 1024 * 1024, NaN, Infinity]) {
    installBrowserGlobals();
    FakePeerConnection.reset();
    const signaling = createSignaling();
    const engine = new TransferEngine(signaling, () => 'sender', () => [], true, { sendBufferBytes });
    const reports = [];
    engine.onDebug((message, details) => { if (message === 'p2p performance') reports.push(details); });
    const transfer = engine.sendFile('receiver', createFile('default-queue.bin', 1024));
    await acceptLatestRequest(engine, signaling);
    FakePeerConnection.instances[0].dataChannel.open();
    await transfer;
    assert.equal(reports[0].sendBufferHighWater, 512 * 1024);
  }
});

test('remote cancellation while sink approval is pending prevents late acceptance', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'receiver');
  const sink = createSink();
  let resolveIncoming;
  engine.onIncoming(() => new Promise(resolve => {
    resolveIncoming = resolve;
  }));
  const meta = createMeta('cancelled-preflight', 1024);

  const request = engine.handleSignal({ type: 'p2p-transfer-request', from: 'sender', fileMeta: meta });
  await waitFor(() => typeof resolveIncoming === 'function');
  await engine.handleSignal({
    type: 'transfer-cancel',
    from: 'sender',
    transferId: meta.transferId,
    reason: 'Peer cancelled.'
  });
  resolveIncoming({ accepted: true, sink });
  await request;

  assert.equal(messagesOfType(signaling, 'p2p-transfer-accept').length, 0);
  assert.equal(sink.aborted, 1);
  assert.equal(FakePeerConnection.instances.length, 0);
});

test('cancellation after sink preparation suppresses late offer and ICE', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'receiver');
  const sink = createSink();
  engine.onIncoming(() => ({ accepted: true, sink }));
  const meta = createMeta('prepared-cancel', 1024);

  await engine.handleSignal({ type: 'p2p-transfer-request', from: 'sender', fileMeta: meta });
  assert.equal(messagesOfType(signaling, 'p2p-transfer-accept').length, 1);
  await engine.handleSignal({
    type: 'transfer-cancel',
    from: 'sender',
    transferId: meta.transferId,
    reason: 'Peer cancelled.'
  });
  await engine.handleSignal({
    type: 'ice-candidate',
    from: 'sender',
    transferId: meta.transferId,
    candidate: { candidate: 'candidate:late' }
  });
  await engine.handleSignal({
    type: 'offer',
    from: 'sender',
    transferId: meta.transferId,
    description: { type: 'offer', sdp: 'late' }
  });

  assert.equal(sink.aborted, 1);
  assert.equal(FakePeerConnection.instances.length, 0);
  assert.equal(engine.pendingIceByTransfer.has(meta.transferId), false);
});

test('P2P-only cancellation suppresses late setup without creating a global transfer cancellation', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'receiver');
  const sink = createSink();
  engine.onIncoming(() => ({ accepted: true, sink }));
  const meta = createMeta('p2p-only-cancel', 1024);

  await engine.handleSignal({ type: 'p2p-transfer-request', from: 'sender', fileMeta: meta });
  await engine.handleSignal({
    type: 'p2p-transfer-cancel',
    from: 'sender',
    transferId: meta.transferId,
    reason: 'P2P setup failed; sender may retry with Relay.'
  });
  await engine.handleSignal({
    type: 'ice-candidate',
    from: 'sender',
    transferId: meta.transferId,
    candidate: { candidate: 'candidate:late-p2p-only' }
  });

  assert.equal(sink.aborted, 1);
  assert.equal(engine.pendingIceByTransfer.has(meta.transferId), false);
  assert.equal(messagesOfType(signaling, 'transfer-cancel').length, 0);
});

test('active sender cancellation closes the channel and settles as cancelled', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const progress = [];
  engine.onProgress(item => progress.push(item));

  const transfer = engine.sendFile('receiver', createFile('active-cancel.bin', 64 * 1024));
  const transferId = await acceptLatestRequest(engine, signaling);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.autoSaved = false;
  channel.open();
  await waitFor(() => channel.pendingSavedTransferId);
  engine.cancelTransfer(transferId, 'Stopped locally.');

  await assert.rejects(transfer, error => error.name === 'TransferCancelledError');
  assert.equal(channel.readyState, 'closed');
  assert.ok(progress.some(item => item.done && item.cancelled));
});

test('cancelling during prefetch prevents queued chunks from being sent', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  FakePeerConnection.maxMessageSize = 64 * 1024;
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const deferred = createDeferredFile('prefetch-cancel.bin', 12 * 1024 * 1024);

  const transfer = engine.sendFile('receiver', deferred.file);
  const transferId = await acceptLatestRequest(engine, signaling);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.open();
  await waitFor(() => deferred.pendingReads === 4);
  engine.cancelTransfer(transferId, 'Stopped during prefetch.');
  deferred.releaseAll();

  await assert.rejects(transfer, error => error.name === 'TransferCancelledError');
  assert.deepEqual(channel.sentBinarySizes, []);
});

test('successful receiver cleanup does not abort the completed sink', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'receiver');
  const sink = createSink();
  engine.onIncoming(() => ({ accepted: true, sink }));
  const meta = createMeta('completed-sink', 4);

  await engine.handleSignal({ type: 'p2p-transfer-request', from: 'sender', fileMeta: meta });
  await engine.handleSignal({
    type: 'offer',
    from: 'sender',
    transferId: meta.transferId,
    description: { type: 'offer', sdp: 'complete' }
  });
  const peer = FakePeerConnection.instances[0];
  const channel = peer.dataChannel;
  peer.ondatachannel({ channel });
  channel.open();
  channel.onmessage({ data: JSON.stringify({ type: 'meta', meta }) });
  channel.onmessage({ data: new Uint8Array([1, 2, 3, 4]).buffer });
  channel.onmessage({ data: JSON.stringify({ type: 'done', transferId: meta.transferId }) });

  await waitFor(() => sink.closed === 1);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(sink.aborted, 0);
});

async function acceptLatestRequest(engine, signaling) {
  await waitFor(() => messagesOfType(signaling, 'p2p-transfer-request').length === 1);
  const transferId = messagesOfType(signaling, 'p2p-transfer-request')[0].fileMeta.transferId;
  await engine.handleSignal({ type: 'p2p-transfer-accept', from: 'receiver', transferId });
  await waitFor(() => FakePeerConnection.instances.length === 1);
  return transferId;
}

async function loadTransferEngine() {
  const sourceUrl = new URL('../src/transfer/TransferEngine.ts', import.meta.url);
  const statsUrl = new URL('../src/transfer/RtcStatsSampler.ts', import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const statsSource = await readFile(statsUrl, 'utf8');
  const policySource = await readFile(new URL('../src/transfer/TransferPolicy.ts', import.meta.url), 'utf8');
  const policyOutput = ts.transpileModule(policySource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText;
  const policyDataUrl = `data:text/javascript;base64,${Buffer.from(policyOutput).toString('base64')}`;
  const statsOutput = ts.transpileModule(statsSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext
    },
    fileName: 'RtcStatsSampler.ts'
  }).outputText;
  const statsDataUrl = `data:text/javascript;base64,${Buffer.from(statsOutput).toString('base64')}`;
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext
    },
    fileName: 'TransferEngine.ts'
  }).outputText.replace(
    "from './RtcStatsSampler'",
    `from '${statsDataUrl}'`
  ).replace("from './TransferPolicy'", `from '${policyDataUrl}'`);
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

function createTrackedFile(name, size) {
  let activeReads = 0;
  let maxReads = 0;
  const bytes = new Uint8Array(size);
  const readSizes = [];
  return {
    readSizes,
    get maxReads() {
      return maxReads;
    },
    file: {
      name,
      size,
      type: 'application/octet-stream',
      lastModified: 1,
      slice(start, end) {
        readSizes.push(end - start);
        return {
          async arrayBuffer() {
            activeReads += 1;
            maxReads = Math.max(maxReads, activeReads);
            await new Promise(resolve => setTimeout(resolve, 0));
            activeReads -= 1;
            return bytes.slice(start, end).buffer;
          }
        };
      }
    }
  };
}

function createDeferredFile(name, size) {
  const bytes = new Uint8Array(size);
  const releases = [];
  return {
    get pendingReads() {
      return releases.length;
    },
    releaseAll() {
      for (const release of releases.splice(0)) release();
    },
    file: {
      name,
      size,
      type: 'application/octet-stream',
      lastModified: 1,
      slice(start, end) {
        return {
          arrayBuffer() {
            return new Promise(resolve => {
              releases.push(() => resolve(bytes.slice(start, end).buffer));
            });
          }
        };
      }
    }
  };
}

function createMeta(transferId, size) {
  return {
    transferId,
    name: `${transferId}.bin`,
    size,
    type: 'application/octet-stream',
    lastModified: 1
  };
}

function createSink() {
  return {
    bytesWritten: 0,
    prepared: 0,
    aborted: 0,
    closed: 0,
    async prepare() {
      this.prepared += 1;
    },
    async write(chunk) {
      this.bytesWritten += chunk.byteLength;
    },
    async close() {
      this.closed += 1;
      return {};
    },
    async abort() {
      this.aborted += 1;
    }
  };
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
    this.listeners = new Map();
    this.autoSaved = true;
    this.autoAck = true;
    this.pendingSavedTransferId = '';
    this.sendQueueCapacity = FakePeerConnection.sendQueueCapacity;
    this.sendQueueDrainDelayMs = FakePeerConnection.sendQueueDrainDelayMs;
    this.queueFullErrors = 0;
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
      if (control.type === 'meta') this.transferId = control.meta.transferId;
      if (control.type === 'done') {
        this.pendingSavedTransferId = control.transferId;
        if (this.autoSaved) queueMicrotask(() => this.releaseSaved());
      }
      return;
    }

    if (this.bufferedAmount + payload.byteLength > this.sendQueueCapacity) {
      this.queueFullErrors += 1;
      throw new Error(
        "Failed to execute 'send' on 'RTCDataChannel': RTCDataChannel send queue is full"
      );
    }

    if (Number.isFinite(this.sendQueueCapacity)) {
      this.bufferedAmount += payload.byteLength;
      setTimeout(() => {
        this.bufferedAmount = Math.max(0, this.bufferedAmount - payload.byteLength);
        if (this.bufferedAmount <= this.bufferedAmountLowThreshold) {
          this.emit('bufferedamountlow');
        }
      }, this.sendQueueDrainDelayMs);
    }
    this.bytesReceived += payload.byteLength;
    this.sentBinarySizes.push(payload.byteLength);
    queueMicrotask(() => {
      if (!this.autoAck) return;
      this.onmessage?.({
        data: JSON.stringify({
          type: 'progress-ack',
          transferId: this.transferId,
          bytesReceived: this.bytesReceived
        })
      });
    });
  }

  releaseSaved() {
    const transferId = this.pendingSavedTransferId;
    if (!transferId) return;
    this.pendingSavedTransferId = '';
    this.onmessage?.({
      data: JSON.stringify({
        type: 'saved',
        transferId
      })
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

test('slow receiver caps outstanding file bytes at 8 MiB and cancellation wakes credit wait', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const transfer = engine.sendFile('receiver', createFile('credit.bin', 20 * 1024 * 1024));
  const rejected = assert.rejects(transfer, { name: 'TransferCancelledError' });
  await acceptLatestRequest(engine, signaling);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.autoAck = false;
  channel.open();
  await waitFor(() => channel.bytesReceived === 8 * 1024 * 1024);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(channel.bytesReceived, 8 * 1024 * 1024);
  const id = messagesOfType(signaling, 'p2p-transfer-request')[0].fileMeta.transferId;
  channel.onmessage({ data: JSON.stringify({ type: 'progress-ack', transferId: id, bytesReceived: 1024 * 1024 }) });
  await waitFor(() => channel.bytesReceived === 9 * 1024 * 1024);
  engine.cancelTransfer(id);
  await rejected;
  assert.equal(channel.readyState, 'closed');
  assert.equal(engine.sessions.size, 0);
});

test('tiny negotiated messages never exceed the SCTP limit', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  FakePeerConnection.maxMessageSize = 4096;
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const transfer = engine.sendFile('receiver', createFile('tiny-chunks.bin', 64 * 1024));
  await acceptLatestRequest(engine, signaling);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.open();
  await transfer;
  assert.ok(channel.sentBinarySizes.every(size => size <= 4096));
});

test('receiver errors stop the sender immediately, without waiting for a saved timeout', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const transfer = engine.sendFile('receiver', createFile('writer-failed.bin', 20 * 1024 * 1024));
  const rejected = assert.rejects(transfer, /Disk full/);
  await acceptLatestRequest(engine, signaling);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.autoAck = false;
  channel.open();
  await waitFor(() => channel.bytesReceived === 8 * 1024 * 1024);
  channel.onmessage({ data: JSON.stringify({ type: 'receive-error', transferId: channel.transferId, message: 'Disk full' }) });
  await rejected;
  assert.equal(engine.sessions.size, 0);
  assert.equal(channel.readyState, 'closed');
});

test('late WebSocket cancellation reconciles a preceding data-channel close', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender');
  const progress = [];
  engine.onProgress(item => progress.push(item));
  const transfer = engine.sendFile('receiver', createFile('cancel-race.bin', 20 * 1024 * 1024));
  const rejected = assert.rejects(transfer, /closed/);
  await acceptLatestRequest(engine, signaling);
  const channel = FakePeerConnection.instances[0].dataChannel;
  channel.autoAck = false;
  channel.open();
  await waitFor(() => channel.bytesReceived === 8 * 1024 * 1024);
  channel.close();
  await rejected;
  assert.equal(progress.at(-1).cancelled, undefined);
  assert.equal(progress.at(-1).failed, true);
  await engine.handleSignal({ type: 'transfer-cancel', from: 'receiver', transferId: channel.transferId });
  assert.equal(progress.at(-1).cancelled, true);
  assert.equal(progress.at(-1).failed, false);
  assert.equal(progress.at(-1).done, true);
});

test('receive counters retain bytes beyond 4 GiB without integer truncation', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'receiver');
  const size = 5 * 1024 * 1024 * 1024;
  const meta = createMeta('wide-counter', size);
  const sink = createSink();
  sink.bytesWritten = 4 * 1024 * 1024 * 1024;
  const session = engine.createSession(meta.transferId, 'sender', 'receive', meta, sink);
  session.receiveState = { meta, bytes: sink.bytesWritten, lastAckAt: 0, lastAckBytes: 0 };
  const channel = new FakeDataChannel();
  channel.readyState = 'open';
  await engine.handleReceiverMessage(session, channel, new ArrayBuffer(64 * 1024));
  assert.equal(session.receiveState.bytes, 4294967296 + 65536);
  assert.equal(sink.bytesWritten, 4294967296 + 65536);
  engine.cancelTransfer(meta.transferId);
});

test('receiver keeps accepting bytes while speed sampling is throttled', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const engine = new TransferEngine(createSignaling(), () => 'receiver');
  const meta = createMeta('stats-overhead', 4 * 1024 * 1024);
  const sink = createSink();
  const session = engine.createSession(meta.transferId, 'sender', 'receive', meta, sink);
  const channel = new FakeDataChannel();
  channel.readyState = 'open';
  session.receiveState = { meta, bytes: 0, lastAckAt: 0, lastAckBytes: 0 };
  let samples = 0;
  const record = session.stats.record.bind(session.stats);
  session.stats.record = (...args) => { samples++; return record(...args); };
  engine.lastProgressAt.set(meta.transferId, Number.POSITIVE_INFINITY);
  for (let index = 0; index < 16; index++) {
    await engine.handleReceiverMessage(session, channel, new ArrayBuffer(64 * 1024));
  }
  assert.equal(sink.bytesWritten, 1024 * 1024);
  assert.equal(samples, 0);
  engine.emitSessionProgress(session, true);
  assert.equal(samples, 1);
  engine.close();
});

for (const enabled of [false, true]) {
  test(`performance diagnostics are ${enabled ? 'opt-in and count read blocks' : 'disabled by default'}`, async () => {
    installBrowserGlobals();
    FakePeerConnection.reset();
    const signaling = createSignaling();
    const engine = new TransferEngine(signaling, () => 'sender', () => [], enabled);
    const reports = [];
    engine.onDebug((message, details) => { if (message === 'p2p performance') reports.push(details); });
    const transfer = engine.sendFile('receiver', createFile('profile.bin', 2 * 1024 * 1024));
    await acceptLatestRequest(engine, signaling);
    FakePeerConnection.instances[0].dataChannel.open();
    await transfer;
    assert.equal(reports.length, enabled ? 1 : 0);
    if (enabled) {
      assert.equal(reports[0].readOperations, 2);
      assert.equal(reports[0].dataMessages, 32);
      assert.equal(reports[0].bytesDelivered, 2 * 1024 * 1024);
      assert.equal(reports[0].uploadLimitBytesPerSecond, null);
      assert.ok(reports[0].readWaitMs >= 0);
      assert.ok(reports[0].creditWaitMs >= 0);
    }
  });
}

test('an unresolved stats report cannot delay transfer completion', async () => {
  installBrowserGlobals();
  FakePeerConnection.reset();
  const signaling = createSignaling();
  const engine = new TransferEngine(signaling, () => 'sender', () => [], true);
  const reports = [];
  engine.onDebug((message, details) => { if (message === 'p2p performance') reports.push(details); });
  const transfer = engine.sendFile('receiver', createFile('slow-stats.bin', 64 * 1024));
  await acceptLatestRequest(engine, signaling);
  const peer = FakePeerConnection.instances[0];
  let rejectStats;
  peer.getStats = () => new Promise((_, reject) => { rejectStats = reject; });
  peer.dataChannel.open();
  await transfer;
  assert.equal(reports.length, 0);
  rejectStats(new Error('Stats unavailable'));
  await waitFor(() => reports.length === 1);
  assert.equal(reports[0].statsError, 'Stats unavailable');
});

class FakePeerConnection {
  static instances = [];
  static maxMessageSize = 256 * 1024;
  static sendQueueCapacity = Number.POSITIVE_INFINITY;
  static sendQueueDrainDelayMs = 0;

  static reset() {
    this.instances = [];
    this.maxMessageSize = 256 * 1024;
    this.sendQueueCapacity = Number.POSITIVE_INFINITY;
    this.sendQueueDrainDelayMs = 0;
  }

  constructor(configuration) {
    this.configuration = configuration;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.remoteDescription = null;
    this.dataChannel = new FakeDataChannel();
    this.addedCandidates = [];
    this.sctp = { maxMessageSize: FakePeerConnection.maxMessageSize };
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
