import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/transfer/TransferPolicy.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const { P2P_MAX_FILE_SIZE, resolveAutomaticTransferRoute } = await import(
  `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

test('the desktop WebRTC boundary is exactly 64 MiB', () => {
  assert.equal(P2P_MAX_FILE_SIZE, 64 * 1024 * 1024);
});

for (const canDirectSave of [false, true]) {
  for (const size of [0, 32 * 1024 * 1024, 48 * 1024 * 1024, P2P_MAX_FILE_SIZE - 1, P2P_MAX_FILE_SIZE]) {
    test(`${size} bytes use P2P with direct-save capability ${canDirectSave}`, () => {
      assert.equal(resolveAutomaticTransferRoute(size, canDirectSave), 'p2p');
    });
  }
  for (const size of [P2P_MAX_FILE_SIZE + 1, 5 * 1024 ** 3]) {
    test(`${size} bytes retain ${canDirectSave ? 'direct save' : 'Relay'}`, () => {
      assert.equal(resolveAutomaticTransferRoute(size, canDirectSave), canDirectSave ? 'direct' : 'relay');
    });
  }
}
