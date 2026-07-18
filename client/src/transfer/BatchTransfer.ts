import type { FileMeta } from '../types';

export function isBatchTransferMeta(
  meta: FileMeta
): meta is FileMeta & { batchId: string } {
  return typeof meta.batchId === 'string' && meta.batchId.length > 0;
}
