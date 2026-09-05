import type { BandwidthLimit, FileMeta, SignalingMessage, TransferBatchMeta, TransferProgress } from '../types';
import type { SignalingClient } from '../signaling/SignalingClient';

const CHUNK_SIZE = 256 * 1024;
const BACKPRESSURE_HIGH_WATER = 16 * 1024 * 1024;
const BACKPRESSURE_LOW_WATER = 4 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 10;
const PROGRESS_INTERVAL_MS = 150;
const RECEIVER_ACK_TIMEOUT_MS = 30000;
const RECEIVER_PROGRESS_ACK_INTERVAL_MS = 150;
const PEER_CONNECTION_TIMEOUT_MS = 120000;
const DISCONNECTED_GRACE_MS = 10000;
const HTTP_BLOB_FALLBACK_LIMIT = 512 * 1024 * 1024;
const BATCH_BLOB_RECEIVE_LIMIT = 64 * 1024 * 1024;

type ProgressHandler = (progress: TransferProgress) => void;
type IncomingHandler = (meta: FileMeta, from: string) => Promise<boolean> | boolean;
type DebugLevel = 'info' | 'warn' | 'error';
type DebugHandler = (message: string, details?: unknown, level?: DebugLevel) => void;
type QueuedTransfer = { peerId: string; file: File; meta: FileMeta };
type PendingP2pAccept = {
  peerId: string;
  meta: FileMeta;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: number;
};
type PendingP2pRequest = {
  from: string;
  promise: Promise<boolean>;
  cancel: () => void;
};
type PendingReceivePreparation = {
  promise: Promise<ReceiveState>;
  cancel: (error: Error) => void;
};
type IncomingP2pDecision = {
  from: string;
  accepted: boolean;
  timer: number;
};

interface PeerSession {
  peerId: string;
  transferId?: string;
  peer: RTCPeerConnection;
  channel?: RTCDataChannel;
  cancelled?: boolean;
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
  connectionFailureTimer?: number;
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
  private pendingIceByTransfer = new Map<string, RTCIceCandidateInit[]>();
  private progressHandlers = new Set<ProgressHandler>();
  private debugHandlers = new Set<DebugHandler>();
  private incomingHandler: IncomingHandler | null = null;
  private bandwidthLimit: BandwidthLimit = { mode: 'unlimited' };
  private queuedTransfers = new Map<string, QueuedTransfer>();
  private pendingP2pAccepts = new Map<string, PendingP2pAccept>();
  private pendingP2pRequests = new Map<string, PendingP2pRequest>();
  private incomingP2pDecisions = new Map<string, IncomingP2pDecision>();
  private pendingP2pPeers = new Map<string, string>();
  private pendingIncomingOffers = new Map<string, string>();
  private preparedReceiveStates = new Map<string, ReceiveState>();
  private pendingReceivePreparations = new Map<string, PendingReceivePreparation>();
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

  async prepareIncomingTransfer(meta: FileMeta) {
    if (this.cancelledTransfers.has(meta.transferId)) {
      throw this.createCancelledError();
    }
    const existing = this.preparedReceiveStates.get(meta.transferId);
    if (existing) return;
    const pending = this.pendingReceivePreparations.get(meta.transferId);
    if (pending) {
      await pending.promise;
      return;
    }

    let rejectCancelled!: (error: Error) => void;
    let cancelledError: Error | undefined;
    const rawPreparation = this.createReceiveState(meta, true);
    const cancellation = new Promise<ReceiveState>((_, reject) => {
      rejectCancelled = reject;
    });
    const preparation: PendingReceivePreparation = {
      promise: Promise.race([rawPreparation, cancellation]),
      cancel: error => {
        if (cancelledError) return;
        cancelledError = error;
        rejectCancelled(error);
        void rawPreparation.then(
          state => this.abortReceiveState(state, error),
          () => undefined
        );
      }
    };
    this.pendingReceivePreparations.set(meta.transferId, preparation);

    try {
      const state = await preparation.promise;
      if (cancelledError || this.cancelledTransfers.has(meta.transferId)) {
        const error = cancelledError || this.createCancelledError();
        await this.abortReceiveState(state, error);
        throw error;
      }
      this.preparedReceiveStates.set(meta.transferId, state);
      this.emitDebug('p2p receive state prepared', {
        transferId: meta.transferId,
        fileName: meta.name,
        size: meta.size,
        mode: state.mode
      });
    } finally {
      if (this.pendingReceivePreparations.get(meta.transferId) === preparation) {
        this.pendingReceivePreparations.delete(meta.transferId);
      }
    }
  }

  cancelTransfer(transferId: string, reason = 'Transfer cancelled.', rememberUnknown = false) {
    const cancelledError = this.createCancelledError(reason);
    const pendingPreparation = this.pendingReceivePreparations.get(transferId);
    if (pendingPreparation) {
      this.rememberCancelledTransfer(transferId);
      pendingPreparation.cancel(cancelledError);
      this.emitDebug('pending p2p receive preparation cancelled', { transferId }, 'warn');
    }
    const prepared = this.preparedReceiveStates.get(transferId);
    if (prepared) {
      this.preparedReceiveStates.delete(transferId);
      this.rememberCancelledTransfer(transferId);
      void this.abortReceiveState(prepared, cancelledError);
      this.emitDebug('prepared p2p receive state cancelled', { transferId }, 'warn');
    }

    for (const session of this.sessions.values()) {
      const sessionTransferId = session.fileMeta?.transferId || session.receiveState?.meta.transferId;
      if (sessionTransferId !== transferId) continue;
      this.rememberCancelledTransfer(transferId);
      this.emitDebug('p2p transfer cancelled', { peerId: session.peerId, transferId }, 'warn');
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
        peerId: session.peerId,
        statusText: reason
      });
      session.cancelled = true;
      if (!rememberUnknown) {
        this.signaling.send({
          type: 'transfer-cancel',
          to: session.peerId,
          transferId,
          reason
        });
      }
      this.cleanupSession(session, cancelledError);
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

    const pendingP2pPeer = this.pendingP2pPeers.get(transferId);
    if (pendingP2pPeer) {
      const pendingP2p = this.pendingP2pAccepts.get(transferId);
      this.rememberCancelledTransfer(transferId);
      this.emitDebug('pending p2p confirmation cancelled', { peerId: pendingP2pPeer, transferId }, 'warn');
      if (!rememberUnknown) {
        this.signaling.send({
          type: 'transfer-cancel',
          to: pendingP2pPeer,
          transferId,
          reason
        });
      }
      this.rejectP2pAccept(transferId, pendingP2pPeer, this.createCancelledError(reason));
      this.emit({
        id: transferId,
        direction: 'send',
        fileName: pendingP2p?.meta.name || 'Transfer',
        bytesTransferred: 0,
        bytesUploaded: 0,
        bytesDelivered: 0,
        totalBytes: pendingP2p?.meta.size || 0,
        done: true,
        mode: 'p2p',
        cancellable: false,
        cancelled: true,
        peerId: pendingP2pPeer,
        statusText: reason
      });
      return;
    }

    const pendingRequest = this.pendingP2pRequests.get(transferId);
    if (pendingRequest) {
      if (!rememberUnknown) {
        this.signaling.send({
          type: 'transfer-cancel',
          to: pendingRequest.from,
          transferId,
          reason
        });
      }
      pendingRequest.cancel();
      this.rememberCancelledTransfer(transferId);
      this.emitDebug('pending p2p request cancelled', { transferId }, 'warn');
      return;
    }

    const pendingIncomingPeer = this.pendingIncomingOffers.get(transferId);
    if (pendingIncomingPeer) {
      if (!rememberUnknown) {
        this.signaling.send({
          type: 'transfer-cancel',
          to: pendingIncomingPeer,
          transferId,
          reason
        });
      }
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
    this.emitDebug('p2p signal received', {
      type: message.type,
      from: 'from' in message ? message.from : undefined,
      transferId: signalTransferId(message)
    });
    if (message.type === 'p2p-transfer-request') {
      await this.handleP2pTransferRequest(message);
    } else if (message.type === 'p2p-transfer-accept') {
      this.resolveP2pAccept(message.transferId, message.from);
    } else if (message.type === 'p2p-transfer-reject') {
      this.rejectP2pAccept(message.transferId, message.from, new Error(message.reason || 'Rejected by receiver.'));
    } else if (message.type === 'offer') {
      await this.handleOffer(message);
    } else if (message.type === 'answer') {
      this.emitDebug('p2p answer received', { from: message.from, transferId: message.transferId });
      const session = this.getSession(message.from, message.transferId);
      if (!session) return;
      await session.peer.setRemoteDescription(message.description);
      await this.flushPendingCandidates(session);
    } else if (message.type === 'ice-candidate' && message.candidate) {
      this.emitDebug('p2p ice candidate received', { from: message.from, transferId: message.transferId });
      const session = this.getSession(message.from, message.transferId);
      if (!session) {
        const pendingIce = message.transferId ? this.pendingIceByTransfer : this.pendingIceByPeer;
        const pendingKey = message.transferId || message.from;
        const candidates = pendingIce.get(pendingKey) || [];
        candidates.push(message.candidate);
        pendingIce.set(pendingKey, candidates);
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
      const session = this.getSession(message.from, message.transferId);
      if (!session) return;
      this.cleanupSession(session, new Error(message.reason || 'Rejected by receiver.'));
    } else if (message.type === 'peer-unavailable') {
      this.cleanupPeerSessions(message.to, new Error('Peer is unavailable.'));
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

    this.pendingP2pPeers.set(meta.transferId, to);
    try {
      const accepted = this.waitForP2pAccept(meta, to);
      this.signaling.send({
        type: 'p2p-transfer-request',
        to,
        fileMeta: meta
      });
      this.emitDebug('p2p transfer request sent', { to, transferId: meta.transferId, fileName: meta.name, size: meta.size });
      await accepted;
      this.pendingP2pPeers.delete(meta.transferId);

      const session = this.createSession(to, meta.transferId);
      session.file = file;
      session.fileMeta = meta;
      const completion = new Promise<void>((resolve, reject) => {
        session.resolveTransfer = resolve;
        session.rejectTransfer = reject;
      });
      session.connectionTimer = window.setTimeout(() => {
        if (!this.isCurrentSession(session) || session.channel?.readyState === 'open') return;
        this.cleanupSession(session, new Error('Timed out waiting for the peer connection.'));
      }, PEER_CONNECTION_TIMEOUT_MS);

      const channel = session.peer.createDataChannel('file', { ordered: true });
      session.channel = channel;
      this.bindSenderChannel(to, session, channel);

      this.emitDebug('p2p create offer', { to, transferId: meta.transferId });
      const offer = await session.peer.createOffer();
      await session.peer.setLocalDescription(offer);
      this.emitDebug('p2p offer sent', { to, transferId: meta.transferId });
      this.signaling.send({ type: 'offer', to, transferId: meta.transferId, description: offer, fileMeta: meta });
      await completion;
    } catch (error) {
      this.pendingP2pPeers.delete(meta.transferId);
      if (!isTransferCancelledError(error)) {
        const session = this.getSession(to, meta.transferId);
        if (session) {
          this.cleanupSession(session, toError(error));
        }
      }
      throw error;
    }
  }

  private async handleP2pTransferRequest(message: Extract<SignalingMessage, { type: 'p2p-transfer-request' }>) {
    const { transferId } = message.fileMeta;
    this.emitDebug('p2p transfer request received', {
      from: message.from,
      transferId,
      fileName: message.fileMeta.name,
      size: message.fileMeta.size
    });
    if (this.cancelledTransfers.has(transferId)) {
      this.emitDebug('p2p request ignored after cancellation', { from: message.from, transferId }, 'warn');
      return;
    }

    const existingDecision = this.incomingP2pDecisions.get(transferId);
    if (existingDecision && existingDecision.from === message.from) {
      this.sendP2pDecision(message.from, transferId, existingDecision.accepted);
      this.emitDebug('duplicate p2p request answered from decision cache', { from: message.from, transferId, accepted: existingDecision.accepted });
      return;
    }

    const existingRequest = this.pendingP2pRequests.get(transferId);
    if (existingRequest && existingRequest.from === message.from) {
      await existingRequest.promise;
      return;
    }

    let accepted = false;
    const pendingRequest = this.createIncomingDecision(message.fileMeta, message.from);
    try {
      accepted = await pendingRequest.promise;
    } catch (error) {
      this.emitDebug('p2p request confirmation failed', { from: message.from, transferId, error: errorMessage(error) }, 'error');
    } finally {
      if (this.pendingP2pRequests.get(transferId) === pendingRequest) {
        this.pendingP2pRequests.delete(transferId);
      }
    }

    if (this.cancelledTransfers.has(transferId)) {
      this.emitDebug('p2p request rejected after cancellation', { from: message.from, transferId }, 'warn');
      return;
    }

    this.rememberIncomingP2pDecision(transferId, message.from, accepted);
    this.sendP2pDecision(message.from, transferId, accepted);
    this.emitDebug(accepted ? 'p2p request accepted' : 'p2p request rejected', {
      from: message.from,
      transferId,
      fileName: message.fileMeta.name,
      size: message.fileMeta.size
    }, accepted ? 'info' : 'warn');
  }

  private async handleOffer(message: Extract<SignalingMessage, { type: 'offer' }>) {
    if (!message.fileMeta) return;
    const transferId = message.fileMeta.transferId;
    if (this.cancelledTransfers.has(transferId)) {
      this.forgetCancelledTransfer(transferId);
      this.emitDebug('p2p offer ignored after cancellation', { from: message.from, transferId }, 'warn');
      return;
    }
    if (this.getSession(message.from, transferId)) {
      this.emitDebug('duplicate p2p offer ignored for active session', { from: message.from, transferId }, 'warn');
      return;
    }
    this.emitDebug('p2p offer received', { from: message.from, transferId, fileName: message.fileMeta.name, size: message.fileMeta.size });
    this.pendingIncomingOffers.set(transferId, message.from);
    let accepted: boolean;
    try {
      const cachedDecision = this.incomingP2pDecisions.get(transferId);
      if (cachedDecision && cachedDecision.from === message.from) {
        accepted = cachedDecision.accepted;
        this.forgetIncomingP2pDecision(transferId);
      } else {
        const pendingRequest = this.createIncomingDecision(message.fileMeta, message.from);
        accepted = await pendingRequest.promise;
        if (this.pendingP2pRequests.get(transferId) === pendingRequest) {
          this.pendingP2pRequests.delete(transferId);
        }
      }
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

    let session: PeerSession | undefined;
    try {
      session = this.createSession(message.from, transferId);
      session.fileMeta = message.fileMeta;
      session.peer.ondatachannel = event => {
        session!.channel = event.channel;
        this.bindReceiverChannel(message.from, session!, event.channel);
      };
      await session.peer.setRemoteDescription(message.description);
      await this.flushPendingCandidates(session);
      const answer = await session.peer.createAnswer();
      await session.peer.setLocalDescription(answer);
      this.emitDebug('p2p answer sent', { to: message.from, transferId: message.fileMeta.transferId });
      this.signaling.send({ type: 'answer', to: message.from, transferId, description: answer });
    } catch (error) {
      if (session) this.cleanupSession(session, toError(error));
      this.signaling.send({
        type: 'transfer-reject',
        to: message.from,
        transferId,
        reason: errorMessage(error)
      });
      throw error;
    }
  }

  private createSession(peerId: string, transferId?: string) {
    const sessionKey = transferId || `peer:${peerId}`;
    const existing = this.sessions.get(sessionKey);
    if (existing) this.cleanupSession(existing, new Error('A newer connection replaced this transfer session.'));
    this.emitDebug('p2p session creating', { peerId, transferId });
    const peer = new RTCPeerConnection({ iceServers: [] });
    const transferCandidates = transferId ? this.pendingIceByTransfer.get(transferId) || [] : [];
    const peerCandidates = this.pendingIceByPeer.get(peerId) || [];
    const session: PeerSession = {
      peerId,
      transferId,
      peer,
      pendingCandidates: transferId
        ? [...transferCandidates, ...peerCandidates]
        : [...peerCandidates]
    };
    if (transferId) this.pendingIceByTransfer.delete(transferId);
    this.pendingIceByPeer.delete(peerId);
    peer.onicecandidate = event => {
      if (event.candidate) {
        this.emitDebug('p2p ice candidate sent', { peerId, candidateType: event.candidate.type });
        this.signaling.send({
          type: 'ice-candidate',
          to: peerId,
          transferId: session.transferId,
          candidate: event.candidate.toJSON()
        });
      }
    };
    peer.oniceconnectionstatechange = () => {
      this.emitDebug('p2p ice state', { peerId, transferId, iceConnectionState: peer.iceConnectionState });
      if (peer.iceConnectionState === 'failed') {
        this.cleanupSession(session, new Error('Peer ICE connection failed.'));
      }
    };
    peer.onconnectionstatechange = () => {
      this.emitDebug('p2p connection state', { peerId, transferId, connectionState: peer.connectionState });
      if (peer.connectionState === 'disconnected') {
        this.clearConnectionFailureTimer(session);
        session.connectionFailureTimer = window.setTimeout(() => {
          if (this.isCurrentSession(session) && peer.connectionState === 'disconnected') {
            this.cleanupSession(session, new Error('Peer connection disconnected.'));
          }
        }, DISCONNECTED_GRACE_MS);
      } else if (peer.connectionState === 'closed' || peer.connectionState === 'failed') {
        this.cleanupSession(session, new Error(`Peer connection ${peer.connectionState}.`));
      } else {
        this.clearConnectionFailureTimer(session);
      }
    };
    this.sessions.set(sessionKey, session);
    return session;
  }

  private bindSenderChannel(peerId: string, session: PeerSession, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BACKPRESSURE_LOW_WATER;
    channel.onclose = () => {
      this.emitDebug('p2p sender channel closed', { peerId, transferId: session.fileMeta?.transferId }, 'warn');
      if (!session.transferSettled && this.isCurrentSession(session)) {
        this.cleanupSession(session, new Error('Transfer channel closed before completion.'));
      }
    };
    channel.onerror = () => {
      this.emitDebug('p2p sender channel error', { peerId, transferId: session.fileMeta?.transferId }, 'error');
      if (!session.transferSettled && this.isCurrentSession(session)) {
        this.cleanupSession(session, new Error('Transfer channel failed.'));
      }
    };
    channel.onmessage = event => {
      if (typeof event.data !== 'string') return;
      let control: Record<string, any>;
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!isTransferControl(parsed)) {
          throw new Error('Transfer control message must be an object with a type.');
        }
        control = parsed;
      } catch (error) {
        this.emitDebug('p2p sender control parse failed', {
          peerId,
          transferId: session.fileMeta?.transferId,
          error: errorMessage(error)
        }, 'error');
        this.cleanupSession(session, new Error('Invalid transfer control message.'));
        return;
      }
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
          this.cleanupSession(session, toError(error));
        });
      }
    };
  }

  private bindReceiverChannel(peerId: string, session: PeerSession, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => this.emitDebug('p2p receiver channel open', { peerId, transferId: session.fileMeta?.transferId });
    channel.onclose = () => {
      this.emitDebug('p2p receiver channel closed', { peerId, transferId: session.fileMeta?.transferId }, 'warn');
      if (this.isCurrentSession(session)) {
        this.cleanupSession(session, new Error('Transfer channel closed before completion.'));
      }
    };
    channel.onerror = () => {
      this.emitDebug('p2p receiver channel error', { peerId, transferId: session.fileMeta?.transferId }, 'error');
      if (this.isCurrentSession(session)) {
        this.cleanupSession(session, new Error('Transfer channel failed.'));
      }
    };
    session.receiveQueue = Promise.resolve();
    channel.onmessage = event => {
      const data = event.data;
      session.receiveQueue = (session.receiveQueue || Promise.resolve())
        .then(() => this.handleReceiverMessage(peerId, session, channel, data))
        .catch(error => {
          if (!this.isCurrentSession(session)) return;
          this.emitDebug('p2p receive failed', { peerId, error: errorMessage(error) }, 'error');
          if (channel.readyState === 'open') {
            try {
              this.sendControl(channel, {
                type: 'receive-error',
                message: error instanceof Error ? error.message : 'Unknown receive error'
              });
            } catch (sendError) {
              this.emitDebug('p2p receive error response failed', {
                peerId,
                error: errorMessage(sendError)
              }, 'warn');
            }
          }
          this.cleanupSession(session, toError(error));
        });
    };
  }

  private async handleReceiverMessage(peerId: string, session: PeerSession, channel: RTCDataChannel, data: unknown) {
    if (!this.isCurrentSession(session)) return;

    if (typeof data === 'string') {
      const parsed: unknown = JSON.parse(data);
      if (!isTransferControl(parsed)) {
        throw new Error('Transfer control message must be an object with a type.');
      }
      const control = parsed;
      this.emitDebug('p2p control received', { peerId, type: control.type, transferId: control.transferId });
      if (control.type === 'meta') {
        if (!isMatchingFileMeta(session.fileMeta, control.meta)) {
          throw new Error('WebRTC transfer metadata does not match the accepted file.');
        }
        if (session.receiveState) {
          throw new Error('Received duplicate WebRTC transfer metadata.');
        }
        this.emitDebug('p2p receiver meta', { peerId, transferId: control.meta?.transferId, fileName: control.meta?.name, size: control.meta?.size });
        const prepared = this.preparedReceiveStates.get(control.meta.transferId);
        if (prepared) {
          this.preparedReceiveStates.delete(control.meta.transferId);
          session.receiveState = prepared;
          this.emitDebug('p2p receiver using prepared receive state', {
            peerId,
            transferId: control.meta.transferId,
            mode: prepared.mode
          });
        } else {
          session.receiveState = await this.createReceiveState(control.meta);
        }
      }
      if (control.type === 'done') {
        if (!session.receiveState) {
          throw new Error('Received transfer completion before transfer metadata.');
        }
        const state = session.receiveState;
        this.emitDebug('p2p receiver done control', { peerId, transferId: state.meta.transferId, bytes: state.bytes });
        await this.finishReceive(session, state, channel);
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
    const chunkSize = getDataChannelChunkSize(session.peer);
    this.emitDebug('p2p stream start', {
      peerId,
      transferId: meta.transferId,
      fileName: meta.name,
      size: meta.size,
      chunkSize,
      highWater: BACKPRESSURE_HIGH_WATER,
      lowWater: BACKPRESSURE_LOW_WATER
    });
    this.assertSessionSendable(session, channel);
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

    while (offset < file.size) {
      this.assertSessionSendable(session, channel);
      await this.waitForBackpressure(channel, BACKPRESSURE_HIGH_WATER, () => this.sessionAbortError(session, channel));
      const end = Math.min(offset + chunkSize, file.size);
      await this.applyManualThrottle(end - offset, () => this.sessionAbortError(session, channel));
      this.assertSessionSendable(session, channel);
      const buffer = await file.slice(offset, end).arrayBuffer();
      this.assertSessionSendable(session, channel);
      await this.sendBinaryWithRetry(session, channel, buffer);
      offset += buffer.byteLength;
      session.bytesQueued = offset;
    }

    this.assertSessionSendable(session, channel);
    this.emitDebug('p2p stream bytes sent', { peerId, transferId: meta.transferId, offset, size: file.size });
    const receiverSaved = this.waitForReceiverSaved(session);
    await this.waitForBackpressure(channel, 1, () => this.sessionAbortError(session, channel));
    this.assertSessionSendable(session, channel);
    this.sendControl(channel, { type: 'done', transferId: meta.transferId });
    await this.waitForBackpressure(channel, 1, () => this.sessionAbortError(session, channel));
    await receiverSaved;
    this.assertSessionSendable(session, channel);
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
    this.cleanupSession(session);
  }

  private async createReceiveState(meta: FileMeta, fromUserGesture = false): Promise<ReceiveState> {
    this.emitDebug('p2p create receive state', {
      transferId: meta.transferId,
      fileName: meta.name,
      size: meta.size,
      secure: window.isSecureContext,
      hasSavePicker: Boolean(window.showSaveFilePicker),
      fromUserGesture
    });
    // Batch approval is a single user action that happens before individual
    // P2P jobs arrive. Keep bounded batch jobs in memory so later jobs do not
    // reopen the native save picker or require another user gesture.
    if (meta.batchId && meta.size <= BATCH_BLOB_RECEIVE_LIMIT) {
      this.emitDebug('p2p receive mode: batch blob', { transferId: meta.transferId });
      return { mode: 'blob', meta, bytes: 0, chunks: [], lastAckAt: 0, lastAckBytes: 0 };
    }
    if (window.isSecureContext && window.showSaveFilePicker && fromUserGesture) {
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

  private async writeChunk(state: ReceiveState, chunk: Uint8Array) {
    if (state.mode === 'stream') {
      await state.writer.write(chunk);
      return;
    }
    state.chunks.push(chunk.slice());
  }

  private async finishReceive(session: PeerSession, state: ReceiveState, channel: RTCDataChannel) {
    const peerId = session.peerId;
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
    window.setTimeout(() => this.cleanupSession(session), 250);
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

  private async waitForBackpressure(
    channel: RTCDataChannel,
    maxBufferedAmount: number,
    getAbortError?: () => Error | undefined
  ) {
    const initialAbort = getAbortError?.();
    if (initialAbort) throw initialAbort;
    if (channel.readyState !== 'open') {
      throw new Error('Transfer channel closed before the transfer completed.');
    }
    if (channel.bufferedAmount < maxBufferedAmount) return;

    await new Promise<void>((resolve, reject) => {
      let timer: number | undefined;
      let settled = false;

      const cleanup = () => {
        channel.removeEventListener('bufferedamountlow', check);
        channel.removeEventListener('close', onClose);
        channel.removeEventListener('error', onError);
        if (timer !== undefined) window.clearInterval(timer);
        timer = undefined;
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onClose = () => finish(new Error('Transfer channel closed while waiting for send capacity.'));
      const onError = () => finish(new Error('Transfer channel failed while waiting for send capacity.'));
      const check = () => {
        const abortError = getAbortError?.();
        if (abortError) {
          finish(abortError);
          return;
        }
        if (channel.readyState !== 'open') {
          finish(new Error('Transfer channel closed while waiting for send capacity.'));
          return;
        }
        if (channel.bufferedAmount < maxBufferedAmount) finish();
      };

      channel.addEventListener('bufferedamountlow', check);
      channel.addEventListener('close', onClose);
      channel.addEventListener('error', onError);
      timer = window.setInterval(check, BACKPRESSURE_POLL_MS);
      check();
    });
  }

  private assertSessionSendable(session: PeerSession, channel: RTCDataChannel) {
    const error = this.sessionAbortError(session, channel);
    if (error) throw error;
  }

  private sessionAbortError(session: PeerSession, channel: RTCDataChannel) {
    if (session.cancelled || (session.transferId && this.cancelledTransfers.has(session.transferId))) {
      return this.createCancelledError();
    }
    if (!this.isCurrentSession(session)) {
      return new Error('Transfer session is no longer active.');
    }
    if (channel.readyState !== 'open') {
      return new Error('Transfer channel closed before the transfer completed.');
    }
    return undefined;
  }

  private async sendBinaryWithRetry(session: PeerSession, channel: RTCDataChannel, payload: ArrayBuffer) {
    const maxAttempts = 8;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.assertSessionSendable(session, channel);
      try {
        this.sendBinary(channel, payload);
        return;
      } catch (error) {
        if (!isDataChannelQueueFullError(error) || attempt === maxAttempts) throw error;
        this.emitDebug('p2p data channel queue full; waiting before retry', {
          peerId: session.peerId,
          transferId: session.transferId,
          attempt,
          bufferedAmount: channel.bufferedAmount
        }, 'warn');
        await this.waitForBackpressure(channel, BACKPRESSURE_HIGH_WATER, () => this.sessionAbortError(session, channel));
      }
    }
  }

  private getSession(peerId: string, transferId?: string) {
    if (transferId) {
      const session = this.sessions.get(transferId);
      if (session?.peerId === peerId) return session;
      return undefined;
    }
    return [...this.sessions.values()].find(session => session.peerId === peerId && !session.transferId);
  }

  private isCurrentSession(session: PeerSession) {
    return this.sessions.get(this.sessionKey(session)) === session;
  }

  private waitForP2pAccept(meta: FileMeta, peerId: string) {
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingP2pAccepts.delete(meta.transferId);
        this.pendingP2pPeers.delete(meta.transferId);
        reject(new Error('Timed out waiting for receiver confirmation.'));
      }, PEER_CONNECTION_TIMEOUT_MS);
      this.pendingP2pAccepts.set(meta.transferId, { peerId, meta, resolve, reject, timer });
    });
  }

  private resolveP2pAccept(transferId: string, from: string) {
    const pending = this.pendingP2pAccepts.get(transferId);
    if (!pending) {
      this.emitDebug('p2p accept ignored because no sender is waiting', { transferId }, 'warn');
      return;
    }
    if (pending.peerId !== from) {
      this.emitDebug('p2p accept ignored because sender does not match', {
        transferId,
        expectedPeerId: pending.peerId,
        actualPeerId: from
      }, 'warn');
      return;
    }
    window.clearTimeout(pending.timer);
    this.pendingP2pAccepts.delete(transferId);
    this.pendingP2pPeers.delete(transferId);
    this.emitDebug('p2p transfer accepted', { peerId: pending.peerId, transferId });
    pending.resolve();
  }

  private rejectP2pAccept(transferId: string, from: string, error: Error) {
    const pending = this.pendingP2pAccepts.get(transferId);
    if (!pending) return;
    if (pending.peerId !== from) {
      this.emitDebug('p2p reject ignored because sender does not match', {
        transferId,
        expectedPeerId: pending.peerId,
        actualPeerId: from
      }, 'warn');
      return;
    }
    window.clearTimeout(pending.timer);
    this.pendingP2pAccepts.delete(transferId);
    this.pendingP2pPeers.delete(transferId);
    this.emitDebug('p2p transfer rejected', { peerId: pending.peerId, transferId, error: error.message }, 'warn');
    pending.reject(error);
  }

  private sendP2pDecision(to: string, transferId: string, accepted: boolean) {
    this.emitDebug(accepted ? 'p2p accept sent' : 'p2p reject sent', {
      to,
      transferId
    }, accepted ? 'info' : 'warn');
    this.signaling.send({
      type: accepted ? 'p2p-transfer-accept' : 'p2p-transfer-reject',
      to,
      transferId,
      reason: accepted ? undefined : 'Rejected by receiver'
    });
  }

  private rememberIncomingP2pDecision(transferId: string, from: string, accepted: boolean) {
    this.forgetIncomingP2pDecision(transferId);
    const timer = window.setTimeout(() => {
      this.incomingP2pDecisions.delete(transferId);
    }, RECEIVER_ACK_TIMEOUT_MS);
    this.incomingP2pDecisions.set(transferId, { from, accepted, timer });
  }

  private forgetIncomingP2pDecision(transferId: string) {
    const existing = this.incomingP2pDecisions.get(transferId);
    if (!existing) return;
    window.clearTimeout(existing.timer);
    this.incomingP2pDecisions.delete(transferId);
  }

  private async waitForReceiverSaved(session: PeerSession) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => finish(new Error('Timed out waiting for receiver save acknowledgement.')), RECEIVER_ACK_TIMEOUT_MS);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (session.resolveSaved === resolveSaved) session.resolveSaved = undefined;
        if (session.rejectSaved === rejectSaved) session.rejectSaved = undefined;
        if (error) reject(error);
        else resolve();
      };
      const resolveSaved = () => finish();
      const rejectSaved = (error: Error) => finish(error);
      session.resolveSaved = resolveSaved;
      session.rejectSaved = rejectSaved;
    });
  }

  private async applyManualThrottle(nextBytes: number, getAbortError?: () => Error | undefined) {
    if (this.bandwidthLimit.mode !== 'manual' || !this.bandwidthLimit.bytesPerSecond) return;
    const initialAbort = getAbortError?.();
    if (initialAbort) throw initialAbort;
    const now = performance.now();
    if (this.nextThrottleAt <= 0 || this.nextThrottleAt < now - 1000) {
      this.nextThrottleAt = now;
    }
    const waitMs = this.nextThrottleAt - now;
    if (waitMs > 1) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: number | undefined;
        let poll: number | undefined;
        const cleanup = () => {
          if (timer !== undefined) window.clearTimeout(timer);
          if (poll !== undefined) window.clearInterval(poll);
          timer = undefined;
          poll = undefined;
        };
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve();
        };
        timer = window.setTimeout(() => {
          const abortError = getAbortError?.();
          finish(abortError);
        }, waitMs);
        if (!getAbortError) return;
        poll = window.setInterval(() => {
          const abortError = getAbortError();
          if (!abortError) return;
          finish(abortError);
        }, BACKPRESSURE_POLL_MS);
      });
    }
    const abortError = getAbortError?.();
    if (abortError) throw abortError;
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
  private async flushPendingCandidates(session: PeerSession) {
    const pending = session.pendingCandidates.splice(0);
    for (const candidate of pending) {
      if (!this.isCurrentSession(session)) return;
      await session.peer.addIceCandidate(candidate);
    }
  }

  private createIncomingDecision(meta: FileMeta, from: string) {
    const transferId = meta.transferId;
    const existing = this.pendingP2pRequests.get(transferId);
    if (existing && existing.from === from) return existing;

    this.emitDebug('p2p incoming decision requested', {
      from,
      transferId,
      fileName: meta.name,
      size: meta.size
    });
    let cancelDecision: (() => void) | undefined;
    const cancellation = new Promise<boolean>(resolve => {
      cancelDecision = () => resolve(false);
    });
    let decision: Promise<boolean>;
    try {
      decision = Promise.resolve(this.incomingHandler?.(meta, from) ?? true);
    } catch (error) {
      decision = Promise.reject(error);
    }
    const pending: PendingP2pRequest = {
      from,
      promise: Promise.race([decision, cancellation]),
      cancel: () => cancelDecision?.()
    };
    this.pendingP2pRequests.set(transferId, pending);
    return pending;
  }

  private async abortReceiveState(state: ReceiveState, error: Error) {
    if (state.mode === 'stream') {
      await state.writer.abort(error.message).catch(() => undefined);
      return;
    }
    state.chunks.length = 0;
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

  private clearConnectionFailureTimer(session: PeerSession) {
    if (session.connectionFailureTimer === undefined) return;
    window.clearTimeout(session.connectionFailureTimer);
    session.connectionFailureTimer = undefined;
  }

  private sessionKey(session: PeerSession) {
    return session.transferId || `peer:${session.peerId}`;
  }

  private cleanupPeerSessions(peerId: string, error = new Error('Transfer connection closed.')) {
    for (const session of [...this.sessions.values()]) {
      if (session.peerId === peerId) this.cleanupSession(session, error);
    }
  }

  private cleanupSession(session: PeerSession, error = new Error('Transfer connection closed.')) {
    if (!this.isCurrentSession(session)) return;
    this.sessions.delete(this.sessionKey(session));
    this.clearConnectionFailureTimer(session);
    this.emitDebug('p2p cleanup', { peerId: session.peerId, transferId: session.fileMeta?.transferId || session.transferId });
    this.rejectSessionTransfer(session, error);
    if (session.receiveState?.mode === 'stream') {
      void this.abortReceiveState(session.receiveState, error);
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

function signalTransferId(message: SignalingMessage) {
  if ('transferId' in message && message.transferId) return message.transferId;
  if ('fileMeta' in message) return message.fileMeta?.transferId;
  return undefined;
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function getDataChannelChunkSize(peer: RTCPeerConnection) {
  const maxMessageSize = Number(peer.sctp?.maxMessageSize || 0);
  if (!Number.isFinite(maxMessageSize) || maxMessageSize <= 0) return CHUNK_SIZE;
  return Math.max(16 * 1024, Math.min(CHUNK_SIZE, Math.floor(maxMessageSize - 1024)));
}

function isTransferCancelledError(error: unknown) {
  return error instanceof Error && error.name === 'TransferCancelledError';
}

function isDataChannelQueueFullError(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('send queue is full') ||
    message.includes('bufferedamount') ||
    message.includes('buffered amount') ||
    message.includes('operation is not supported') && message.includes('send');
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

function isTransferControl(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string');
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
