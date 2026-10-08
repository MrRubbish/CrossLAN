import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';

const source = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8');
const script = parse(source).descriptor.scriptSetup.content;
const ast = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const policySource = await readFile(new URL('../src/transfer/TransferPolicy.ts', import.meta.url), 'utf8');
const policyOutput = ts.transpileModule(policySource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const { P2P_MAX_FILE_SIZE, resolveAutomaticTransferRoute } = await import(
  `data:text/javascript;base64,${Buffer.from(policyOutput).toString('base64')}`
);

test('switching language translates stored UI messages without changing raw errors or paths', () => {
  const globals = loadFunctions(['displayStoredMessage'], {
    messages: { zh: { current: '当前', saved: '已保存' }, en: { current: 'Current', saved: 'Saved' } },
    messageKeysByText: new Map([['传输已取消。', 'cancelled'], ['Transfer cancelled.', 'cancelled']]),
    t: { value: { current: 'Current', saved: 'Saved', cancelled: 'Transfer cancelled.' } }
  });
  assert.equal(globals.displayStoredMessage('传输已取消。'), 'Transfer cancelled.');
  assert.equal(globals.displayStoredMessage('当前: C:\\Downloads\\CrossLAN'), 'Current: C:\\Downloads\\CrossLAN');
  assert.equal(globals.displayStoredMessage('已保存: /data/CrossLAN'), 'Saved: /data/CrossLAN');
  assert.equal(globals.displayStoredMessage('ECONNRESET from receiver'), 'ECONNRESET from receiver');
  globals.t.value.cancelled = '传输已取消。';
  assert.equal(globals.displayStoredMessage('Transfer cancelled.'), '传输已取消。');
});

// Exercise the production handlers with controlled clocks and network effects.
test('the task success indicator uses terminal flags and bytes, not the translated status text', () => {
  const { isTransferSuccessful } = loadFunctions(['isTransferSuccessful'], {});
  const complete = { done: true, bytesTransferred: 100, totalBytes: 100, statusText: 'Receive complete' };
  assert.equal(isTransferSuccessful(complete), true);
  assert.equal(isTransferSuccessful({ ...complete, statusText: '接收完成' }), true);
  assert.equal(isTransferSuccessful({ ...complete, done: false }), false);
  assert.equal(isTransferSuccessful({ ...complete, cancelled: true }), false);
  assert.equal(isTransferSuccessful({ ...complete, failed: true }), false);
  assert.equal(isTransferSuccessful({ ...complete, bytesTransferred: 99 }), false);
  assert.equal(isTransferSuccessful({ ...complete, bytesTransferred: 0, totalBytes: 0 }), true);
});

function loadFunctions(names, globals) {
  const nodes = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name.text));
  assert.equal(nodes.length, names.length);
  const output = ts.transpileModule(nodes.map(node => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText;
  vm.runInNewContext(output, globals);
  return globals;
}

test('service relocation accepts only clean HTTP(S) origins', () => {
  const globals = loadFunctions(['normalizeServiceRelocationUrl'], { URL });
  const target = globals.normalizeServiceRelocationUrl('http://192.168.31.9:6100/path?stale=1#old');
  assert.equal(target.toString(), 'http://192.168.31.9:6100/');
  assert.equal(globals.normalizeServiceRelocationUrl('file:///tmp/crosslan'), null);
  assert.equal(globals.normalizeServiceRelocationUrl('http://user:pass@192.168.31.9:6100/'), null);
});

for (const cancelled of [false, true]) {
  test(`late progress preserves the ${cancelled ? 'cancelled' : 'completed'} task`, () => {
    const current = { id: 'terminal', done: true, cancelled, mode: 'p2p', peerId: 'peer', bytesTransferred: 80, totalBytes: 100 };
    const globals = loadFunctions(['withSpeedSample'], {
      performance, speedSamples: new Map(), progress: { value: new Map([[current.id, current]]) }
    });
    assert.equal(globals.withSpeedSample({ id: current.id, done: false, bytesTransferred: 30 }), current);
  });
}

for (const bytesTransferred of [80, 100]) {
  test(`a late peer cancellation reconciles a failed P2P task at ${bytesTransferred}%`, () => {
    const current = {
      id: 'cancel-race', direction: 'send', fileName: 'file.bin', peerId: 'peer',
      mode: 'p2p', done: true, failed: true, bytesTransferred, totalBytes: 100,
      statusText: 'Transfer channel failed.'
    };
    const globals = loadFunctions([
      'handleP2PProgress', 'withSpeedSample', 'handleRemoteCancel', 'markCancelled', 'setProgress'
    ], {
      performance, progress: { value: new Map([[current.id, current]]) },
      cancelledTransfers: new Set(), autoDownloadedTransfers: new Set(),
      speedSamples: new Map(), activeUploads: new Map(), pendingDirectAccepts: new Map(), pendingRelayAccepts: new Map(),
      addLog() {}, logProgress() {}, clearIncomingBatchApprovalForTransfer() {},
      cleanupServerTransfer() {}, rejectPending() {}, rejectRelayCompletion() {}, clearTransferBookkeeping() {},
      disableWakeLock() {}, maybeAutoDownload: item => item,
      t: { value: { remoteCancelled: 'Cancelled by peer.' } }
    });
    globals.handleP2PProgress({ ...current, cancelled: true, failed: false, statusText: 'Cancelled by peer.' });
    globals.handleRemoteCancel(current.id, 'peer');
    const reconciled = globals.progress.value.get(current.id);
    assert.equal(reconciled.cancelled, true);
    assert.equal(reconciled.failed, false);
    assert.equal(reconciled.done, true);
    assert.equal(reconciled.bytesTransferred, bytesTransferred);
    assert.equal(reconciled.downloadUrl, undefined);
    assert.equal(globals.cancelledTransfers.has(current.id), true);
    globals.handleP2PProgress({ ...current, done: false, failed: false, bytesTransferred: 100 });
    assert.equal(globals.progress.value.get(current.id), reconciled);
  });
}

test('remote cancellation can correct a failed task without an engine callback', () => {
  const current = { id: 'failed', mode: 'p2p', done: true, failed: true, bytesTransferred: 80, totalBytes: 100 };
  const globals = loadFunctions(['handleRemoteCancel', 'markCancelled', 'setProgress'], {
    progress: { value: new Map([[current.id, current]]) }, cancelledTransfers: new Set(),
    autoDownloadedTransfers: new Set(), activeUploads: new Map(), pendingDirectAccepts: new Map(), pendingRelayAccepts: new Map(),
    addLog() {}, clearIncomingBatchApprovalForTransfer() {}, cleanupServerTransfer() {},
    rejectPending() {}, rejectRelayCompletion() {}, clearTransferBookkeeping() {}, disableWakeLock() {},
    t: { value: { remoteCancelled: 'Cancelled by peer.' } }
  });
  globals.handleRemoteCancel(current.id, 'peer');
  assert.equal(globals.progress.value.get(current.id).cancelled, true);
  assert.equal(globals.progress.value.get(current.id).failed, false);
});

test('a successfully saved P2P task is not changed by late cancellation', () => {
  const current = { id: 'saved', mode: 'p2p', done: true, bytesTransferred: 100, totalBytes: 100 };
  const globals = loadFunctions(['handleP2PProgress', 'handleRemoteCancel', 'markCancelled'], {
    progress: { value: new Map([[current.id, current]]) }, cancelledTransfers: new Set(),
    addLog() {}, logProgress: () => assert.fail('Unexpected task update')
  });
  globals.handleP2PProgress({ ...current, cancelled: true });
  globals.handleRemoteCancel(current.id, 'peer');
  globals.markCancelled(current.id, 'cancelled');
  assert.equal(globals.progress.value.get(current.id), current);
  assert.equal(globals.cancelledTransfers.size, 0);
});

test('lowering a running upload limit does not charge previously uploaded bytes', async () => {
  const MiB = 1024 * 1024;
  let now = 0;
  let count = 0;
  const waits = [];
  const globals = loadFunctions(['uploadFileChunkedWithThrottle'], {
    performance: { now: () => now }, cancelledTransfers: new Set(),
    addLog() {}, manualLimitMbps: { value: 100 },
    getManualLimitBytesPerSecond: () => count < 100 ? 100 * MiB : MiB,
    getThrottleChunkSize: () => MiB,
    uploadChunk: async () => { count += 1; now += 10; return { ok: true }; },
    sleepForThrottle: async ms => { waits.push(ms); now += ms; },
    t: { value: { uploadHttpFailed: 'failed' } }
  });
  await globals.uploadFileChunkedWithThrottle('/chunk', { name: 'file.bin', size: 103 * MiB, slice() {} }, 'limit', () => {});
  assert.ok(waits.length > 0);
  assert.ok(Math.max(...waits) <= 1000);
  assert.equal(count, 103);
});

test('a cancelled chunked upload does not send the next request', async () => {
  let requests = 0;
  const globals = loadFunctions(['uploadFileChunkedWithThrottle'], {
    performance, cancelledTransfers: new Set(['cancelled']), addLog() {}, manualLimitMbps: { value: 100 },
    getManualLimitBytesPerSecond: () => 1, uploadChunk: async () => { requests += 1; },
    t: { value: { cancelled: 'cancelled' } }
  });
  await assert.rejects(globals.uploadFileChunkedWithThrottle('/chunk', { name: 'file', size: 10 }, 'cancelled', () => {}), /cancelled/);
  assert.equal(requests, 0);
});

for (const action of ['resume', 'cancel']) {
  test(`a throttle wait supports ${action} without retaining handles`, async () => {
    const timers = new Map();
    const globals = loadFunctions(['sleepForThrottle'], {
      window: { setTimeout: fn => { timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id) },
      cancelledTransfers: new Set(), activeUploads: new Map(), activeThrottleWaits: new Map(),
      t: { value: { cancelled: 'cancelled' } }
    });
    const pending = globals.sleepForThrottle(100000, 'transfer');
    if (action === 'resume') {
      globals.activeThrottleWaits.get('transfer')();
      await pending;
    } else {
      globals.activeUploads.get('transfer').abort();
      await assert.rejects(pending, /cancelled/);
    }
    assert.equal(timers.size, 0);
    assert.equal(globals.activeUploads.size, 0);
    assert.equal(globals.activeThrottleWaits.size, 0);
  });
}

for (const name of ['handleDirectTransferRequest', 'handleRelayTransferRequest']) {
  test(`${name} ignores a request already cancelled before the prompt`, async () => {
    const globals = loadFunctions([name], {
      cancelledTransfers: new Set(['cancelled']), progress: { value: new Map() }
    });
    await globals[name]('sender', { transferId: 'cancelled' });
    assert.equal(globals.progress.value.size, 0);
  });

  test(`${name} cannot reopen a task cancelled during confirmation`, async () => {
    let accept;
    const globals = loadFunctions([name], {
      cancelledTransfers: new Set(), progress: { value: new Map() }, addLog() {},
      rejectDuplicateIncoming: () => false,
      confirmIncomingTransfer: () => new Promise(resolve => { accept = resolve; }),
      t: { value: { receiveLargePrompt: 'receive' } }
    });
    const pending = globals[name]('sender', { transferId: 'cancelled', name: 'file', size: 10 });
    globals.cancelledTransfers.add('cancelled');
    accept(true);
    await pending;
    assert.equal(globals.progress.value.size, 0);
  });
}

test('recovering relay cancellation settles sender acceptance and completion waiters', async () => {
  const rejected = [];
  let aborted = false;
  const item = { id: 'restore-cancel', mode: 'relay', done: false, fileName: 'file.bin' };
  const error = new Error('cancelled');
  error.name = 'RelayCancelledError';
  const globals = loadFunctions(['reconcileActiveRelayTransfers'], {
    Error, AbortController, window: { setTimeout, clearTimeout },
    progress: { value: new Map([[item.id, item]]) }, relayStateCache: new Map(),
    fetchRelayState: async () => { throw error; },
    rejectPending: (_map, id) => rejected.push('accept:' + id), pendingRelayAccepts: new Map(),
    rejectRelayCompletion: id => rejected.push('complete:' + id),
    cancelledTransfers: new Set(), autoDownloadedTransfers: new Set(),
    activeUploads: new Map([[item.id, { abort: () => { aborted = true; } }]]),
    markCancelled() {}, t: { value: { remoteCancelled: 'cancelled' } }
  });
  await globals.reconcileActiveRelayTransfers();
  assert.deepEqual(rejected, ['accept:restore-cancel', 'complete:restore-cancel']);
  assert.equal(aborted, true);
  assert.equal(globals.activeUploads.size, 0);
});

test('WebRTC ACK statistics are not replaced by the HTTP speed sampler', () => {
  const item = {
    id: 'rtc', mode: 'p2p', direction: 'send', totalBytes: 100, bytesTransferred: 80,
    bytesUploaded: 100, bytesDelivered: 80, done: false,
    speedBytesPerSecond: 20, averageBytesPerSecond: 15, peakBytesPerSecond: 30
  };
  const globals = loadFunctions(['withSpeedSample'], {
    performance, speedSamples: new Map(), progress: { value: new Map() }
  });
  for (const done of [false, true]) {
    const result = globals.withSpeedSample({ ...item, done });
    assert.equal(result.bytesTransferred, 80);
    assert.equal(result.bytesDelivered, 80);
    assert.equal(result.speedBytesPerSecond, 20);
    assert.equal(result.averageBytesPerSecond, 15);
    assert.equal(result.peakBytesPerSecond, 30);
    assert.equal(globals.speedSamples.size, 0);
  }
});

test('the desktop UI uses the common 64 MiB policy for Relay and direct save', () => {
  let directSave = false;
  const globals = loadFunctions(['shouldDirectSave', 'shouldRelayToBrowserDownload'], {
    resolveAutomaticTransferRoute, canDirectSaveTo: () => directSave
  });
  for (directSave of [false, true]) {
    assert.equal(globals.shouldDirectSave({}, { size: P2P_MAX_FILE_SIZE }), false);
    assert.equal(globals.shouldRelayToBrowserDownload({}, { size: P2P_MAX_FILE_SIZE }), false);
    assert.equal(globals.shouldDirectSave({}, { size: P2P_MAX_FILE_SIZE + 1 }), directSave);
    assert.equal(globals.shouldRelayToBrowserDownload({}, { size: P2P_MAX_FILE_SIZE + 1 }), !directSave);
  }
});

test('P2P prepares a compatible Blob sink at 64 MiB without a save picker', async () => {
  const sinks = [];
  const globals = loadFunctions(['prepareP2PReceive'], {
    P2P_MAX_FILE_SIZE, cancelledTransfers: new Set(), progress: { value: new Map() },
    confirmIncomingTransfer: async () => true, enableWakeLock() {},
    BlobReceiveSink: class { constructor(options) { sinks.push(options); } },
    t: { value: { receivePrompt: 'receive', cancelled: 'cancelled', receiverRejected: 'rejected' } }
  });
  const result = await globals.prepareP2PReceive({ transferId: '64-mib', size: P2P_MAX_FILE_SIZE, type: '' }, 'sender');
  assert.equal(result.accepted, true);
  assert.equal(sinks.length, 1);
  assert.equal(sinks[0].size, P2P_MAX_FILE_SIZE);
  assert.equal(sinks[0].type, 'application/octet-stream');
});

test('P2P rejects files over 64 MiB before prompting or allocating a sink', async () => {
  const globals = loadFunctions(['prepareP2PReceive'], {
    P2P_MAX_FILE_SIZE, cancelledTransfers: new Set(), progress: { value: new Map() },
    confirmIncomingTransfer: () => assert.fail('Unexpected prompt'),
    BlobReceiveSink: class { constructor() { assert.fail('Unexpected sink'); } },
    t: { value: { cancelled: 'cancelled' } }
  });
  const result = await globals.prepareP2PReceive({ transferId: 'too-large', size: P2P_MAX_FILE_SIZE + 1 }, 'sender');
  assert.equal(result.accepted, false);
  assert.match(result.reason, /64 MiB/);
});

test('P2P cancellation during confirmation cannot create a receive sink', async () => {
  let accept;
  const globals = loadFunctions(['prepareP2PReceive'], {
    P2P_MAX_FILE_SIZE, cancelledTransfers: new Set(), progress: { value: new Map() },
    confirmIncomingTransfer: () => new Promise(resolve => { accept = resolve; }),
    BlobReceiveSink: class { constructor() { assert.fail('Unexpected sink'); } },
    t: { value: { cancelled: 'cancelled', receivePrompt: 'receive' } }
  });
  const pending = globals.prepareP2PReceive({ transferId: 'cancelled-prompt', size: 10 }, 'sender');
  globals.cancelledTransfers.add('cancelled-prompt');
  accept(true);
  assert.equal((await pending).accepted, false);
});

test('a mixed P2P and Relay batch retains one receiver approval', async () => {
  let prompts = 0;
  const globals = loadFunctions([
    'handleBatchTransferRequest', 'prepareP2PReceive', 'confirmIncomingTransfer',
    'createIncomingBatchKey', 'storeIncomingBatchApproval', 'refreshIncomingBatchApproval'
  ], {
    P2P_MAX_FILE_SIZE, INCOMING_BATCH_APPROVAL_TTL_MS: 1800000,
    cancelledTransfers: new Set(), incomingBatchApprovals: new Map(), progress: { value: new Map() },
    isBatchTransferMeta: meta => Boolean(meta.batchId),
    window: { confirm: () => { prompts++; return true; }, setTimeout: () => 1, clearTimeout() {} },
    signaling: { send() {} }, addLog() {}, enableWakeLock() {}, formatBytes: String,
    BlobReceiveSink: class {}, t: { value: { receivePrompt: 'receive', receiveBatchPrompt: 'batch' } }
  });
  await globals.handleBatchTransferRequest('sender', { batchId: 'mixed', batchTotal: 2, fileCount: 2, totalBytes: 120 * 1024 * 1024 });
  const first = await globals.prepareP2PReceive({ transferId: 'small', size: 48 * 1024 * 1024, batchId: 'mixed', batchIndex: 0, batchTotal: 2 }, 'sender');
  const second = await globals.confirmIncomingTransfer('sender', { transferId: 'large', size: 72 * 1024 * 1024, batchId: 'mixed', batchIndex: 1, batchTotal: 2 }, 'receive');
  assert.equal(first.accepted, true);
  assert.equal(second, true);
  assert.equal(prompts, 1);
});
