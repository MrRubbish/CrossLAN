import os from 'node:os';
import { nanoid } from 'nanoid';

const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice-candidate', 'transfer-accept', 'transfer-reject', 'direct-transfer-request', 'direct-transfer-accept', 'direct-transfer-reject', 'relay-transfer-request', 'relay-transfer-accept', 'relay-transfer-reject', 'relay-transfer-progress', 'relay-transfer-ready', 'relay-transfer-error', 'transfer-cancel']);
const REQUEST_TYPES = new Set(['transfer-accept', 'direct-transfer-request', 'relay-transfer-request', 'offer']);
const RESPONSE_TYPES = new Set(['transfer-accept', 'transfer-reject', 'direct-transfer-accept', 'direct-transfer-reject', 'relay-transfer-accept', 'relay-transfer-reject', 'answer']);
const RECEIVER_FOLLOWUP_TYPES = new Set(['relay-transfer-progress', 'relay-transfer-ready', 'relay-transfer-error']);
const ROUTE_TTL_MS = 30 * 60 * 1000;

export class SignalingHub {
  constructor({ wss, mdns, networkProber }) {
    this.wss = wss;
    this.mdns = mdns;
    this.networkProber = networkProber;
    this.clients = new Map();
    this.transferRoutes = new Map();
    this.refreshTimer = null;

    this.wss.on('connection', (socket, request) => this.handleConnection(socket, request));
    this.refreshTimer = setInterval(() => {
      this.pruneTransferRoutes();
      this.broadcastDeviceList();
    }, 5000);
  }

  handleConnection(socket, request) {
    const ip = normalizeIp(request.socket.remoteAddress);
    const clientDeviceId = getClientDeviceId(request);
    const id = clientDeviceId || ip || `unknown-${nanoid(6)}`;
    const connectionId = `${id}-${nanoid(8)}`;
    const client = {
      connectionId,
      id,
      ip,
      socket,
      userAgent: request.headers['user-agent'] || 'Unknown device',
      lastSeen: Date.now(),
      connectedAt: Date.now()
    };

    this.clients.set(connectionId, client);
    console.log('CrossLAN ws connected: id=' + id + ' conn=' + connectionId + ' ip=' + ip + ' ua=' + client.userAgent);

    this.send(socket, {
      type: 'hello',
      device: publicDevice(client),
      serverIps: getLocalIpv4Addresses()
    });
    this.broadcastDeviceList();

    socket.on('message', raw => this.handleMessage(client, raw));
    socket.on('close', () => this.removeClient(client, 'closed'));
    socket.on('error', () => this.removeClient(client, 'error'));
  }

  async handleMessage(sender, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      this.send(sender.socket, { type: 'error', message: 'Invalid JSON message.' });
      return;
    }

    sender.lastSeen = Date.now();

    if (message.type === 'device-list-request') {
      this.send(sender.socket, { type: 'device-list', devices: this.getDevicesFor(sender.id) });
      console.log('CrossLAN signal device-list request: from=' + sender.id + ' conn=' + sender.connectionId);
      return;
    }

    if (message.type === 'network-probe-subscribe') {
      this.send(sender.socket, {
        type: 'network-probe-event',
        event: this.networkProber.createMockRealtimeSample()
      });
      return;
    }

    if (!SIGNAL_TYPES.has(message.type)) {
      console.warn('CrossLAN signal unsupported: type=' + message.type + ' from=' + sender.id + ' transferId=' + getTransferId(message));
      this.send(sender.socket, { type: 'error', message: `Unsupported message type: ${message.type}` });
      return;
    }

    const transferId = getTransferId(message);
    if (transferId && REQUEST_TYPES.has(message.type)) {
      this.transferRoutes.set(transferId, {
        requesterConnectionId: sender.connectionId,
        requesterId: sender.id,
        receiverId: message.to,
        receiverConnectionId: null,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    const targets = this.resolveTargets(sender, message, transferId);
    if (!targets.length) {
      console.warn('CrossLAN signal peer unavailable: type=' + message.type + ' from=' + sender.id + ' to=' + message.to + ' transferId=' + transferId);
      this.send(sender.socket, { type: 'peer-unavailable', to: message.to });
      return;
    }

    if (transferId && RESPONSE_TYPES.has(message.type)) {
      const route = this.transferRoutes.get(transferId);
      if (route) {
        route.receiverConnectionId = sender.connectionId;
        route.receiverId = sender.id;
        route.updatedAt = Date.now();
      }
    }

    const payload = {
      ...message,
      from: sender.id,
      fromDevice: publicDevice(sender)
    };

    for (const target of targets) {
      this.send(target.socket, payload);
    }
    console.log('CrossLAN signal routed: type=' + message.type + ' from=' + sender.id + ' conn=' + sender.connectionId + ' to=' + message.to + ' targets=' + targets.map(target => target.connectionId).join(',') + ' transferId=' + transferId);
  }

  resolveTargets(sender, message, transferId) {
    const route = transferId ? this.transferRoutes.get(transferId) : null;

    if (route && message.type === 'transfer-cancel') {
      const requester = this.clients.get(route.requesterConnectionId);
      const receiver = route.receiverConnectionId ? this.clients.get(route.receiverConnectionId) : null;
      if (sender.connectionId === route.requesterConnectionId && isOpenClient(receiver)) return [receiver];
      if (sender.connectionId === route.receiverConnectionId && isOpenClient(requester)) return [requester];
      if (sender.id === route.requesterId && isOpenClient(receiver)) return [receiver];
      if (sender.id === route.receiverId && isOpenClient(requester)) return [requester];
    }

    if (route && RESPONSE_TYPES.has(message.type)) {
      const requester = this.clients.get(route.requesterConnectionId);
      if (isOpenClient(requester)) return [requester];
    }

    if (route && RECEIVER_FOLLOWUP_TYPES.has(message.type) && route.receiverConnectionId) {
      const receiver = this.clients.get(route.receiverConnectionId);
      if (isOpenClient(receiver)) return [receiver];
    }

    return this.getTargetsForDevice(message.to, sender.connectionId);
  }

  getTargetsForDevice(deviceId, excludeConnectionId = '') {
    const id = String(deviceId || '');
    return [...this.clients.values()]
      .filter(client => client.id === id && client.connectionId !== excludeConnectionId && isOpenClient(client))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  removeClient(client, reason) {
    this.clients.delete(client.connectionId);
    console.log('CrossLAN ws ' + reason + ': id=' + client.id + ' conn=' + client.connectionId);
    this.broadcastDeviceList();
  }

  broadcastDeviceList() {
    for (const client of this.clients.values()) {
      this.send(client.socket, {
        type: 'device-list',
        devices: this.getDevicesFor(client.id),
        mdnsPeers: this.mdns.getPeers()
      });
    }
  }

  getDevicesFor(selfId) {
    const devicesById = new Map();
    for (const client of this.clients.values()) {
      if (client.id === selfId || !isOpenClient(client)) continue;
      const current = devicesById.get(client.id);
      if (!current || client.lastSeen > current.lastSeen) {
        devicesById.set(client.id, publicDevice(client));
      }
    }
    return [...devicesById.values()];
  }

  send(socket, payload) {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  broadcastToTransfer(transferId, payload) {
    const route = this.transferRoutes.get(String(transferId || ''));
    if (!route) return false;
    const targets = [
      this.clients.get(route.requesterConnectionId),
      route.receiverConnectionId ? this.clients.get(route.receiverConnectionId) : null
    ].filter(isOpenClient);
    if (!targets.length) return false;
    for (const target of targets) {
      this.send(target.socket, payload);
    }
    return true;
  }

  pruneTransferRoutes() {
    const cutoff = Date.now() - ROUTE_TTL_MS;
    for (const [transferId, route] of this.transferRoutes.entries()) {
      if ((route.updatedAt || route.createdAt) < cutoff) this.transferRoutes.delete(transferId);
    }
  }

  close() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    for (const client of this.clients.values()) {
      client.socket.close();
    }
  }
}

function getTransferId(message) {
  return message.transferId || message.fileMeta?.transferId || '';
}

function isOpenClient(client) {
  return Boolean(client?.socket && client.socket.readyState === client.socket.OPEN);
}

function publicDevice(client) {
  return {
    id: client.id,
    ip: client.ip,
    userAgent: client.userAgent,
    lastSeen: client.lastSeen
  };
}

function normalizeIp(address = '') {
  if (address.startsWith('::ffff:')) {
    return address.slice(7);
  }
  if (address === '::1') {
    return '127.0.0.1';
  }
  return address;
}

function getClientDeviceId(request) {
  try {
    const url = new URL(request.url || '/', 'http://crosslan.local');
    const value = String(url.searchParams.get('deviceId') || '');
    return sanitizeDeviceId(value);
  } catch {
    return '';
  }
}

function sanitizeDeviceId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 96);
}

function getLocalIpv4Addresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .filter(iface => iface.family === 'IPv4' && !iface.internal)
    .map(iface => iface.address);
}
