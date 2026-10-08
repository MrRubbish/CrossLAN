import type { SignalingClient } from '../signaling/SignalingClient';
import type {
  BandwidthLimit,
  FileMeta,
  SignalingMessage,
  TransferBatchMeta,
  TransferModePreference,
  TransferProgress
} from '../types';
import type { ReceiveSink } from './ReceiveSink';
import { RtcStatsSampler } from './RtcStatsSampler';
import { P2P_MAX_FILE_SIZE } from './TransferPolicy';

const MAX_CHUNK_SIZE = 64 * 1024;
const READ_BLOCK_SIZE = 1024 * 1024;
const PREFETCH_BLOCKS = 4;
const RECEIVE_CREDIT_WINDOW = 8 * 1024 * 1024;
const RECEIVE_ACK_BYTES = 1024 * 1024;
const BACKPRESSURE_HIGH_WATER = 512 * 1024;
const BACKPRESSURE_LOW_WATER = 128 * 1024;
const BACKPRESSURE_POLL_MS = 10;
const SEND_QUEUE_RETRY_TIMEOUT_MS = 30000;
const PROGRESS_INTERVAL_MS = 150;
const STATS_REFRESH_INTERVAL_MS = 750;
const RECEIVER_ACK_TIMEOUT_MS = 30000;
const RECEIVER_PROGRESS_ACK_INTERVAL_MS = 150;
const PEER_CONNECTION_TIMEOUT_MS = 120000;
const CANCELLATION_TOMBSTONE_MS = 120000;

type ProgressHandler = (progress: TransferProgress) => void;
type IncomingDecision =
  | { accepted: true; sink: ReceiveSink }
  | { accepted: false; reason?: string };
type IncomingHandler = (
  meta: FileMeta,
  from: string,
  context: { requiresLargeSink: boolean }
) => Promise<IncomingDecision> | IncomingDecision;
type DebugLevel = 'info' | 'warn' | 'error';
type DebugHandler = (message: string, details?: unknown, level?: DebugLevel) => void;
type P2PStage = 'preflight' | 'connecting' | 'transferring';
type QueuedTransfer = {
  peerId: string;
  file: File;
  meta: FileMeta;
  requestedMode?: TransferModePreference;
};

interface P2PSendOptions {
  transferId?: string;
  requestedMode?: TransferModePreference;
}

interface PendingOutgoingPreflight {
  peerId: string;
  meta: FileMeta;
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: number;
}

interface PendingIncomingPreflight {
  peerId: string;
  meta: FileMeta;
  sink?: ReceiveSink;
  prepared: boolean;
  cancelled: boolean;
  timer?: number;
}

interface ReceiveState {
  meta: FileMeta;
  bytes: number;
  lastAckAt: number;
  lastAckBytes: number;
}

interface P2PTuningOptions {
  sendBufferBytes?: number;
}

interface TransferPerformance {
  startedAt: number;
  readOperations: number;
  readWaitMs: number;
  creditWaitMs: number;
  sendQueueWaitMs: number;
  sinkWriteWaitMs: number;
  dataMessages: number;
  maxBufferedAmount: number;
}

interface TransferSession {
  transferId: string;
  peerId: string;
  direction: 'send' | 'receive';
  peer: RTCPeerConnection;
  channel?: RTCDataChannel;
  file?: File;
  fileMeta: FileMeta;
  sink?: ReceiveSink;
  receiveState?: ReceiveState;
  receiveQueue?: Promise<void>;
  resolveSaved?: () => void;
  rejectSaved?: (error: Error) => void;
  savedReceived?: boolean;
  savedError?: Error;
  resolveTransfer?: () => void;
  rejectTransfer?: (error: Error) => void;
  transferSettled?: boolean;
  channelOpened?: boolean;
  sinkClosed?: boolean;
  connectionTimer?: number;
  pendingCandidates: RTCIceCandidateInit[];
  bytesQueued: number;
  bytesAcknowledged: number;
  requestedMode?: TransferModePreference;
  stats: RtcStatsSampler;
  statsTimer?: number;
  creditChanged?: () => void;
  pendingReceiveBytes?: number;
  performance?: TransferPerformance;
}

interface PrefetchedBlock {
  start: number;
  end: number;
  read: Promise<ArrayBuffer>;
}

export class TransferEngine {
  private sessions = new Map<string, TransferSession>();
  private outgoingQueues = new Map<string, Promise<void>>();
  private pendingIceByTransfer = new Map<string, RTCIceCandidateInit[]>();
  private pendingOutgoingPreflights = new Map<string, PendingOutgoingPreflight>();
  private pendingIncomingPreflights = new Map<string, PendingIncomingPreflight>();
  private progressHandlers = new Set<ProgressHandler>();
  private debugHandlers = new Set<DebugHandler>();
  private incomingHandler: IncomingHandler | null = null;
  private bandwidthLimit: BandwidthLimit = { mode: 'unlimited' };
  private queuedTransfers = new Map<string, QueuedTransfer>();
  private cancelledTransfers = new Set<string>();
  private cancelledTransferTimers = new Map<string, number>();
  private lastProgressAt = new Map<string, number>();
  private recentFailures = new Map<string, TransferProgress>();
  private nextThrottleAt = 0;

  constructor(
    private signaling: SignalingClient,
    private getSelfId: () => string | null,
    private getIceServers: () => RTCIceServer[] = () => [],
    private profileTransfers = false,
    private tuning: P2PTuningOptions = {}
  ) {}

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

  close() {
    const ids = new Set([
      ...this.sessions.keys(), ...this.pendingOutgoingPreflights.keys(),
      ...this.pendingIncomingPreflights.keys(), ...this.queuedTransfers.keys()
    ]);
    for (const transferId of ids) {
      const peerId = this.sessions.get(transferId)?.peerId ||
        this.pendingOutgoingPreflights.get(transferId)?.peerId ||
        this.pendingIncomingPreflights.get(transferId)?.peerId ||
        this.queuedTransfers.get(transferId)?.peerId;
      if (peerId) this.signaling.send({ type: 'transfer-cancel', to: peerId, transferId });
      this.cancelTransfer(transferId);
    }
    for (const timer of this.cancelledTransferTimers.values()) window.clearTimeout(timer);
    this.cancelledTransferTimers.clear();
    this.pendingIceByTransfer.clear();
  }

  setBandwidthLimit(limit: BandwidthLimit) {
    this.bandwidthLimit = limit;
    if (limit.mode !== 'manual' || !limit.bytesPerSecond) {
      this.nextThrottleAt = 0;
    }
  }

  cancelTransfer(transferId: string, reason = 'Transfer cancelled.', rememberUnknown = false) {
    const error = this.createCancelledError(reason);
    const session = this.sessions.get(transferId);
    if (session) {
      this.rememberCancelledTransfer(transferId);
      this.emitTerminalCancellation(session.fileMeta, session.peerId, session.direction, session);
      this.cleanupSession(transferId, error);
      return;
    }

    const outgoing = this.pendingOutgoingPreflights.get(transferId);
    if (outgoing) {
      this.rememberCancelledTransfer(transferId);
      this.pendingOutgoingPreflights.delete(transferId);
      this.clearPreflightTimer(outgoing);
      outgoing.reject(error);
      this.emitTerminalCancellation(outgoing.meta, outgoing.peerId, 'send');
      return;
    }

    const incoming = this.pendingIncomingPreflights.get(transferId);
    if (incoming) {
      this.rememberCancelledTransfer(transferId);
      incoming.cancelled = true;
      this.pendingIncomingPreflights.delete(transferId);
      if (incoming.timer !== undefined) window.clearTimeout(incoming.timer);
      void incoming.sink?.abort(reason).catch(() => undefined);
      this.emitTerminalCancellation(incoming.meta, incoming.peerId, 'receive');
      return;
    }

    const queued = this.queuedTransfers.get(transferId);
    if (queued) {
      this.rememberCancelledTransfer(transferId);
      this.emitTerminalCancellation(queued.meta, queued.peerId, 'send');
      return;
    }

    if (rememberUnknown && !this.cancelledTransfers.has(transferId)) {
      this.rememberCancelledTransfer(transferId);
      const failure = this.recentFailures.get(transferId);
      if (failure) {
        this.recentFailures.delete(transferId);
        this.emit({ ...failure, cancelled: true, failed: false, statusText: reason, cancellable: false });
      }
    }
  }

  sendFile(
    to: string,
    file: File,
    batchMeta?: TransferBatchMeta,
    options: P2PSendOptions = {}
  ) {
    const transferId = options.transferId || createTransferId();
    const meta: FileMeta = {
      transferId,
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified,
      requestedMode: options.requestedMode,
      ...batchMeta
    };

    const previous = this.outgoingQueues.get(to) || Promise.resolve();
    this.queuedTransfers.set(transferId, {
      peerId: to,
      file,
      meta,
      requestedMode: options.requestedMode
    });
    const transfer = previous.then(() => {
      this.queuedTransfers.delete(transferId);
      if (this.cancelledTransfers.has(transferId)) {
        throw this.createCancelledError();
      }
      return this.sendFileNow(to, file, meta);
    });

    let queueTail: Promise<void>;
    queueTail = transfer
      .then(() => undefined, () => undefined)
      .finally(() => {
        this.queuedTransfers.delete(transferId);
        if (!this.cancelledTransfers.has(transferId)) {
          this.forgetCancelledTransfer(transferId);
        }
        if (this.outgoingQueues.get(to) === queueTail) {
          this.outgoingQueues.delete(to);
        }
      });
    this.outgoingQueues.set(to, queueTail);

    return transfer.catch(error => {
      if (!isTransferCancelledError(error)) {
        const failure = toTransferFailure(error);
        const bytesDelivered = failure.bytesDelivered || 0;
        this.emit({
          id: transferId,
          direction: 'send',
          fileName: file.name,
          bytesTransferred: bytesDelivered,
          bytesUploaded: failure.bytesUploaded || 0,
          bytesDelivered,
          totalBytes: file.size,
          done: true,
          failed: true,
          mode: 'p2p',
          cancellable: false,
          peerId: to,
          requestedMode: options.requestedMode,
          statusText: errorMessage(error)
        });
      }
      throw error;
    });
  }

  async handleSignal(message: SignalingMessage) {
    const transferId = getMessageTransferId(message);
    this.emitDebug('p2p signal received', {
      type: message.type,
      from: 'from' in message ? message.from : undefined,
      transferId
    });

    if (message.type === 'p2p-transfer-request') {
      await this.handleP2PRequest(message);
      return;
    }
    if (message.type === 'p2p-transfer-accept') {
      this.handleP2PAccept(message);
      return;
    }
    if (message.type === 'p2p-transfer-reject') {
      this.handleP2PReject(message);
      return;
    }
    if (message.type === 'p2p-transfer-cancel') {
      this.cancelP2PSetup(
        message.transferId,
        message.reason || 'Peer cancelled P2P setup.'
      );
      return;
    }
    if (message.type === 'offer') {
      await this.handleOffer(message);
      return;
    }
    if (message.type === 'answer') {
      await this.handleAnswer(message);
      return;
    }
    if (message.type === 'ice-candidate' && message.candidate) {
      await this.handleIceCandidate(message);
      return;
    }
    if (message.type === 'transfer-cancel') {
      this.cancelTransfer(message.transferId, message.reason || 'Peer cancelled the transfer.', true);
      return;
    }
    if (message.type === 'peer-unavailable') {
      this.rejectPeerTransfers(message.to, new Error('Peer is unavailable.'));
    }
  }

  private async sendFileNow(to: string, file: File, meta: FileMeta) {
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
      peerId: to,
      requestedMode: meta.requestedMode
    });

    await this.requestP2PApproval(to, meta);
    if (this.cancelledTransfers.has(meta.transferId)) {
      throw this.createCancelledError();
    }

    const session = this.createSession(meta.transferId, to, 'send', meta);
    session.file = file;
    const completion = new Promise<void>((resolve, reject) => {
      session.resolveTransfer = resolve;
      session.rejectTransfer = reject;
    });
    void completion.catch(() => undefined);
    session.connectionTimer = this.setUnrefTimeout(() => {
      if (this.sessions.get(meta.transferId) !== session || session.channel?.readyState === 'open') return;
      this.cleanupSession(
        meta.transferId,
        withP2PStage(new Error('Timed out waiting for the peer connection.'), 'connecting')
      );
    }, PEER_CONNECTION_TIMEOUT_MS);

    try {
      const channel = session.peer.createDataChannel('file', { ordered: true });
      session.channel = channel;
      this.bindSenderChannel(session, channel);

      const offer = await session.peer.createOffer();
      await session.peer.setLocalDescription(offer);
      this.signaling.send({
        type: 'offer',
        to,
        transferId: meta.transferId,
        description: offer
      });
      await completion;
    } catch (error) {
      if (this.sessions.get(meta.transferId) === session) {
        this.cleanupSession(meta.transferId, toError(error));
      }
      throw error;
    }
  }

  private requestP2PApproval(peerId: string, meta: FileMeta) {
    return new Promise<void>((resolve, reject) => {
      const pending: PendingOutgoingPreflight = {
        peerId,
        meta,
        resolve,
        reject
      };
      pending.timer = this.setUnrefTimeout(() => {
        if (this.pendingOutgoingPreflights.get(meta.transferId) !== pending) return;
        this.pendingOutgoingPreflights.delete(meta.transferId);
        const error = withP2PStage(
          new Error('Timed out waiting for receiver confirmation.'),
          'preflight'
        );
        this.rememberCancelledTransfer(meta.transferId);
        this.signaling.send({
          type: 'p2p-transfer-cancel',
          to: peerId,
          transferId: meta.transferId,
          reason: error.message
        });
        reject(error);
      }, PEER_CONNECTION_TIMEOUT_MS);
      this.pendingOutgoingPreflights.set(meta.transferId, pending);
      this.signaling.send({
        type: 'p2p-transfer-request',
        to: peerId,
        fileMeta: meta
      });
    });
  }

  private async handleP2PRequest(message: Extract<SignalingMessage, { type: 'p2p-transfer-request' }>) {
    const transferId = message.fileMeta.transferId;
    if (!Number.isSafeInteger(message.fileMeta.size) || message.fileMeta.size < 0 || !transferId) {
      this.signaling.send({ type: 'p2p-transfer-reject', to: message.from, transferId, reason: 'Invalid file metadata.' });
      return;
    }
    if (this.cancelledTransfers.has(transferId)) return;

    const existing = this.pendingIncomingPreflights.get(transferId);
    if (existing?.prepared) {
      this.signaling.send({
        type: 'p2p-transfer-accept',
        to: message.from,
        transferId
      });
      return;
    }
    if (existing) return;

    const pending: PendingIncomingPreflight = {
      peerId: message.from,
      meta: message.fileMeta,
      prepared: false,
      cancelled: false
    };
    this.pendingIncomingPreflights.set(transferId, pending);

    let decision: IncomingDecision;
    try {
      decision = this.incomingHandler
        ? await this.incomingHandler(message.fileMeta, message.from, {
            requiresLargeSink: message.fileMeta.size > P2P_MAX_FILE_SIZE
          })
        : { accepted: false, reason: 'Receiver is not ready to accept files.' };

      if (!decision.accepted) {
        if (this.pendingIncomingPreflights.get(transferId) === pending) {
          this.pendingIncomingPreflights.delete(transferId);
          this.signaling.send({
            type: 'p2p-transfer-reject',
            to: message.from,
            transferId,
            reason: decision.reason || 'Rejected by receiver.'
          });
        }
        return;
      }

      pending.sink = decision.sink;
      if (pending.cancelled ||
        this.cancelledTransfers.has(transferId) ||
        this.pendingIncomingPreflights.get(transferId) !== pending) {
        await decision.sink.abort('Transfer cancelled before receive preparation completed.');
        return;
      }

      await decision.sink.prepare();
      if (pending.cancelled ||
        this.cancelledTransfers.has(transferId) ||
        this.pendingIncomingPreflights.get(transferId) !== pending) {
        await decision.sink.abort('Transfer cancelled before receive preparation completed.');
        return;
      }

      pending.prepared = true;
      pending.timer = this.setUnrefTimeout(() => {
        if (this.pendingIncomingPreflights.get(transferId) !== pending) return;
        const reason = 'Timed out waiting for the sender offer.';
        this.cancelTransfer(transferId, reason);
        this.signaling.send({ type: 'p2p-transfer-cancel', to: message.from, transferId, reason });
      }, PEER_CONNECTION_TIMEOUT_MS);
      this.emit({
        id: transferId, direction: 'receive', fileName: message.fileMeta.name,
        bytesTransferred: 0, totalBytes: message.fileMeta.size, done: false,
        mode: 'p2p', peerId: message.from, cancellable: true
      });
      this.signaling.send({
        type: 'p2p-transfer-accept',
        to: message.from,
        transferId
      });
    } catch (error) {
      if (pending.sink) {
        await pending.sink.abort(error).catch(() => undefined);
      }
      if (pending.cancelled ||
        this.cancelledTransfers.has(transferId) ||
        this.pendingIncomingPreflights.get(transferId) !== pending) {
        return;
      }
      this.pendingIncomingPreflights.delete(transferId);
      this.signaling.send({
        type: 'p2p-transfer-reject',
        to: message.from,
        transferId,
        reason: errorMessage(error)
      });
    }
  }

  private handleP2PAccept(message: Extract<SignalingMessage, { type: 'p2p-transfer-accept' }>) {
    const pending = this.pendingOutgoingPreflights.get(message.transferId);
    if (!pending || pending.peerId !== message.from) return;
    this.pendingOutgoingPreflights.delete(message.transferId);
    this.clearPreflightTimer(pending);
    pending.resolve();
  }

  private handleP2PReject(message: Extract<SignalingMessage, { type: 'p2p-transfer-reject' }>) {
    const pending = this.pendingOutgoingPreflights.get(message.transferId);
    if (!pending || pending.peerId !== message.from) return;
    this.pendingOutgoingPreflights.delete(message.transferId);
    this.clearPreflightTimer(pending);
    const error = new Error(message.reason || 'Rejected by receiver.');
    error.name = 'P2PRejectedError';
    pending.reject(withP2PStage(error, 'preflight'));
  }

  private async handleOffer(message: Extract<SignalingMessage, { type: 'offer' }>) {
    const pending = this.pendingIncomingPreflights.get(message.transferId);
    if (!pending ||
      !pending.prepared ||
      !pending.sink ||
      pending.peerId !== message.from ||
      this.cancelledTransfers.has(message.transferId)) {
      return;
    }

    this.pendingIncomingPreflights.delete(message.transferId);
    if (pending.timer !== undefined) window.clearTimeout(pending.timer);
    const session = this.createSession(
      message.transferId,
      message.from,
      'receive',
      pending.meta,
      pending.sink
    );
    session.peer.ondatachannel = event => {
      session.channel = event.channel;
      this.bindReceiverChannel(session, event.channel);
    };

    try {
      await session.peer.setRemoteDescription(message.description);
      await this.flushPendingCandidates(session);
      const answer = await session.peer.createAnswer();
      await session.peer.setLocalDescription(answer);
      this.signaling.send({
        type: 'answer',
        to: message.from,
        transferId: message.transferId,
        description: answer
      });
    } catch (error) {
      this.cleanupSession(message.transferId, toError(error));
      throw error;
    }
  }

  private async handleAnswer(message: Extract<SignalingMessage, { type: 'answer' }>) {
    const session = this.sessions.get(message.transferId);
    if (!session || session.peerId !== message.from || session.direction !== 'send') return;
    await session.peer.setRemoteDescription(message.description);
    await this.flushPendingCandidates(session);
  }

  private async handleIceCandidate(message: Extract<SignalingMessage, { type: 'ice-candidate' }>) {
    if (this.cancelledTransfers.has(message.transferId)) return;
    const session = this.sessions.get(message.transferId);
    if (!session) {
      const candidates = this.pendingIceByTransfer.get(message.transferId) || [];
      candidates.push(message.candidate);
      this.pendingIceByTransfer.set(message.transferId, candidates);
      return;
    }
    if (session.peerId !== message.from) return;
    if (!session.peer.remoteDescription) {
      session.pendingCandidates.push(message.candidate);
      return;
    }
    await session.peer.addIceCandidate(message.candidate);
  }

  private createSession(
    transferId: string,
    peerId: string,
    direction: 'send' | 'receive',
    fileMeta: FileMeta,
    sink?: ReceiveSink
  ) {
    if (this.sessions.has(transferId)) {
      this.cleanupSession(transferId, new Error('Duplicate transfer session.'));
    }
    const iceServers = cloneIceServers(this.getIceServers());
    const peer = new RTCPeerConnection({ iceServers });
    const session: TransferSession = {
      transferId,
      peerId,
      direction,
      peer,
      fileMeta,
      sink,
      requestedMode: fileMeta.requestedMode,
      channelOpened: false,
      pendingCandidates: this.pendingIceByTransfer.get(transferId) || [],
      bytesQueued: 0,
      bytesAcknowledged: 0,
      stats: new RtcStatsSampler(),
      performance: this.profileTransfers ? {
        startedAt: performance.now(), readOperations: 0, readWaitMs: 0,
        creditWaitMs: 0, sendQueueWaitMs: 0, sinkWriteWaitMs: 0,
        dataMessages: 0, maxBufferedAmount: 0
      } : undefined
    };
    session.stats.record(0);
    this.pendingIceByTransfer.delete(transferId);

    peer.onicecandidate = event => {
      if (!event.candidate || this.sessions.get(transferId) !== session) return;
      this.signaling.send({
        type: 'ice-candidate',
        to: peerId,
        transferId,
        candidate: event.candidate.toJSON()
      });
    };
    peer.onicecandidateerror = event => {
      this.emitDebug('p2p ice candidate error', {
        peerId,
        transferId,
        url: event.url,
        errorCode: event.errorCode,
        errorText: event.errorText
      }, 'warn');
    };
    peer.onicegatheringstatechange = () => {
      this.emitDebug('p2p ice gathering state', {
        peerId,
        transferId,
        iceGatheringState: peer.iceGatheringState
      });
    };
    peer.oniceconnectionstatechange = () => {
      this.emitDebug('p2p ice state', {
        peerId,
        transferId,
        iceConnectionState: peer.iceConnectionState
      });
    };
    peer.onconnectionstatechange = () => {
      if (this.sessions.get(transferId) !== session) return;
      if (['closed', 'failed', 'disconnected'].includes(peer.connectionState)) {
        if (peer.connectionState === 'failed') {
          void this.emitPeerFailureDiagnostics(session, iceServers);
        }
        this.cleanupSession(transferId, new Error(`Peer connection ${peer.connectionState}.`));
      }
    };
    this.sessions.set(transferId, session);
    if (direction === 'receive') {
      session.connectionTimer = this.setUnrefTimeout(() => {
        if (this.sessions.get(transferId) === session && !session.channelOpened) {
          this.cleanupSession(transferId, new Error('Timed out waiting for the peer connection.'));
        }
      }, PEER_CONNECTION_TIMEOUT_MS);
    }
    return session;
  }

  private async emitPeerFailureDiagnostics(session: TransferSession, iceServers: RTCIceServer[]) {
    const details: Record<string, unknown> = {
      peerId: session.peerId,
      transferId: session.transferId,
      connectionState: session.peer.connectionState,
      iceConnectionState: session.peer.iceConnectionState,
      iceGatheringState: session.peer.iceGatheringState,
      signalingState: session.peer.signalingState,
      iceServerCount: iceServers.length
    };
    if (typeof session.peer.getStats === 'function') {
      try {
        details.selectedCandidatePair = summarizeSelectedCandidatePair(await session.peer.getStats());
      } catch (error) {
        details.statsError = errorMessage(error);
      }
    }
    this.emitDebug('p2p connection failed', details, 'error');
  }

  private bindSenderChannel(session: TransferSession, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.onclose = () => {
      if (!session.transferSettled && this.sessions.get(session.transferId) === session) {
        this.cleanupSession(session.transferId, new Error('Transfer channel closed before completion.'));
      }
    };
    channel.onerror = () => {
      if (!session.transferSettled && this.sessions.get(session.transferId) === session) {
        this.cleanupSession(session.transferId, new Error('Transfer channel failed.'));
      }
    };
    channel.onmessage = event => {
      if (typeof event.data !== 'string') return;
      let control;
      try { control = JSON.parse(event.data); }
      catch { this.cleanupSession(session.transferId, new Error('Invalid transfer control message.')); return; }
      if (!control || typeof control !== 'object') {
        this.cleanupSession(session.transferId, new Error('Invalid transfer control message.'));
        return;
      }
      if (control.type === 'progress-ack' && control.transferId === session.transferId) {
        if (!Number.isSafeInteger(control.bytesReceived) || control.bytesReceived < 0 ||
          control.bytesReceived > session.bytesQueued) {
          this.cleanupSession(session.transferId, new Error('Invalid receiver byte acknowledgement.'));
          return;
        }
        const acknowledged = Math.min(
          session.fileMeta.size,
          Math.max(session.bytesAcknowledged, Number(control.bytesReceived) || 0)
        );
        session.bytesAcknowledged = acknowledged;
        session.creditChanged?.();
        this.emitSessionProgress(session);
      }
      if (control.type === 'saved' && control.transferId === session.transferId) {
        if (session.bytesQueued !== session.fileMeta.size ||
          session.bytesAcknowledged !== session.fileMeta.size) {
          this.cleanupSession(session.transferId, new Error('Receiver completed before all bytes were acknowledged.'));
          return;
        }
        session.savedReceived = true;
        session.resolveSaved?.();
      }
      if (control.type === 'receive-error' &&
        (!control.transferId || control.transferId === session.transferId)) {
        const error = new Error(control.message || 'Receiver failed to save the file.');
        session.savedError = error;
        session.rejectSaved?.(error);
        this.cleanupSession(session.transferId, error);
      }
    };
    channel.onopen = () => {
      session.channelOpened = true;
      this.clearConnectionTimer(session);
      this.startStatsTimer(session);
      if (!session.file) return;
      void this.streamFile(session, channel, session.file).catch(error => {
        if (this.sessions.get(session.transferId) !== session) return;
        this.emitDebug('p2p stream failed', {
          peerId: session.peerId,
          transferId: session.transferId,
          error: errorMessage(error)
        }, 'error');
        this.cleanupSession(session.transferId, toError(error));
      });
    };
  }

  private bindReceiverChannel(session: TransferSession, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.onclose = () => {
      if (!session.transferSettled && this.sessions.get(session.transferId) === session) {
        this.cleanupSession(session.transferId, new Error('Transfer channel closed before completion.'));
      }
    };
    channel.onerror = () => {
      if (!session.transferSettled && this.sessions.get(session.transferId) === session) {
        this.cleanupSession(session.transferId, new Error('Transfer channel failed.'));
      }
    };
    channel.onopen = () => {
      session.channelOpened = true;
      this.clearConnectionTimer(session);
      this.startStatsTimer(session);
    };
    session.receiveQueue = Promise.resolve();
    channel.onmessage = event => {
      const data = event.data;
      if (this.sessions.get(session.transferId) !== session) return;
      const byteLength = data instanceof ArrayBuffer ? data.byteLength : 0;
      session.pendingReceiveBytes = (session.pendingReceiveBytes || 0) + byteLength;
      if (session.pendingReceiveBytes > RECEIVE_CREDIT_WINDOW) {
        this.cleanupSession(session.transferId, new Error('Peer exceeded the receive window.'));
        return;
      }
      session.receiveQueue = (session.receiveQueue || Promise.resolve())
        .then(() => this.handleReceiverMessage(session, channel, data))
        .catch(error => {
          if (this.sessions.get(session.transferId) !== session) return;
          this.emitDebug('p2p receive failed', {
            peerId: session.peerId,
            transferId: session.transferId,
            error: errorMessage(error)
          }, 'error');
          if (channel.readyState === 'open') {
            this.sendControl(channel, {
              type: 'receive-error',
              transferId: session.transferId,
              message: errorMessage(error)
            });
          }
          this.cleanupSession(session.transferId, toError(error));
        })
        .finally(() => { session.pendingReceiveBytes = Math.max(0, (session.pendingReceiveBytes || 0) - byteLength); });
    };
  }

  private async handleReceiverMessage(
    session: TransferSession,
    channel: RTCDataChannel,
    data: unknown
  ) {
    if (this.sessions.get(session.transferId) !== session) return;

    if (typeof data === 'string') {
      const control = JSON.parse(data);
      if (control.type === 'meta') {
        if (!isMatchingFileMeta(session.fileMeta, control.meta)) {
          throw new Error('WebRTC transfer metadata does not match the accepted file.');
        }
        if (session.receiveState) {
          throw new Error('Received duplicate WebRTC transfer metadata.');
        }
        session.receiveState = {
          meta: session.fileMeta,
          bytes: 0,
          lastAckAt: 0,
          lastAckBytes: 0
        };
        if (session.performance) session.performance.startedAt = performance.now();
      }
      if (control.type === 'done') {
        if (!session.receiveState || control.transferId !== session.transferId) {
          throw new Error('Received invalid transfer completion.');
        }
        await this.finishReceive(session, session.receiveState, channel);
        session.receiveState = undefined;
      }
      return;
    }

    if (!(data instanceof ArrayBuffer)) {
      throw new Error('Unsupported WebRTC transfer payload.');
    }
    if (!session.receiveState || !session.sink) {
      throw new Error('Received file data before transfer metadata.');
    }

    const chunk = new Uint8Array(data);
    if (session.receiveState.bytes + chunk.byteLength > session.fileMeta.size) {
      throw new Error('Received more WebRTC data than the declared file size.');
    }
    const writeStartedAt = session.performance ? performance.now() : 0;
    await session.sink.write(chunk, session.receiveState.bytes);
    if (session.performance) {
      session.performance.sinkWriteWaitMs += performance.now() - writeStartedAt;
      session.performance.dataMessages++;
    }
    this.ensureSessionActive(session);
    session.receiveState.bytes += chunk.byteLength;
    this.sendReceiverProgressAck(channel, session.receiveState);
    this.emitSessionProgress(session);
  }

  private async streamFile(session: TransferSession, channel: RTCDataChannel, file: File) {
    if (session.performance) session.performance.startedAt = performance.now();
    const meta = session.fileMeta;
    const backpressure = getBackpressureProfile(this.tuning.sendBufferBytes);
    const chunkSize = getChunkSize(session.peer);
    channel.bufferedAmountLowThreshold = backpressure.lowWater;
    this.sendControl(channel, { type: 'meta', meta });
    session.bytesQueued = 0;
    session.bytesAcknowledged = 0;

    let nextOffset = 0;
    let sentOffset = 0;
    const prefetched: PrefetchedBlock[] = [];
    const fillPrefetch = () => {
      while (
        prefetched.length < PREFETCH_BLOCKS &&
        nextOffset < file.size &&
        this.sessions.get(session.transferId) === session &&
        !this.cancelledTransfers.has(session.transferId)
      ) {
        const start = nextOffset;
        const end = Math.min(start + READ_BLOCK_SIZE, file.size);
        const read = file.slice(start, end).arrayBuffer();
        if (session.performance) session.performance.readOperations++;
        void read.catch(() => undefined);
        prefetched.push({ start, end, read });
        nextOffset = end;
      }
    };

    fillPrefetch();
    while (prefetched.length > 0) {
      this.ensureSessionActive(session);
      const item = prefetched.shift()!;
      const readStartedAt = session.performance ? performance.now() : 0;
      const buffer = await item.read;
      if (session.performance) session.performance.readWaitMs += performance.now() - readStartedAt;
      fillPrefetch();
      if (buffer.byteLength !== item.end - item.start) {
        throw new Error('File read returned an unexpected number of bytes.');
      }
      // File reads are batched; SCTP messages remain small and use views, not copies.
      for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
        this.ensureSessionActive(session);
        const chunk = new Uint8Array(buffer, offset, Math.min(chunkSize, buffer.byteLength - offset));
        await this.waitForReceiveCredit(session, chunk.byteLength);
        await this.applyManualThrottle(chunk.byteLength);
        this.ensureSessionActive(session);
        await this.sendBinaryWithBackpressure(
          session,
          channel,
          chunk,
          backpressure.highWater,
          backpressure.lowWater
        );
        sentOffset = item.start + offset + chunk.byteLength;
        session.bytesQueued = sentOffset;
      }
    }

    if (sentOffset !== file.size) {
      throw new Error(`WebRTC sender stopped before all bytes were queued: ${sentOffset}/${file.size}.`);
    }

    const receiverSaved = this.waitForReceiverSaved(session);
    void receiverSaved.catch(() => undefined);
    await this.waitForBackpressure(channel, 1, 0);
    this.sendControl(channel, { type: 'done', transferId: session.transferId });
    await this.waitForBackpressure(channel, 1, 0);
    await receiverSaved;
    this.ensureSessionActive(session);
    const stats = session.stats.record(meta.size);
    void this.emitPerformanceDiagnostics(session);

    this.emit({
      id: session.transferId,
      direction: 'send',
      fileName: meta.name,
      bytesTransferred: meta.size,
      bytesUploaded: meta.size,
      bytesDelivered: meta.size,
      totalBytes: meta.size,
      done: true,
      mode: 'p2p',
      cancellable: false,
      peerId: session.peerId,
      requestedMode: session.requestedMode,
      speedBytesPerSecond: stats.speedBytesPerSecond,
      averageBytesPerSecond: stats.averageBytesPerSecond,
      peakBytesPerSecond: stats.peakBytesPerSecond
    });
    this.resolveSessionTransfer(session);
    this.cleanupSession(session.transferId);
  }

  private async finishReceive(
    session: TransferSession,
    state: ReceiveState,
    channel: RTCDataChannel
  ) {
    if (!session.sink) {
      throw new Error('Receive sink is unavailable.');
    }
    if (state.bytes !== state.meta.size || session.sink.bytesWritten !== state.meta.size) {
      throw new Error(
        `Received file size mismatch: ${state.bytes}/${session.sink.bytesWritten}/${state.meta.size}`
      );
    }

    const result = await session.sink.close();
    session.sinkClosed = true;
    const stats = session.stats.record(state.meta.size);
    this.sendReceiverProgressAck(channel, state, true);
    this.sendControl(channel, { type: 'saved', transferId: session.transferId });
    session.transferSettled = true;
    void this.emitPerformanceDiagnostics(session);
    this.emit({
      id: session.transferId,
      direction: 'receive',
      fileName: state.meta.name,
      bytesTransferred: state.meta.size,
      bytesDelivered: state.meta.size,
      totalBytes: state.meta.size,
      done: true,
      mode: 'p2p',
      cancellable: false,
      peerId: session.peerId,
      downloadUrl: result.downloadUrl,
      needsUserSave: result.needsUserSave,
      requestedMode: session.requestedMode,
      speedBytesPerSecond: stats.speedBytesPerSecond,
      averageBytesPerSecond: stats.averageBytesPerSecond,
      peakBytesPerSecond: stats.peakBytesPerSecond
    });
    this.setUnrefTimeout(() => this.cleanupSession(session.transferId), 250);
  }

  private sendReceiverProgressAck(channel: RTCDataChannel, state: ReceiveState, force = false) {
    const now = performance.now();
    if (!force && now - state.lastAckAt < RECEIVER_PROGRESS_ACK_INTERVAL_MS &&
      state.bytes - state.lastAckBytes < RECEIVE_ACK_BYTES) return;
    if (!force && state.bytes <= state.lastAckBytes) return;
    state.lastAckAt = now;
    state.lastAckBytes = state.bytes;
    this.sendControl(channel, {
      type: 'progress-ack',
      transferId: state.meta.transferId,
      bytesReceived: state.bytes
    });
  }

  private ensureSessionActive(session: TransferSession) {
    if (this.cancelledTransfers.has(session.transferId)) {
      throw this.createCancelledError();
    }
    if (this.sessions.get(session.transferId) !== session) {
      throw new Error('Transfer session is no longer active.');
    }
  }

  private async waitForReceiveCredit(session: TransferSession, nextBytes: number) {
    this.ensureSessionActive(session);
    if (session.bytesQueued - session.bytesAcknowledged + nextBytes <= RECEIVE_CREDIT_WINDOW) return;
    const waitStartedAt = session.performance ? performance.now() : 0;
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        try {
          this.ensureSessionActive(session);
          if (session.bytesQueued - session.bytesAcknowledged + nextBytes > RECEIVE_CREDIT_WINDOW) return;
          finish();
          resolve();
        } catch (error) {
          finish();
          reject(error);
        }
      };
      const finish = () => {
        window.clearTimeout(timer);
        if (session.creditChanged === check) session.creditChanged = undefined;
      };
      const timer = this.setUnrefTimeout(() => {
        finish();
        reject(new Error('Receiver stopped acknowledging writes.'));
      }, RECEIVER_ACK_TIMEOUT_MS);
      session.creditChanged = check;
      check();
    });
    if (session.performance) session.performance.creditWaitMs += performance.now() - waitStartedAt;
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

  private sendBinary(channel: RTCDataChannel, payload: Uint8Array<ArrayBuffer>) {
    this.ensureChannelOpen(channel);
    channel.send(payload);
  }

  private async sendBinaryWithBackpressure(
    session: TransferSession,
    channel: RTCDataChannel,
    payload: Uint8Array<ArrayBuffer>,
    highWater: number,
    lowWater: number
  ) {
    const maxBufferedBeforeSend = Math.max(0, highWater - payload.byteLength);
    if (channel.bufferedAmount > maxBufferedBeforeSend) {
      const waitStartedAt = session.performance ? performance.now() : 0;
      await this.waitForBufferedAmountAtMost(
        channel,
        Math.min(lowWater, maxBufferedBeforeSend)
      );
      if (session.performance) session.performance.sendQueueWaitMs += performance.now() - waitStartedAt;
    }

    const retryStartedAt = performance.now();
    while (true) {
      this.ensureSessionActive(session);
      try {
        this.sendBinary(channel, payload);
        session.bytesQueued += payload.byteLength;
        if (session.performance) {
          session.performance.dataMessages++;
          session.performance.maxBufferedAmount = Math.max(session.performance.maxBufferedAmount, channel.bufferedAmount);
        }
        return;
      } catch (error) {
        if (!isDataChannelSendQueueFullError(error) ||
          channel.readyState !== 'open' ||
          performance.now() - retryStartedAt >= SEND_QUEUE_RETRY_TIMEOUT_MS) {
          throw error;
        }

        const bufferedAmount = Math.max(0, channel.bufferedAmount);
        const drainTarget = Math.max(
          0,
          Math.min(
            lowWater,
            maxBufferedBeforeSend,
            bufferedAmount - Math.min(bufferedAmount, payload.byteLength)
          )
        );
        const waitStartedAt = session.performance ? performance.now() : 0;
        await this.waitForBufferedAmountAtMost(channel, drainTarget, true);
        if (session.performance) session.performance.sendQueueWaitMs += performance.now() - waitStartedAt;
      }
    }
  }

  private async waitForBackpressure(
    channel: RTCDataChannel,
    highWater: number,
    lowWater: number
  ) {
    if (channel.bufferedAmount < highWater) return;
    await this.waitForBufferedAmountAtMost(channel, lowWater);
  }

  private async waitForBufferedAmountAtMost(
    channel: RTCDataChannel,
    target: number,
    waitAtLeastOnePoll = false
  ) {
    channel.bufferedAmountLowThreshold = target;
    await new Promise<void>(resolve => {
      let canResolve = !waitAtLeastOnePoll;
      const done = () => {
        if (!canResolve) {
          canResolve = true;
          return;
        }
        if (channel.bufferedAmount <= target || channel.readyState !== 'open') {
          channel.removeEventListener('bufferedamountlow', done);
          channel.removeEventListener('close', done);
          window.clearInterval(timer);
          resolve();
        }
      };
      const timer = window.setInterval(done, BACKPRESSURE_POLL_MS);
      channel.addEventListener('bufferedamountlow', done);
      channel.addEventListener('close', done);
      done();
    });
  }

  private async waitForReceiverSaved(session: TransferSession) {
    if (session.savedError) throw session.savedError;
    if (session.savedReceived) return;
    await new Promise<void>((resolve, reject) => {
      const timer = this.setUnrefTimeout(
        () => reject(new Error('Timed out waiting for receiver save acknowledgement.')),
        RECEIVER_ACK_TIMEOUT_MS
      );
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
    this.nextThrottleAt =
      Math.max(performance.now(), this.nextThrottleAt) +
      (nextBytes / this.bandwidthLimit.bytesPerSecond) * 1000;
  }

  private emitSessionProgress(session: TransferSession, force = false) {
    const now = performance.now();
    if (!force && now - (this.lastProgressAt.get(session.transferId) || 0) < PROGRESS_INTERVAL_MS) return;
    const delivered = session.direction === 'send'
      ? session.bytesAcknowledged
      : session.receiveState?.bytes || session.sink?.bytesWritten || 0;
    const stats = session.stats.record(delivered, now);
    this.lastProgressAt.set(session.transferId, now);
    this.emit({
      id: session.transferId,
      direction: session.direction,
      fileName: session.fileMeta.name,
      bytesTransferred: delivered,
      bytesUploaded: session.direction === 'send' ? session.bytesQueued : undefined,
      bytesDelivered: delivered,
      totalBytes: session.fileMeta.size,
      done: false,
      mode: 'p2p',
      cancellable: true,
      peerId: session.peerId,
      requestedMode: session.requestedMode,
      speedBytesPerSecond: stats.speedBytesPerSecond,
      averageBytesPerSecond: stats.averageBytesPerSecond,
      peakBytesPerSecond: stats.peakBytesPerSecond
    });
  }

  private async emitPerformanceDiagnostics(session: TransferSession) {
    if (!session.performance) return;
    const details: Record<string, unknown> = {
      ...session.performance, transferId: session.transferId, direction: session.direction,
      bytesDelivered: session.direction === 'send' ? session.bytesAcknowledged : session.sink?.bytesWritten,
      elapsedMs: performance.now() - session.performance.startedAt,
      sendBufferHighWater: getBackpressureProfile(this.tuning.sendBufferBytes).highWater,
      receiveCreditWindow: RECEIVE_CREDIT_WINDOW,
      chunkSize: getChunkSize(session.peer),
      uploadLimitBytesPerSecond: this.bandwidthLimit.mode === 'manual'
        ? this.bandwidthLimit.bytesPerSecond ?? null : null
    };
    delete details.startedAt;
    try {
      if (typeof session.peer.getStats === 'function') {
        details.selectedCandidatePair = summarizeSelectedCandidatePair(await session.peer.getStats());
      }
    } catch (error) { details.statsError = errorMessage(error); }
    this.emitDebug('p2p performance', details);
  }

  private emit(progress: TransferProgress) {
    if (progress.done) this.lastProgressAt.delete(progress.id);
    if (progress.done && progress.failed && !progress.cancelled) {
      this.recentFailures.set(progress.id, progress);
      this.setUnrefTimeout(() => this.recentFailures.delete(progress.id), CANCELLATION_TOMBSTONE_MS);
      if (this.recentFailures.size > 100) this.recentFailures.delete(this.recentFailures.keys().next().value!);
    }
    for (const handler of this.progressHandlers) handler(progress);
  }

  private startStatsTimer(session: TransferSession) {
    if (session.statsTimer !== undefined) return;
    session.statsTimer = this.setUnrefInterval(() => {
      if (this.sessions.get(session.transferId) !== session || session.transferSettled) return;
      this.emitSessionProgress(session, true);
    }, STATS_REFRESH_INTERVAL_MS);
  }

  private emitTerminalCancellation(
    meta: FileMeta,
    peerId: string,
    direction: 'send' | 'receive',
    session?: TransferSession
  ) {
    const bytesTransferred = direction === 'send'
      ? session?.bytesAcknowledged || 0
      : session?.receiveState?.bytes || session?.sink?.bytesWritten || 0;
    this.emit({
      id: meta.transferId,
      direction,
      fileName: meta.name,
      bytesTransferred,
      bytesUploaded: direction === 'send' ? session?.bytesQueued || 0 : undefined,
      bytesDelivered: bytesTransferred,
      totalBytes: meta.size,
      done: true,
      mode: 'p2p',
      cancellable: false,
      cancelled: true,
      peerId,
      requestedMode: meta.requestedMode,
      statusText: 'Transfer cancelled.'
    });
  }

  private emitDebug(message: string, details?: unknown, level: DebugLevel = 'info') {
    for (const handler of this.debugHandlers) handler(message, details, level);
    if (level === 'error') {
      console.error('[CrossLAN:p2p]', message, details ?? '');
    }
  }

  private async flushPendingCandidates(session: TransferSession) {
    const pending = session.pendingCandidates.splice(0);
    for (const candidate of pending) {
      if (this.sessions.get(session.transferId) !== session) return;
      await session.peer.addIceCandidate(candidate);
    }
  }

  private resolveSessionTransfer(session: TransferSession) {
    if (session.transferSettled) return;
    session.transferSettled = true;
    this.clearConnectionTimer(session);
    session.resolveTransfer?.();
    session.resolveTransfer = undefined;
    session.rejectTransfer = undefined;
  }

  private rejectSessionTransfer(session: TransferSession, error: Error) {
    if (session.transferSettled) return;
    session.transferSettled = true;
    this.clearConnectionTimer(session);
    session.rejectTransfer?.(error);
    session.resolveTransfer = undefined;
    session.rejectTransfer = undefined;
  }

  private clearConnectionTimer(session: TransferSession) {
    if (session.connectionTimer === undefined) return;
    window.clearTimeout(session.connectionTimer);
    session.connectionTimer = undefined;
  }

  private cleanupSession(
    transferId: string,
    error = new Error('Transfer connection closed.')
  ) {
    const session = this.sessions.get(transferId);
    if (!session) return;
    if (
      !session.transferSettled &&
      session.direction === 'send' &&
      !session.channelOpened &&
      !isTransferCancelledError(error) &&
      !this.cancelledTransfers.has(transferId)
    ) {
      this.rememberCancelledTransfer(transferId);
      this.signaling.send({
        type: 'p2p-transfer-cancel',
        to: session.peerId,
        transferId,
        reason: error.message
      });
    }
    const failure = annotateTransferFailure(error, session);
    this.sessions.delete(transferId);
    session.creditChanged?.();
    if (session.statsTimer !== undefined) {
      window.clearInterval(session.statsTimer);
      session.statsTimer = undefined;
    }
    this.rejectSessionTransfer(session, failure);
    if (session.direction === 'receive' && !session.sinkClosed && !isTransferCancelledError(error)) {
      this.emit({
        id: transferId, direction: 'receive', fileName: session.fileMeta.name,
        bytesTransferred: session.sink?.bytesWritten || 0, totalBytes: session.fileMeta.size,
        done: true, failed: true, mode: 'p2p', peerId: session.peerId, cancellable: false,
        statusText: failure.message
      });
    }
    if (!session.sinkClosed) {
      void session.sink?.abort(failure.message).catch(() => undefined);
    }
    session.rejectSaved?.(failure);
    session.channel?.close();
    session.peer.close();
  }

  private rejectPeerTransfers(peerId: string, error: Error) {
    for (const [transferId, pending] of this.pendingOutgoingPreflights.entries()) {
      if (pending.peerId !== peerId) continue;
      this.pendingOutgoingPreflights.delete(transferId);
      this.clearPreflightTimer(pending);
      pending.reject(withP2PStage(error, 'preflight'));
    }
    for (const session of [...this.sessions.values()]) {
      if (session.peerId === peerId) {
        this.cleanupSession(session.transferId, error);
      }
    }
  }

  private clearPreflightTimer(pending: PendingOutgoingPreflight) {
    if (pending.timer === undefined) return;
    window.clearTimeout(pending.timer);
    pending.timer = undefined;
  }

  private cancelP2PSetup(transferId: string, reason: string) {
    this.rememberCancelledTransfer(transferId);
    this.pendingIceByTransfer.delete(transferId);

    const outgoing = this.pendingOutgoingPreflights.get(transferId);
    if (outgoing) {
      this.pendingOutgoingPreflights.delete(transferId);
      this.clearPreflightTimer(outgoing);
      outgoing.reject(withP2PStage(new Error(reason), 'preflight'));
    }

    const incoming = this.pendingIncomingPreflights.get(transferId);
    if (incoming) {
      incoming.cancelled = true;
      this.pendingIncomingPreflights.delete(transferId);
      if (incoming.timer !== undefined) window.clearTimeout(incoming.timer);
      void incoming.sink?.abort(reason).catch(() => undefined);
      this.emitTerminalCancellation(incoming.meta, incoming.peerId, 'receive');
    }

    const session = this.sessions.get(transferId);
    if (session) {
      this.cleanupSession(
        transferId,
        withP2PStage(new Error(reason), session.channelOpened ? 'transferring' : 'connecting')
      );
    }
  }

  private setUnrefTimeout(callback: () => void, delay: number) {
    const timer = window.setTimeout(callback, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
  }

  private setUnrefInterval(callback: () => void, delay: number) {
    const timer = window.setInterval(callback, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    return timer;
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
    const timer = this.setUnrefTimeout(() => {
      this.cancelledTransfers.delete(transferId);
      this.cancelledTransferTimers.delete(transferId);
      this.pendingIceByTransfer.delete(transferId);
    }, CANCELLATION_TOMBSTONE_MS);
    this.cancelledTransferTimers.set(transferId, timer);
  }

  private forgetCancelledTransfer(transferId: string) {
    this.cancelledTransfers.delete(transferId);
    const timer = this.cancelledTransferTimers.get(transferId);
    if (timer !== undefined) window.clearTimeout(timer);
    this.cancelledTransferTimers.delete(transferId);
  }
}

function getMessageTransferId(message: SignalingMessage) {
  if ('transferId' in message) return message.transferId;
  if ('fileMeta' in message) return message.fileMeta?.transferId;
  return undefined;
}

function cloneIceServers(iceServers: RTCIceServer[]) {
  if (!Array.isArray(iceServers)) return [];
  return iceServers.map(server => ({
    ...server,
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls
  }));
}

function summarizeSelectedCandidatePair(stats: RTCStatsReport) {
  const reports = new Map<string, Record<string, unknown>>();
  let selectedPairId = '';
  for (const report of stats.values()) {
    const record = report as unknown as Record<string, unknown>;
    reports.set(String(record.id || ''), record);
    if (record.type === 'transport' && typeof record.selectedCandidatePairId === 'string') {
      selectedPairId = record.selectedCandidatePairId;
    }
  }

  let pair = selectedPairId ? reports.get(selectedPairId) : undefined;
  if (!pair) {
    pair = [...reports.values()].find(record =>
      record.type === 'candidate-pair' &&
      record.state === 'succeeded' &&
      (record.selected === true || record.nominated === true)
    );
  }
  if (!pair) return null;

  return {
    state: pair.state,
    nominated: pair.nominated,
    currentRoundTripTime: pair.currentRoundTripTime,
    availableOutgoingBitrate: pair.availableOutgoingBitrate,
    local: summarizeIceCandidate(reports.get(String(pair.localCandidateId || ''))),
    remote: summarizeIceCandidate(reports.get(String(pair.remoteCandidateId || '')))
  };
}

function summarizeIceCandidate(candidate?: Record<string, unknown>) {
  if (!candidate) return null;
  return {
    candidateType: candidate.candidateType,
    protocol: candidate.protocol,
    networkType: candidate.networkType,
    relayProtocol: candidate.relayProtocol
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isDataChannelSendQueueFullError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes('send queue is full') ||
    (message.includes('buffer') && message.includes('full')) ||
    message.includes('insufficient buffer')
  );
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

type TransferFailure = Error & {
  bytesDelivered?: number;
  bytesUploaded?: number;
  p2pStage?: P2PStage;
};

function toTransferFailure(error: unknown) {
  return toError(error) as TransferFailure;
}

function annotateTransferFailure(error: Error, session: TransferSession) {
  const failure = error as TransferFailure;
  failure.p2pStage ||= session.channelOpened ? 'transferring' : 'connecting';
  const bytesDelivered = session.direction === 'send'
    ? session.bytesAcknowledged
    : session.receiveState?.bytes || session.sink?.bytesWritten || 0;
  failure.bytesDelivered = Math.max(failure.bytesDelivered || 0, bytesDelivered);
  if (session.direction === 'send') {
    failure.bytesUploaded = Math.max(failure.bytesUploaded || 0, session.bytesQueued);
  }
  return failure;
}

function withP2PStage(error: Error, stage: P2PStage) {
  const failure = error as TransferFailure;
  failure.p2pStage = stage;
  return failure;
}

function isTransferCancelledError(error: unknown) {
  return error instanceof Error && error.name === 'TransferCancelledError';
}

function isMatchingFileMeta(expected: FileMeta, actual: unknown): actual is FileMeta {
  if (!actual || typeof actual !== 'object') return false;
  const meta = actual as Partial<FileMeta>;
  return meta.transferId === expected.transferId &&
    meta.name === expected.name &&
    meta.size === expected.size &&
    meta.type === expected.type &&
    meta.lastModified === expected.lastModified;
}

function getChunkSize(peer: RTCPeerConnection) {
  const negotiated = peer.sctp?.maxMessageSize;
  return negotiated && Number.isFinite(negotiated)
    ? Math.max(1, Math.min(MAX_CHUNK_SIZE, negotiated))
    : MAX_CHUNK_SIZE;
}

function getBackpressureProfile(sendBufferBytes?: number) {
  if (typeof sendBufferBytes === 'number' && Number.isSafeInteger(sendBufferBytes) &&
    sendBufferBytes >= 256 * 1024 && sendBufferBytes <= 32 * 1024 * 1024) {
    return { highWater: sendBufferBytes, lowWater: Math.floor(sendBufferBytes / 4) };
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
