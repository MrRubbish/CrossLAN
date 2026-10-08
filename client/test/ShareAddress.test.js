import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/sharing/ShareAddress.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText;
const { getShareAddressOptions } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

test('share links omit desktop tokens, role flags, fragments, and credentials', () => {
  assert.deepEqual(getShareAddressOptions(
    'http://user:pass@192.168.31.9:6100/page?crosslanDesktopToken=secret&serviceHost=1#old'
  ), ['http://192.168.31.9:6100/']);
});

test('the currently reachable LAN address takes priority over another adapter', () => {
  assert.deepEqual(getShareAddressOptions('http://192.168.31.9:6100/', ['192.168.31.5', '192.168.31.9']), [
    'http://192.168.31.9:6100/', 'http://192.168.31.5:6100/'
  ]);
});

test('loopback pages use advertised LAN addresses with the current port', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.deepEqual(getShareAddressOptions(`http://${host}:6200/`, ['127.0.0.1', '192.168.31.9']), [
      'http://192.168.31.9:6200/'
    ]);
  }
});

test('HTTPS and custom ports are preserved', () => {
  assert.deepEqual(getShareAddressOptions('https://crosslan.local:8443/?secret=1', ['192.168.31.9']), [
    'https://crosslan.local:8443/', 'https://192.168.31.9:8443/'
  ]);
  assert.deepEqual(getShareAddressOptions('https://localhost/', ['192.168.31.9']), ['https://192.168.31.9/']);
});

test('repeated and unavailable addresses are omitted', () => {
  assert.deepEqual(getShareAddressOptions('http://127.0.0.1:6100/', [
    '', '127.1', '0.0.0.0', '169.254.1.1', '224.0.0.1', '255.255.255.255',
    '999.1.1.1', 'localhost', 'test.localhost', '192.168.31.9', ' 192.168.31.9 '
  ]), ['http://192.168.31.9:6100/']);
});

test('advertised values cannot insert a path, credentials, query, or a different scheme', () => {
  assert.deepEqual(getShareAddressOptions('http://localhost:6100/', [
    'user@evil.test', 'http://evil.test', 'evil.test/path', 'evil.test?token=secret', 'evil.test#old'
  ]), []);
});

test('IPv6 LAN addresses are bracketed and loopback/link-local are omitted', () => {
  assert.deepEqual(getShareAddressOptions('http://localhost:6100/', ['::1', 'fe80::1234', 'fd12::1234']), [
    'http://[fd12::1234]:6100/'
  ]);
});

test('no LAN information does not produce a misleading localhost QR link', () => {
  assert.deepEqual(getShareAddressOptions('http://localhost:6100/'), []);
  assert.deepEqual(getShareAddressOptions('file:///app/index.html', ['192.168.31.9']), []);
  assert.deepEqual(getShareAddressOptions('invalid'), []);
});
