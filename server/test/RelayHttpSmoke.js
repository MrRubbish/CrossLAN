import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const saveDir = await mkdtemp(path.join(os.tmpdir(), 'crosslan-http-smoke-'));
const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const output = [];
const server = spawn(process.execPath, ['src/index.js'], {
  cwd: serverDir,
  env: {
    ...process.env,
    PORT: String(port),
    CROSSLAN_SAVE_DIR: saveDir,
    CROSSLAN_CONFIG: path.join(saveDir, 'config.json'),
    CROSSLAN_RELAY_TOTAL_BUFFER_MB: '8',
    CROSSLAN_RELAY_HIGH_WATER_MB: '4',
    CROSSLAN_RELAY_TARGET_MB: '2',
    CROSSLAN_RELAY_LOW_WATER_MB: '1',
    CROSSLAN_RELAY_COMPLETED_SESSION_GRACE_MS: '25',
    CROSSLAN_RELAY_COMPLETED_TOMBSTONE_TTL_MS: '5000',
    MDNS_SERVICE_NAME: `CrossLAN smoke ${port}`
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

server.stdout.on('data', chunk => output.push(String(chunk)));
server.stderr.on('data', chunk => output.push(String(chunk)));

try {
  await waitForHealth(baseUrl, server, output);
  const relay = await smokeRelay(baseUrl);
  const direct = await smokeDirectSave(baseUrl, saveDir);
  console.log(
    `CrossLAN HTTP smoke passed: relay=${formatBytes(relay.bytes)} @ ${formatRate(relay.bytes, relay.elapsedMs)} ` +
    `(max buffer ${formatBytes(relay.maxBufferedBytes)}), direct=${formatBytes(direct.bytes)} @ ${formatRate(direct.bytes, direct.elapsedMs)}`
  );
} catch (error) {
  const logs = output.join('').trim();
  if (logs) console.error(logs);
  throw error;
} finally {
  server.kill();
  await Promise.race([once(server, 'exit'), delay(3000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  await rm(saveDir, { recursive: true, force: true });
}

async function smokeRelay(baseUrl) {
  const transferId = `smoke-relay-${randomUUID()}`;
  const fileName = 'relay-smoke.bin';
  const totalBytes = 24 * 1024 * 1024;
  const startedAt = performance.now();
  const downloadResponse = await fetch(
    `${baseUrl}/api/transfers/relay/${encodeURIComponent(transferId)}/${encodeURIComponent(fileName)}?size=${totalBytes}`
  );
  assert.equal(downloadResponse.status, 200);

  let observeState = true;
  const observationPromise = observeRelayState(baseUrl, transferId, () => observeState);
  const uploadHash = createHash('sha256');
  const uploadPromise = fetch(`${baseUrl}/api/transfers/relay/${encodeURIComponent(transferId)}`, {
    method: 'POST',
    headers: {
      'content-length': String(totalBytes),
      'x-crosslan-transfer-id': transferId,
      'x-crosslan-file-name': encodeURIComponent(fileName),
      'x-crosslan-file-size': String(totalBytes)
    },
    body: createPatternStream(totalBytes, uploadHash, 17),
    duplex: 'half'
  });
  const downloadPromise = consumeResponse(downloadResponse, 1);
  const [uploadResponse, downloaded] = await Promise.all([uploadPromise, downloadPromise]);
  observeState = false;
  const observation = await observationPromise;
  const uploadResult = await uploadResponse.json();
  const finalStateResponse = await fetch(`${baseUrl}/api/transfers/relay/${encodeURIComponent(transferId)}/state`, {
    cache: 'no-store'
  });
  const finalState = await finalStateResponse.json();

  assert.equal(uploadResponse.status, 200);
  assert.equal(uploadResult.ok, true);
  assert.equal(uploadResult.bytesWritten, totalBytes);
  assert.equal(downloaded.bytes, totalBytes);
  assert.equal(downloaded.hash, uploadHash.digest('hex'));
  assert.ok(observation.maxBufferedBytes <= 4 * 1024 * 1024);
  assert.equal(finalStateResponse.status, 200);
  assert.equal(finalState.downloadComplete, true);
  assert.equal(finalState.bytesUploaded, totalBytes);
  assert.equal(finalState.bytesDownloaded, totalBytes);
  const recoveredState = await waitForRetainedRelayState(baseUrl, transferId);
  assert.equal(recoveredState.completed, true);
  assert.equal(recoveredState.downloadComplete, true);
  assert.equal(recoveredState.bytesUploaded, totalBytes);
  assert.equal(recoveredState.bytesDownloaded, totalBytes);
  await waitForRelayDownloadStatus(baseUrl, transferId, fileName, totalBytes, 410);
  return {
    bytes: totalBytes,
    elapsedMs: performance.now() - startedAt,
    maxBufferedBytes: observation.maxBufferedBytes
  };
}

async function waitForRetainedRelayState(baseUrl, transferId) {
  const url = `${baseUrl}/api/transfers/relay/${encodeURIComponent(transferId)}/state`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(url, { cache: 'no-store' });
    const state = await response.json();
    if (response.ok && state.completed) return state;
    await delay(10);
  }
  throw new Error('Timed out waiting for retained Relay completion state.');
}

async function waitForRelayDownloadStatus(baseUrl, transferId, fileName, totalBytes, expectedStatus) {
  const url = `${baseUrl}/api/transfers/relay/${encodeURIComponent(transferId)}/${encodeURIComponent(fileName)}?size=${totalBytes}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(url);
    await response.body?.cancel();
    if (response.status === expectedStatus) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for Relay download status ${expectedStatus}.`);
}

async function smokeDirectSave(baseUrl, saveDir) {
  const transferId = `smoke-direct-${randomUUID()}`;
  const fileName = 'direct-smoke.bin';
  const totalBytes = 8 * 1024 * 1024;
  const startedAt = performance.now();
  const uploadHash = createHash('sha256');
  const response = await fetch(`${baseUrl}/api/transfers/direct`, {
    method: 'POST',
    headers: {
      'content-length': String(totalBytes),
      'x-crosslan-transfer-id': transferId,
      'x-crosslan-file-name': encodeURIComponent(fileName),
      'x-crosslan-file-size': String(totalBytes)
    },
    body: createPatternStream(totalBytes, uploadHash, 91),
    duplex: 'half'
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.bytesWritten, totalBytes);
  const saved = await readFile(path.join(saveDir, result.fileName));
  assert.equal(saved.length, totalBytes);
  assert.equal(createHash('sha256').update(saved).digest('hex'), uploadHash.digest('hex'));
  return { bytes: totalBytes, elapsedMs: performance.now() - startedAt };
}

function createPatternStream(totalBytes, hash, seed) {
  const chunkBytes = 1024 * 1024;
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= totalBytes) {
        controller.close();
        return;
      }
      const length = Math.min(chunkBytes, totalBytes - offset);
      const chunk = Buffer.allocUnsafe(length);
      chunk.fill((seed + offset / chunkBytes) % 251);
      offset += length;
      hash.update(chunk);
      controller.enqueue(chunk);
    }
  });
}

async function consumeResponse(response, delayMs) {
  assert.ok(response.body);
  const hash = createHash('sha256');
  const reader = response.body.getReader();
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    hash.update(result.value);
    if (delayMs > 0) await delay(delayMs);
  }
  return { bytes, hash: hash.digest('hex') };
}

async function waitForHealth(baseUrl, child, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`CrossLAN server exited during startup.\n${output.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The listener may not be ready yet.
    }
    await delay(50);
  }
  throw new Error('Timed out waiting for CrossLAN HTTP server.');
}

async function observeRelayState(baseUrl, transferId, shouldContinue) {
  let maxBufferedBytes = 0;
  while (shouldContinue()) {
    const response = await fetch(`${baseUrl}/api/transfers/relay/${encodeURIComponent(transferId)}/state`, {
      cache: 'no-store'
    });
    if (response.ok) {
      const state = await response.json();
      maxBufferedBytes = Math.max(maxBufferedBytes, Number(state.bufferedBytes) || 0);
    }
    await delay(10);
  }
  return { maxBufferedBytes };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      listener.close(error => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatRate(bytes, elapsedMs) {
  return `${(bytes / Math.max(elapsedMs, 1) / 1024).toFixed(1)} MB/s`;
}
