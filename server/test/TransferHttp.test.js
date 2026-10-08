import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';

const serverDir = fileURLToPath(new URL('../', import.meta.url));
let child;
let saveDir;
let base;
let output = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  saveDir = await mkdtemp(path.join(os.tmpdir(), 'crosslan-transfer-test-'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), CROSSLAN_SAVE_DIR: saveDir,
      CROSSLAN_CONFIG: path.join(saveDir, 'config.json'), CROSSLAN_LOG_FILE: '', CROSSLAN_LOG_LEVEL: 'error',
      CROSSLAN_DESKTOP_SESSION_TOKEN: 'desktop-test-token',
      CROSSLAN_DESKTOP_MANAGED: '1',
      CROSSLAN_HTTPS_KEY: '', CROSSLAN_HTTPS_CERT: '', CROSSLAN_HTTP_REDIRECT: '0',
      CROSSLAN_RELAY_SESSION_TTL_MS: '500', CROSSLAN_RELAY_TOTAL_BUFFER_MB: '8',
      CROSSLAN_RELAY_HIGH_WATER_MB: '4', CROSSLAN_RELAY_TARGET_MB: '2', CROSSLAN_RELAY_LOW_WATER_MB: '1',
      MDNS_SERVICE_NAME: `CrossLAN regression ${port}`
    }
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(output);
    try { return (await fetch(base + '/api/health')).ok; } catch { return false; }
  });
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  if (saveDir) {
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(path.resolve(saveDir).startsWith(tempRoot));
    await rm(saveDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function upload(mode, id, name, data, { chunked = false, offset = 0, final = true, size = data.length, type = 'application/octet-stream' } = {}) {
  const endpoint = mode === 'direct' && !chunked ? '/api/transfers/direct' : `/api/transfers/${mode}/${id}${chunked ? '/chunk' : ''}`;
  return fetch(base + endpoint, {
    method: 'POST', signal: AbortSignal.timeout(5000), headers: {
      'content-type': type, 'x-crosslan-transfer-id': id,
      'x-crosslan-file-name': name, 'x-crosslan-file-size': String(size),
      'x-crosslan-offset': String(offset), 'x-crosslan-final': final ? '1' : '0'
    }, body: data
  });
}

test('desktop lifecycle endpoints require the launcher token', async () => {
  const health = await (await fetch(base + '/api/health')).json();
  assert.equal(health.desktopManaged, true);

  const invalid = await fetch(base + '/api/desktop/session/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-token' })
  });
  assert.equal(invalid.status, 403);

  for (const action of ['claim', 'close', 'terminate']) {
    const response = await fetch(`${base}/api/desktop/session/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'desktop-test-token' })
    });
    assert.equal(response.status, 200, `${action}: ${await response.text()}`);
  }
});

test('desktop relocation notifies connected pages before restart', async t => {
  const socket = new WebSocket(`${base.replace('http://', 'ws://')}/ws?deviceId=relocation-test`);
  t.after(() => socket.terminate());
  await once(socket, 'open');

  const invalid = await fetch(`${base}/api/desktop/service/relocate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'desktop-test-token', targetUrl: 'file:///not-allowed' })
  });
  assert.equal(invalid.status, 400);

  const relocation = waitForWebSocketMessage(socket, message => message.type === 'service-relocating');
  const response = await fetch(`${base}/api/desktop/service/relocate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: 'desktop-test-token',
      targetUrl: 'http://192.168.31.9:6200/path?ignored=1',
      delayMs: 1500
    })
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.clients, 1);
  assert.equal(result.targetUrl, 'http://192.168.31.9:6200/');

  const message = await relocation;
  assert.equal(message.type, 'service-relocating');
  assert.equal(message.targetUrl, 'http://192.168.31.9:6200/');
  assert.equal(message.delayMs, 1500);
  assert.ok(Number.isFinite(message.issuedAt));
});

function waitForWebSocketMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message.'));
    }, 3000);
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

for (const chunked of [false, true]) {
  test(`direct ${chunked ? 'chunked' : 'continuous'} JSON upload preserves original bytes`, async () => {
    const bytes = Buffer.from(JSON.stringify({ data: 'x'.repeat(100000) }));
    const id = `json-direct-${chunked}`;
    const response = await upload('direct', id, id + '.json', bytes, { chunked, type: 'application/json' });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(await readFile(result.path), bytes);
  });

  test(`relay ${chunked ? 'chunked' : 'continuous'} JSON upload preserves original bytes`, async () => {
    const bytes = Buffer.from(JSON.stringify({ data: 'x'.repeat(100000) }));
    const id = `json-relay-${chunked}`;
    const download = await fetch(`${base}/api/transfers/relay/${id}/file.json?size=${bytes.length}`);
    const received = download.arrayBuffer();
    const response = await upload('relay', id, 'file.json', bytes, { chunked, type: 'application/json' });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(Buffer.from(await received), bytes);
  });
}

test('concurrent same-name uploads keep every file with its original content', async () => {
  const results = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
    const bytes = Buffer.alloc(512 * 1024, index);
    const response = await upload('direct', `parallel-${index}`, 'same-name.bin', bytes, { chunked: index % 2 === 0 });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return { result, bytes };
  }));
  assert.equal(new Set(results.map(({ result }) => result.path)).size, results.length);
  for (const { result, bytes } of results) assert.deepEqual(await readFile(result.path), bytes);
});

for (const chunked of [false, true]) {
  test(`direct cancellation before ${chunked ? 'chunked' : 'continuous'} upload prevents file creation`, async () => {
    const id = `early-cancel-${chunked}`;
    const cancelled = await fetch(`${base}/api/transfers/direct/${id}`, { method: 'DELETE' });
    assert.equal(cancelled.status, 200);
    const response = await upload('direct', id, id + '.bin', Buffer.alloc(1024), { chunked });
    assert.equal(response.status, 410);
    assert.equal((await response.json()).cancelled, true);
    assert.equal((await readdir(saveDir)).includes(id + '.bin'), false);
  });
}

test('cancelling a partially written direct file removes it and rejects stale chunks', async () => {
  const id = 'partial-cancel';
  const first = await upload('direct', id, 'partial.bin', Buffer.alloc(65536), { chunked: true, final: false, size: 131072 });
  const saved = await first.json();
  assert.equal(first.status, 200);
  await (await fetch(`${base}/api/transfers/direct/${id}`, { method: 'DELETE' })).text();
  await assert.rejects(readFile(saved.path), { code: 'ENOENT' });
  for (const offset of [0, 65536]) {
    const response = await upload('direct', id, 'partial.bin', Buffer.alloc(65536), { chunked: true, offset, size: 131072 });
    assert.equal(response.status, 410);
    await response.text();
  }
});

test('an upload with no downloader times out and releases its buffer', async () => {
  const id = 'no-download';
  const pending = upload('relay', id, 'blocked.bin', Buffer.alloc(8 * 1024 * 1024)).then(response => response.text()).catch(() => {});
  const failed = await waitForFailedRelay(id);
  await pending;
  assert.match(failed.message, /waiting for receiver download/);
  assert.equal(failed.totalBufferedBytes, 0);
  const stale = await fetch(`${base}/api/transfers/relay/${id}/blocked.bin?size=8388608`);
  assert.equal(stale.status, 409);
  await stale.text();
});

for (const chunked of [false, true]) {
  test(`cancelling an active ${chunked ? 'chunked' : 'continuous'} direct request closes it and removes its file`, async t => {
    const id = `active-cancel-${chunked}`;
    const filename = id + '.bin';
    const req = request(base + (chunked ? `/api/transfers/direct/${id}/chunk` : '/api/transfers/direct'), {
      method: 'POST', headers: {
        'content-length': String(1024 * 1024), 'x-crosslan-transfer-id': id,
        'x-crosslan-file-name': filename, 'x-crosslan-file-size': String(1024 * 1024),
        'x-crosslan-offset': '0', 'x-crosslan-final': '1'
      }
    });
    t.after(() => req.destroy());
    req.on('error', () => {});
    const closed = new Promise(resolve => req.once('close', resolve));
    req.write(Buffer.alloc(65536));
    await waitFor(async () => (await readdir(saveDir)).includes(filename));
    await (await fetch(`${base}/api/transfers/direct/${id}`, { method: 'DELETE' })).text();
    await closed;
    await waitFor(async () => !(await readdir(saveDir)).includes(filename));
    assert.equal((await fetch(base + '/api/health')).status, 200);
  });
}

test('a download with no sender terminates instead of hanging', async () => {
  const id = 'no-sender';
  const response = await fetch(`${base}/api/transfers/relay/${id}/blocked.bin?size=8388608`);
  const pending = response.arrayBuffer();
  const rejected = assert.rejects(pending);
  const failed = await waitForFailedRelay(id);
  await rejected;
  assert.equal(failed.totalBufferedBytes, 0);
});

test('ongoing relay traffic survives longer than its idle timeout', async () => {
  const id = 'active-relay';
  const bytes = Buffer.alloc(65536, 17);
  const total = bytes.length * 7;
  const response = await fetch(`${base}/api/transfers/relay/${id}/active.bin?size=${total}`);
  const received = response.arrayBuffer();
  const started = Date.now();
  for (let index = 0; index < 7; index += 1) {
    const sent = await upload('relay', id, 'active.bin', bytes, {
      chunked: true, offset: index * bytes.length, size: total, final: index === 6
    });
    assert.equal(sent.status, 200, await sent.text());
    if (index < 6) await delay(150);
  }
  assert.ok(Date.now() - started > 500);
  assert.deepEqual(Buffer.from(await received), Buffer.alloc(total, 17));
});

async function waitForFailedRelay(id) {
  let state;
  await waitFor(async () => {
    const response = await fetch(`${base}/api/transfers/relay/${id}/state`);
    state = await response.json();
    return state.failed;
  });
  return state;
}

async function waitFor(predicate, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for regression condition.\n' + output);
    await delay(30);
  }
}
