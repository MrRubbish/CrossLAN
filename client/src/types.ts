export interface DeviceRecord {
  id: string;
  ip: string;
  fingerprint?: string | null;
  alias?: string | null;
  userAgent?: string | null;
  canDirectSave?: boolean;
  hostUi?: boolean;
  virtual?: boolean;
  lastSeen: number;
}

export interface LocalIdentity extends DeviceRecord {
  serverIps: string[];
}

export type ServerMode = 'node' | 'docker';

export type BandwidthMode = 'unlimited' | 'manual';

export interface BandwidthLimit {
  mode: BandwidthMode;
  bytesPerSecond?: number | null;
}

export type TransferModePreference = 'auto' | 'p2p' | 'relay' | 'direct';
export type TransferRoute = 'p2p' | 'direct' | 'relay';

export interface TransferProgress {
  id: string;
  direction: 'send' | 'receive';
  fileName: string;
  bytesTransferred: number;
  bytesUploaded?: number;
  bytesDelivered?: number;
  totalBytes: number;
  done: boolean;
  cancellable?: boolean;
  cancelled?: boolean;
  failed?: boolean;
  peerId?: string;
  downloadUrl?: string;
  needsUserSave?: boolean;
  requestedMode?: TransferModePreference;
  mode?: TransferRoute;
  statusText?: string;
  speedBytesPerSecond?: number;
  averageBytesPerSecond?: number;
  peakBytesPerSecond?: number;
  startedAt?: number;
  completedAt?: number;
  batchLabel?: string;
}

export type SignalingMessage =
  | { type: 'hello'; device: DeviceRecord; serverIps: string[]; serverMode?: ServerMode }
  | { type: 'device-list'; devices: DeviceRecord[]; mdnsPeers?: DeviceRecord[] }
  | { type: 'service-relocating'; targetUrl: string; delayMs: number; issuedAt: number }
  | { type: 'p2p-transfer-request'; from: string; to?: string; fileMeta: FileMeta }
  | { type: 'p2p-transfer-accept'; from: string; to?: string; transferId: string }
  | { type: 'p2p-transfer-reject'; from: string; to?: string; transferId: string; reason?: string }
  | { type: 'p2p-transfer-cancel'; from: string; to?: string; transferId: string; reason?: string }
  | { type: 'offer'; from: string; to?: string; transferId: string; description: RTCSessionDescriptionInit; fileMeta?: FileMeta }
  | { type: 'answer'; from: string; to?: string; transferId: string; description: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; from: string; to?: string; transferId: string; candidate: RTCIceCandidateInit }
  | { type: 'transfer-accept'; from: string; to?: string; transferId: string }
  | { type: 'transfer-reject'; from: string; to?: string; transferId: string; reason?: string }
  | { type: 'direct-transfer-request'; from: string; to?: string; fileMeta: FileMeta }
  | { type: 'direct-transfer-accept'; from: string; to?: string; transferId: string }
  | { type: 'direct-transfer-reject'; from: string; to?: string; transferId: string; reason?: string }
  | { type: 'batch-transfer-request'; from: string; to?: string; batchId: string; batchTotal: number; fileCount: number; totalBytes: number }
  | { type: 'batch-transfer-accept'; from: string; to?: string; batchId: string }
  | { type: 'batch-transfer-reject'; from: string; to?: string; batchId: string; reason?: string }
  | { type: 'relay-transfer-request'; from: string; to?: string; fileMeta: FileMeta }
  | { type: 'relay-transfer-accept'; from: string; to?: string; transferId: string }
  | { type: 'relay-transfer-reject'; from: string; to?: string; transferId: string; reason?: string }
  | { type: 'relay-transfer-progress'; from: string; to?: string; transferId: string; fileName: string; bytesTransferred: number; bytesUploaded?: number; bytesDownloaded?: number; totalBytes: number }
  | { type: 'relay-transfer-ready'; from: string; to?: string; transferId: string; fileName: string; downloadUrl: string; bytesWritten: number }
  | { type: 'relay-transfer-complete'; transferId: string; fileName: string; bytesUploaded: number; bytesDownloaded: number; totalBytes: number }
  | { type: 'relay-transfer-error'; transferId: string; fileName?: string; message: string; cancelled?: boolean }
  | { type: 'transfer-cancel'; from: string; to?: string; transferId: string; reason?: string }
  | { type: 'direct-transfer-progress'; transferId: string; fileName: string; bytesTransferred: number; totalBytes: number }
  | { type: 'direct-transfer-complete'; transferId: string; fileName: string; bytesTransferred: number; totalBytes: number; path: string }
  | { type: 'direct-transfer-error'; transferId: string; fileName?: string; message: string; cancelled?: boolean }
  | { type: 'peer-unavailable'; to: string }
  | { type: 'network-probe-event'; event: unknown }
  | { type: 'error'; message: string };

export interface FileMeta {
  transferId: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  requestedMode?: TransferModePreference;
  packageType?: 'crosslan-zip';
  packageCount?: number;
  batchId?: string;
  batchIndex?: number;
  batchTotal?: number;
}

export type TransferBatchMeta = Pick<
  FileMeta,
  'batchId' | 'batchIndex' | 'batchTotal' | 'packageType' | 'packageCount'
>;

export interface BatchTransferSummary {
  batchId: string;
  batchTotal: number;
  fileCount: number;
  totalBytes: number;
}
