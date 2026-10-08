import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { SignalingHub } from '../src/signaling/SignalingHub.js';

const SERVICE_HOST_DEVICE_ID = 'crosslan-service-host';

test('node direct-save waits for the receiver browser to accept', async () => {
  const hub = createHub('node');
  const sender = addClient(hub, { id: 'sender', ip: '192.168.1.20' });
  const receiver = addClient(hub, { id: 'host-browser', ip: '192.168.1.10', canDirectSave: true });
  const transferId = 'node-direct-1';

  await sendSignal(hub, sender, {
    type: 'direct-transfer-request',
    to: receiver.id,
    fileMeta: createFileMeta(transferId)
  });

  assert.equal(messagesOfType(sender, 'direct-transfer-accept').length, 0);
  assert.equal(messagesOfType(receiver, 'direct-transfer-request').length, 1);

  await sendSignal(hub, receiver, {
    type: 'direct-transfer-accept',
    to: sender.id,
    transferId
  });

  assert.equal(messagesOfType(sender, 'direct-transfer-accept').length, 1);
  hub.close();
});

test('docker direct-save prompts the open host UI before accepting', async () => {
  const hub = createHub('docker');
  const sender = addClient(hub, { id: 'sender', ip: '192.168.1.20' });
  const hostUi = addClient(hub, {
    id: 'host-ui',
    ip: '192.168.1.10',
    canDirectSave: true,
    hostUi: true
  });
  const transferId = 'docker-direct-1';

  await sendSignal(hub, sender, {
    type: 'direct-transfer-request',
    to: SERVICE_HOST_DEVICE_ID,
    fileMeta: createFileMeta(transferId)
  });

  assert.equal(messagesOfType(sender, 'direct-transfer-accept').length, 0);
  assert.equal(messagesOfType(hostUi, 'direct-transfer-request').length, 1);

  await sendSignal(hub, hostUi, {
    type: 'direct-transfer-accept',
    to: sender.id,
    transferId
  });

  assert.equal(messagesOfType(sender, 'direct-transfer-accept').length, 1);
  hub.close();
});

test('docker direct-save auto-accepts only when no host UI is open', async () => {
  const hub = createHub('docker');
  const sender = addClient(hub, { id: 'sender', ip: '192.168.1.20' });
  const transferId = 'docker-direct-headless-1';

  await sendSignal(hub, sender, {
    type: 'direct-transfer-request',
    to: SERVICE_HOST_DEVICE_ID,
    fileMeta: createFileMeta(transferId)
  });

  const accepts = messagesOfType(sender, 'direct-transfer-accept');
  assert.equal(accepts.length, 1);
  assert.equal(accepts[0].from, SERVICE_HOST_DEVICE_ID);
  hub.close();
});

test('batch approval messages route between the selected devices', async () => {
  const hub = createHub('node');
  const sender = addClient(hub, { id: 'sender', ip: '192.168.1.20' });
  const receiver = addClient(hub, { id: 'receiver', ip: '192.168.1.21' });
  const batchId = 'batch-1';

  await sendSignal(hub, sender, {
    type: 'batch-transfer-request',
    to: receiver.id,
    batchId,
    batchTotal: 2,
    fileCount: 3,
    totalBytes: 128 * 1024 * 1024
  });

  assert.equal(messagesOfType(sender, 'batch-transfer-request').length, 0);
  assert.equal(messagesOfType(receiver, 'batch-transfer-request').length, 1);

  await sendSignal(hub, receiver, {
    type: 'batch-transfer-accept',
    to: sender.id,
    batchId
  });

  assert.equal(messagesOfType(sender, 'batch-transfer-accept').length, 1);
  hub.close();
});

for (const mode of ['direct', 'relay']) {
  test(`${mode} completion follows a reconnected receiver`, async t => {
    const hub = createHub('node');
    t.after(() => hub.close());
    const sender = addClient(hub, { id: 'sender' });
    const receiver = addClient(hub, { id: 'receiver' });
    const transferId = mode + '-reconnect';
    await sendSignal(hub, sender, { type: mode + '-transfer-request', to: receiver.id, fileMeta: createFileMeta(transferId) });
    await sendSignal(hub, receiver, { type: mode + '-transfer-accept', to: sender.id, transferId });
    receiver.socket.close();
    const replacement = addClient(hub, { id: 'receiver', connectionId: 'receiver-new' });
    hub.broadcastToTransfer(transferId, { type: mode + '-transfer-complete', transferId });
    assert.equal(messagesOfType(replacement, mode + '-transfer-complete').length, 1);
    assert.equal(hub.transferRoutes.get(transferId).receiverConnectionId, replacement.connectionId);
  });

  test(`${mode} completion missed while offline is replayed only to its endpoint`, async t => {
    const hub = createHub('node');
    t.after(() => hub.close());
    const sender = addClient(hub, { id: 'sender' });
    const receiver = addClient(hub, { id: 'receiver' });
    const transferId = mode + '-offline';
    await sendSignal(hub, sender, { type: mode + '-transfer-request', to: receiver.id, fileMeta: createFileMeta(transferId) });
    await sendSignal(hub, receiver, { type: mode + '-transfer-accept', to: sender.id, transferId });
    sender.socket.close();
    receiver.socket.close();
    assert.equal(hub.broadcastToTransfer(transferId, { type: mode + '-transfer-complete', transferId }), true);
    const replacement = addClient(hub, { id: 'sender', connectionId: 'sender-new' });
    const stranger = addClient(hub, { id: 'stranger' });
    await sendSignal(hub, replacement, { type: 'transfer-state-request', transferIds: [transferId] });
    await sendSignal(hub, stranger, { type: 'transfer-state-request', transferIds: [transferId] });
    assert.equal(messagesOfType(replacement, mode + '-transfer-complete').length, 1);
    assert.equal(stranger.socket.messages.length, 0);
  });
}

test('a second live tab cannot take over an existing transfer', async t => {
  const hub = createHub('node');
  t.after(() => hub.close());
  const sender = addClient(hub, { id: 'sender' });
  const receiver = addClient(hub, { id: 'receiver' });
  await sendSignal(hub, sender, { type: 'relay-transfer-request', to: receiver.id, fileMeta: createFileMeta('live-tab') });
  await sendSignal(hub, receiver, { type: 'relay-transfer-accept', to: sender.id, transferId: 'live-tab' });
  const otherTab = addClient(hub, { id: 'receiver', connectionId: 'second-tab' });
  hub.broadcastToTransfer('live-tab', { type: 'relay-transfer-progress', transferId: 'live-tab' });
  await sendSignal(hub, otherTab, { type: 'transfer-state-request', transferIds: ['live-tab'] });
  assert.equal(otherTab.socket.messages.length, 0);
  assert.equal(messagesOfType(receiver, 'relay-transfer-progress').length, 1);
});

test('device list collapses the same browser reached through a new service address', t => {
  const hub = createHub('node');
  t.after(() => hub.close());
  const viewer = addClient(hub, { id: 'viewer', ip: '192.168.1.10' });
  const oldOrigin = addClient(hub, {
    id: 'phone-old-origin',
    connectionId: 'phone-old',
    ip: '192.168.1.20',
    connectedAt: 100,
    lastSeen: 100
  });
  const newOrigin = addClient(hub, {
    id: 'phone-new-origin',
    connectionId: 'phone-new',
    ip: '192.168.1.20',
    connectedAt: 200,
    lastSeen: 200
  });

  assert.deepEqual(hub.getDevicesFor(viewer).map(device => device.id), ['phone-new-origin']);
  assert.equal(hub.getDevicesFor(newOrigin).some(device => device.id === oldOrigin.id), false);
});

test('device list collapses service-host browser tabs across wired and wireless addresses', t => {
  const previousAdvertisedIp = process.env.CROSSLAN_ADVERTISED_IP;
  process.env.CROSSLAN_ADVERTISED_IP = '192.168.1.10';
  t.after(() => {
    if (previousAdvertisedIp === undefined) delete process.env.CROSSLAN_ADVERTISED_IP;
    else process.env.CROSSLAN_ADVERTISED_IP = previousAdvertisedIp;
  });
  const hub = createHub('node');
  t.after(() => hub.close());
  const viewer = addClient(hub, { id: 'phone', ip: '192.168.1.20', userAgent: 'Phone browser' });
  addClient(hub, {
    id: 'host-wireless-origin',
    ip: '192.168.1.11',
    requestHost: '192.168.1.11',
    serviceHost: true,
    lastSeen: 300
  });
  addClient(hub, {
    id: 'host-wired-origin',
    ip: '192.168.1.10',
    requestHost: '192.168.1.10',
    serviceHost: true,
    lastSeen: 200
  });

  const devices = hub.getDevicesFor(viewer);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].id, 'host-wired-origin');
  assert.equal(devices[0].ip, '192.168.1.10');
});

test('a new transfer request targets only the most recent tab for a device id', async t => {
  const hub = createHub('node');
  t.after(() => hub.close());
  const sender = addClient(hub, { id: 'sender' });
  const oldTab = addClient(hub, { id: 'receiver', connectionId: 'old-tab', lastSeen: 100 });
  const newTab = addClient(hub, { id: 'receiver', connectionId: 'new-tab', lastSeen: 200 });

  await sendSignal(hub, sender, {
    type: 'relay-transfer-request',
    to: 'receiver',
    fileMeta: createFileMeta('single-tab-request')
  });

  assert.equal(messagesOfType(oldTab, 'relay-transfer-request').length, 0);
  assert.equal(messagesOfType(newTab, 'relay-transfer-request').length, 1);
});

test('active progress refreshes route expiry and cannot replace terminal state', async t => {
  const hub = createHub('node');
  t.after(() => hub.close());
  const sender = addClient(hub, { id: 'sender' });
  const receiver = addClient(hub, { id: 'receiver' });
  await sendSignal(hub, sender, { type: 'relay-transfer-request', to: receiver.id, fileMeta: createFileMeta('long-running') });
  const route = hub.transferRoutes.get('long-running');
  route.updatedAt = Date.now() - 60 * 60 * 1000;
  hub.broadcastToTransfer('long-running', { type: 'relay-transfer-progress' });
  hub.pruneTransferRoutes();
  assert.equal(hub.transferRoutes.has('long-running'), true);
  hub.broadcastToTransfer('long-running', { type: 'relay-transfer-error', cancelled: true });
  hub.broadcastToTransfer('long-running', { type: 'relay-transfer-progress' });
  assert.equal(route.lastStatus.type, 'relay-transfer-error');
});

test('desktop P2P preflight, negotiation and cancellation stay pinned to the selected tab', async t => {
  const hub = createHub('node');
  t.after(() => hub.close());
  const sender = addClient(hub, { id: 'sender' });
  const receiver = addClient(hub, { id: 'receiver', connectionId: 'receiver-tab' });
  const transferId = 'desktop-p2p';
  await sendSignal(hub, sender, { type: 'p2p-transfer-request', to: receiver.id, fileMeta: createFileMeta(transferId) });
  assert.equal(messagesOfType(receiver, 'p2p-transfer-request').length, 1);
  const otherTab = addClient(hub, { id: receiver.id, connectionId: 'other-tab', lastSeen: Date.now() + 1000 });
  await sendSignal(hub, otherTab, { type: 'p2p-transfer-accept', to: sender.id, transferId });
  assert.equal(messagesOfType(sender, 'p2p-transfer-accept').length, 0);
  await sendSignal(hub, receiver, { type: 'p2p-transfer-accept', to: sender.id, transferId });
  assert.equal(messagesOfType(sender, 'p2p-transfer-accept').length, 1);
  await sendSignal(hub, sender, { type: 'offer', to: receiver.id, transferId, description: { type: 'offer', sdp: 'test' } });
  await sendSignal(hub, receiver, { type: 'answer', to: sender.id, transferId, description: { type: 'answer', sdp: 'test' } });
  await sendSignal(hub, sender, { type: 'ice-candidate', to: receiver.id, transferId, candidate: { candidate: 'host' } });
  await sendSignal(hub, receiver, { type: 'p2p-transfer-cancel', to: sender.id, transferId });
  assert.equal(messagesOfType(receiver, 'offer').length, 1);
  assert.equal(messagesOfType(receiver, 'ice-candidate').length, 1);
  assert.equal(messagesOfType(sender, 'answer').length, 1);
  assert.equal(messagesOfType(sender, 'p2p-transfer-cancel').length, 1);
  assert.equal(messagesOfType(otherTab, 'offer').length, 0);
  assert.equal(messagesOfType(otherTab, 'ice-candidate').length, 0);
});

test('desktop P2P rejection reaches its sender without affecting a Relay request', async t => {
  const hub = createHub('node');
  t.after(() => hub.close());
  const sender = addClient(hub, { id: 'sender' });
  const receiver = addClient(hub, { id: 'receiver' });
  await sendSignal(hub, sender, { type: 'p2p-transfer-request', to: receiver.id, fileMeta: createFileMeta('p2p-reject') });
  await sendSignal(hub, receiver, { type: 'p2p-transfer-reject', to: sender.id, transferId: 'p2p-reject', reason: 'declined' });
  await sendSignal(hub, sender, { type: 'relay-transfer-request', to: receiver.id, fileMeta: createFileMeta('relay-unaffected') });
  await sendSignal(hub, receiver, { type: 'relay-transfer-accept', to: sender.id, transferId: 'relay-unaffected' });
  assert.equal(messagesOfType(sender, 'p2p-transfer-reject')[0].reason, 'declined');
  assert.equal(messagesOfType(receiver, 'relay-transfer-request').length, 1);
  assert.equal(messagesOfType(sender, 'relay-transfer-accept').length, 1);
});

function createHub(deploymentMode) {
  const wss = new EventEmitter();
  return new SignalingHub({
    wss,
    mdns: { getPeers: () => [] },
    networkProber: { createMockRealtimeSample: () => ({}) },
    deploymentMode,
    serverInstanceId: 'test-server'
  });
}

function addClient(hub, overrides) {
  const socket = {
    OPEN: 1,
    readyState: 1,
    messages: [],
    send(payload) {
      this.messages.push(JSON.parse(payload));
    },
    close() {
      this.readyState = 3;
    }
  };
  const client = {
    connectionId: overrides.connectionId || `${overrides.id}-connection`,
    id: overrides.id,
    ip: overrides.ip,
    requestHost: overrides.requestHost || overrides.ip,
    socket,
    userAgent: overrides.userAgent || 'CrossLAN test browser',
    canDirectSave: Boolean(overrides.canDirectSave),
    serviceHost: Boolean(overrides.serviceHost),
    hostUi: Boolean(overrides.hostUi),
    lastSeen: overrides.lastSeen ?? Date.now(),
    connectedAt: overrides.connectedAt ?? Date.now()
  };
  hub.clients.set(client.connectionId, client);
  return client;
}

function createFileMeta(transferId) {
  return {
    transferId,
    name: 'large.bin',
    size: 64 * 1024 * 1024,
    type: 'application/octet-stream'
  };
}

function sendSignal(hub, sender, message) {
  return hub.handleMessage(sender, Buffer.from(JSON.stringify(message)));
}

function messagesOfType(client, type) {
  return client.socket.messages.filter(message => message.type === type);
}
