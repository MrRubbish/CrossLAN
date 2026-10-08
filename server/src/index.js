import express from 'express';
import http, { createServer } from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import { SignalingHub } from './signaling/SignalingHub.js';
import { MdnsDiscovery } from './discovery/MdnsDiscovery.js';
import { NetworkProber } from './network/NetworkProber.js';
import { RelayBufferPool } from './relay/RelayBufferPool.js';
import { Logger } from './Logger.js';

const __dirname = path.dirname(path.resolve(process.argv[1] || process.execPath));
const port = Number(process.env.PORT || 6100);
const bindHost = String(process.env.CROSSLAN_BIND_HOST || '0.0.0.0').trim() || '0.0.0.0';
const httpsPort = Number(process.env.HTTPS_PORT || 8443);
const httpsKeyPath = process.env.CROSSLAN_HTTPS_KEY || '';
const httpsCertPath = process.env.CROSSLAN_HTTPS_CERT || '';
const shouldRedirectHttp = process.env.CROSSLAN_HTTP_REDIRECT === '1' || process.env.CROSSLAN_HTTP_REDIRECT === 'true';
const deploymentMode = normalizeDeploymentMode(process.env.CROSSLAN_DEPLOYMENT || process.env.CROSSLAN_SERVER_MODE || 'node');
const desktopManaged = process.env.CROSSLAN_DESKTOP_MANAGED === '1';
const serverInstanceId = randomUUID();
const defaultSaveDir = process.env.CROSSLAN_SAVE_DIR || path.join(os.homedir(), 'Downloads', 'CrossLAN');
const configPath = process.env.CROSSLAN_CONFIG || path.join(os.homedir(), '.crosslan.json');
const storageSettings = { saveDir: defaultSaveDir };
const desktopSessionToken = String(process.env.CROSSLAN_DESKTOP_SESSION_TOKEN || '').trim();
const DESKTOP_PAGE_CLOSED_MARKER = 'CrossLAN desktop page closed';
const DESKTOP_PAGE_CLAIMED_MARKER = 'CrossLAN desktop page claimed';
const DIRECT_UPLOAD_LOG_INTERVAL_MS = 30000;
const RELAY_UPLOAD_LOG_INTERVAL_MS = 5000;
const DIRECT_UPLOAD_WRITE_BUFFER = 8 * 1024 * 1024;
const RELAY_SESSION_TTL_MS = Number(process.env.CROSSLAN_RELAY_SESSION_TTL_MS || 5 * 60 * 1000);
const RELAY_TOTAL_BUFFER_BYTES = readMegabytesAsBytes(process.env.CROSSLAN_RELAY_TOTAL_BUFFER_MB, process.env.CROSSLAN_RELAY_BUFFER_MB, 256);
const RELAY_HIGH_WATER_BYTES = Math.min(readMegabytesAsBytes(process.env.CROSSLAN_RELAY_HIGH_WATER_MB, undefined, 64), RELAY_TOTAL_BUFFER_BYTES);
const RELAY_TARGET_BUFFER_BYTES = Math.min(readMegabytesAsBytes(process.env.CROSSLAN_RELAY_TARGET_MB, undefined, 32), RELAY_HIGH_WATER_BYTES);
const RELAY_LOW_WATER_BYTES = Math.min(readMegabytesAsBytes(process.env.CROSSLAN_RELAY_LOW_WATER_MB, undefined, 24), RELAY_TARGET_BUFFER_BYTES);
const RELAY_REFILL_BYTES = Math.min(readMegabytesAsBytes(process.env.CROSSLAN_RELAY_REFILL_MB, undefined, 1), RELAY_HIGH_WATER_BYTES);
const RELAY_CANCEL_TOMBSTONE_TTL_MS = Number(process.env.CROSSLAN_RELAY_CANCEL_TOMBSTONE_TTL_MS || 30 * 60 * 1000);
const RELAY_COMPLETED_TOMBSTONE_TTL_MS = Number(process.env.CROSSLAN_RELAY_COMPLETED_TOMBSTONE_TTL_MS || 30 * 60 * 1000);
const RELAY_COMPLETED_SESSION_GRACE_MS = Number(process.env.CROSSLAN_RELAY_COMPLETED_SESSION_GRACE_MS || 30000);
const configuredRelayDownloadHandoffMs = Number(process.env.CROSSLAN_RELAY_DOWNLOAD_HANDOFF_MS);
const RELAY_DOWNLOAD_HANDOFF_MS = Math.max(0,
  Number.isFinite(configuredRelayDownloadHandoffMs) ? configuredRelayDownloadHandoffMs : 300);
const RELAY_DOWNLOAD_PREFIX_BYTES = Math.min(256 * 1024, RELAY_LOW_WATER_BYTES);
const HTTP_STREAM_HIGH_WATER_BYTES = readMegabytesAsBytes(process.env.CROSSLAN_HTTP_STREAM_BUFFER_MB, undefined, 4);
const HTTP_SERVER_OPTIONS = {
  highWaterMark: HTTP_STREAM_HIGH_WATER_BYTES,
  keepAlive: true,
  keepAliveInitialDelay: 1000,
  noDelay: true
};
const app = express();
const server = createServer(HTTP_SERVER_OPTIONS, app);
const logger = new Logger();
let activeServer = server;
let redirectServer = null;
const wss = new WebSocketServer({ noServer: true });
const networkProber = new NetworkProber();
const relaySessions = new Map();
const relayBufferPool = new RelayBufferPool({
  targetBytes: RELAY_TARGET_BUFFER_BYTES,
  highWaterBytes: RELAY_HIGH_WATER_BYTES,
  lowWaterBytes: RELAY_LOW_WATER_BYTES,
  refillBytes: RELAY_REFILL_BYTES,
  totalBytes: RELAY_TOTAL_BUFFER_BYTES
});
const cancelledRelayTransfers = new Map();
const completedRelayTransfers = new Map();
const directUploads = new Map();
const directChunkSessions = new Map();
const directTerminalStates = new Map();
const failedRelayTransfers = new Map();
const mdns = new MdnsDiscovery({
  port,
  serviceName: process.env.MDNS_SERVICE_NAME || 'CrossLAN',
  logger
});

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

app.options('/api/health', (req, res) => {
  setHealthCors(res);
  res.sendStatus(204);
});

app.get('/api/health', (req, res) => {
  setHealthCors(res);
  res.json({ ok: true, name: 'CrossLAN', deploymentMode, desktopManaged, instanceId: serverInstanceId, now: Date.now() });
});

const desktopSessionJson = express.json({ limit: '4kb' });

app.post('/api/desktop/session/claim', desktopSessionJson, (req, res) => {
  if (!desktopSessionToken) {
    res.status(404).json({ ok: false, message: 'Desktop session control is disabled.' });
    return;
  }
  if (!isDesktopSessionTokenValid(req.body?.token)) {
    res.status(403).json({ ok: false, message: 'Invalid desktop session token.' });
    return;
  }
  logger.ready(DESKTOP_PAGE_CLAIMED_MARKER);
  res.json({ ok: true });
});

app.post('/api/desktop/session/close', desktopSessionJson, (req, res) => {
  if (!desktopSessionToken) {
    res.status(404).json({ ok: false, message: 'Desktop session control is disabled.' });
    return;
  }
  if (!isDesktopSessionTokenValid(req.body?.token)) {
    res.status(403).json({ ok: false, message: 'Invalid desktop session token.' });
    return;
  }

  // Closing the browser page only lets the tray know it may be opened again.
  logger.ready(DESKTOP_PAGE_CLOSED_MARKER);
  res.json({ ok: true });
});

app.post('/api/desktop/session/terminate', desktopSessionJson, (req, res) => {
  if (!desktopSessionToken) {
    res.status(404).json({ ok: false, message: 'Desktop session control is disabled.' });
    return;
  }
  if (!isDesktopSessionTokenValid(req.body?.token)) {
    res.status(403).json({ ok: false, message: 'Invalid desktop session token.' });
    return;
  }

  broadcastDesktopSessionClose('desktop-exit');
  res.json({ ok: true });
});

app.post('/api/desktop/service/relocate', desktopSessionJson, (req, res) => {
  if (!desktopSessionToken) {
    res.status(404).json({ ok: false, message: 'Desktop session control is disabled.' });
    return;
  }
  if (!isDesktopSessionTokenValid(req.body?.token)) {
    res.status(403).json({ ok: false, message: 'Invalid desktop session token.' });
    return;
  }

  const targetUrl = normalizeRelocationUrl(req.body?.targetUrl);
  if (!targetUrl) {
    res.status(400).json({ ok: false, message: 'Invalid relocation target.' });
    return;
  }
  const requestedDelay = Number(req.body?.delayMs);
  const delayMs = Number.isFinite(requestedDelay)
    ? Math.min(5000, Math.max(500, Math.round(requestedDelay)))
    : 1500;
  const clients = hub.broadcastServiceRelocation(targetUrl, delayMs);
  res.json({ ok: true, clients, targetUrl, delayMs });
});

function setHealthCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

app.get('/api/storage', async (req, res) => {
  try {
    await ensureWritableDirectory(storageSettings.saveDir);
    res.json({ saveDir: storageSettings.saveDir });
  } catch (error) {
    res.status(500).json({ ok: false, message: error instanceof Error ? error.message : 'Storage is not writable.' });
  }
});

app.post('/api/storage', express.json({ limit: '32kb' }), async (req, res) => {
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
  let uploadSession = null;

  try {
    const fileName = sanitizeFileName(decodeFileName(String(req.header('x-crosslan-file-name') || req.query.name || 'download.bin')));
    const expectedSize = Number(req.header('x-crosslan-file-size') || req.query.size || 0);
    transferId = sanitizePathSegment(String(req.header('x-crosslan-transfer-id') || req.query.transferId || ''));
    if (rejectTerminalDirectTransfer(transferId, res)) return;
    if (transferId && (directUploads.has(transferId) || directChunkSessions.has(transferId))) {
      res.status(409).json({ ok: false, message: 'Direct upload already started.' });
      return;
    }
    uploadSession = {
      transferId,
      fileName,
      expectedSize,
      targetPath,
      request: req,
      bytesWritten: 0,
      cancelled: false,
      cancelNotified: false
    };
    if (transferId) directUploads.set(transferId, uploadSession);
    req.on('error', () => {});
    await prepareDirectFile(uploadSession);
    targetPath = uploadSession.targetPath;
    logger.info('CrossLAN direct upload started: ' + fileName + ' -> ' + targetPath + ' (' + formatBytes(expectedSize) + ')');

    req.on('data', chunk => {
      bytesWritten += chunk.length;
      if (uploadSession) uploadSession.bytesWritten = bytesWritten;
      const now = Date.now();
      if (now - lastLogAt > DIRECT_UPLOAD_LOG_INTERVAL_MS) {
        const intervalBytes = bytesWritten - lastLoggedBytes;
        const intervalSeconds = (now - lastLogAt) / 1000;
        lastLogAt = now;
        lastLoggedBytes = bytesWritten;
        logger.debug('CrossLAN direct upload progress: ' + fileName + ' ' + formatBytes(bytesWritten) + ' / ' + formatBytes(expectedSize) + ' @ ' + formatBytes(intervalBytes / intervalSeconds) + '/s avg ' + formatBytes(bytesWritten / ((now - startedAt) / 1000)) + '/s');
      }
      if (now - lastBroadcastAt > 500) {
        lastBroadcastAt = now;
        broadcastDirectProgress({ type: 'direct-transfer-progress', transferId, fileName, bytesTransferred: bytesWritten, totalBytes: expectedSize });
      }
    });

    await pipeline(req, uploadSession.stream);
    if (uploadSession.cancelled) throw new Error('Transfer cancelled.');

    if (expectedSize > 0 && bytesWritten !== expectedSize) {
      throw new Error(`Upload size mismatch: ${bytesWritten}/${expectedSize}`);
    }

    const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
    logger.info('CrossLAN direct upload completed: ' + path.basename(targetPath) + ' (' + formatBytes(bytesWritten) + ', avg ' + formatBytes(bytesWritten / elapsedSeconds) + '/s)');
    broadcastDirectProgress({ type: 'direct-transfer-complete', transferId, fileName: path.basename(targetPath), bytesTransferred: bytesWritten, totalBytes: expectedSize || bytesWritten, path: targetPath });
    res.json({ ok: true, fileName: path.basename(targetPath), path: targetPath, bytesWritten });
  } catch (error) {
    const cancelled = Boolean(uploadSession?.cancelled);
    const message = cancelled ? 'Transfer cancelled.' : error instanceof Error ? error.message : 'Upload failed.';
    const logMessage = 'CrossLAN direct upload ' + (cancelled ? 'cancelled: ' : 'failed: ') + message;
    if (cancelled) logger.warn(logMessage);
    else logger.error(logMessage);
    if (!uploadSession?.cancelNotified) {
      broadcastDirectProgress({ type: 'direct-transfer-error', transferId, fileName: targetPath ? path.basename(targetPath) : undefined, message, cancelled });
    }
    await discardDirectFile(uploadSession);
    if (!res.headersSent && !res.destroyed) res.status(cancelled ? 409 : 500).json({ ok: false, message, cancelled });
  } finally {
    if (transferId && directUploads.get(transferId) === uploadSession) directUploads.delete(transferId);
  }
});

app.post('/api/transfers/direct/:transferId/chunk', async (req, res) => {
  const transferId = sanitizePathSegment(req.params.transferId || req.header('x-crosslan-transfer-id') || '');
  const fileName = sanitizeFileName(decodeFileName(String(req.header('x-crosslan-file-name') || req.query.name || 'download.bin')));
  const expectedSize = Number(req.header('x-crosslan-file-size') || req.query.size || 0);
  const offset = Number(req.header('x-crosslan-offset') || req.query.offset || 0);
  const isFinal = String(req.header('x-crosslan-final') || req.query.final || '') === '1';

  if (!transferId) {
    res.status(400).json({ ok: false, message: 'transferId is required.' });
    return;
  }

  if (rejectTerminalDirectTransfer(transferId, res)) return;
  if (directUploads.has(transferId) || directChunkSessions.get(transferId)?.request) {
    res.status(409).json({ ok: false, message: 'Direct upload already started.' });
    return;
  }
  let session = directChunkSessions.get(transferId);
  try {
    if (!session) {
      if (offset !== 0) {
        res.status(409).json({ ok: false, message: 'Chunk session has not started.' });
        return;
      }
      session = {
        transferId,
        fileName,
        expectedSize,
        bytesWritten: 0,
        startedAt: Date.now(),
        request: req,
        cancelled: false,
        cancelNotified: false
      };
      directChunkSessions.set(transferId, session);
      req.on('error', () => {});
      await prepareDirectFile(session);
      logger.info('CrossLAN direct chunk upload started: ' + fileName + ' -> ' + session.targetPath + ' (' + formatBytes(expectedSize) + ')');
    }

    if (session.bytesWritten !== offset) {
      res.status(409).json({ ok: false, message: `Chunk offset mismatch: expected ${session.bytesWritten}, got ${offset}` });
      return;
    }

    session.request = req;
    let chunkBytes = 0;
    req.on('data', chunk => {
      chunkBytes += chunk.length;
      session.bytesWritten += chunk.length;
      broadcastDirectProgress({ type: 'direct-transfer-progress', transferId, fileName: session.fileName, bytesTransferred: session.bytesWritten, totalBytes: session.expectedSize });
    });

    await writeRequestToStream(req, session.stream);
    if (session.error) throw session.error;
    if (session.cancelled) throw new Error('Transfer cancelled.');

    if (isFinal) {
      session.stream.end();
      await once(session.stream, 'finish');
      if (session.cancelled) throw new Error('Transfer cancelled.');
      if (session.expectedSize > 0 && session.bytesWritten !== session.expectedSize) {
        throw new Error(`Upload size mismatch: ${session.bytesWritten}/${session.expectedSize}`);
      }
      const elapsedSeconds = Math.max((Date.now() - session.startedAt) / 1000, 0.001);
      logger.info('CrossLAN direct chunk upload completed: ' + path.basename(session.targetPath) + ' (' + formatBytes(session.bytesWritten) + ', avg ' + formatBytes(session.bytesWritten / elapsedSeconds) + '/s)');
      broadcastDirectProgress({ type: 'direct-transfer-complete', transferId, fileName: path.basename(session.targetPath), bytesTransferred: session.bytesWritten, totalBytes: session.expectedSize || session.bytesWritten, path: session.targetPath });
      directChunkSessions.delete(transferId);
      res.json({ ok: true, fileName: path.basename(session.targetPath), path: session.targetPath, bytesWritten: session.bytesWritten });
      return;
    }

    res.json({ ok: true, fileName: session.fileName, path: session.targetPath, bytesWritten: session.bytesWritten, chunkBytes });
  } catch (error) {
    if (session?.request === req) session.request = null;
    const cancelled = Boolean(session?.cancelled);
    const message = cancelled ? 'Transfer cancelled.' : error instanceof Error ? error.message : 'Upload failed.';
    const logMessage = 'CrossLAN direct chunk upload ' + (cancelled ? 'cancelled: ' : 'failed: ') + 'transferId=' + transferId + ' ' + message;
    if (cancelled) logger.warn(logMessage);
    else logger.error(logMessage);
    if (session) {
      await discardDirectFile(session);
      if (directChunkSessions.get(transferId) === session) directChunkSessions.delete(transferId);
    }
    if (!session?.cancelNotified) {
      broadcastDirectProgress({ type: 'direct-transfer-error', transferId, fileName, message, cancelled });
    }
    if (!res.headersSent && !res.destroyed) res.status(cancelled ? 409 : 500).json({ ok: false, message, cancelled });
  } finally {
    if (session?.request === req) session.request = null;
  }
});

app.delete('/api/transfers/direct/:transferId', async (req, res) => {
  const transferId = sanitizePathSegment(req.params.transferId);
  const terminal = getDirectTerminalState(transferId);
  if (terminal?.type === 'direct-transfer-complete') {
    res.json({ ok: true, cleaned: false, completed: true });
    return;
  }
  rememberDirectTerminalState({ type: 'direct-transfer-error', transferId, message: 'Transfer cancelled.', cancelled: true });
  const uploadCleaned = cleanupDirectUploadSession(transferId, 'cancelled');
  const chunkCleaned = await cleanupDirectChunkSession(transferId, 'cancelled');
  res.json({ ok: true, cleaned: uploadCleaned || chunkCleaned });
});

app.post('/api/transfers/relay/:transferId', async (req, res) => {
  const transferId = sanitizePathSegment(req.params.transferId || req.header('x-crosslan-transfer-id') || req.query.transferId || '');
  const fileName = sanitizeFileName(decodeFileName(String(req.header('x-crosslan-file-name') || req.query.name || 'download.bin')));
  const expectedSize = Number(req.header('x-crosslan-file-size') || req.query.size || 0);
  let bytesWritten = 0;
  let lastLogAt = Date.now();
  let lastLoggedBytes = 0;
  const startedAt = Date.now();

  if (!transferId) {
    res.status(400).json({ ok: false, message: 'transferId is required.' });
    return;
  }
  if (rejectCancelledRelayTransfer(transferId, res)) return;
  if (rejectCompletedRelayTransfer(transferId, res)) return;
  if (rejectFailedRelayTransfer(transferId, res)) return;

  const session = getOrCreateRelaySession(transferId, fileName, expectedSize);
  if (session.uploadStarted) {
    res.status(409).json({ ok: false, message: 'Relay upload already started.' });
    return;
  }

  session.uploadStarted = true;
  session.uploadRequest = req;
  session.fileName = fileName;
  session.expectedSize = expectedSize;
  session.lastActivityAt = Date.now();
  logger.info('CrossLAN relay stream upload started: ' + fileName + ' transferId=' + transferId + ' size=' + formatBytes(expectedSize));
  const reportUploadProgress = uploaded => {
    bytesWritten = uploaded;
    const now = Date.now();
    if (now - lastLogAt > RELAY_UPLOAD_LOG_INTERVAL_MS) {
      const intervalBytes = bytesWritten - lastLoggedBytes;
      const intervalSeconds = Math.max((now - lastLogAt) / 1000, 0.001);
      const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
      lastLogAt = now;
      lastLoggedBytes = bytesWritten;
      logger.debug('CrossLAN relay stream upload progress: ' + fileName + ' transferId=' + transferId + ' ' + formatBytes(bytesWritten) + ' / ' + formatBytes(expectedSize) + ' @ ' + formatBytes(intervalBytes / intervalSeconds) + '/s avg ' + formatBytes(bytesWritten / elapsedSeconds) + '/s');
    }
  };
  req.on('aborted', () => {
    logger.warn('CrossLAN relay stream upload aborted: ' + fileName + ' transferId=' + transferId + ' written=' + formatBytes(bytesWritten));
    failRelaySession(transferId, 'Sender aborted upload.');
  });
  req.on('error', error => {
    logger.warn('CrossLAN relay stream request error: ' + fileName + ' transferId=' + transferId + ' ' + (error instanceof Error ? error.message : error));
    failRelaySession(transferId, 'Sender upload error.');
  });

  try {
    await writeRelayRequestToSession(req, session, reportUploadProgress);
    if (expectedSize > 0 && bytesWritten !== expectedSize) {
      failRelaySession(transferId, `Upload size mismatch: ${bytesWritten}/${expectedSize}`);
      res.status(400).json({ ok: false, message: `Upload size mismatch: ${bytesWritten}/${expectedSize}` });
      return;
    }

    session.stream.end();
    session.uploadComplete = true;
    broadcastRelaySessionProgress(session, true);
    const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
    logger.info('CrossLAN relay stream upload completed: ' + fileName + ' transferId=' + transferId + ' bytes=' + formatBytes(bytesWritten) + ' avg=' + formatBytes(bytesWritten / elapsedSeconds) + '/s');
    scheduleRelaySessionAfterUpload(session);
    res.json({ ok: true, fileName, bytesWritten });
  } catch (error) {
    if (!session.failed) failRelaySession(transferId, error instanceof Error ? error.message : 'Relay stream upload failed.');
    logger.error('CrossLAN relay stream upload failed: transferId=' + transferId + ' file=' + fileName + ' ' + (error instanceof Error ? error.message : error));
    if (!res.headersSent && !res.destroyed) res.status(500).json({ ok: false, message: error instanceof Error ? error.message : 'Relay stream upload failed.' });
  } finally {
    if (session.uploadRequest === req) session.uploadRequest = null;
  }
});

app.post('/api/transfers/relay/:transferId/chunk', async (req, res) => {
  const transferId = sanitizePathSegment(req.params.transferId || req.header('x-crosslan-transfer-id') || req.query.transferId || '');
  const fileName = sanitizeFileName(decodeFileName(String(req.header('x-crosslan-file-name') || req.query.name || 'download.bin')));
  const expectedSize = Number(req.header('x-crosslan-file-size') || req.query.size || 0);
  const offset = Number(req.header('x-crosslan-offset') || req.query.offset || 0);
  const isFinal = String(req.header('x-crosslan-final') || req.query.final || '') === '1';

  if (!transferId) {
    res.status(400).json({ ok: false, message: 'transferId is required.' });
    return;
  }
  if (rejectCancelledRelayTransfer(transferId, res)) return;
  if (rejectCompletedRelayTransfer(transferId, res)) return;
  if (rejectFailedRelayTransfer(transferId, res)) return;

  const session = getOrCreateRelaySession(transferId, fileName, expectedSize);
  try {
    if (!session.uploadStarted) {
      if (offset !== 0) {
        res.status(409).json({ ok: false, message: 'Relay chunk session has not started.' });
        return;
      }
      session.uploadStarted = true;
      session.fileName = fileName;
      session.expectedSize = expectedSize;
      session.startedAt = Date.now();
      session.lastActivityAt = Date.now();
      logger.info('CrossLAN relay chunk upload started: ' + fileName + ' transferId=' + transferId + ' size=' + formatBytes(expectedSize));
    }

    if (session.bytesUploaded !== offset) {
      res.status(409).json({ ok: false, message: `Chunk offset mismatch: expected ${session.bytesUploaded}, got ${offset}` });
      return;
    }

    session.uploadRequest = req;
    const chunkBytes = await writeRelayRequestToSession(req, session);
    if (session.failed) throw new Error('Relay session failed.');

    if (isFinal) {
      if (session.expectedSize > 0 && session.bytesUploaded !== session.expectedSize) {
        failRelaySession(transferId, `Upload size mismatch: ${session.bytesUploaded}/${session.expectedSize}`);
        res.status(400).json({ ok: false, message: `Upload size mismatch: ${session.bytesUploaded}/${session.expectedSize}` });
        return;
      }
      session.uploadComplete = true;
      session.stream.end();
      broadcastRelaySessionProgress(session, true);
      const elapsedSeconds = Math.max((Date.now() - (session.startedAt || Date.now())) / 1000, 0.001);
      logger.info('CrossLAN relay chunk upload completed: ' + fileName + ' transferId=' + transferId + ' bytes=' + formatBytes(session.bytesUploaded) + ' avg=' + formatBytes(session.bytesUploaded / elapsedSeconds) + '/s');
      scheduleRelaySessionAfterUpload(session);
      res.json({ ok: true, fileName, bytesWritten: session.bytesUploaded });
      return;
    }

    res.json({ ok: true, fileName, bytesWritten: session.bytesUploaded, chunkBytes });
  } catch (error) {
    if (!session.failed) failRelaySession(transferId, error instanceof Error ? error.message : 'Relay chunk upload failed.');
    logger.error('CrossLAN relay chunk upload failed: transferId=' + transferId + ' file=' + fileName + ' ' + (error instanceof Error ? error.message : error));
    if (!res.headersSent && !res.destroyed) res.status(500).json({ ok: false, message: error instanceof Error ? error.message : 'Relay chunk upload failed.' });
  } finally {
    if (session.uploadRequest === req) session.uploadRequest = null;
  }
});

app.delete('/api/transfers/relay/:transferId', (req, res) => {
  const transferId = sanitizePathSegment(req.params.transferId);
  const session = relaySessions.get(transferId);
  if (getCompletedRelayTransfer(transferId)) {
    res.json({ ok: true, cleaned: false, completed: true });
    return;
  }
  markRelayTransferCancelled(transferId);
  if (session) {
    failRelaySession(transferId, 'Transfer cancelled.', true);
  }
  res.json({ ok: true, cleaned: Boolean(session) });
});

app.get('/api/transfers/relay/:transferId/state', (req, res) => {
  const transferId = sanitizePathSegment(req.params.transferId);
  if (rejectCancelledRelayTransfer(transferId, res, getRelayBufferStateFields())) return;
  const session = relaySessions.get(transferId);
  if (!session) {
    const failed = getFailedRelayTransfer(transferId);
    if (failed) {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, ...failed, ...getRelayBufferStateFields(), failed: true });
      return;
    }
    const completed = getCompletedRelayTransfer(transferId);
    if (completed) {
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        transferId,
        fileName: completed.fileName,
        expectedSize: completed.expectedSize,
        ...getRelayBufferStateFields(),
        bytesUploaded: completed.bytesUploaded,
        bytesDownloaded: completed.bytesDownloaded,
        uploadStarted: true,
        downloadStarted: true,
        uploadComplete: true,
        downloadComplete: true,
        completed: true,
        failed: false
      });
      return;
    }
    res.status(404).json({ ok: false, message: 'Relay session not found.', ...getRelayBufferStateFields() });
    return;
  }

  const bufferState = getRelayBufferStateFields(session);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    transferId,
    fileName: session.fileName,
    expectedSize: session.expectedSize,
    ...bufferState,
    bytesUploaded: session.bytesUploaded,
    bytesDownloaded: session.bytesDownloaded,
    uploadStarted: session.uploadStarted,
    downloadStarted: session.downloadStarted,
    uploadComplete: session.uploadComplete,
    downloadComplete: session.downloadComplete,
    failed: session.failed
  });
});

app.head('/api/transfers/relay/:transferId/:fileName', (req, res) => {
  const transferId = sanitizePathSegment(req.params.transferId);
  if (rejectCancelledRelayTransfer(transferId, res)) return;
  if (rejectCompletedRelayTransfer(transferId, res)) return;
  if (rejectFailedRelayTransfer(transferId, res)) return;
  const session = relaySessions.get(transferId);
  setRelayDownloadHeaders(res, sanitizeFileName(req.params.fileName), session?.expectedSize || Number(req.query.size || 0));
  res.status(200).end();
});

app.get('/api/transfers/relay/:transferId/:fileName', async (req, res) => {
  const transferId = sanitizePathSegment(req.params.transferId);
  const fileName = sanitizeFileName(req.params.fileName);
  const expectedSize = Number(req.query.size || 0);
  if (rejectCancelledRelayTransfer(transferId, res)) return;
  if (rejectCompletedRelayTransfer(transferId, res)) return;
  if (rejectFailedRelayTransfer(transferId, res)) return;
  const range = String(req.header('range') || '').trim();
  if (range && !/^bytes=0-(?:\d+)?$/i.test(range)) {
    res.setHeader('Accept-Ranges', 'none');
    if (expectedSize > 0) res.setHeader('Content-Range', `bytes */${expectedSize}`);
    res.status(416).end();
    return;
  }
  const session = getOrCreateRelaySession(transferId, fileName, expectedSize);
  const clientIp = normalizeIp(req.socket.remoteAddress);
  const previous = session.downloadConnection;
  if (previous) {
    if (!previous.provisional || previous.claimed || previous.clientIp !== clientIp) {
      res.status(409).json({ ok: false, message: 'Relay download already started.' });
      return;
    }
    // Claim before awaiting so only one replacement can own the byte stream.
    previous.claimed = true;
    previous.controller.abort();
    previous.res.destroy();
    await previous.finished;
    if (rejectCancelledRelayTransfer(transferId, res)) return;
    if (rejectFailedRelayTransfer(transferId, res)) return;
    if (res.destroyed) return;
  }
  if (session.handoffClientIp && session.handoffClientIp !== clientIp) {
    res.status(409).json({ ok: false, message: 'Relay download belongs to another client.' });
    return;
  }

  const userAgent = String(req.header('user-agent') || '');
  const hasPendingHandoff = Boolean(session.handoffClientIp);
  const isAndroidBrowserRequest = /Mozilla\/5\.0.*Android/i.test(userAgent);
  const replayWithoutDelay = hasPendingHandoff && !isAndroidBrowserRequest;
  const connection = createRelayDownloadConnection(
    req,
    res,
    !replayWithoutDelay && (hasPendingHandoff || isAndroidBrowserRequest),
    replayWithoutDelay
  );
  session.downloadStarted = true;
  session.downloadConnection = connection;
  session.downloadRequest = req;
  session.downloadResponse = res;
  if (connection.provisional) session.handoffClientIp = clientIp;
  session.fileName = fileName;
  if (expectedSize > 0) session.expectedSize = expectedSize;
  session.lastActivityAt = Date.now();
  logger.info('CrossLAN relay stream download opened: transferId=' + transferId + ' file=' + fileName + ' ip=' + normalizeIp(req.socket.remoteAddress));

  setRelayDownloadHeaders(res, fileName, session.expectedSize);
  res.flushHeaders();

  let bytesDownloaded = 0;
  let downloadProgressListener = null;
  try {
    if (connection.provisional || connection.replayHandoff) {
      if (!await prepareRelayDownloadHandoff(session, connection, connection.provisional)) {
        // Keep the prefix in the existing buffer budget until the download
        // manager reconnects. The session idle watchdog still bounds this wait.
        session.lastActivityAt = Date.now();
        return;
      }
      connection.provisional = false;
      connection.replayHandoff = false;
      bytesDownloaded = session.handoffBytes;
      session.handoffChunks.length = 0;
      session.handoffBytes = 0;
      session.handoffClientIp = '';
      session.bytesDownloaded = bytesDownloaded;
      session.lastActivityAt = Date.now();
      relayBufferPool.release(transferId, bytesDownloaded);
      broadcastRelaySessionProgress(session, true);
    }
    downloadProgressListener = chunk => {
      bytesDownloaded += chunk.length;
      session.bytesDownloaded = bytesDownloaded;
      session.lastActivityAt = Date.now();
      relayBufferPool.release(transferId, chunk.length);
      broadcastRelaySessionProgress(session);
    };
    session.stream.pause();
    session.stream.on('data', downloadProgressListener);
    await pipeline(session.stream, res);
    if (session.failed) return;
    if (session.expectedSize > 0 && bytesDownloaded !== session.expectedSize) {
      throw new Error(`Download size mismatch: ${bytesDownloaded}/${session.expectedSize}`);
    }
    session.downloadComplete = true;
    recordCompletedRelayTransfer(session);
    broadcastRelaySessionProgress(session, true);
    broadcastRelayProgress({
      type: 'relay-transfer-complete',
      transferId,
      fileName,
      bytesUploaded: session.bytesUploaded,
      bytesDownloaded,
      totalBytes: session.expectedSize || bytesDownloaded
    });
    logger.info('CrossLAN relay stream download finished: transferId=' + transferId + ' file=' + fileName + ' bytes=' + formatBytes(bytesDownloaded));
    scheduleRelaySessionCleanup(session, RELAY_COMPLETED_SESSION_GRACE_MS);
  } catch (error) {
    if (!session.failed) {
      const reason = error?.code === 'ERR_STREAM_PREMATURE_CLOSE' ? 'Receiver closed download.'
        : error instanceof Error ? error.message : 'Relay stream download failed.';
      logger.error('CrossLAN relay download failed: transferId=' + transferId +
        ' bytes=' + bytesDownloaded + '/' + session.expectedSize + ' ip=' + clientIp +
        ' ua=' + String(req.header('user-agent') || '') + ' reason=' + reason);
      failRelaySession(transferId, reason);
    }
    logger.warn('CrossLAN relay stream download failed: transferId=' + transferId + ' file=' + fileName + ' ' + (error instanceof Error ? error.message : error));
  } finally {
    if (downloadProgressListener) session.stream.removeListener('data', downloadProgressListener);
    if (session.downloadConnection === connection) {
      session.downloadConnection = null;
      session.downloadRequest = null;
      session.downloadResponse = null;
      if (connection.provisional || connection.replayHandoff) session.downloadStarted = false;
    }
    connection.dispose();
  }
});

function setRelayDownloadHeaders(res, fileName, expectedSize) {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeRFC5987(fileName)}`);
  if (expectedSize > 0) res.setHeader('Content-Length', String(expectedSize));
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('Cache-Control', 'no-store');
}

function createRelayDownloadConnection(req, res, provisional, replayHandoff = false) {
  const controller = new AbortController();
  const onClosed = () => controller.abort();
  req.once('aborted', onClosed);
  res.once('close', onClosed);
  res.once('error', onClosed);
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  return {
    res, controller, provisional, replayHandoff, finished, claimed: false,
    clientIp: normalizeIp(req.socket.remoteAddress),
    dispose() {
      req.removeListener('aborted', onClosed);
      res.removeListener('close', onClosed);
      res.removeListener('error', onClosed);
      finish();
    }
  };
}

async function prepareRelayDownloadHandoff(session, connection, waitForTakeover) {
  const { signal } = connection.controller;
  try {
    if (!session.handoffBytes) {
      while (!signal.aborted && !session.stream.readableEnded) {
        const available = session.stream.readableLength;
        if (available > 0) {
          const chunk = session.stream.read(Math.min(available, RELAY_DOWNLOAD_PREFIX_BYTES));
          session.handoffChunks.push(chunk);
          session.handoffBytes += chunk.length;
          break;
        }
        await waitForRelayReadable(session.stream, signal);
      }
    }
    for (const chunk of session.handoffChunks) {
      if (signal.aborted || connection.res.destroyed) return false;
      if (!connection.res.write(chunk)) await once(connection.res, 'drain', { signal });
      session.lastActivityAt = Date.now();
    }
    // Send a bounded prefix immediately, without filling a buffer or ending the
    // stream. A browser may now replace this request with its download manager.
    if (waitForTakeover) await waitForRelayHandoffWindow(signal);
    return !signal.aborted && !session.failed;
  } catch (error) {
    if (signal.aborted && !session.failed) return false;
    throw error;
  }
}

function waitForRelayReadable(stream, signal) {
  if (signal.aborted || stream.readableEnded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = error => {
      stream.removeListener('readable', onReadable);
      stream.removeListener('end', onReadable);
      stream.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onReadable = () => finish();
    const onError = error => finish(error);
    const onAbort = () => finish();
    stream.once('readable', onReadable);
    stream.once('end', onReadable);
    stream.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForRelayHandoffWindow(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, RELAY_DOWNLOAD_HANDOFF_MS);
    signal.addEventListener('abort', finish, { once: true });
  });
}
app.get('/api/network/probe/quick', async (req, res) => {
  res.json(await networkProber.quickProbe());
});

const clientDist = process.env.CROSSLAN_CLIENT_DIST
  ? path.resolve(process.env.CROSSLAN_CLIENT_DIST)
  : path.resolve(__dirname, '../../client/dist');
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

const hub = new SignalingHub({ wss, mdns, networkProber, deploymentMode, serverInstanceId, logger });
server.on('upgrade', handleUpgrade);

void startCrosslan();

async function startCrosslan() {
  try {
    if (httpsKeyPath && httpsCertPath) {
      const tlsOptions = {
        key: await fs.readFile(httpsKeyPath),
        cert: await fs.readFile(httpsCertPath)
      };
      activeServer = https.createServer({ ...HTTP_SERVER_OPTIONS, ...tlsOptions }, app);
      activeServer.on('upgrade', handleUpgrade);
      configureServer(activeServer);

      if (shouldRedirectHttp) {
        redirectServer = http.createServer({ noDelay: true }, (req, res) => {
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
    logger.error(`CrossLAN failed to configure HTTPS: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
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
  targetServer.maxRequestsPerSocket = 0;
  targetServer.on('error', error => {
    if (error?.code === 'EADDRINUSE') {
      logger.error('CrossLAN failed to start: port is already in use.');
    } else {
      logger.error(`CrossLAN failed to start: ${error instanceof Error ? error.message : error}`);
    }
    process.exit(1);
  });
}

function startServer(targetServer, listenPort, label, startDiscovery) {
  targetServer.listen(listenPort, bindHost, async () => {
    await loadStorageSettings();
    await ensureWritableDirectory(storageSettings.saveDir).catch(error => {
      logger.warn(`CrossLAN storage warning: ${error instanceof Error ? error.message : error}`);
    });
    const protocol = label === 'HTTPS' ? 'https' : 'http';
    logger.ready(`CrossLAN listening on ${label} ${protocol}://${bindHost}:${listenPort}`);
    logger.info(`CrossLAN direct-save directory: ${storageSettings.saveDir}`);
    if (startDiscovery) {
      mdns.start().catch(error => {
        logger.warn(`CrossLAN discovery warning: ${error instanceof Error ? error.message : error}`);
      });
    }
  });
}

function closeServer(targetServer) {
  return new Promise(resolve => targetServer.close(resolve));
}

function isDesktopSessionTokenValid(value) {
  if (!desktopSessionToken) return false;
  const expected = Buffer.from(desktopSessionToken, 'utf8');
  const actual = Buffer.from(String(value || ''), 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeRelocationUrl(value) {
  try {
    const target = new URL(String(value || ''));
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    if (!target.hostname || target.username || target.password) return null;
    target.pathname = '/';
    target.search = '';
    target.hash = '';
    return target.toString();
  } catch {
    return null;
  }
}

function broadcastDesktopSessionClose(reason) {
  const message = JSON.stringify({ type: 'desktop-session-close', reason });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

function broadcastRelayProgress(payload) {
  if (!payload.transferId) return;
  hub.broadcastToTransfer(payload.transferId, payload);
}

function broadcastDirectProgress(payload) {
  if (!payload.transferId) return;
  if (payload.type === 'direct-transfer-complete' || payload.type === 'direct-transfer-error') {
    rememberDirectTerminalState(payload);
  }
  hub.broadcastToTransfer(payload.transferId, payload);
}

function getOrCreateRelaySession(transferId, fileName, expectedSize) {
  let session = relaySessions.get(transferId);
  if (session) return session;

  relayBufferPool.register(transferId);
  const stream = new PassThrough({
    readableHighWaterMark: RELAY_TARGET_BUFFER_BYTES,
    writableHighWaterMark: HTTP_STREAM_HIGH_WATER_BYTES
  });
  stream.on('error', () => {});
  session = {
    transferId,
    fileName,
    expectedSize,
    stream,
    uploadStarted: false,
    downloadStarted: false,
    uploadComplete: false,
    downloadComplete: false,
    failed: false,
    cancelled: false,
    bytesUploaded: 0,
    bytesDownloaded: 0,
    uploadRequest: null,
    downloadRequest: null,
    downloadResponse: null,
    downloadConnection: null,
    handoffClientIp: '',
    handoffChunks: [],
    handoffBytes: 0,
    lastProgressBroadcastAt: 0,
    timer: null,
    createdAt: Date.now(),
    lastActivityAt: Date.now()
  };
  relaySessions.set(transferId, session);
  scheduleRelaySessionTimeout(session);
  logger.debug('CrossLAN relay stream session created: transferId=' + transferId + ' file=' + fileName + ' target=' + formatBytes(RELAY_TARGET_BUFFER_BYTES) + ' high=' + formatBytes(RELAY_HIGH_WATER_BYTES) + ' low=' + formatBytes(RELAY_LOW_WATER_BYTES) + ' refill=' + formatBytes(RELAY_REFILL_BYTES) + ' total=' + formatBytes(RELAY_TOTAL_BUFFER_BYTES));
  return session;
}

function failRelaySession(transferId, reason, cancelled = false) {
  const session = relaySessions.get(transferId);
  if (!session || session.failed) return;
  completedRelayTransfers.delete(transferId);
  session.failed = true;
  session.cancelled = cancelled;
  for (const id of failedRelayTransfers.keys()) getFailedRelayTransfer(id);
  failedRelayTransfers.set(transferId, {
    transferId, fileName: session.fileName, expectedSize: session.expectedSize,
    bytesUploaded: session.bytesUploaded, bytesDownloaded: session.bytesDownloaded,
    message: reason, cancelled, expiresAt: Date.now() + RELAY_COMPLETED_TOMBSTONE_TTL_MS
  });
  clearRelaySessionTimer(session);
  relaySessions.delete(transferId);
  relayBufferPool.close(transferId, new Error(reason));
  logger.warn('CrossLAN relay stream session failed: transferId=' + transferId + ' reason=' + reason);
  session.downloadConnection?.controller.abort();
  session.uploadRequest?.destroy();
  session.downloadRequest?.destroy();
  session.downloadResponse?.destroy();
  session.stream.destroy(new Error(reason));
  session.handoffChunks.length = 0;
  session.handoffBytes = 0;
  session.uploadRequest = null;
  session.downloadRequest = null;
  session.downloadResponse = null;
  broadcastRelayProgress({ type: 'relay-transfer-error', transferId, fileName: session.fileName, message: reason, cancelled });
}

function scheduleRelaySessionCleanup(session, delayMs) {
  clearRelaySessionTimer(session);
  session.timer = setTimeout(() => {
    if (relaySessions.get(session.transferId) !== session) return;
    logger.debug('CrossLAN relay stream session cleanup: transferId=' + session.transferId + ' uploaded=' + formatBytes(session.bytesUploaded) + ' downloaded=' + formatBytes(session.bytesDownloaded));
    session.stream.destroy();
    session.handoffChunks.length = 0;
    session.handoffBytes = 0;
    relaySessions.delete(session.transferId);
    relayBufferPool.close(session.transferId);
  }, delayMs);
  session.timer.unref?.();
}

function scheduleRelaySessionAfterUpload(session) {
  if (session.downloadComplete) {
    scheduleRelaySessionCleanup(session, RELAY_COMPLETED_SESSION_GRACE_MS);
    return;
  }
  // The idle watchdog stays active while waiting for a downloader or drain.
}

function scheduleRelaySessionTimeout(session) {
  const check = () => {
    if (relaySessions.get(session.transferId) !== session || session.downloadComplete) return;
    const remaining = RELAY_SESSION_TTL_MS - (Date.now() - session.lastActivityAt);
    if (remaining <= 0) {
      failRelaySession(session.transferId, session.downloadStarted ? 'Relay transfer timed out without progress.' : 'Timed out waiting for receiver download.');
      return;
    }
    session.timer = setTimeout(check, remaining);
    session.timer.unref?.();
  };
  session.timer = setTimeout(check, RELAY_SESSION_TTL_MS);
  session.timer.unref?.();
}

function getFailedRelayTransfer(transferId) {
  const state = failedRelayTransfers.get(transferId);
  if (!state) return null;
  if (state.expiresAt > Date.now()) return state;
  failedRelayTransfers.delete(transferId);
  return null;
}

function rejectFailedRelayTransfer(transferId, res) {
  const state = getFailedRelayTransfer(transferId);
  if (!state) return false;
  res.status(409).json({ ok: false, failed: true, message: state.message });
  return true;
}

function clearRelaySessionTimer(session) {
  if (!session.timer) return;
  clearTimeout(session.timer);
  session.timer = null;
}

function markRelayTransferCancelled(transferId) {
  if (!transferId) return;
  pruneCancelledRelayTransfers();
  completedRelayTransfers.delete(transferId);
  cancelledRelayTransfers.set(transferId, Date.now() + RELAY_CANCEL_TOMBSTONE_TTL_MS);
}

function isRelayTransferCancelled(transferId) {
  const expiresAt = cancelledRelayTransfers.get(transferId);
  if (!expiresAt) return false;
  if (expiresAt > Date.now()) return true;
  cancelledRelayTransfers.delete(transferId);
  return false;
}

function pruneCancelledRelayTransfers() {
  const now = Date.now();
  for (const [transferId, expiresAt] of cancelledRelayTransfers) {
    if (expiresAt <= now) cancelledRelayTransfers.delete(transferId);
  }
}

function rejectCancelledRelayTransfer(transferId, res, extra = {}) {
  if (!isRelayTransferCancelled(transferId)) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.status(410).json({
    ok: false,
    cancelled: true,
    message: 'Transfer cancelled.',
    ...extra
  });
  return true;
}

function recordCompletedRelayTransfer(session) {
  if (!session?.transferId) return;
  pruneCompletedRelayTransfers();
  completedRelayTransfers.set(session.transferId, {
    fileName: session.fileName,
    expectedSize: session.expectedSize || session.bytesDownloaded,
    bytesUploaded: session.bytesUploaded,
    bytesDownloaded: session.bytesDownloaded,
    expiresAt: Date.now() + RELAY_COMPLETED_TOMBSTONE_TTL_MS
  });
}

function getCompletedRelayTransfer(transferId) {
  const completed = completedRelayTransfers.get(transferId);
  if (!completed) return null;
  if (completed.expiresAt > Date.now()) return completed;
  completedRelayTransfers.delete(transferId);
  return null;
}

function pruneCompletedRelayTransfers() {
  const now = Date.now();
  for (const [transferId, completed] of completedRelayTransfers) {
    if (completed.expiresAt <= now) completedRelayTransfers.delete(transferId);
  }
}

function rejectCompletedRelayTransfer(transferId, res) {
  if (!getCompletedRelayTransfer(transferId)) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.status(410).json({
    ok: false,
    completed: true,
    message: 'Transfer already completed.'
  });
  return true;
}

function cleanupDirectUploadSession(transferId, reason) {
  const session = directUploads.get(transferId);
  if (!session) return false;
  directUploads.delete(transferId);
  session.cancelled = reason === 'cancelled';
  session.cancelNotified = true;
  logger.warn('CrossLAN direct upload cleanup: transferId=' + transferId + ' file=' + session.fileName + ' reason=' + reason + ' written=' + formatBytes(session.bytesWritten));
  broadcastDirectProgress({
    type: 'direct-transfer-error',
    transferId,
    fileName: session.fileName,
    message: session.cancelled ? 'Transfer cancelled.' : reason || 'Direct transfer cancelled.',
    cancelled: session.cancelled
  });
  session.request.destroy(new Error(reason || 'Direct transfer cancelled.'));
  void discardDirectFile(session);
  return true;
}

async function cleanupDirectChunkSession(transferId, reason) {
  const session = directChunkSessions.get(transferId);
  if (!session) return false;
  directChunkSessions.delete(transferId);
  session.cancelled = reason === 'cancelled';
  session.cancelNotified = true;
  logger.warn('CrossLAN direct chunk session cleanup: transferId=' + transferId + ' file=' + session.fileName + ' reason=' + reason + ' written=' + formatBytes(session.bytesWritten));
  broadcastDirectProgress({
    type: 'direct-transfer-error',
    transferId,
    fileName: session.fileName,
    message: session.cancelled ? 'Transfer cancelled.' : reason || 'Direct transfer cancelled.',
    cancelled: session.cancelled
  });
  session.request?.destroy(new Error(reason || 'Direct transfer cancelled.'));
  await discardDirectFile(session);
  return true;
}

async function writeRequestToStream(req, stream) {
  for await (const chunk of req) {
    if (!stream.write(chunk)) await once(stream, 'drain');
  }
}

async function writeRelayRequestToSession(req, session, onProgress) {
  let requestBytes = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
      const requestedBytes = chunk.length - offset;
      const bytesReserved = relayBufferPool.tryReserve(session.transferId, requestedBytes)
        || await relayBufferPool.reserve(session.transferId, requestedBytes);
      const nextOffset = offset + bytesReserved;
      relayBufferPool.commit(session.transferId, bytesReserved);
      session.bytesUploaded += bytesReserved;
      session.lastActivityAt = Date.now();
      let canContinue;
      try {
        canContinue = session.stream.write(chunk.subarray(offset, nextOffset));
      } catch (error) {
        session.bytesUploaded -= bytesReserved;
        relayBufferPool.release(session.transferId, bytesReserved);
        throw error;
      }
      offset = nextOffset;
      requestBytes += bytesReserved;
      onProgress?.(session.bytesUploaded, requestBytes);
      if (!canContinue) await once(session.stream, 'drain');
    }
  }
  return requestBytes;
}

function broadcastRelaySessionProgress(session, force = false) {
  if (!session || session.failed) return;
  const now = Date.now();
  if (!force && now - session.lastProgressBroadcastAt < 500) return;
  session.lastProgressBroadcastAt = now;
  broadcastRelayProgress({
    type: 'relay-transfer-progress',
    transferId: session.transferId,
    fileName: session.fileName,
    bytesTransferred: session.bytesDownloaded,
    bytesUploaded: session.bytesUploaded,
    bytesDownloaded: session.bytesDownloaded,
    totalBytes: session.expectedSize
  });
}

function getRelayBufferStateFields(session) {
  const snapshot = session ? relayBufferPool.snapshot(session.transferId) : null;
  return {
    bufferBytes: RELAY_HIGH_WATER_BYTES,
    targetBufferBytes: RELAY_TARGET_BUFFER_BYTES,
    lowWaterBytes: RELAY_LOW_WATER_BYTES,
    refillBytes: RELAY_REFILL_BYTES,
    resumeWaterBytes: snapshot?.resumeWaterBytes || Math.max(RELAY_LOW_WATER_BYTES, RELAY_HIGH_WATER_BYTES - RELAY_REFILL_BYTES),
    totalBufferBytes: RELAY_TOTAL_BUFFER_BYTES,
    totalBufferedBytes: relayBufferPool.totalBufferedBytes,
    bufferedBytes: snapshot?.bufferedBytes || 0,
    backpressured: snapshot?.backpressured || false
  };
}

function readMegabytesAsBytes(primaryValue, fallbackValue, defaultMegabytes) {
  const parsed = Number(primaryValue ?? fallbackValue ?? defaultMegabytes);
  const megabytes = Number.isFinite(parsed) ? Math.max(parsed, 1) : defaultMegabytes;
  return Math.floor(megabytes * 1024 * 1024);
}

function encodeRFC5987(value) {
  return encodeURIComponent(value).replace(/['()]/g, escape).replace(/\*/g, '%2A');
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
      logger.warn(`CrossLAN config warning: ${error instanceof Error ? error.message : error}`);
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

function getDirectTerminalState(transferId) {
  const state = directTerminalStates.get(transferId);
  if (!state) return null;
  if (state.expiresAt > Date.now()) return state;
  directTerminalStates.delete(transferId);
  return null;
}

function rememberDirectTerminalState(payload) {
  if (!payload.transferId) return;
  for (const id of directTerminalStates.keys()) getDirectTerminalState(id);
  const previous = getDirectTerminalState(payload.transferId);
  if (previous?.cancelled || previous?.type === 'direct-transfer-complete') return;
  directTerminalStates.set(payload.transferId, { ...payload, expiresAt: Date.now() + RELAY_CANCEL_TOMBSTONE_TTL_MS });
}

function rejectTerminalDirectTransfer(transferId, res) {
  const state = getDirectTerminalState(transferId);
  if (!state) return false;
  res.status(410).json({ ok: false, cancelled: Boolean(state.cancelled), message: state.message || 'Transfer already completed.' });
  return true;
}

async function prepareDirectFile(session) {
  await ensureWritableDirectory(storageSettings.saveDir);
  if (session.cancelled) throw new Error('Transfer cancelled.');
  const { targetPath, handle } = await openAvailableFile(storageSettings.saveDir, session.fileName);
  session.targetPath = targetPath;
  session.stream = handle.createWriteStream({ highWaterMark: DIRECT_UPLOAD_WRITE_BUFFER });
  session.stream.on('error', error => { session.error = error; });
  if (session.cancelled) {
    await discardDirectFile(session);
    throw new Error('Transfer cancelled.');
  }
}

function discardDirectFile(session) {
  if (!session?.stream) return Promise.resolve();
  // Only the session that atomically created this file may remove it.
  session.discardPromise ||= (async () => {
    if (!session.stream.closed) {
      await new Promise(resolve => {
        session.stream.once('close', resolve);
        session.stream.destroy(new Error(session.cancelled ? 'Transfer cancelled.' : 'Direct upload failed.'));
      });
    }
    await fs.rm(session.targetPath, { force: true });
  })().catch(error => logger.error('CrossLAN direct file cleanup failed: ' + error.message));
  return session.discardPromise;
}

async function openAvailableFile(dir, fileName) {
  const parsed = path.parse(fileName);
  for (let i = 0; i < 1000; i += 1) {
    const suffix = i === 0 ? '' : ` (${i})`;
    const candidate = path.join(dir, `${parsed.name}${suffix}${parsed.ext}`);
    try {
      const handle = await fs.open(candidate, 'wx');
      return { targetPath: candidate, handle };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Too many files with the same name.');
}


function sanitizePathSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function normalizeIp(value) {
  return String(value || '').replace(/^::ffff:/, '');
}

function normalizeDeploymentMode(value) {
  return String(value || '').toLowerCase() === 'docker' ? 'docker' : 'node';
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
