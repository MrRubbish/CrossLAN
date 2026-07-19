import os from 'node:os';
import { nanoid } from 'nanoid';

const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice-candidate', 'transfer-accept', 'transfer-reject', 'batch-transfer-request', 'batch-transfer-accept', 'batch-transfer-reject', 'direct-transfer-request', 'direct-transfer-accept', 'direct-transfer-reject', 'relay-transfer-request', 'relay-transfer-accept', 'relay-transfer-reject', 'relay-transfer-progress', 'relay-transfer-ready', 'relay-transfer-error', 'transfer-cancel']);
const REQUEST_TYPES = new Set(['transfer-accept', 'direct-transfer-request', 'relay-transfer-request', 'offer']);
const RESPONSE_TYPES = new Set(['transfer-accept', 'transfer-reject', 'direct-transfer-accept', 'direct-transfer-reject', 'relay-transfer-accept', 'relay-transfer-reject', 'answer']);
const RECEIVER_FOLLOWUP_TYPES = new Set(['relay-transfer-progress', 'relay-transfer-ready', 'relay-transfer-error']);
const ROUTE_TTL_MS = 30 * 60 * 1000;
const SERVICE_HOST_DEVICE_ID = 'crosslan-service-host';

export class SignalingHub {
  constructor({ wss, mdns, networkProber, deploymentMode = 'node', serverInstanceId = '', logger = console }) {
    this.wss = wss;
    this.mdns = mdns;
    this.networkProber = networkProber;
    this.deploymentMode = deploymentMode;
    this.serverInstanceId = serverInstanceId;
    this.logger = logger;
    this.clients = new Map();
    this.hostUiDeviceIds = new Set();
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
    if (isProbeClient(request)) {
      const hostUi = this.deploymentMode === 'docker' && isHostUiClient(request);
      if (hostUi) this.markHostUiDeviceId(id);
      this.logger.debug('CrossLAN ws probe: id=' + id + ' ip=' + ip + ' hostUi=' + (hostUi ? '1' : '0') + ' ua=' + (request.headers['user-agent'] || 'Unknown device'));
      this.send(socket, {
        type: 'hello',
        device: publicDevice({
          connectionId,
          id,
          ip,
          socket,
          userAgent: request.headers['user-agent'] || 'Unknown device',
          canDirectSave: false,
          hostUi,
          lastSeen: Date.now()
        }),
        serverIps: getAdvertisedServerIps(request, this.deploymentMode),
        serverMode: this.deploymentMode,
        serverInstanceId: this.serverInstanceId
      });
      socket.close(1000, 'probe complete');
      return;
    }

    const hostUi = this.deploymentMode === 'docker' && (isHostUiClient(request) || this.hostUiDeviceIds.has(id));
    if (hostUi) this.hostUiDeviceIds.add(id);
    const client = {
      connectionId,
      id,
      ip,
      socket,
      userAgent: request.headers['user-agent'] || 'Unknown device',
      canDirectSave: isDirectSaveClient(request) || isServiceHostRequest(request, ip),
      hostUi,
      lastSeen: Date.now(),
      connectedAt: Date.now()
    };

    this.clients.set(connectionId, client);
    this.logger.info('CrossLAN ws connected: id=' + id + ' conn=' + connectionId + ' ip=' + ip + ' hostUi=' + (client.hostUi ? '1' : '0') + ' ua=' + client.userAgent);

    this.send(socket, {
      type: 'hello',
      device: publicDevice(client),
      serverIps: getAdvertisedServerIps(request, this.deploymentMode),
      serverMode: this.deploymentMode,
      serverInstanceId: this.serverInstanceId
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
      this.logger.debug('CrossLAN signal device-list request: from=' + sender.id + ' conn=' + sender.connectionId);
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
      this.logger.warn('CrossLAN signal unsupported: type=' + message.type + ' from=' + sender.id + ' transferId=' + getTransferId(message));
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
      if (this.isServiceHostDirectRequest(message)) {
        const route = this.transferRoutes.get(transferId);
        if (route) {
          route.receiverId = SERVICE_HOST_DEVICE_ID;
          route.updatedAt = Date.now();
        }
        this.send(sender.socket, {
          type: 'direct-transfer-accept',
          from: SERVICE_HOST_DEVICE_ID,
          to: sender.id,
          transferId
        });
        this.logger.info('CrossLAN signal service host direct auto-accepted: from=' + sender.id + ' conn=' + sender.connectionId + ' transferId=' + transferId);
        return;
      }
      this.logger.warn('CrossLAN signal peer unavailable: type=' + message.type + ' from=' + sender.id + ' to=' + message.to + ' transferId=' + transferId);
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
    this.logger.debug('CrossLAN signal routed: type=' + message.type + ' from=' + sender.id + ' conn=' + sender.connectionId + ' to=' + message.to + ' targets=' + targets.map(target => target.connectionId).join(',') + ' transferId=' + transferId);
  }

  resolveTargets(sender, message, transferId) {
    const route = transferId ? this.transferRoutes.get(transferId) : null;

    if (this.isServiceHostDirectRequest(message)) {
      return [...this.clients.values()]
        .filter(client => client.connectionId !== sender.connectionId && client.hostUi && client.canDirectSave && isOpenClient(client))
        .sort((a, b) => b.lastSeen - a.lastSeen)
        .slice(0, 1);
    }

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

  isServiceHostDirectRequest(message) {
    return this.deploymentMode === 'docker' &&
      message.type === 'direct-transfer-request' &&
      String(message.to || '') === SERVICE_HOST_DEVICE_ID;
  }

  getTargetsForDevice(deviceId, excludeConnectionId = '') {
    const id = String(deviceId || '');
    return [...this.clients.values()]
      .filter(client => client.id === id && client.connectionId !== excludeConnectionId && isOpenClient(client))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  removeClient(client, reason) {
    this.clients.delete(client.connectionId);
    this.logger.info('CrossLAN ws ' + reason + ': id=' + client.id + ' conn=' + client.connectionId);
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
      if (client.hostUi) continue;
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

  markHostUiDeviceId(id) {
    if (this.deploymentMode !== 'docker') return;
    if (!id) return;
    this.hostUiDeviceIds.add(id);
    let changed = false;
    for (const client of this.clients.values()) {
      if (client.id !== id || client.hostUi) continue;
      client.hostUi = true;
      changed = true;
    }
    if (changed) this.broadcastDeviceList();
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
  return message.transferId || message.fileMeta?.transferId || message.batchId || '';
}

function isOpenClient(client) {
  return Boolean(client?.socket && client.socket.readyState === client.socket.OPEN);
}

function publicDevice(client) {
  return {
    id: client.id,
    ip: client.ip,
    userAgent: client.userAgent,
    canDirectSave: client.canDirectSave,
    hostUi: client.hostUi,
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

function isDirectSaveClient(request) {
  try {
    const url = new URL(request.url || '/', 'http://crosslan.local');
    return url.searchParams.get('directSave') === '1';
  } catch {
    return false;
  }
}

function isHostUiClient(request) {
  try {
    const url = new URL(request.url || '/', 'http://crosslan.local');
    return url.searchParams.get('hostUi') === '1';
  } catch {
    return false;
  }
}

function isProbeClient(request) {
  try {
    const url = new URL(request.url || '/', 'http://crosslan.local');
    return url.searchParams.get('probe') === '1';
  } catch {
    return false;
  }
}

function isServiceHostRequest(request, ip) {
  const host = getRequestHost(request);
  if (isLoopbackHost(host)) return true;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  return getLocalIpv4Addresses().includes(ip);
}

function getAdvertisedServerIps(request, deploymentMode) {
  const configuredIp = String(process.env.CROSSLAN_ADVERTISED_IP || '').trim();
  if (configuredIp) return [configuredIp];

  const requestHost = getRequestHost(request);
  const localIps = getLocalIpv4Addresses();
  if (requestHost && !isLoopbackHost(requestHost) && !localIps.includes(requestHost)) {
    return [requestHost];
  }

  // A Docker container cannot reliably discover the Windows host's LAN IP.
  // Never expose the container interface as the advertised service address.
  if (deploymentMode === 'docker') return [];
  return localIps;
}

function getRequestHost(request) {
  const forwardedHost = request.headers['x-forwarded-host'];
  const headerValue = forwardedHost || request.headers.host || '';
  const rawHost = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const value = String(rawHost || '').split(',')[0].trim();

  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    if (closingBracket > 0) return value.slice(1, closingBracket).toLowerCase();
  }

  // Only a single-colon host can be an ordinary hostname/IPv4 address with a port.
  // Leave unbracketed IPv6 addresses intact.
  if (value.indexOf(':') === value.lastIndexOf(':')) {
    const separator = value.lastIndexOf(':');
    if (/^\d+$/.test(value.slice(separator + 1))) {
      return value.slice(0, separator).toLowerCase();
    }
  }

  return value.toLowerCase();
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function getLocalIpv4Addresses() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, interfaces]) => (interfaces || []).map(iface => ({ name, ...iface })))
    .filter(iface => iface.family === 'IPv4' && !iface.internal)
    .sort(compareNetworkInterfaces)
    .map(iface => iface.address);
}

function compareNetworkInterfaces(a, b) {
  const virtualDifference = Number(isVirtualInterfaceName(a.name)) - Number(isVirtualInterfaceName(b.name));
  if (virtualDifference !== 0) return virtualDifference;
  return ipv4AddressScore(b.address) - ipv4AddressScore(a.address);
}

function isVirtualInterfaceName(name = '') {
  return /docker|veth|v-?ethernet|hyper[- ]?v|vmware|vmnet|virtualbox|vbox|wsl|teredo|tunnel|wireguard|tailscale|zerotier|vpn|bridge|container|loopback/i.test(name);
}

function ipv4AddressScore(address = '') {
  if (address.startsWith('169.254.')) return -100;
  if (address.startsWith('192.168.')) return 30;
  if (address.startsWith('10.')) return 20;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 10;
  return 0;
}
