import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const serverDir = fileURLToPath(new URL('../', import.meta.url));
const browser = 'Mozilla/5.0 (Linux; Android 10) Chrome/135.0.0.0 Mobile Safari/537.36';
const manager = 'AndroidDownloadManager';
const prefix = Buffer.alloc(16 * 1024, 37);
const file = Buffer.alloc(3 * 1024 * 1024, 91);
prefix.copy(file);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let temporaryDir;
let base;
let output = '';

before(async () => {
  temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'crosslan-handoff-test-'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const executable = process.env.CROSSLAN_TEST_SERVER_EXE;
  child = spawn(executable || process.execPath, executable ? [] : [path.join(serverDir, 'src/index.js')], {
    cwd: temporaryDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      CROSSLAN_CLIENT_DIST: path.resolve(serverDir, '../client/dist'),
      CROSSLAN_CONFIG: path.join(temporaryDir, 'config.json'),
      CROSSLAN_SAVE_DIR: temporaryDir,
      CROSSLAN_LOG_FILE: '',
      CROSSLAN_LOG_LEVEL: 'error',
      CROSSLAN_HTTPS_KEY: '',
      CROSSLAN_HTTPS_CERT: '',
      CROSSLAN_HTTP_REDIRECT: '0',
      CROSSLAN_RELAY_SESSION_TTL_MS: '1200',
      CROSSLAN_RELAY_DOWNLOAD_HANDOFF_MS: '300',
      CROSSLAN_RELAY_TOTAL_BUFFER_MB: '8',
      CROSSLAN_RELAY_HIGH_WATER_MB: '4',
      CROSSLAN_RELAY_TARGET_MB: '2',
      CROSSLAN_RELAY_LOW_WATER_MB: '1',
      MDNS_SERVICE_NAME: `CrossLAN handoff test ${port}`
    }
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('error', error => { output += error.message; });
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
  if (temporaryDir) {
    assert.ok(path.resolve(temporaryDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(temporaryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function downloadUrl(id, size = file.length) {
  return `${base}/api/transfers/relay/${id}/handoff.zip?size=${size}`;
}

async function upload(id, bytes, offset = 0, final = true, size = file.length) {
  const response = await fetch(`${base}/api/transfers/relay/${id}/chunk`, {
    method: 'POST', signal: AbortSignal.timeout(5000),
    headers: {
      'x-crosslan-file-name': 'handoff.zip',
      'x-crosslan-file-size': String(size),
      'x-crosslan-offset': String(offset),
      'x-crosslan-final': final ? '1' : '0'
    },
    body: bytes
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
}

function openProbe(t, id, closeOnData = true, size = file.length) {
  let res;
  let settlePrefix;
  const sawPrefix = new Promise(resolve => { settlePrefix = resolve; });
  const req = request(downloadUrl(id, size), { headers: { 'user-agent': browser } }, response => {
    res = response;
    response.on('error', () => {});
    response.once('data', bytes => {
      settlePrefix(Buffer.from(bytes));
      if (closeOnData) response.destroy();
      else response.pause();
    });
  });
  req.on('error', () => {});
  req.end();
  t.after(() => { res?.destroy(); req.destroy(); });
  return { sawPrefix, close: () => { res?.destroy(); req.destroy(); } };
}

async function state(id) {
  return (await fetch(`${base}/api/transfers/relay/${id}/state`)).json();
}

async function assertComplete(id, received, expected = file) {
  assert.equal(received.byteLength, expected.length);
  assert.equal(createHash('sha256').update(Buffer.from(received)).digest('hex'),
    createHash('sha256').update(expected).digest('hex'));
  let final;
  await waitFor(async () => { final = await state(id); return final.downloadComplete; });
  assert.equal(final.bytesUploaded, expected.length);
  assert.equal(final.bytesDownloaded, expected.length);
  assert.equal(final.bufferedBytes, 0);
}

test('server serves bundled frontend from its configured resource directory', async () => {
  const response = await fetch(base + '/');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.equal(html, await readFile(path.resolve(serverDir, '../client/dist/index.html'), 'utf8'));
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  const js = await fetch(new URL(asset, base));
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('HEAD probes do not claim or consume the relay download', async () => {
  const id = 'head-probe';
  await upload(id, prefix, 0, false);
  const head = await fetch(downloadUrl(id), { method: 'HEAD', signal: AbortSignal.timeout(1000) });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(file.length));
  const before = await state(id);
  assert.equal(before.downloadStarted, false);
  assert.equal(before.bytesDownloaded, 0);
  const download = await fetch(downloadUrl(id));
  assert.equal(download.status, 200);
  const received = download.arrayBuffer();
  await upload(id, file.subarray(prefix.length), prefix.length);
  await assertComplete(id, await received);
});

for (const closeOnData of [true, false]) {
  test(`download manager takes over ${closeOnData ? 'after' : 'before'} the browser closes at 16 KB`, async t => {
    const id = `handoff-${closeOnData}`;
    const probe = openProbe(t, id, closeOnData);
    await upload(id, prefix, 0, false);
    assert.deepEqual(await probe.sawPrefix, prefix);
    if (closeOnData) await delay(40);
    const download = await fetch(downloadUrl(id), { headers: { 'user-agent': manager, range: 'bytes=0-' } });
    assert.equal(download.status, 200, JSON.stringify(await state(id)));
    const received = download.arrayBuffer();
    await upload(id, file.subarray(prefix.length), prefix.length);
    await assertComplete(id, await received);
  });
}

test('browser retry with the same user agent preserves the entire file', async t => {
  const id = 'same-ua-retry';
  const probe = openProbe(t, id);
  await upload(id, prefix, 0, false);
  await probe.sawPrefix;
  await delay(40);
  const retry = await fetch(downloadUrl(id), { headers: { 'user-agent': browser } });
  assert.equal(retry.status, 200);
  const received = retry.arrayBuffer();
  await upload(id, file.subarray(prefix.length), prefix.length);
  await assertComplete(id, await received);
});

test('a continuous 24 MB upload stays within the buffer budget while the download manager reconnects', async t => {
  const id = 'continuous-handoff';
  const bytes = Buffer.alloc(24 * 1024 * 1024, 76);
  prefix.copy(bytes);
  const probe = openProbe(t, id, true, bytes.length);
  let sender;
  const sent = new Promise((resolve, reject) => {
    sender = request(`${base}/api/transfers/relay/${id}`, {
      method: 'POST', headers: {
        'content-length': String(bytes.length),
        'x-crosslan-file-name': 'handoff.zip',
        'x-crosslan-file-size': String(bytes.length)
      }
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
      response.on('error', reject);
    });
    sender.on('error', reject);
    sender.write(prefix);
  });
  void sent.catch(() => {});
  t.after(() => sender.destroy());
  await probe.sawPrefix;
  sender.end(bytes.subarray(prefix.length));
  let waiting;
  await waitFor(async () => { waiting = await state(id); return waiting.bufferedBytes >= 2 * 1024 * 1024; });
  await delay(100);
  waiting = await state(id);
  assert.equal(waiting.failed, false);
  assert.equal(waiting.bytesDownloaded, 0);
  assert.ok(waiting.totalBufferedBytes <= 8 * 1024 * 1024);
  assert.ok(waiting.bufferedBytes <= 4 * 1024 * 1024);
  const download = await fetch(downloadUrl(id, bytes.length), { headers: { 'user-agent': manager } });
  assert.equal(download.status, 200);
  const received = await download.arrayBuffer();
  assert.equal(await sent, 200);
  await assertComplete(id, received, bytes);
});

test('multiple header probes can reconnect without counting the prefix repeatedly', async t => {
  const id = 'repeated-handoff';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const probe = openProbe(t, id);
    if (attempt === 0) await upload(id, prefix, 0, false);
    assert.deepEqual(await probe.sawPrefix, prefix);
    await delay(40);
    const waiting = await state(id);
    assert.equal(waiting.failed, false);
    assert.equal(waiting.bytesDownloaded, 0);
    assert.equal(waiting.bufferedBytes, prefix.length);
  }
  const download = await fetch(downloadUrl(id), { headers: { 'user-agent': manager } });
  assert.equal(download.status, 200);
  const received = download.arrayBuffer();
  await upload(id, file.subarray(prefix.length), prefix.length);
  await assertComplete(id, await received);
});

test('closing an established download fails and clears memory instead of replaying incomplete data', async t => {
  const id = 'established-close';
  const probe = openProbe(t, id, false);
  await upload(id, prefix, 0, false);
  await probe.sawPrefix;
  await waitFor(async () => (await state(id)).bytesDownloaded === prefix.length);
  const duplicate = await fetch(downloadUrl(id));
  await duplicate.text();
  assert.equal(duplicate.status, 409);
  probe.close();
  let failed;
  await waitFor(async () => { failed = await state(id); return failed.failed; });
  assert.equal(failed.message, 'Receiver closed download.');
  assert.equal(failed.totalBufferedBytes, 0);
  const retry = await fetch(downloadUrl(id));
  await retry.text();
  assert.equal(retry.status, 409);
});

test('unsupported partial range requests do not consume the live stream', async () => {
  const id = 'invalid-range';
  await upload(id, prefix, 0, false);
  const invalid = await fetch(downloadUrl(id), { headers: { range: 'bytes=16384-' } });
  await invalid.arrayBuffer();
  assert.equal(invalid.status, 416);
  assert.equal((await state(id)).bytesDownloaded, 0);
  const download = await fetch(downloadUrl(id));
  const received = download.arrayBuffer();
  await upload(id, file.subarray(prefix.length), prefix.length);
  await assertComplete(id, await received);
});

test('explicit cancellation during browser handoff releases memory and rejects retries', async t => {
  const id = 'cancel-handoff';
  const probe = openProbe(t, id);
  await upload(id, prefix, 0, false);
  await probe.sawPrefix;
  await delay(40);
  assert.equal((await state(id)).failed, false);
  await (await fetch(`${base}/api/transfers/relay/${id}`, { method: 'DELETE' })).text();
  const cancelled = await state(id);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.totalBufferedBytes, 0);
  const retry = await fetch(downloadUrl(id));
  await retry.text();
  assert.equal(retry.status, 410);
});

test('an abandoned browser handoff expires and releases retained bytes', async t => {
  const id = 'abandoned-handoff';
  const probe = openProbe(t, id);
  await upload(id, prefix, 0, false);
  await probe.sawPrefix;
  await delay(40);
  assert.equal((await state(id)).failed, false);
  let failed;
  await waitFor(async () => { failed = await state(id); return failed.failed; });
  assert.match(failed.message, /Timed out waiting for receiver download/);
  assert.equal(failed.totalBufferedBytes, 0);
});

test('a small browser download completes without filling the prefix buffer', async () => {
  const id = 'small-browser';
  const download = await fetch(downloadUrl(id, prefix.length), { headers: { 'user-agent': browser } });
  const received = download.arrayBuffer();
  await upload(id, prefix, 0, true, prefix.length);
  assert.deepEqual(Buffer.from(await received), prefix);
  await waitFor(async () => (await state(id)).downloadComplete);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 7000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for handoff test.\n' + output);
    await delay(20);
  }
}
