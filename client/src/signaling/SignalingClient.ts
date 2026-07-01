import type { SignalingMessage } from '../types';

type Handler = (message: SignalingMessage) => void;
type DebugLevel = 'info' | 'warn' | 'error';
type DebugHandler = (message: string, details?: unknown, level?: DebugLevel) => void;

export class SignalingClient {
  private socket: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private debugHandlers = new Set<DebugHandler>();
  private reconnectTimer: number | null = null;
  private outboundQueue: Record<string, unknown>[] = [];
  private socketDeviceId = '';
  private socketDirectSave = false;
  private closingManually = false;

  connect(deviceId = '', directSave = false) {
    this.socketDeviceId = deviceId || this.socketDeviceId;
    this.socketDirectSave = directSave;
    this.closingManually = false;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams();
    if (this.socketDeviceId) params.set('deviceId', this.socketDeviceId);
    if (this.socketDirectSave) params.set('directSave', '1');
    const query = params.toString() ? `?${params.toString()}` : '';
    const url = `${protocol}://${location.host}/ws${query}`;
    this.emitDebug('ws connecting', { url, readyState: this.socket?.readyState });
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.emitDebug('ws open', { url });
      this.flushQueue();
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      try {
        const message = JSON.parse(event.data) as SignalingMessage;
        this.emitDebug(`ws message: ${message.type}`, summarizeMessage(message));
        for (const handler of this.handlers) handler(message);
      } catch (error) {
        this.emitDebug('ws message parse failed', { data: String(event.data).slice(0, 500), error: errorMessage(error) }, 'error');
      }
    });
    socket.addEventListener('close', event => {
      if (this.socket !== socket) return;
      this.emitDebug('ws closed', { code: event.code, reason: event.reason, wasClean: event.wasClean }, 'warn');
      if (this.closingManually) return;
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      if (this.socket !== socket) return;
      this.emitDebug('ws error', { url }, 'error');
    });
  }

  onMessage(handler: Handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onDebug(handler: DebugHandler) {
    this.debugHandlers.add(handler);
    return () => this.debugHandlers.delete(handler);
  }

  send(message: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.emitDebug(`ws send: ${String(message.type || 'unknown')}`, summarizeMessage(message));
      this.socket.send(JSON.stringify(message));
      return;
    }
    this.outboundQueue.push({ ...message });
    this.emitDebug('ws send queued: socket not open', { readyState: this.socket?.readyState, message: summarizeMessage(message), queueLength: this.outboundQueue.length }, 'warn');
  }

  requestDeviceList() {
    this.send({ type: 'device-list-request' });
  }

  close() {
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.closingManually = true;
    this.emitDebug('ws close requested');
    this.socket?.close();
  }

  reconnect(deviceId = this.socketDeviceId, directSave = this.socketDirectSave) {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closingManually = true;
    this.socket?.close();
    this.connect(deviceId, directSave);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.emitDebug('ws reconnect scheduled');
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.socketDeviceId, this.socketDirectSave);
    }, 1500);
  }

  private flushQueue() {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.outboundQueue.length) return;
    const messages = this.outboundQueue.splice(0);
    this.emitDebug('ws flushing queued messages', { count: messages.length });
    for (const message of messages) this.send(message);
  }

  private emitDebug(message: string, details?: unknown, level: DebugLevel = 'info') {
    for (const handler of this.debugHandlers) handler(message, details, level);
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    method('[CrossLAN:signal]', message, details ?? '');
  }
}

function summarizeMessage(message: Record<string, unknown>) {
  const copy = { ...message };
  if (copy.description) copy.description = '[rtc-description]';
  if (copy.candidate) copy.candidate = '[ice-candidate]';
  if (copy.fileMeta && typeof copy.fileMeta === 'object') {
    const meta = copy.fileMeta as Record<string, unknown>;
    copy.fileMeta = { transferId: meta.transferId, name: meta.name, size: meta.size, type: meta.type };
  }
  return copy;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
