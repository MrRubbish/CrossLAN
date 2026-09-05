import type { FileMeta } from '../types';

type SizedFile = { size: number };

export interface BatchPlanLimits {
  maxFileSize: number;
  maxBatchSize: number;
}

export function isBatchTransferMeta(
  meta: FileMeta
): meta is FileMeta & { batchId: string } {
  return typeof meta.batchId === 'string' && meta.batchId.length > 0;
}

export function createBatchTransferPlan<T extends SizedFile>(
  files: T[],
  limits: BatchPlanLimits
): Array<T | T[]> {
  const smallFiles = files.filter(file => file.size <= limits.maxFileSize);
  if (smallFiles.length === 0) return [...files];

  const smallGroups: T[][] = [];
  let currentGroup: T[] = [];
  let currentSize = 0;
  for (const file of smallFiles) {
    if (currentGroup.length > 0 && currentSize + file.size > limits.maxBatchSize) {
      smallGroups.push(currentGroup);
      currentGroup = [];
      currentSize = 0;
    }
    currentGroup.push(file);
    currentSize += file.size;
  }
  if (currentGroup.length > 0) smallGroups.push(currentGroup);

  const plan: Array<T | T[]> = [];
  let insertedSmallGroups = false;
  for (const file of files) {
    if (file.size <= limits.maxFileSize) {
      if (!insertedSmallGroups) {
        for (const group of smallGroups) plan.push(group.length === 1 ? group[0] : group);
        insertedSmallGroups = true;
      }
      continue;
    }
    plan.push(file);
  }
  return plan;
}
