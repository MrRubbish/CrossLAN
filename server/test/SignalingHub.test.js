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
    connectionId: `${overrides.id}-connection`,
    id: overrides.id,
    ip: overrides.ip,
    socket,
    userAgent: 'CrossLAN test browser',
    canDirectSave: Boolean(overrides.canDirectSave),
    hostUi: Boolean(overrides.hostUi),
    lastSeen: Date.now(),
    connectedAt: Date.now()
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
