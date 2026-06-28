export interface DeviceRecord {
  id: string;
  ip: string;
  fingerprint?: string | null;
  alias?: string | null;
  userAgent?: string | null;
  lastSeen: number;
}

export interface LocalIdentity extends DeviceRecord {
  serverIps: string[];
}

export type BandwidthMode = 'unlimited' | 'manual' | 'auto';

export interface BandwidthLimit {
  mode: BandwidthMode;
  bytesPerSecond?: number | null;
}

export interface TransferProgress {
  id: string;
  direction: 'send' | 'receive';
  fileName: string;
  bytesTransferred: number;
  totalBytes: number;
  done: boolean;
  cancellable?: boolean;
  cancelled?: boolean;
  peerId?: string;
  downloadUrl?: string;
  needsUserSave?: boolean;
  mode?: 'p2p' | 'direct' | 'relay';
  statusText?: string;
  speedBytesPerSecond?: number;
  averageBytesPerSecond?: number;
}

export type SignalingMessage =
  | { type: 'hello'; device: DeviceRecord; serverIps: string[] }
  | { type: 'device-list'; devices: DeviceRecord[]; mdnsPeers?: DeviceRecord[] }
  | { type: 'offer'; from: string; to?: string; description: RTCSessionDescriptionInit; fileMeta?: FileMeta }
  | { type: 'answer'; from: string; to?: string; description: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; from: string; to?: string; candidate: RTCIceCandidateInit }
  | { type: 'transfer-accept'; from: string; to?: string; transferId: string }
  | { type: 'transfer-reject'; from: string; to?: string; transferId: string; reason?: string }
  | { type: 'direct-transfer-request'; from: string; to?: string; fileMeta: FileMeta }
  | { type: 'direct-transfer-accept'; from: string; to?: string; transferId: string }
  | { type: 'direct-transfer-reject'; from: string; to?: string; transferId: string; reason?: string }
  | { type: 'relay-transfer-request'; from: string; to?: string; fileMeta: FileMeta }
  | { type: 'relay-transfer-accept'; from: string; to?: string; transferId: string }
  | { type: 'relay-transfer-reject'; from: string; to?: string; transferId: string; reason?: string }
  | { type: 'relay-transfer-progress'; from: string; to?: string; transferId: string; fileName: string; bytesTransferred: number; totalBytes: number }
  | { type: 'relay-transfer-ready'; from: string; to?: string; transferId: string; fileName: string; downloadUrl: string; bytesWritten: number }
  | { type: 'transfer-cancel'; from: string; to?: string; transferId: string; reason?: string }
  | { type: 'direct-transfer-progress'; transferId: string; fileName: string; bytesTransferred: number; totalBytes: number }
  | { type: 'direct-transfer-complete'; transferId: string; fileName: string; bytesTransferred: number; totalBytes: number; path: string }
  | { type: 'direct-transfer-error'; transferId: string; fileName?: string; message: string }
  | { type: 'peer-unavailable'; to: string }
  | { type: 'network-probe-event'; event: unknown }
  | { type: 'error'; message: string };

export interface FileMeta {
  transferId: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
}
