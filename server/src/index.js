import express from 'express';
import http, { createServer } from 'node:http';
import https from 'node:https';
import { constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { SignalingHub } from './signaling/SignalingHub.js';
import { MdnsDiscovery } from './discovery/MdnsDiscovery.js';
import { NetworkProber } from './network/NetworkProber.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8080);
const httpsPort = Number(process.env.HTTPS_PORT || 8443);
const httpsKeyPath = process.env.CROSSLAN_HTTPS_KEY || '';
const httpsCertPath = process.env.CROSSLAN_HTTPS_CERT || '';
const shouldRedirectHttp = process.env.CROSSLAN_HTTP_REDIRECT === '1' || process.env.CROSSLAN_HTTP_REDIRECT === 'true';
const defaultSaveDir = process.env.CROSSLAN_SAVE_DIR || path.join(os.homedir(), 'Downloads', 'CrossLAN');
const configPath = process.env.CROSSLAN_CONFIG || path.join(os.homedir(), '.crosslan.json');
const storageSettings = { saveDir: defaultSaveDir };
const DIRECT_UPLOAD_LOG_INTERVAL_MS = 30000;
const RELAY_UPLOAD_LOG_INTERVAL_MS = 5000;
const DIRECT_UPLOAD_WRITE_BUFFER = 8 * 1024 * 1024;
const relayDir = process.env.CROSSLAN_RELAY_DIR || path.join(os.tmpdir(), 'crosslan-relay');
const RELAY_TTL_MS = 2 * 60 * 60 * 1000;
const app = express();
const server = createServer(app);
let activeServer = server;
let redirectServer = null;
const wss = new WebSocketServer({ noServer: true });
const networkProber = new NetworkProber();
const mdns = new MdnsDiscovery({
  port,
  serviceName: process.env.MDNS_SERVICE_NAME || 'CrossLAN'
});

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '32kb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'CrossLAN', now: Date.now() });
});

app.get('/api/storage', async (req, res) => {
  try {
    await ensureWritableDirectory(storageSettings.saveDir);
    res.json({ saveDir: storageSettings.saveDir });
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : 'Storage is not writable.' });
  }
});

app.post('/api/storage', async (req, res) => {
  try {
    const saveDir = String(req.body?.saveDir || '').trim();
    if (!saveDir) {
      res.status(400).json({ ok: false, message: 'saveDir is required.' });
      return;
    }
    if (!path.isAbsolute(saveDir)) {
      res.status(400).json({ ok: false, message: 'Use an absolute path.' });
      return;
    }

    await ensureWritableDirectory(saveDir);
    storageSettings.saveDir = saveDir;
    await saveStorageSettings();
    res.json({ ok: true, saveDir: storageSettings.saveDir });
  } catch (error) {
    res.status(400).json({ ok: false, message: error instanceof Error ? error.message : 'Failed to update storage.' });
  }
});

app.post('/api/transfers/direct', async (req, res) => {
  let targetPath;
  let transferId = '';
  let bytesWritten = 0;
  let lastLogAt = Date.now();
  let lastBroadcastAt = 0;
  const startedAt = Date.now();
  let lastLoggedBytes = 0;

  try {
    await ensureWritableDirectory(storageSettings.saveDir);
    const fileName = sanitizeFileName(decodeFileName(String(req.header('x-crosslan-file-name') || req.query.name || 'download.bin')));
    const expectedSize = Number(req.header('x-crosslan-file-size') || req.query.size || 0);
    transferId = String(req.header('x-crosslan-transfer-id') || req.query.transferId || '');
    targetPath = await getAvailablePath(storageSettings.saveDir, fileName);
    console.log('CrossLAN direct upload started: ' + fileName + ' -> ' + targetPath + ' (' + formatBytes(expectedSize) + ')');

    req.on('data', chunk => {
      bytesWritten += chunk.length;
      const now = Date.now();
      if (now - lastLogAt > DIRECT_UPLOAD_LOG_INTERVAL_MS) {
        const intervalBytes = bytesWritten - lastLoggedBytes;
        const intervalSeconds = (now - lastLogAt) / 1000;
        lastLogAt = now;
        lastLoggedBytes = bytesWritten;
        console.log('CrossLAN direct upload progress: ' + fileName + ' ' + formatBytes(bytesWritten) + ' / ' + formatBytes(expectedSize) + ' @ ' + formatBytes(intervalBytes / intervalSeconds) + '/s avg ' + formatBytes(bytesWritten / ((now - startedAt) / 1000)) + '/s');
      }
      if (now - lastBroadcastAt > 500) {
        lastBroadcastAt = now;
        broadcastDirectProgress({ type: 'direct-transfer-progress', transferId, fileName, bytesTransferred: bytesWritten, totalBytes: expectedSize });
      }
    });

    await pipeline(req, createWriteStream(targetPath, { flags: 'wx', highWaterMark: DIRECT_UPLOAD_WRITE_BUFFER }));

    if (expectedSize > 0 && bytesWritten !== expectedSize) {
      await fs.rm(targetPath, { force: true });
      res.status(400).json({ ok: false, message: `Upload size mismatch: ${bytesWritten}/${expectedSize}` });
      return;
    }

    const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
    console.log('CrossLAN direct upload completed: ' + path.basename(targetPath) + ' (' + formatBytes(bytesWritten) + ', avg ' + formatBytes(bytesWritten / elapsedSeconds) + '/s)');
    broadcastDirectProgress({ type: 'direct-transfer-complete', transferId, fileName: path.basename(targetPath), bytesTransferred: bytesWritten, totalBytes: expectedSize || bytesWritten, path: targetPath });
    res.json({ ok: true, fileName: path.basename(targetPath), path: targetPath, bytesWritten });
  } catch (error) {
    console.error('CrossLAN direct upload failed: ' + (error instanceof Error ? error.message : error));
    broadcastDirectProgress({ type: 'direct-transfer-error', transferId, fileName: targetPath ? path.basename(targetPath) : undefined, message: error instanceof Error ? error.message : 'Upload failed.' });
    if (targetPath) await fs.rm(targetPath, { force: true }).catch(() => {});
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : 'Upload failed.' });
  }
});

app.post('/api/transfers/relay', async (req, res) => {
  let targetPath;
  let bytesWritten = 0;
  let lastLogAt = Date.now();
  let lastLoggedBytes = 0;
  const startedAt = Date.now();
  const transferId = String(req.header('x-crosslan-transfer-id') || req.query.transferId || '');

  try {
    await ensureWritableDirectory(relayDir);
    const relayId = createRelayId();
    const fileName = sanitizeFileName(decodeFileName(String(req.header('x-crosslan-file-name') || req.query.name || 'download.bin')));
    const expectedSize = Number(req.header('x-crosslan-file-size') || req.query.size || 0);
    const dir = path.join(relayDir, relayId);
    await fs.mkdir(dir, { recursive: true });
    targetPath = path.join(dir, fileName);
    console.log('CrossLAN relay upload started: ' + fileName + ' transferId=' + transferId + ' relayId=' + relayId + ' size=' + formatBytes(expectedSize) + ' -> ' + targetPath);

    req.on('data', chunk => {
      bytesWritten += chunk.length;
      const now = Date.now();
      if (now - lastLogAt > RELAY_UPLOAD_LOG_INTERVAL_MS) {
        const intervalBytes = bytesWritten - lastLoggedBytes;
        const intervalSeconds = Math.max((now - lastLogAt) / 1000, 0.001);
        const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
        lastLogAt = now;
        lastLoggedBytes = bytesWritten;
        console.log('CrossLAN relay upload progress: ' + fileName + ' transferId=' + transferId + ' ' + formatBytes(bytesWritten) + ' / ' + formatBytes(expectedSize) + ' @ ' + formatBytes(intervalBytes / intervalSeconds) + '/s avg ' + formatBytes(bytesWritten / elapsedSeconds) + '/s');
      }
    });
    req.on('aborted', () => {
      console.warn('CrossLAN relay upload aborted: ' + fileName + ' transferId=' + transferId + ' written=' + formatBytes(bytesWritten));
    });
    req.on('error', error => {
      console.warn('CrossLAN relay request error: ' + fileName + ' transferId=' + transferId + ' ' + (error instanceof Error ? error.message : error));
    });

    await pipeline(req, createWriteStream(targetPath, { flags: 'wx', highWaterMark: DIRECT_UPLOAD_WRITE_BUFFER }));

    if (expectedSize > 0 && bytesWritten !== expectedSize) {
      await fs.rm(dir, { recursive: true, force: true });
      console.warn('CrossLAN relay upload size mismatch: ' + fileName + ' transferId=' + transferId + ' ' + bytesWritten + '/' + expectedSize);
      res.status(400).json({ ok: false, message: `Upload size mismatch: ${bytesWritten}/${expectedSize}` });
      return;
    }

    const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
    const downloadUrl = `/api/transfers/relay/${encodeURIComponent(relayId)}/${encodeURIComponent(fileName)}`;
    console.log('CrossLAN relay upload completed: ' + fileName + ' transferId=' + transferId + ' relayId=' + relayId + ' bytes=' + formatBytes(bytesWritten) + ' avg=' + formatBytes(bytesWritten / elapsedSeconds) + '/s url=' + downloadUrl);

    const timer = setTimeout(() => {
      console.log('CrossLAN relay cleanup expired: relayId=' + relayId + ' file=' + fileName);
      void fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }, RELAY_TTL_MS);
    timer.unref?.();

    res.json({
      ok: true,
      relayId,
      fileName,
      bytesWritten,
      downloadUrl
    });
  } catch (error) {
    console.error('CrossLAN relay upload failed: transferId=' + transferId + ' path=' + (targetPath || 'unknown') + ' ' + (error instanceof Error ? error.message : error));
    if (targetPath) await fs.rm(path.dirname(targetPath), { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : 'Relay upload failed.' });
  }
});

app.get('/api/transfers/relay/:relayId/:fileName', async (req, res) => {
  const relayId = sanitizePathSegment(req.params.relayId);
  const fileName = sanitizeFileName(req.params.fileName);
  const targetPath = path.join(relayDir, relayId, fileName);

  try {
    await fs.access(targetPath, constants.R_OK);
  } catch (error) {
    const code = getErrorCode(error);
    console.warn('CrossLAN relay download missing: relayId=' + relayId + ' file=' + fileName + ' path=' + targetPath + ' code=' + code);
    res.status(404).json({ ok: false, message: 'Relay file not found or expired.' });
    return;
  }

  console.log('CrossLAN relay download requested: relayId=' + relayId + ' file=' + fileName + ' ip=' + normalizeIp(req.socket.remoteAddress));
  res.on('finish', () => {
    console.log('CrossLAN relay download finished: relayId=' + relayId + ' file=' + fileName + ' status=' + res.statusCode);
  });
  res.download(targetPath, fileName, error => {
    if (!error) return;
    console.warn('CrossLAN relay download failed: relayId=' + relayId + ' file=' + fileName + ' path=' + targetPath + ' code=' + getErrorCode(error) + ' message=' + error.message);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, message: 'Relay download failed.' });
    }
  });
});
app.get('/api/network/probe/quick', async (req, res) => {
  res.json(await networkProber.quickProbe());
});

const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist, {
  maxAge: 0,
  setHeaders(res, filePath) {
    const normalizedPath = filePath.replaceAll(path.sep, '/');
    if (normalizedPath.includes('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return;
    }
    if (
      normalizedPath.endsWith('/index.html') ||
      normalizedPath.endsWith('/service-worker.js') ||
      normalizedPath.endsWith('/registerSW.js') ||
      normalizedPath.endsWith('/manifest.webmanifest')
    ) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(clientDist, 'index.html'));
});

const hub = new SignalingHub({ wss, mdns, networkProber });
server.on('upgrade', handleUpgrade);

try {
  if (httpsKeyPath && httpsCertPath) {
    const tlsOptions = {
      key: await fs.readFile(httpsKeyPath),
      cert: await fs.readFile(httpsCertPath)
    };
    activeServer = https.createServer(tlsOptions, app);
    activeServer.on('upgrade', handleUpgrade);
    configureServer(activeServer);

    if (shouldRedirectHttp) {
      redirectServer = http.createServer((req, res) => {
        const host = String(req.headers.host || '').replace(/:\d+$/, `:${httpsPort}`);
        res.writeHead(308, { location: `https://${host}${req.url || '/'}` });
        res.end();
      });
      configureServer(redirectServer);
      startServer(redirectServer, port, 'HTTP redirect', false);
    }

    startServer(activeServer, httpsPort, 'HTTPS', true);
  } else {
    configureServer(server);
    startServer(server, port, 'HTTP', true);
  }
} catch (error) {
  console.error(`CrossLAN failed to configure HTTPS: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const shutdown = async () => {
  await mdns.stop();
  hub.close();
  await Promise.all([
    closeServer(activeServer),
    redirectServer ? closeServer(redirectServer) : Promise.resolve()
  ]);
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function handleUpgrade(request, socket, head) {
  if (!request.url?.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request);
  });
}

function configureServer(targetServer) {
  targetServer.requestTimeout = 0;
  targetServer.headersTimeout = 0;
  targetServer.keepAliveTimeout = 0;
  targetServer.on('error', error => {
    if (error?.code === 'EADDRINUSE') {
      console.error('CrossLAN failed to start: port is already in use.');
    } else {
      console.error(`CrossLAN failed to start: ${error instanceof Error ? error.message : error}`);
    }
    process.exit(1);
  });
}

function startServer(targetServer, listenPort, label, startDiscovery) {
  targetServer.listen(listenPort, '0.0.0.0', async () => {
    await loadStorageSettings();
    await ensureWritableDirectory(storageSettings.saveDir).catch(error => {
      console.warn(`CrossLAN storage warning: ${error instanceof Error ? error.message : error}`);
    });
    const protocol = label === 'HTTPS' ? 'https' : 'http';
    console.log(`CrossLAN listening on ${label} ${protocol}://0.0.0.0:${listenPort}`);
    console.log(`CrossLAN direct-save directory: ${storageSettings.saveDir}`);
    if (startDiscovery) {
      mdns.start().catch(error => {
        console.warn(`CrossLAN discovery warning: ${error instanceof Error ? error.message : error}`);
      });
    }
  });
}

function closeServer(targetServer) {
  return new Promise(resolve => targetServer.close(resolve));
}

function broadcastDirectProgress(payload) {
  if (!payload.transferId) return;
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

async function loadStorageSettings() {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const saved = JSON.parse(raw);
    if (typeof saved.saveDir === 'string' && path.isAbsolute(saved.saveDir)) {
      storageSettings.saveDir = saved.saveDir;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`CrossLAN config warning: ${error instanceof Error ? error.message : error}`);
    }
  }
}

async function saveStorageSettings() {
  await fs.writeFile(configPath, JSON.stringify({ saveDir: storageSettings.saveDir }, null, 2), 'utf8');
}
async function ensureWritableDirectory(dir) {
  await fs.mkdir(dir, { recursive: true });
  await fs.access(dir, constants.W_OK);
}

function decodeFileName(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function sanitizeFileName(name) {
  const baseName = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return baseName || 'download.bin';
}

async function getAvailablePath(dir, fileName) {
  const parsed = path.parse(fileName);
  for (let i = 0; i < 1000; i += 1) {
    const suffix = i === 0 ? '' : ` (${i})`;
    const candidate = path.join(dir, `${parsed.name}${suffix}${parsed.ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error('Too many files with the same name.');
}

function createRelayId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizePathSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function normalizeIp(value) {
  return String(value || '').replace(/^::ffff:/, '');
}

function getErrorCode(error) {
  return typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
