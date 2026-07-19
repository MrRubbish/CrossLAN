import type { BandwidthLimit, FileMeta, SignalingMessage, TransferBatchMeta, TransferProgress } from '../types';
import type { SignalingClient } from '../signaling/SignalingClient';

const CHUNK_SIZE = 256 * 1024;
const BACKPRESSURE_HIGH_WATER = 16 * 1024 * 1024;
const BACKPRESSURE_LOW_WATER = 8 * 1024 * 1024;
const BATCH_BACKPRESSURE_HIGH_WATER = 32 * 1024 * 1024;
const BATCH_BACKPRESSURE_LOW_WATER = 16 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 10;
const PROGRESS_INTERVAL_MS = 150;
const RECEIVER_ACK_TIMEOUT_MS = 30000;
const RECEIVER_PROGRESS_ACK_INTERVAL_MS = 150;
const PEER_CONNECTION_TIMEOUT_MS = 120000;
const HTTP_BLOB_FALLBACK_LIMIT = 512 * 1024 * 1024;

type ProgressHandler = (progress: TransferProgress) => void;
type IncomingHandler = (meta: FileMeta, from: string) => Promise<boolean> | boolean;
type DebugLevel = 'info' | 'warn' | 'error';
type DebugHandler = (message: string, details?: unknown, level?: DebugLevel) => void;
type QueuedTransfer = { peerId: string; file: File; meta: FileMeta };

interface PeerSession {
  peer: RTCPeerConnection;
  channel?: RTCDataChannel;
  file?: File;
  fileMeta?: FileMeta;
  receiveState?: ReceiveState;
  receiveQueue?: Promise<void>;
  resolveSaved?: () => void;
  rejectSaved?: (error: Error) => void;
  resolveTransfer?: () => void;
  rejectTransfer?: (error: Error) => void;
  transferSettled?: boolean;
  connectionTimer?: number;
  pendingCandidates: RTCIceCandidateInit[];
  bytesQueued?: number;
  bytesAcknowledged?: number;
}

type ReceiveState =
  | {
      mode: 'stream';
      meta: FileMeta;
      bytes: number;
      writer: WritableStreamDefaultWriter<Uint8Array>;
      lastAckAt: number;
      lastAckBytes: number;
    }
  | {
      mode: 'blob';
      meta: FileMeta;
      bytes: number;
      chunks: BlobPart[];
      lastAckAt: number;
      lastAckBytes: number;
    };

export class TransferEngine {
  private sessions = new Map<string, PeerSession>();
  private outgoingQueues = new Map<string, Promise<void>>();
  private pendingIceByPeer = new Map<string, RTCIceCandidateInit[]>();
  private progressHandlers = new Set<ProgressHandler>();
  private debugHandlers = new Set<DebugHandler>();
  private incomingHandler: IncomingHandler | null = null;
  private bandwidthLimit: BandwidthLimit = { mode: 'unlimited' };
  private queuedTransfers = new Map<string, QueuedTransfer>();
  private pendingIncomingOffers = new Map<string, string>();
  private cancelledTransfers = new Set<string>();
  private cancelledTransferTimers = new Map<string, number>();
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

  cancelTransfer(transferId: string, reason = 'Transfer cancelled.', rememberUnknown = false) {
    for (const [peerId, session] of this.sessions.entries()) {
      const sessionTransferId = session.fileMeta?.transferId || session.receiveState?.meta.transferId;
      if (sessionTransferId !== transferId) continue;
      this.rememberCancelledTransfer(transferId);
      this.emitDebug('p2p transfer cancelled', { peerId, transferId }, 'warn');
      const sending = Boolean(session.file);
      const bytesTransferred = sending
        ? session.bytesAcknowledged || 0
        : session.receiveState?.bytes || 0;
      this.emit({
        id: transferId,
        direction: sending ? 'send' : 'receive',
        fileName: session.fileMeta?.name || session.receiveState?.meta.name || 'Transfer',
        bytesTransferred,
        bytesUploaded: sending ? session.bytesQueued || 0 : undefined,
        bytesDelivered: bytesTransferred,
        totalBytes: session.fileMeta?.size || session.receiveState?.meta.size || 0,
        done: true,
        mode: 'p2p',
        cancellable: false,
        cancelled: true,
        peerId,
        statusText: reason
      });
      const error = this.createCancelledError(reason);
      this.cleanup(peerId, error);
      // An active session is already gone after cleanup. Keep the
      // cancellation guard only for queued work or a still-open offer prompt.
      this.forgetCancelledTransfer(transferId);
      return;
    }

    const queued = this.queuedTransfers.get(transferId);
    if (queued) {
      this.rememberCancelledTransfer(transferId);
      this.emitDebug('queued p2p transfer cancelled', { peerId: queued.peerId, transferId }, 'warn');
      this.emit({
        id: transferId,
        direction: 'send',
        fileName: queued.meta.name,
        bytesTransferred: 0,
        bytesUploaded: 0,
        bytesDelivered: 0,
        totalBytes: queued.meta.size,
        done: true,
        mode: 'p2p',
        cancellable: false,
        cancelled: true,
        peerId: queued.peerId,
        statusText: reason
      });
      return;
    }

    if (this.pendingIncomingOffers.has(transferId)) {
      this.rememberCancelledTransfer(transferId);
      this.emitDebug('pending p2p offer cancelled', { transferId }, 'warn');
      return;
    }

    if (rememberUnknown && !this.cancelledTransfers.has(transferId)) {
      this.rememberCancelledTransfer(transferId);
      this.emitDebug('unknown p2p transfer cancellation remembered', { transferId }, 'warn');
    }
  }

  sendFile(to: string, file: File, batchMeta?: TransferBatchMeta) {
    const transferId = createTransferId();
    const meta: FileMeta = {
      transferId,
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified,
      ...batchMeta
    };

    const previous = this.outgoingQueues.get(to) || Promise.resolve();
    this.queuedTransfers.set(meta.transferId, { peerId: to, file, meta });
    const transfer = previous.then(() => {
      this.queuedTransfers.delete(meta.transferId);
      if (this.cancelledTransfers.has(meta.transferId)) {
        throw this.createCancelledError();
      }
      return this.sendFileNow(to, file, meta);
    });
    let queueTail: Promise<void>;
    queueTail = transfer
      .then(() => undefined, () => undefined)
      .finally(() => {
        this.queuedTransfers.delete(meta.transferId);
        this.forgetCancelledTransfer(meta.transferId);
        if (this.outgoingQueues.get(to) === queueTail) {
          this.outgoingQueues.delete(to);
        }
      });
    this.outgoingQueues.set(to, queueTail);

    return transfer.catch(error => {
      if (!isTransferCancelledError(error)) {
        this.emit({
          id: transferId,
          direction: 'send',
          fileName: file.name,
          bytesTransferred: 0,
          totalBytes: file.size,
          done: true,
          mode: 'p2p',
          cancellable: false,
          peerId: to,
          statusText: errorMessage(error)
        });
      }
      throw error;
    });
  }

  async handleSignal(message: SignalingMessage) {
    this.emitDebug('p2p signal received', { type: message.type, from: 'from' in message ? message.from : undefined, transferId: 'fileMeta' in message ? message.fileMeta?.transferId : undefined });
    if (message.type === 'offer') {
      await this.handleOffer(message);
    } else if (message.type === 'answer') {
      this.emitDebug('p2p answer received', { from: message.from });
      const session = this.sessions.get(message.from);
      if (!session) return;
      await session.peer.setRemoteDescription(message.description);
      await this.flushPendingCandidates(message.from, session);
    } else if (message.type === 'ice-candidate' && message.candidate) {
      this.emitDebug('p2p ice candidate received', { from: message.from });
      const session = this.sessions.get(message.from);
      if (!session) {
        const candidates = this.pendingIceByPeer.get(message.from) || [];
        candidates.push(message.candidate);
        this.pendingIceByPeer.set(message.from, candidates);
        return;
      }
      if (!session.peer.remoteDescription) {
        session.pendingCandidates.push(message.candidate);
        return;
      }
      await session.peer.addIceCandidate(message.candidate);
    } else if (message.type === 'transfer-cancel') {
      this.cancelTransfer(message.transferId, message.reason || 'Peer cancelled the transfer.', true);
    } else if (message.type === 'transfer-reject') {
      const session = this.sessions.get(message.from);
      if (session?.fileMeta?.transferId !== message.transferId) return;
      this.cleanup(message.from, new Error(message.reason || 'Rejected by receiver.'));
    } else if (message.type === 'peer-unavailable') {
      this.cleanup(message.to, new Error('Peer is unavailable.'));
    }
  }

  private async sendFileNow(to: string, file: File, meta: FileMeta) {
    this.emitDebug('p2p send created', { to, transferId: meta.transferId, fileName: file.name, size: file.size });
    this.emit({
      id: meta.transferId,
      direction: 'send',
      fileName: meta.name,
      bytesTransferred: 0,
      bytesUploaded: 0,
      bytesDelivered: 0,
      totalBytes: meta.size,
      done: false,
      mode: 'p2p',
      cancellable: true,
      peerId: to
    });

    const session = this.createSession(to);
    session.file = file;
    session.fileMeta = meta;
    const completion = new Promise<void>((resolve, reject) => {
      session.resolveTransfer = resolve;
      session.rejectTransfer = reject;
    });
    session.connectionTimer = window.setTimeout(() => {
      if (this.sessions.get(to) !== session || session.channel?.readyState === 'open') return;
      this.cleanup(to, new Error('Timed out waiting for the peer connection.'));
    }, PEER_CONNECTION_TIMEOUT_MS);

    try {
      const channel = session.peer.createDataChannel('file', { ordered: true });
      session.channel = channel;
      this.bindSenderChannel(to, session, channel);

      this.emitDebug('p2p create offer', { to, transferId: meta.transferId });
      const offer = await session.peer.createOffer();
      await session.peer.setLocalDescription(offer);
      this.emitDebug('p2p offer sent', { to, transferId: meta.transferId });
      this.signaling.send({ type: 'offer', to, description: offer, fileMeta: meta });
      await completion;
    } catch (error) {
      if (this.sessions.get(to) === session) {
        this.cleanup(to, toError(error));
      }
      throw error;
    }
  }

  private async handleOffer(message: Extract<SignalingMessage, { type: 'offer' }>) {
    if (!message.fileMeta) return;
    const transferId = message.fileMeta.transferId;
    if (this.cancelledTransfers.has(transferId)) {
      this.forgetCancelledTransfer(transferId);
      this.emitDebug('p2p offer ignored after cancellation', { from: message.from, transferId }, 'warn');
      return;
    }
    this.emitDebug('p2p offer received', { from: message.from, transferId, fileName: message.fileMeta.name, size: message.fileMeta.size });
    this.pendingIncomingOffers.set(transferId, message.from);
    let accepted: boolean;
    try {
      accepted = await (this.incomingHandler?.(message.fileMeta, message.from) ?? true);
    } finally {
      this.pendingIncomingOffers.delete(transferId);
    }
    if (this.cancelledTransfers.has(transferId)) {
      this.forgetCancelledTransfer(transferId);
      this.emitDebug('p2p offer rejected after cancellation', { from: message.from, transferId }, 'warn');
      return;
    }
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
    await this.flushPendingCandidates(message.from, session);
    const answer = await session.peer.createAnswer();
    await session.peer.setLocalDescription(answer);
    this.emitDebug('p2p answer sent', { to: message.from, transferId: message.fileMeta.transferId });
    this.signaling.send({ type: 'answer', to: message.from, description: answer });
  }

  private createSession(peerId: string) {
    this.cleanup(peerId, new Error('A newer transfer replaced the active peer session.'));
    this.emitDebug('p2p session creating', { peerId });
    const peer = new RTCPeerConnection({ iceServers: [] });
    const session: PeerSession = {
      peer,
      pendingCandidates: this.pendingIceByPeer.get(peerId) || []
    };
    this.pendingIceByPeer.delete(peerId);
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
        this.cleanup(peerId, new Error(`Peer connection ${peer.connectionState}.`));
      }
    };
    this.sessions.set(peerId, session);
    return session;
  }

  private bindSenderChannel(peerId: string, session: PeerSession, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.onclose = () => {
      this.emitDebug('p2p sender channel closed', { peerId, transferId: session.fileMeta?.transferId }, 'warn');
      if (!session.transferSettled && this.sessions.get(peerId) === session) {
        this.cleanup(peerId, new Error('Transfer channel closed before completion.'));
      }
    };
    channel.onerror = () => {
      this.emitDebug('p2p sender channel error', { peerId, transferId: session.fileMeta?.transferId }, 'error');
      if (!session.transferSettled && this.sessions.get(peerId) === session) {
        this.cleanup(peerId, new Error('Transfer channel failed.'));
      }
    };
    channel.onmessage = event => {
      if (typeof event.data !== 'string') return;
      const control = JSON.parse(event.data);
      this.emitDebug('p2p control received', { peerId, type: control.type, transferId: control.transferId });
      const fileMeta = session.fileMeta;
      if (control.type === 'progress-ack' && fileMeta && control.transferId === fileMeta.transferId) {
        const totalBytes = fileMeta.size;
        const acknowledged = Math.min(
          totalBytes,
          Math.max(session.bytesAcknowledged || 0, Number(control.bytesReceived) || 0)
        );
        session.bytesAcknowledged = acknowledged;
        this.emitThrottled({
          id: fileMeta.transferId,
          direction: 'send',
          fileName: fileMeta.name,
          bytesTransferred: acknowledged,
          bytesUploaded: session.bytesQueued || 0,
          bytesDelivered: acknowledged,
          totalBytes,
          done: false
        });
      }
      if (control.type === 'saved' && control.transferId === session.fileMeta?.transferId) {
        session.resolveSaved?.();
      }
      if (control.type === 'receive-error') {
        session.rejectSaved?.(new Error(control.message || 'Receiver failed to save the file.'));
      }
    };
    channel.onopen = () => {
      this.emitDebug('p2p sender channel open', { peerId, transferId: session.fileMeta?.transferId });
      this.clearConnectionTimer(session);
      if (session.file && session.fileMeta) {
        void this.streamFile(peerId, session, channel, session.file, session.fileMeta).catch(error => {
          this.emitDebug('p2p stream failed', { peerId, error: errorMessage(error) }, 'error');
          console.error(error);
          this.cleanup(peerId, toError(error));
        });
      }
    };
  }

  private bindReceiverChannel(peerId: string, session: PeerSession, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => this.emitDebug('p2p receiver channel open', { peerId, transferId: session.fileMeta?.transferId });
    channel.onclose = () => {
      this.emitDebug('p2p receiver channel closed', { peerId, transferId: session.fileMeta?.transferId }, 'warn');
      if (this.sessions.get(peerId) === session) {
        this.cleanup(peerId, new Error('Transfer channel closed before completion.'));
      }
    };
    channel.onerror = () => {
      this.emitDebug('p2p receiver channel error', { peerId, transferId: session.fileMeta?.transferId }, 'error');
      if (this.sessions.get(peerId) === session) {
        this.cleanup(peerId, new Error('Transfer channel failed.'));
      }
    };
    session.receiveQueue = Promise.resolve();
    channel.onmessage = event => {
      const data = event.data;
      session.receiveQueue = (session.receiveQueue || Promise.resolve())
        .then(() => this.handleReceiverMessage(peerId, session, channel, data))
        .catch(error => {
          if (this.sessions.get(peerId) !== session) return;
        this.emitDebug('p2p receive failed', { peerId, error: errorMessage(error) }, 'error');
          if (channel.readyState === 'open') {
            this.sendControl(channel, {
              type: 'receive-error',
              message: error instanceof Error ? error.message : 'Unknown receive error'
            });
          }
          this.cleanup(peerId);
        });
    };
  }

  private async handleReceiverMessage(peerId: string, session: PeerSession, channel: RTCDataChannel, data: unknown) {
    if (this.sessions.get(peerId) !== session) return;

    if (typeof data === 'string') {
      const control = JSON.parse(data);
      this.emitDebug('p2p control received', { peerId, type: control.type, transferId: control.transferId });
      if (control.type === 'meta') {
        if (!isMatchingFileMeta(session.fileMeta, control.meta)) {
          throw new Error('WebRTC transfer metadata does not match the accepted file.');
        }
        if (session.receiveState) {
          throw new Error('Received duplicate WebRTC transfer metadata.');
        }
        this.emitDebug('p2p receiver meta', { peerId, transferId: control.meta?.transferId, fileName: control.meta?.name, size: control.meta?.size });
        session.receiveState = await this.createReceiveState(control.meta);
      }
      if (control.type === 'done') {
        if (!session.receiveState) {
          throw new Error('Received transfer completion before transfer metadata.');
        }
        const state = session.receiveState;
        this.emitDebug('p2p receiver done control', { peerId, transferId: state.meta.transferId, bytes: state.bytes });
        await this.finishReceive(peerId, state, channel);
        session.receiveState = undefined;
      }
      return;
    }

    if (!(data instanceof ArrayBuffer)) {
      throw new Error('Unsupported WebRTC transfer payload.');
    }
    if (!session.receiveState) {
      throw new Error('Received file data before transfer metadata.');
    }

    const chunk = new Uint8Array(data);
    if (session.receiveState.bytes + chunk.byteLength > session.receiveState.meta.size) {
      throw new Error('Received more WebRTC data than the declared file size.');
    }
    await this.writeChunk(session.receiveState, chunk);
    session.receiveState.bytes += chunk.byteLength;
    this.sendReceiverProgressAck(channel, session.receiveState);
    this.emitThrottled({
      id: session.receiveState.meta.transferId,
      direction: 'receive',
      fileName: session.receiveState.meta.name,
      bytesTransferred: session.receiveState.bytes,
      totalBytes: session.receiveState.meta.size,
      done: false,
      bytesDelivered: session.receiveState.bytes,
      mode: 'p2p',
      cancellable: true,
      peerId
    });
  }

  private async streamFile(peerId: string, session: PeerSession, channel: RTCDataChannel, file: File, meta: FileMeta) {
    const backpressure = getBackpressureProfile(meta);
    channel.bufferedAmountLowThreshold = backpressure.lowWater;
    this.emitDebug('p2p stream start', {
      peerId,
      transferId: meta.transferId,
      fileName: meta.name,
      size: meta.size,
      chunkSize: CHUNK_SIZE,
      highWater: backpressure.highWater,
      lowWater: backpressure.lowWater
    });
    this.sendControl(channel, { type: 'meta', meta });
    session.bytesQueued = 0;
    session.bytesAcknowledged = 0;
    this.emit({
      id: meta.transferId,
      direction: 'send',
      fileName: meta.name,
      bytesTransferred: 0,
      bytesUploaded: 0,
      bytesDelivered: 0,
      totalBytes: meta.size,
      done: false,
      mode: 'p2p',
      cancellable: true,
      peerId
    });
    let offset = 0;
    let pendingRead = file.size > 0
      ? file.slice(0, Math.min(CHUNK_SIZE, file.size)).arrayBuffer()
      : null;

    while (offset < file.size && channel.readyState === 'open') {
      const buffer = await pendingRead!;
      const end = offset + buffer.byteLength;
      pendingRead = end < file.size
        ? file.slice(end, Math.min(end + CHUNK_SIZE, file.size)).arrayBuffer()
        : null;
      await this.waitForBackpressure(channel, backpressure.highWater, backpressure.lowWater);
      await this.applyManualThrottle(buffer.byteLength);
      this.sendBinary(channel, buffer);
      offset = end;
      session.bytesQueued = offset;
    }

    this.emitDebug('p2p stream bytes sent', { peerId, transferId: meta.transferId, offset, size: file.size });
    const receiverSaved = this.waitForReceiverSaved(session);
    await this.waitForBackpressure(channel, 1, 0);
    this.sendControl(channel, { type: 'done', transferId: meta.transferId });
    await this.waitForBackpressure(channel, 1, 0);
    await receiverSaved;
    this.emitDebug('p2p receiver save ack received', { peerId, transferId: meta.transferId });

    this.emit({
      id: meta.transferId,
      direction: 'send',
      fileName: meta.name,
      bytesTransferred: meta.size,
      bytesUploaded: meta.size,
      bytesDelivered: meta.size,
      totalBytes: meta.size,
      done: true,
      mode: 'p2p',
      cancellable: false,
      peerId
    });
    this.resolveSessionTransfer(session);
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
      return { mode: 'stream', meta, bytes: 0, writer: writable.getWriter(), lastAckAt: 0, lastAckBytes: 0 };
    }

    if (window.isSecureContext) {
      const streamSaver = await import('streamsaver');
      streamSaver.default.mitm = `${location.origin}/streamsaver/mitm.html`;
      this.emitDebug('p2p receive mode: streamsaver', { transferId: meta.transferId });
      return {
        mode: 'stream',
        meta,
        bytes: 0,
        writer: streamSaver.default.createWriteStream(meta.name, { size: meta.size }).getWriter(),
        lastAckAt: 0,
        lastAckBytes: 0
      };
    }

    if (meta.size > HTTP_BLOB_FALLBACK_LIMIT) {
      throw new Error('Large files require HTTPS or localhost for streaming save on this browser.');
    }

    // Plain LAN HTTP cannot use Service Worker/File System Access reliably.
    // Use a bounded Blob fallback so phone/PC transfers still complete.
    this.emitDebug('p2p receive mode: blob fallback', { transferId: meta.transferId });
    return { mode: 'blob', meta, bytes: 0, chunks: [], lastAckAt: 0, lastAckBytes: 0 };
  }

  private async writeChunk(state: ReceiveState, chunk: Uint8Array<ArrayBuffer>) {
    if (state.mode === 'stream') {
      await state.writer.write(chunk);
      return;
    }
    // The DataChannel ArrayBuffer is already owned by this message. Retaining
    // its view avoids a second full payload copy on memory-constrained phones.
    state.chunks.push(chunk.buffer);
  }

  private async finishReceive(peerId: string, state: ReceiveState, channel: RTCDataChannel) {
    let downloadUrl: string | undefined;
    let needsUserSave = false;

    this.emitDebug('p2p finish receive', { peerId, transferId: state.meta.transferId, mode: state.mode, bytes: state.bytes });
    if (state.bytes !== state.meta.size) {
      throw new Error(`Received file size mismatch: ${state.bytes}/${state.meta.size}`);
    }
    if (state.mode === 'stream') {
      await state.writer.close();
    } else {
      const blob = new Blob(state.chunks, { type: state.meta.type });
      downloadUrl = URL.createObjectURL(blob);
      needsUserSave = true;
      state.chunks.length = 0;
    }

    this.sendReceiverProgressAck(channel, state, true);
    this.sendControl(channel, { type: 'saved', transferId: state.meta.transferId });
    this.emit({
      id: state.meta.transferId,
      direction: 'receive',
      fileName: state.meta.name,
      bytesTransferred: state.meta.size,
      totalBytes: state.meta.size,
      bytesDelivered: state.meta.size,
      done: true,
      mode: 'p2p',
      cancellable: false,
      peerId,
      downloadUrl,
      needsUserSave
    });
    window.setTimeout(() => this.cleanup(peerId), 250);
  }


  private sendReceiverProgressAck(channel: RTCDataChannel, state: ReceiveState, force = false) {
    const now = performance.now();
    if (!force && now - state.lastAckAt < RECEIVER_PROGRESS_ACK_INTERVAL_MS) return;
    if (!force && state.bytes <= state.lastAckBytes) return;
    state.lastAckAt = now;
    state.lastAckBytes = state.bytes;
    this.sendControl(channel, {
      type: 'progress-ack',
      transferId: state.meta.transferId,
      bytesReceived: state.bytes
    });
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
  private async waitForBackpressure(channel: RTCDataChannel, highWater: number, lowWater: number) {
    if (channel.bufferedAmount < highWater) return;
    channel.bufferedAmountLowThreshold = lowWater;
    await new Promise<void>(resolve => {
      const done = () => {
        if (channel.bufferedAmount <= lowWater || channel.readyState !== 'open') {
          channel.removeEventListener('bufferedamountlow', done);
          window.clearInterval(timer);
          resolve();
        }
      };
      const timer = window.setInterval(done, BACKPRESSURE_POLL_MS);
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
  private async flushPendingCandidates(peerId: string, session: PeerSession) {
    const pending = session.pendingCandidates.splice(0);
    for (const candidate of pending) {
      if (this.sessions.get(peerId) !== session) return;
      await session.peer.addIceCandidate(candidate);
    }
  }

  private resolveSessionTransfer(session: PeerSession) {
    if (session.transferSettled) return;
    session.transferSettled = true;
    this.clearConnectionTimer(session);
    session.resolveTransfer?.();
    session.resolveTransfer = undefined;
    session.rejectTransfer = undefined;
  }

  private rejectSessionTransfer(session: PeerSession, error: Error) {
    if (session.transferSettled) return;
    session.transferSettled = true;
    this.clearConnectionTimer(session);
    session.rejectTransfer?.(error);
    session.resolveTransfer = undefined;
    session.rejectTransfer = undefined;
  }

  private clearConnectionTimer(session: PeerSession) {
    if (session.connectionTimer === undefined) return;
    window.clearTimeout(session.connectionTimer);
    session.connectionTimer = undefined;
  }

  private cleanup(peerId: string, error = new Error('Transfer connection closed.')) {
    const session = this.sessions.get(peerId);
    if (!session) return;
    this.sessions.delete(peerId);
    this.emitDebug('p2p cleanup', { peerId, transferId: session.fileMeta?.transferId });
    this.rejectSessionTransfer(session, error);
    if (session.receiveState?.mode === 'stream') {
      void session.receiveState.writer.abort(error.message).catch(() => undefined);
    } else if (session.receiveState?.mode === 'blob') {
      session.receiveState.chunks.length = 0;
    }
    session.rejectSaved?.(error);
    session.channel?.close();
    session.peer.close();
  }

  private createCancelledError(reason = 'Transfer cancelled.') {
    const error = new Error(reason);
    error.name = 'TransferCancelledError';
    return error;
  }

  private rememberCancelledTransfer(transferId: string) {
    this.cancelledTransfers.add(transferId);
    const existingTimer = this.cancelledTransferTimers.get(transferId);
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    const timer = window.setTimeout(() => {
      this.cancelledTransfers.delete(transferId);
      this.cancelledTransferTimers.delete(transferId);
    }, 120000);
    this.cancelledTransferTimers.set(transferId, timer);
  }

  private forgetCancelledTransfer(transferId: string) {
    this.cancelledTransfers.delete(transferId);
    const timer = this.cancelledTransferTimers.get(transferId);
    if (timer !== undefined) window.clearTimeout(timer);
    this.cancelledTransferTimers.delete(transferId);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function isTransferCancelledError(error: unknown) {
  return error instanceof Error && error.name === 'TransferCancelledError';
}

function isMatchingFileMeta(expected: FileMeta | undefined, actual: unknown): actual is FileMeta {
  if (!expected || !actual || typeof actual !== 'object') return false;
  const meta = actual as Partial<FileMeta>;
  return meta.transferId === expected.transferId &&
    meta.name === expected.name &&
    meta.size === expected.size &&
    meta.type === expected.type &&
    meta.lastModified === expected.lastModified;
}

function getBackpressureProfile(meta: FileMeta) {
  if (meta.packageType === 'crosslan-zip') {
    return {
      highWater: BATCH_BACKPRESSURE_HIGH_WATER,
      lowWater: BATCH_BACKPRESSURE_LOW_WATER
    };
  }
  return {
    highWater: BACKPRESSURE_HIGH_WATER,
    lowWater: BACKPRESSURE_LOW_WATER
  };
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
