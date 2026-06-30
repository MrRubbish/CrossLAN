import type { BandwidthLimit, FileMeta, SignalingMessage, TransferProgress } from '../types';
import type { SignalingClient } from '../signaling/SignalingClient';

const CHUNK_SIZE = 64 * 1024;
const BACKPRESSURE_HIGH_WATER = 4 * 1024 * 1024;
const BACKPRESSURE_LOW_WATER = 512 * 1024;
const PROGRESS_INTERVAL_MS = 150;
const RECEIVER_ACK_TIMEOUT_MS = 30000;
const HTTP_BLOB_FALLBACK_LIMIT = 512 * 1024 * 1024;

type ProgressHandler = (progress: TransferProgress) => void;
type IncomingHandler = (meta: FileMeta, from: string) => Promise<boolean> | boolean;
type DebugLevel = 'info' | 'warn' | 'error';
type DebugHandler = (message: string, details?: unknown, level?: DebugLevel) => void;

interface PeerSession {
  peer: RTCPeerConnection;
  channel?: RTCDataChannel;
  file?: File;
  fileMeta?: FileMeta;
  receiveState?: ReceiveState;
  resolveSaved?: () => void;
  rejectSaved?: (error: Error) => void;
}

type ReceiveState =
  | {
      mode: 'stream';
      meta: FileMeta;
      bytes: number;
      writer: WritableStreamDefaultWriter<Uint8Array>;
    }
  | {
      mode: 'blob';
      meta: FileMeta;
      bytes: number;
      chunks: BlobPart[];
    };

export class TransferEngine {
  private sessions = new Map<string, PeerSession>();
  private progressHandlers = new Set<ProgressHandler>();
  private debugHandlers = new Set<DebugHandler>();
  private incomingHandler: IncomingHandler | null = null;
  private bandwidthLimit: BandwidthLimit = { mode: 'unlimited' };
  private lastProgressAt = 0;
  private nextThrottleAt = 0;

  constructor(private signaling: SignalingClient, private getSelfId: () => string | null) {}

  onProgress(handler: ProgressHandler) {
    this.progressHandlers.add(handler);
    return () => this.progressHandlers.delete(handler);
  }

  onIncoming(handler: IncomingHandler) {
    this.incomingHandler = handler;
  }

  onDebug(handler: DebugHandler) {
    this.debugHandlers.add(handler);
    return () => this.debugHandlers.delete(handler);
  }

  setBandwidthLimit(limit: BandwidthLimit) {
    // V1 defaults to unlimited. Future diagnostics can call this method with a
    // measured value to throttle TransferEngine without changing UI or signaling.
    this.bandwidthLimit = limit;
    if (limit.mode !== 'manual' || !limit.bytesPerSecond) {
      this.nextThrottleAt = 0;
    }
  }

  cancelTransfer(transferId: string) {
    for (const [peerId, session] of this.sessions.entries()) {
      const sessionTransferId = session.fileMeta?.transferId || session.receiveState?.meta.transferId;
      if (sessionTransferId !== transferId) continue;
      this.emitDebug('p2p transfer cancelled', { peerId, transferId }, 'warn');
      if (session.receiveState?.mode === 'stream') {
        void session.receiveState.writer.abort('Transfer cancelled').catch(() => undefined);
      } else if (session.receiveState?.mode === 'blob') {
        session.receiveState.chunks.length = 0;
      }
      session.rejectSaved?.(new Error('Transfer cancelled.'));
      this.emit({
        id: transferId,
        direction: session.file ? 'send' : 'receive',
        fileName: session.fileMeta?.name || session.receiveState?.meta.name || 'Transfer',
        bytesTransferred: session.receiveState?.bytes || 0,
        totalBytes: session.fileMeta?.size || session.receiveState?.meta.size || 0,
        done: true,
        cancellable: false,
        cancelled: true,
        statusText: 'Transfer cancelled.'
      });
      this.cleanup(peerId);
      return;
    }
  }

  async sendFile(to: string, file: File) {
    const transferId = createTransferId();
    this.emitDebug('p2p send created', { to, transferId, fileName: file.name, size: file.size });
    const meta: FileMeta = {
      transferId,
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified
    };

    const session = this.createSession(to);
    session.file = file;
    session.fileMeta = meta;
    const channel = session.peer.createDataChannel('file', { ordered: true });
    session.channel = channel;
    this.bindSenderChannel(to, session, channel);

    this.emitDebug('p2p create offer', { to, transferId });
    const offer = await session.peer.createOffer();
    await session.peer.setLocalDescription(offer);
    this.emitDebug('p2p offer sent', { to, transferId });
    this.signaling.send({ type: 'offer', to, description: offer, fileMeta: meta });
  }

  async handleSignal(message: SignalingMessage) {
    this.emitDebug('p2p signal received', { type: message.type, from: 'from' in message ? message.from : undefined, transferId: 'fileMeta' in message ? message.fileMeta?.transferId : undefined });
    if (message.type === 'offer') {
      await this.handleOffer(message);
    } else if (message.type === 'answer') {
      this.emitDebug('p2p answer received', { from: message.from });
      await this.sessions.get(message.from)?.peer.setRemoteDescription(message.description);
    } else if (message.type === 'ice-candidate' && message.candidate) {
      this.emitDebug('p2p ice candidate received', { from: message.from });
      await this.sessions.get(message.from)?.peer.addIceCandidate(message.candidate);
    } else if (message.type === 'peer-unavailable') {
      this.cleanup(message.to);
    }
  }

  private async handleOffer(message: Extract<SignalingMessage, { type: 'offer' }>) {
    if (!message.fileMeta) return;
    this.emitDebug('p2p offer received', { from: message.from, transferId: message.fileMeta.transferId, fileName: message.fileMeta.name, size: message.fileMeta.size });
    const accepted = await (this.incomingHandler?.(message.fileMeta, message.from) ?? true);
    this.emitDebug(accepted ? 'p2p offer accepted' : 'p2p offer rejected', { from: message.from, transferId: message.fileMeta.transferId }, accepted ? 'info' : 'warn');
    if (!accepted) {
      this.signaling.send({
        type: 'transfer-reject',
        to: message.from,
        transferId: message.fileMeta.transferId,
        reason: 'Rejected by receiver'
      });
      return;
    }

    const session = this.createSession(message.from);
    session.fileMeta = message.fileMeta;
    session.peer.ondatachannel = event => {
      session.channel = event.channel;
      this.bindReceiverChannel(message.from, session, event.channel);
    };
    await session.peer.setRemoteDescription(message.description);
    const answer = await session.peer.createAnswer();
    await session.peer.setLocalDescription(answer);
    this.emitDebug('p2p answer sent', { to: message.from, transferId: message.fileMeta.transferId });
    this.signaling.send({ type: 'answer', to: message.from, description: answer });
  }

  private createSession(peerId: string) {
    this.cleanup(peerId);
    this.emitDebug('p2p session creating', { peerId });
    const peer = new RTCPeerConnection({ iceServers: [] });
    const session: PeerSession = { peer };
    peer.onicecandidate = event => {
      if (event.candidate) {
        this.emitDebug('p2p ice candidate sent', { peerId, candidateType: event.candidate.type });
        this.signaling.send({ type: 'ice-candidate', to: peerId, candidate: event.candidate.toJSON() });
      }
    };
    peer.oniceconnectionstatechange = () => this.emitDebug('p2p ice state', { peerId, iceConnectionState: peer.iceConnectionState });
    peer.onconnectionstatechange = () => {
      this.emitDebug('p2p connection state', { peerId, connectionState: peer.connectionState });
      if (['closed', 'failed', 'disconnected'].includes(peer.connectionState)) {
        this.cleanup(peerId);
      }
    };
    this.sessions.set(peerId, session);
    return session;
  }

  private bindSenderChannel(peerId: string, session: PeerSession, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BACKPRESSURE_LOW_WATER;
    channel.onclose = () => this.emitDebug('p2p sender channel closed', { peerId, transferId: session.fileMeta?.transferId }, 'warn');
    channel.onerror = () => this.emitDebug('p2p sender channel error', { peerId, transferId: session.fileMeta?.transferId }, 'error');
    channel.onmessage = event => {
      if (typeof event.data !== 'string') return;
      const control = JSON.parse(event.data);
      this.emitDebug('p2p control received', { peerId, type: control.type, transferId: control.transferId });
      if (control.type === 'saved' && control.transferId === session.fileMeta?.transferId) {
        session.resolveSaved?.();
      }
      if (control.type === 'receive-error') {
        session.rejectSaved?.(new Error(control.message || 'Receiver failed to save the file.'));
      }
    };
    channel.onopen = () => {
      this.emitDebug('p2p sender channel open', { peerId, transferId: session.fileMeta?.transferId });
      if (session.file && session.fileMeta) {
        void this.streamFile(peerId, session, channel, session.file, session.fileMeta).catch(error => {
          this.emitDebug('p2p stream failed', { peerId, error: errorMessage(error) }, 'error');
          console.error(error);
          this.cleanup(peerId);
        });
      }
    };
  }

  private bindReceiverChannel(peerId: string, session: PeerSession, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => this.emitDebug('p2p receiver channel open', { peerId, transferId: session.fileMeta?.transferId });
    channel.onclose = () => this.emitDebug('p2p receiver channel closed', { peerId, transferId: session.fileMeta?.transferId }, 'warn');
    channel.onerror = () => this.emitDebug('p2p receiver channel error', { peerId, transferId: session.fileMeta?.transferId }, 'error');
    channel.onmessage = async event => {
      try {
        if (typeof event.data === 'string') {
          const control = JSON.parse(event.data);
      this.emitDebug('p2p control received', { peerId, type: control.type, transferId: control.transferId });
          if (control.type === 'meta') {
            this.emitDebug('p2p receiver meta', { peerId, transferId: control.meta?.transferId, fileName: control.meta?.name, size: control.meta?.size });
            session.receiveState = await this.createReceiveState(control.meta);
          }
          if (control.type === 'done' && session.receiveState) {
            this.emitDebug('p2p receiver done control', { peerId, transferId: session.receiveState.meta.transferId, bytes: session.receiveState.bytes });
            await this.finishReceive(peerId, session.receiveState, channel);
          }
          return;
        }

        if (!session.receiveState) return;
        const chunk = new Uint8Array(event.data);
        await this.writeChunk(session.receiveState, chunk);
        session.receiveState.bytes += chunk.byteLength;
        this.emitThrottled({
          id: session.receiveState.meta.transferId,
          direction: 'receive',
          fileName: session.receiveState.meta.name,
          bytesTransferred: session.receiveState.bytes,
          totalBytes: session.receiveState.meta.size,
          done: false
        });
      } catch (error) {
        this.emitDebug('p2p receive failed', { peerId, error: errorMessage(error) }, 'error');
        this.sendControl(channel, {
          type: 'receive-error',
          message: error instanceof Error ? error.message : 'Unknown receive error'
        });
        this.cleanup(peerId);
      }
    };
  }

  private async streamFile(peerId: string, session: PeerSession, channel: RTCDataChannel, file: File, meta: FileMeta) {
    this.emitDebug('p2p stream start', { peerId, transferId: meta.transferId, fileName: meta.name, size: meta.size });
    this.sendControl(channel, { type: 'meta', meta });
    let offset = 0;

    while (offset < file.size && channel.readyState === 'open') {
      await this.waitForBackpressure(channel, BACKPRESSURE_HIGH_WATER);
      const end = Math.min(offset + CHUNK_SIZE, file.size);
      await this.applyManualThrottle(end - offset);
      const buffer = await file.slice(offset, end).arrayBuffer();
      this.sendBinary(channel, buffer);
      offset += buffer.byteLength;

      // Drop references every loop so large files never become a full-memory
      // Blob or ArrayBuffer chain on low-end phones.
      this.emitThrottled({
        id: meta.transferId,
        direction: 'send',
        fileName: meta.name,
        bytesTransferred: offset,
        totalBytes: meta.size,
        done: false
      });
    }

    this.emitDebug('p2p stream bytes sent', { peerId, transferId: meta.transferId, offset, size: file.size });
    const receiverSaved = this.waitForReceiverSaved(session);
    await this.waitForBackpressure(channel, 1);
    this.sendControl(channel, { type: 'done', transferId: meta.transferId });
    await this.waitForBackpressure(channel, 1);
    await receiverSaved;
    this.emitDebug('p2p receiver save ack received', { peerId, transferId: meta.transferId });

    this.emit({
      id: meta.transferId,
      direction: 'send',
      fileName: meta.name,
      bytesTransferred: meta.size,
      totalBytes: meta.size,
      done: true
    });
    this.cleanup(peerId);
  }

  private async createReceiveState(meta: FileMeta): Promise<ReceiveState> {
    this.emitDebug('p2p create receive state', { transferId: meta.transferId, fileName: meta.name, size: meta.size, secure: window.isSecureContext, hasSavePicker: Boolean(window.showSaveFilePicker) });
    if (window.isSecureContext && window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: meta.name,
        types: [{ description: meta.type, accept: { [meta.type]: [`.${meta.name.split('.').pop() || 'bin'}`] } }]
      });
      const writable = await handle.createWritable();
      this.emitDebug('p2p receive mode: file-system-access', { transferId: meta.transferId });
      return { mode: 'stream', meta, bytes: 0, writer: writable.getWriter() };
    }

    if (window.isSecureContext) {
      const streamSaver = await import('streamsaver');
      streamSaver.default.mitm = `${location.origin}/streamsaver/mitm.html`;
      this.emitDebug('p2p receive mode: streamsaver', { transferId: meta.transferId });
      return {
        mode: 'stream',
        meta,
        bytes: 0,
        writer: streamSaver.default.createWriteStream(meta.name, { size: meta.size }).getWriter()
      };
    }

    if (meta.size > HTTP_BLOB_FALLBACK_LIMIT) {
      throw new Error('Large files require HTTPS or localhost for streaming save on this browser.');
    }

    // Plain LAN HTTP cannot use Service Worker/File System Access reliably.
    // Use a bounded Blob fallback so phone/PC transfers still complete.
    this.emitDebug('p2p receive mode: blob fallback', { transferId: meta.transferId });
    return { mode: 'blob', meta, bytes: 0, chunks: [] };
  }

  private async writeChunk(state: ReceiveState, chunk: Uint8Array) {
    if (state.mode === 'stream') {
      await state.writer.write(chunk);
      return;
    }
    state.chunks.push(chunk.slice());
  }

  private async finishReceive(peerId: string, state: ReceiveState, channel: RTCDataChannel) {
    let downloadUrl: string | undefined;
    let needsUserSave = false;

    this.emitDebug('p2p finish receive', { peerId, transferId: state.meta.transferId, mode: state.mode, bytes: state.bytes });
    if (state.mode === 'stream') {
      await state.writer.close();
    } else {
      const blob = new Blob(state.chunks, { type: state.meta.type });
      downloadUrl = URL.createObjectURL(blob);
      needsUserSave = true;
      state.chunks.length = 0;
    }

    this.sendControl(channel, { type: 'saved', transferId: state.meta.transferId });
    this.emit({
      id: state.meta.transferId,
      direction: 'receive',
      fileName: state.meta.name,
      bytesTransferred: state.meta.size,
      totalBytes: state.meta.size,
      done: true,
      downloadUrl,
      needsUserSave
    });
    window.setTimeout(() => this.cleanup(peerId), 250);
  }


  private ensureChannelOpen(channel: RTCDataChannel) {
    if (channel.readyState !== 'open') {
      throw new Error('Transfer channel closed before the transfer completed.');
    }
  }

  private sendControl(channel: RTCDataChannel, payload: unknown) {
    this.ensureChannelOpen(channel);
    channel.send(JSON.stringify(payload));
  }

  private sendBinary(channel: RTCDataChannel, payload: ArrayBuffer) {
    this.ensureChannelOpen(channel);
    channel.send(payload);
  }
  private async waitForBackpressure(channel: RTCDataChannel, maxBufferedAmount: number) {
    if (channel.bufferedAmount < maxBufferedAmount) return;
    await new Promise<void>(resolve => {
      const done = () => {
        if (channel.bufferedAmount < maxBufferedAmount || channel.readyState !== 'open') {
          channel.removeEventListener('bufferedamountlow', done);
          window.clearInterval(timer);
          resolve();
        }
      };
      const timer = window.setInterval(done, 25);
      channel.addEventListener('bufferedamountlow', done);
    });
  }

  private async waitForReceiverSaved(session: PeerSession) {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Timed out waiting for receiver save acknowledgement.')), RECEIVER_ACK_TIMEOUT_MS);
      session.resolveSaved = () => {
        window.clearTimeout(timer);
        resolve();
      };
      session.rejectSaved = error => {
        window.clearTimeout(timer);
        reject(error);
      };
    });
  }

  private async applyManualThrottle(nextBytes: number) {
    if (this.bandwidthLimit.mode !== 'manual' || !this.bandwidthLimit.bytesPerSecond) return;
    const now = performance.now();
    if (this.nextThrottleAt <= 0 || this.nextThrottleAt < now - 1000) {
      this.nextThrottleAt = now;
    }
    const waitMs = this.nextThrottleAt - now;
    if (waitMs > 1) {
      await new Promise(resolve => window.setTimeout(resolve, waitMs));
    }
    this.nextThrottleAt = Math.max(performance.now(), this.nextThrottleAt) + (nextBytes / this.bandwidthLimit.bytesPerSecond) * 1000;
  }

  private emitThrottled(progress: TransferProgress) {
    const now = performance.now();
    if (now - this.lastProgressAt < PROGRESS_INTERVAL_MS && !progress.done) return;
    this.lastProgressAt = now;
    requestAnimationFrame(() => this.emit(progress));
  }

  private emit(progress: TransferProgress) {
    for (const handler of this.progressHandlers) handler(progress);
  }


  private emitDebug(message: string, details?: unknown, level: DebugLevel = 'info') {
    for (const handler of this.debugHandlers) handler(message, details, level);
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    method('[CrossLAN:p2p]', message, details ?? '');
  }
  private cleanup(peerId: string) {
    const session = this.sessions.get(peerId);
    if (!session) return;
    this.emitDebug('p2p cleanup', { peerId, transferId: session.fileMeta?.transferId });
    session.channel?.close();
    session.peer.close();
    this.sessions.delete(peerId);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createTransferId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}
