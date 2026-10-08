import type { TransferRoute } from '../types';

export const P2P_MAX_FILE_SIZE = 64 * 1024 * 1024;

export function resolveAutomaticTransferRoute(size: number, canDirectSave: boolean): TransferRoute {
  if (size <= P2P_MAX_FILE_SIZE) return 'p2p';
  return canDirectSave ? 'direct' : 'relay';
}
