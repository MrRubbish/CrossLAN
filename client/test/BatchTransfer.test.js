import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const { isBatchTransferMeta } = await loadBatchTransfer();

test('a packaged multi-file selection remains a batch when it has one transfer job', () => {
  assert.equal(isBatchTransferMeta({
    transferId: 'zip-transfer',
    name: 'CrossLAN-batch.zip',
    size: 1024,
    type: 'application/zip',
    lastModified: 1,
    batchId: 'batch-1',
    batchIndex: 0,
    batchTotal: 1
  }), true);
});

test('a normal single-file transfer has no batch approval scope', () => {
  assert.equal(isBatchTransferMeta({
    transferId: 'single-transfer',
    name: 'single.bin',
    size: 1024,
    type: 'application/octet-stream',
    lastModified: 1
  }), false);
});

async function loadBatchTransfer() {
  const sourceUrl = new URL('../src/transfer/BatchTransfer.ts', import.meta.url);
  const source = await readFile(sourceUrl, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext
    },
    fileName: 'BatchTransfer.ts'
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}
