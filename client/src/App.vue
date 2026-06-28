<template>
  <main class="min-h-screen bg-mist text-ink">
    <section class="mx-auto max-w-5xl px-4 pb-10 pt-[env(safe-area-inset-top)] sm:px-6">
      <header class="flex items-center justify-between gap-4 py-5">
        <div>
          <h1 class="text-2xl font-800">CrossLAN</h1>
          <p class="text-sm text-ink/60">{{ localStatus }}</p>
        </div>
        <div class="flex items-center gap-2">
          <span class="rounded-full border border-line bg-white px-3 py-1 text-xs font-700 text-ink/55">{{ protocolLabel }}</span>
          <span class="rounded-full border px-3 py-1 text-xs font-700" :class="connected ? 'border-teal/25 bg-teal/8 text-teal' : 'border-coral/25 bg-coral/8 text-coral'">
            {{ connected ? t.online : t.offline }}
          </span>
        </div>
      </header>

      <div class="grid gap-4 lg:grid-cols-[1fr_340px]">
        <section class="panel p-4 sm:p-5">
          <div class="mb-4 flex items-center justify-between gap-3">
            <div>
              <p class="label">{{ t.devices }}</p>
              <h2 class="text-xl font-750">{{ t.selectTarget }}</h2>
            </div>
            <button class="tap border border-line px-3 text-sm font-700" @click="requestRefresh">{{ t.refresh }}</button>
          </div>

          <div v-if="devices.length === 0" class="rounded-md border border-dashed border-line p-6 text-center text-sm text-ink/55">
            {{ t.emptyDevices }}
          </div>

          <div v-else class="grid gap-3 sm:grid-cols-2">
            <button v-for="device in devices" :key="device.id" class="tap border border-line bg-mist/60 p-4 text-left hover:border-teal/40 hover:bg-white" @click="chooseAndSend(device)">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="font-800">{{ identity.getDisplayName(device) }}</p>
                  <p class="mt-1 text-sm text-ink/55">{{ t.deviceId }}: {{ device.id }}</p>
                </div>
                <span class="rounded px-2 py-1 text-xs font-700" :class="canDirectSaveTo(device) ? 'bg-teal/10 text-teal' : 'bg-ink/8 text-ink/50'">
                  {{ deviceReceiveModeLabel(device) }}
                </span>
              </div>
              <p class="mt-3 text-xs text-ink/45">{{ t.lastSeen }} {{ formatTime(device.lastSeen) }}</p>
            </button>
          </div>

          <input ref="fileInput" type="file" accept="*/*" class="hidden" @change="handleFilePicked" />
        </section>

        <aside class="space-y-4">
          <section class="panel p-4">
            <p class="label">{{ t.transfers }}</p>
            <div v-if="progressItems.length === 0" class="mt-3 text-sm text-ink/55">{{ t.noTransfers }}</div>
            <div v-for="item in progressItems" :key="item.id" class="mt-3 rounded-md border border-line p-3">
              <div class="flex items-center justify-between gap-3 text-sm font-700">
                <span class="min-w-0 truncate">{{ item.fileName }}</span>
                <div class="flex shrink-0 items-center gap-2">
                  <button v-if="item.cancellable && !item.done" class="tap border border-coral/30 bg-coral/8 px-2 py-1 text-xs font-800 text-coral" type="button" @click="cancelTransfer(item)">{{ t.cancel }}</button>
                  <span>{{ Math.round(percent(item)) }}%</span>
                </div>
              </div>
              <div class="mt-2 h-2 overflow-hidden rounded-full bg-line">
                <div class="h-full rounded-full bg-teal" :style="{ width: `${percent(item)}%` }"></div>
              </div>
              <p class="mt-2 text-xs text-ink/50">
                {{ item.direction === 'send' ? t.send : t.receive }} | {{ modeLabel(item.mode) }} | {{ formatBytes(item.bytesTransferred) }} / {{ formatBytes(item.totalBytes) }} | {{ formatSpeed(item.speedBytesPerSecond) }}
              </p>
              <p v-if="item.statusText" class="mt-1 break-all text-xs" :class="item.done && item.bytesTransferred < item.totalBytes ? 'text-coral' : 'text-ink/45'">{{ item.statusText }}</p>
              <a v-if="item.downloadUrl" class="tap mt-2 inline-flex border border-teal/30 bg-teal/10 px-3 py-2 text-xs font-800 text-teal" :href="item.downloadUrl" :download="item.fileName" target="_blank" rel="noopener" @click="logDownloadOpen(item)">{{ t.openDownload }}</a>
            </div>
          </section>

          <section class="panel p-4">
            <p class="label">{{ t.storage }}</p>
            <h2 class="text-lg font-750">{{ t.saveDirectory }}</h2>
            <p class="mt-2 text-xs text-ink/50">{{ t.storageHint }}</p>
            <input v-model="saveDirInput" class="mt-3 w-full rounded-md border border-line bg-white px-3 py-2 text-sm" placeholder="/data/CrossLAN" />
            <button class="tap mt-3 w-full bg-ink px-3 py-2 text-sm font-800 text-white" @click="saveStorageDir">{{ t.savePath }}</button>
            <p class="mt-2 break-all text-xs" :class="storageStatusOk ? 'text-teal' : 'text-coral'">{{ storageMessage }}</p>
          </section>

          <section class="panel p-4">
            <div class="flex items-center justify-between gap-2">
              <div>
                <p class="label">{{ t.network }}</p>
                <h2 class="text-lg font-750">{{ t.speedLimit }}</h2>
              </div>
            </div>
            <div class="mt-4 space-y-3">
              <label class="flex items-center gap-2 text-sm"><input v-model="bandwidthMode" value="unlimited" type="radio" /> {{ t.unlimited }}</label>
              <label class="flex items-center gap-2 text-sm"><input v-model="bandwidthMode" value="manual" type="radio" /> {{ t.manual }}</label>
              <input v-model.number="manualLimitMbps" :disabled="bandwidthMode !== 'manual'" type="number" min="1" class="w-full rounded-md border border-line bg-white px-3 py-2 text-sm disabled:bg-line/30" placeholder="Mbps" />
              <label class="flex items-center gap-2 text-sm text-ink/40"><input v-model="bandwidthMode" value="auto" type="radio" disabled /> {{ t.auto }}</label>
            </div>
          </section>
          <details class="panel p-4">
            <summary class="cursor-pointer list-none">
              <div class="flex items-center justify-between gap-2">
                <div>
                  <p class="label">{{ t.diagnostics }}</p>
                  <h2 class="text-lg font-750">{{ t.recentEvents }}</h2>
                </div>
                <button class="tap border border-line px-3 py-1 text-xs font-800" type="button" @click.prevent="clearLogs">{{ t.clear }}</button>
              </div>
            </summary>
            <div class="mt-3 max-h-72 space-y-2 overflow-auto rounded-md border border-line bg-white p-2 text-xs">
              <p v-if="debugLogs.length === 0" class="text-ink/45">{{ t.noDebugEvents }}</p>
              <div v-for="log in debugLogs" :key="log.id" class="border-b border-line/70 pb-2 last:border-b-0 last:pb-0">
                <p :class="log.level === 'error' ? 'text-coral' : log.level === 'warn' ? 'text-amber-600' : 'text-ink/70'">{{ log.time }} {{ log.message }}</p>
                <pre v-if="log.details" class="mt-1 whitespace-pre-wrap break-all text-ink/40">{{ log.details }}</pre>
              </div>
            </div>
          </details>        </aside>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import NoSleep from 'nosleep.js';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { DeviceIdentity } from './identity/DeviceIdentity';
import { SignalingClient } from './signaling/SignalingClient';
import { DeviceStore } from './storage/DeviceStore';
import { TransferEngine } from './transfer/TransferEngine';
import type { BandwidthMode, DeviceRecord, FileMeta, LocalIdentity, SignalingMessage, TransferProgress } from './types';

const DIRECT_SAVE_THRESHOLD = 512 * 1024 * 1024;
const PHONE_RELAY_THRESHOLD = 8 * 1024 * 1024;
const ACCEPT_TIMEOUT_MS = 120000;
const messages = {
  zh: {
    local: '本机', connecting: '正在连接信令服务', online: '在线', offline: '离线', devices: '局域网设备', selectTarget: '选择目标设备', refresh: '刷新', emptyDevices: '在同一局域网的另一台设备打开 CrossLAN，它会出现在这里。', deviceId: '设备 ID', lastSeen: '最后在线', transfers: '传输', noTransfers: '还没有传输任务。', cancel: '取消', send: '发送', receive: '接收', openDownload: '打开下载', storage: '存储', saveDirectory: 'PC 保存目录', storageHint: '发送到这台 PC 的大文件会直接保存到这里。Docker 通常映射到 /data/CrossLAN。', savePath: '保存路径', network: '网络', speedLimit: '速度限制', unlimited: '不限速', manual: '手动', auto: '自动', diagnostics: '诊断', recentEvents: '最近事件', clear: '清空', noDebugEvents: '暂无诊断事件。', direct: '直存', browserDownload: '浏览器下载', p2p: 'P2P', measuring: '测速中', receivePrompt: '接收', receiveLargePrompt: '接收大文件', receiverRejected: '接收方已拒绝文件。', waitingSender: '已接受，等待发送方...', waitingLink: '已接受，等待下载链接...', receiveComplete: '接收完成', savingDisk: '正在写入 PC 磁盘...', downloadReady: '下载已准备好。如果没有自动打开，请点“打开下载”。', sentDownloadManager: '已交给浏览器下载管理器。', waitConfirm: '等待对方确认...', waitPhoneConfirm: '等待手机确认...', savedToPc: '已保存到 PC', preparingPhone: '正在为手机准备浏览器下载...', linkSentPhone: '下载链接已发送到手机。', loadStorage: '正在读取保存目录...', loadStorageFailed: '读取保存目录失败。', saveStorageFailed: '保存目录失败。', current: '当前', saved: '已保存', parseFailed: '无法解析服务器响应。', uploadHttpFailed: '上传失败', uploadNetworkFailed: '上传失败：无法连接到 PC 服务。', cancelled: '传输已取消。', remoteCancelled: '对方已取消传输。', confirmTimeout: '等待对方确认超时。', failed: '传输失败。', duplicateSending: '这个文件正在传输中，已沿用现有任务。', duplicateIncoming: '相同文件已有接收任务，已忽略重复请求。', receivingRelay: '发送方正在上传到临时下载区...'
  },
  en: {
    local: 'Local', connecting: 'Connecting to signaling server', online: 'Online', offline: 'Offline', devices: 'LAN devices', selectTarget: 'Select target device', refresh: 'Refresh', emptyDevices: 'Open CrossLAN on another device in the same LAN and it will appear here.', deviceId: 'Device ID', lastSeen: 'Last seen', transfers: 'Transfers', noTransfers: 'No transfers yet.', cancel: 'Cancel', send: 'Send', receive: 'Receive', openDownload: 'Open download', storage: 'Storage', saveDirectory: 'PC save directory', storageHint: 'Large files sent to this PC are saved directly here. Docker usually maps this to /data/CrossLAN.', savePath: 'Save path', network: 'Network', speedLimit: 'Speed limit', unlimited: 'Unlimited', manual: 'Manual', auto: 'Auto', diagnostics: 'Diagnostics', recentEvents: 'Recent events', clear: 'Clear', noDebugEvents: 'No debug events yet.', direct: 'Direct save', browserDownload: 'Browser download', p2p: 'P2P', measuring: 'measuring', receivePrompt: 'Receive', receiveLargePrompt: 'Receive large file', receiverRejected: 'Receiver rejected the file.', waitingSender: 'Accepted. Waiting for sender...', waitingLink: 'Accepted. Waiting for download link...', receiveComplete: 'Receive complete', savingDisk: 'Saving to PC disk...', downloadReady: 'Download ready. If it did not open, tap Open download.', sentDownloadManager: 'Sent to browser download manager.', waitConfirm: 'Waiting for receiver confirmation...', waitPhoneConfirm: 'Waiting for phone confirmation...', savedToPc: 'Saved to PC', preparingPhone: 'Preparing browser download for phone...', linkSentPhone: 'Download link sent to phone.', loadStorage: 'Loading save directory...', loadStorageFailed: 'Failed to load save directory.', saveStorageFailed: 'Failed to save directory.', current: 'Current', saved: 'Saved', parseFailed: 'Failed to parse server response.', uploadHttpFailed: 'Upload failed', uploadNetworkFailed: 'Upload failed: cannot connect to PC service.', cancelled: 'Transfer cancelled.', remoteCancelled: 'Peer cancelled the transfer.', confirmTimeout: 'Timed out waiting for receiver confirmation.', failed: 'Transfer failed.', duplicateSending: 'This file is already being transferred. Reusing the existing task.', duplicateIncoming: 'The same file already has a receive task. Ignoring the duplicate request.', receivingRelay: 'Sender is uploading to the temporary download area...' }
};

type PendingAccept = { resolve: () => void; reject: (error: Error) => void; timer: number };
type DebugLevel = 'info' | 'warn' | 'error';
type DebugLog = { id: number; time: string; level: DebugLevel; message: string; details?: string };

const DEBUG_LOG_LIMIT = 120;

const identity = new DeviceIdentity();
const store = new DeviceStore();
const signaling = new SignalingClient();
const engine = new TransferEngine(signaling, () => identity.getDeviceId());
const noSleep = new NoSleep();

const connected = ref(false);
const localIdentity = ref<LocalIdentity | null>(null);
const devices = ref<DeviceRecord[]>([]);
const progress = ref(new Map<string, TransferProgress>());
const debugLogs = ref<DebugLog[]>([]);
const speedSamples = new Map<string, { startedAt: number; lastAt: number; lastBytes: number }>();
const lastDebugProgressAt = new Map<string, number>();
const pendingDirectAccepts = new Map<string, PendingAccept>();
const pendingRelayAccepts = new Map<string, PendingAccept>();
const activeUploads = new Map<string, XMLHttpRequest>();
const activePeers = new Map<string, string>();
const activeSendKeys = new Map<string, string>();
const incomingPromptKeys = new Map<string, string>();
const activeTransferKeys = new Map<string, string>();
const lastRelayProgressSignalAt = new Map<string, number>();
const autoDownloadedTransfers = new Set<string>();
const fileInput = ref<HTMLInputElement | null>(null);
const pendingTarget = ref<DeviceRecord | null>(null);
const bandwidthMode = ref<BandwidthMode>('unlimited');
const manualLimitMbps = ref(80);
const saveDirInput = ref('');
const storageMessage = ref(messages.zh.loadStorage);
const storageStatusOk = ref(true);
const progressItems = computed(() => [...progress.value.values()]);
const isZh = computed(() => navigator.language.toLowerCase().startsWith('zh'));
const t = computed(() => isZh.value ? messages.zh : messages.en);
const localStatus = computed(() => localIdentity.value ? `${t.value.local} ${localIdentity.value.ip}` : t.value.connecting);
const protocolLabel = computed(() => location.protocol === 'https:' ? 'HTTPS' : 'HTTP LAN');

onMounted(() => {
  addLog('app mounted', { href: location.href, userAgent: navigator.userAgent });
  signaling.onDebug((message, details, level) => addLog(message, details, level));
  engine.onDebug((message, details, level) => addLog(message, details, level));

  signaling.onMessage(async message => {
    addLog(`signal received: ${message.type}`, summarizeMessage(message));
    connected.value = true;
    await engine.handleSignal(message);
    await handleAppMessage(message);
  });

  engine.onIncoming(async meta => {
    const ok = window.confirm(`${t.value.receivePrompt} ${meta.name} (${formatBytes(meta.size)})?`);
    if (ok) enableWakeLock();
    return ok;
  });

  engine.onProgress(item => {
    logProgress(item);
    const sampled = withSpeedSample(item);
    const finalItem = maybeAutoDownload(sampled);
    progress.value = new Map(progress.value).set(finalItem.id, finalItem);
    if (finalItem.done) {
      speedSamples.delete(finalItem.id);
      disableWakeLock();
    }
  });

  signaling.connect();
  void loadStorageDir();
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('beforeunload', cleanup);
});

onUnmounted(cleanup);

watch([bandwidthMode, manualLimitMbps], () => {
  engine.setBandwidthLimit({
    mode: bandwidthMode.value,
    bytesPerSecond: bandwidthMode.value === 'manual' ? (manualLimitMbps.value * 1024 * 1024) / 8 : null
  });
});

async function handleAppMessage(message: SignalingMessage) {
  if (message.type === 'hello') {
    localIdentity.value = identity.applyServerIdentity(message.device, message.serverIps);
    await store.upsert(localIdentity.value);
    return;
  }

  if (message.type === 'device-list') {
    devices.value = message.devices;
    await store.upsertMany(message.devices);
    return;
  }

  if (message.type === 'direct-transfer-request') {
    await handleDirectTransferRequest(message.from, message.fileMeta);
    return;
  }

  if (message.type === 'direct-transfer-accept') {
    resolvePending(pendingDirectAccepts, message.transferId);
    return;
  }

  if (message.type === 'direct-transfer-reject') {
    rejectPending(pendingDirectAccepts, message.transferId, message.reason || t.value.receiverRejected);
    return;
  }

  if (message.type === 'direct-transfer-progress') {
    updateDirectReceiveProgress(message.transferId, message.fileName, message.bytesTransferred, message.totalBytes, false);
    return;
  }

  if (message.type === 'direct-transfer-complete') {
    updateDirectReceiveProgress(message.transferId, message.fileName, message.bytesTransferred, message.totalBytes, true, `${t.value.savedToPc}: ${message.path}`);
    disableWakeLock();
    return;
  }

  if (message.type === 'direct-transfer-error') {
    const current = progress.value.get(message.transferId);
    if (current?.direction === 'send') return;
    progress.value = new Map(progress.value).set(message.transferId, {
      id: message.transferId,
      direction: 'receive',
      fileName: message.fileName || 'Direct file',
      bytesTransferred: current?.bytesTransferred || 0,
      totalBytes: current?.totalBytes || 0,
      done: true,
      mode: 'direct',
      statusText: message.message
    });
    disableWakeLock();
    return;
  }

  if (message.type === 'relay-transfer-request') {
    await handleRelayTransferRequest(message.from, message.fileMeta);
    return;
  }

  if (message.type === 'relay-transfer-accept') {
    resolvePending(pendingRelayAccepts, message.transferId);
    return;
  }

  if (message.type === 'relay-transfer-reject') {
    rejectPending(pendingRelayAccepts, message.transferId, message.reason || t.value.receiverRejected);
    return;
  }

  if (message.type === 'relay-transfer-progress') {
    updateRelayReceiveProgress(message.transferId, message.fileName, message.bytesTransferred, message.totalBytes);
    return;
  }

  if (message.type === 'relay-transfer-ready') {
    handleRelayTransferReady(message.transferId, message.fileName, message.downloadUrl, message.bytesWritten);
    return;
  }

  if (message.type === 'transfer-cancel') {
    handleRemoteCancel(message.transferId, message.from, message.reason);
  }
}

function enableWakeLock() {
  try {
    void Promise.resolve(noSleep.enable()).catch(error => addLog('wake lock enable failed', { error: errorMessage(error) }, 'warn'));
  } catch (error) {
    addLog('wake lock enable failed', { error: errorMessage(error) }, 'warn');
  }
}

function disableWakeLock() {
  try {
    noSleep.disable();
  } catch (error) {
    addLog('wake lock disable failed', { error: errorMessage(error) }, 'warn');
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function addLog(message: string, details?: unknown, level: DebugLevel = 'info') {
  const entry: DebugLog = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    time: new Date().toLocaleTimeString(),
    level,
    message,
    details: details === undefined ? undefined : stringifyDetails(details)
  };
  debugLogs.value = [entry, ...debugLogs.value].slice(0, DEBUG_LOG_LIMIT);
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  method('[CrossLAN]', message, details ?? '');
}

function clearLogs() {
  debugLogs.value = [];
  addLog('debug log cleared');
}

function stringifyDetails(details: unknown) {
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

function summarizeMessage(message: SignalingMessage) {
  const copy = { ...message } as Record<string, unknown>;
  if (copy.description) copy.description = '[rtc-description]';
  if (copy.candidate) copy.candidate = '[ice-candidate]';
  if (copy.fileMeta && typeof copy.fileMeta === 'object') {
    const meta = copy.fileMeta as Record<string, unknown>;
    copy.fileMeta = { transferId: meta.transferId, name: meta.name, size: meta.size, type: meta.type };
  }
  return copy;
}

function logProgress(item: TransferProgress) {
  const now = performance.now();
  const previous = lastDebugProgressAt.get(item.id) || 0;
  if (!item.done && now - previous < 2000) return;
  lastDebugProgressAt.set(item.id, now);
  addLog('transfer progress', {
    id: item.id,
    direction: item.direction,
    mode: item.mode || 'p2p',
    fileName: item.fileName,
    bytesTransferred: item.bytesTransferred,
    totalBytes: item.totalBytes,
    done: item.done,
    statusText: item.statusText
  });
}

function logDownloadOpen(item: TransferProgress) {
  addLog('download link opened', { id: item.id, fileName: item.fileName, url: item.downloadUrl });
}
function requestRefresh() {
  signaling.requestDeviceList();
}

async function chooseAndSend(device: DeviceRecord) {
  pendingTarget.value = device;

  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ multiple: false });
      const file = await handle?.getFile();
      if (file) {
        await sendSelectedFile(device, file);
        return;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }

  fileInput.value?.click();
}

async function handleFilePicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  const target = pendingTarget.value;
  input.value = '';
  if (!file || !target) return;
  await sendSelectedFile(target, file);
}

async function sendSelectedFile(target: DeviceRecord, file: File) {
  addLog('file selected', { target: target.id, targetIp: target.ip, targetUa: target.userAgent, file: file.name, size: file.size, direct: shouldDirectSave(target, file), relay: shouldRelayToBrowserDownload(target, file) });
  enableWakeLock();
  if (shouldDirectSave(target, file)) {
    await sendDirectToServer(target, file);
    return;
  }
  if (shouldRelayToBrowserDownload(target, file)) {
    await sendRelayToBrowserDownload(target, file);
    return;
  }
  await engine.sendFile(target.id, file);
}

async function handleDirectTransferRequest(from: string, meta: FileMeta) {
  addLog('direct request received', { from, transferId: meta.transferId, file: meta.name, size: meta.size });
  if (rejectDuplicateIncoming(from, meta, 'direct')) return;
  const ok = window.confirm(`${t.value.receiveLargePrompt} ${meta.name} (${formatBytes(meta.size)})?`);
  if (!ok) {
    signaling.send({ type: 'direct-transfer-reject', to: from, transferId: meta.transferId, reason: t.value.receiverRejected });
    return;
  }

  enableWakeLock();
  trackIncomingTransfer(from, meta, 'direct');
  progress.value = new Map(progress.value).set(meta.transferId, {
    id: meta.transferId,
    direction: 'receive',
    fileName: meta.name,
    bytesTransferred: 0,
    totalBytes: meta.size,
    done: false,
    mode: 'direct',
    cancellable: true,
    peerId: from,
    statusText: t.value.waitingSender
  });
  signaling.send({ type: 'direct-transfer-accept', to: from, transferId: meta.transferId });
  addLog('direct request accepted', { to: from, transferId: meta.transferId });
}

async function handleRelayTransferRequest(from: string, meta: FileMeta) {
  addLog('relay request received', { from, transferId: meta.transferId, file: meta.name, size: meta.size });
  if (rejectDuplicateIncoming(from, meta, 'relay')) return;
  const ok = window.confirm(`${t.value.receiveLargePrompt} ${meta.name} (${formatBytes(meta.size)})?`);
  if (!ok) {
    signaling.send({ type: 'relay-transfer-reject', to: from, transferId: meta.transferId, reason: t.value.receiverRejected });
    return;
  }

  enableWakeLock();
  trackIncomingTransfer(from, meta, 'relay');
  progress.value = new Map(progress.value).set(meta.transferId, {
    id: meta.transferId,
    direction: 'receive',
    fileName: meta.name,
    bytesTransferred: 0,
    totalBytes: meta.size,
    done: false,
    mode: 'relay',
    cancellable: true,
    peerId: from,
    statusText: t.value.waitingLink
  });
  signaling.send({ type: 'relay-transfer-accept', to: from, transferId: meta.transferId });
  addLog('relay request accepted', { to: from, transferId: meta.transferId });
}

function waitForPending(map: Map<string, PendingAccept>, transferId: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      map.delete(transferId);
      reject(new Error(t.value.confirmTimeout));
    }, ACCEPT_TIMEOUT_MS);
    map.set(transferId, { resolve, reject, timer });
  });
}

function resolvePending(map: Map<string, PendingAccept>, transferId: string) {
  const pending = map.get(transferId);
  if (!pending) return;
  window.clearTimeout(pending.timer);
  map.delete(transferId);
  pending.resolve();
}

function rejectPending(map: Map<string, PendingAccept>, transferId: string, reason: string) {
  const pending = map.get(transferId);
  if (!pending) return;
  window.clearTimeout(pending.timer);
  map.delete(transferId);
  pending.reject(new Error(reason));
}

function rejectDuplicateIncoming(from: string, meta: FileMeta, mode: 'direct' | 'relay') {
  const key = createMetaTransferKey(from, meta, mode);
  const existingId = incomingPromptKeys.get(key);
  if (!existingId || !isTransferActive(existingId)) {
    if (existingId) incomingPromptKeys.delete(key);
    return false;
  }
  addLog('duplicate incoming request ignored', { from, transferId: meta.transferId, existingId, file: meta.name, mode }, 'warn');
  signaling.send({ type: mode === 'direct' ? 'direct-transfer-reject' : 'relay-transfer-reject', to: from, transferId: meta.transferId, reason: t.value.duplicateIncoming });
  return true;
}

function trackIncomingTransfer(from: string, meta: FileMeta, mode: 'direct' | 'relay') {
  const key = createMetaTransferKey(from, meta, mode);
  incomingPromptKeys.set(key, meta.transferId);
  activeTransferKeys.set(meta.transferId, key);
}

function updateDirectReceiveProgress(transferId: string, fileName: string, bytesTransferred: number, totalBytes: number, done: boolean, statusText?: string) {
  const current = progress.value.get(transferId);
  if (current?.direction === 'send') return;
  const item = withSpeedSample({
    id: transferId,
    direction: 'receive',
    fileName,
    bytesTransferred,
    totalBytes,
    done,
    mode: 'direct',
    cancellable: !done,
    peerId: current?.peerId,
    statusText: statusText || (done ? t.value.receiveComplete : t.value.savingDisk)
  });
  progress.value = new Map(progress.value).set(transferId, item);
}

function updateRelayReceiveProgress(transferId: string, fileName: string, bytesTransferred: number, totalBytes: number) {
  const current = progress.value.get(transferId);
  if (current?.direction === 'send' || current?.done) return;
  setProgress(withSpeedSample({
    id: transferId,
    direction: 'receive',
    fileName,
    bytesTransferred,
    totalBytes,
    done: false,
    mode: 'relay',
    cancellable: true,
    peerId: current?.peerId,
    statusText: t.value.receivingRelay
  }));
}

function handleRelayTransferReady(transferId: string, fileName: string, downloadUrl: string, bytesWritten: number) {
  const current = progress.value.get(transferId);
  const absoluteUrl = new URL(downloadUrl, location.origin).toString();
  addLog('relay download ready', { transferId, fileName, bytesWritten, absoluteUrl });
  triggerBrowserDownload(absoluteUrl, fileName);
  progress.value = new Map(progress.value).set(transferId, {
    id: transferId,
    direction: 'receive',
    fileName,
    bytesTransferred: bytesWritten,
    totalBytes: current?.totalBytes || bytesWritten,
    done: true,
    mode: 'relay',
    downloadUrl: absoluteUrl,
    needsUserSave: true,
    cancellable: false,
    peerId: current?.peerId,
    statusText: t.value.downloadReady
  });
  clearTransferBookkeeping(transferId);
  disableWakeLock();
}

function withSpeedSample(item: TransferProgress): TransferProgress {
  const now = performance.now();
  const previous = speedSamples.get(item.id);
  if (!previous) {
    speedSamples.set(item.id, { startedAt: now, lastAt: now, lastBytes: item.bytesTransferred });
    return item;
  }

  const deltaMs = Math.max(now - previous.lastAt, 1);
  const deltaBytes = Math.max(item.bytesTransferred - previous.lastBytes, 0);
  const elapsedSeconds = Math.max((now - previous.startedAt) / 1000, 0.001);
  const sampled = {
    ...item,
    speedBytesPerSecond: (deltaBytes / deltaMs) * 1000,
    averageBytesPerSecond: item.bytesTransferred / elapsedSeconds
  };
  speedSamples.set(item.id, { ...previous, lastAt: now, lastBytes: item.bytesTransferred });
  return sampled;
}

function maybeAutoDownload(item: TransferProgress): TransferProgress {
  if (!item.downloadUrl || !item.needsUserSave || autoDownloadedTransfers.has(item.id)) return item;
  autoDownloadedTransfers.add(item.id);
  triggerBrowserDownload(item.downloadUrl, item.fileName);
  window.setTimeout(() => URL.revokeObjectURL(item.downloadUrl!), 30000);
  return { ...item, needsUserSave: false, statusText: t.value.sentDownloadManager };
}

function triggerBrowserDownload(url: string, fileName: string) {
  addLog('trigger browser download', { fileName, url });
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function shouldDirectSave(target: DeviceRecord, file: File) {
  return file.size >= DIRECT_SAVE_THRESHOLD && canDirectSaveTo(target);
}

function shouldRelayToBrowserDownload(target: DeviceRecord, file: File) {
  return file.size >= PHONE_RELAY_THRESHOLD && !canDirectSaveTo(target);
}

function canDirectSaveTo(target: DeviceRecord) {
  const serverIps = localIdentity.value?.serverIps ?? [];
  if (serverIps.includes(target.ip)) return true;
  if (target.ip === location.hostname || target.id === location.hostname) return true;
  return isDesktopUserAgent(target.userAgent);
}


function deviceReceiveModeLabel(device: DeviceRecord) {
  if (canDirectSaveTo(device)) return t.value.direct;
  return t.value.browserDownload;
}

function isDesktopUserAgent(userAgent?: string | null) {
  if (!userAgent) return false;
  return !isMobileUserAgent(userAgent);
}

function isMobileUserAgent(userAgent?: string | null) {
  return /Mobile|Android|iPhone|iPad|iPod/i.test(userAgent || '');
}

async function sendDirectToServer(target: DeviceRecord, file: File) {
  const duplicateId = findActiveSend(target.id, file, 'direct');
  if (duplicateId) {
    updateStatus(duplicateId, t.value.waitConfirm);
    addLog('duplicate direct send reused', { duplicateId, target: target.id, file: file.name, size: file.size }, 'warn');
    if (pendingDirectAccepts.has(duplicateId)) {
      signaling.send({ type: 'direct-transfer-request', to: target.id, fileMeta: createFileMeta(duplicateId, file) });
      addLog('direct request resent', { transferId: duplicateId, to: target.id });
    }
    return;
  }
  const id = createTransferId();
  trackActiveSend(target.id, file, 'direct', id);
  activePeers.set(id, target.id);
  addLog('direct send created', { transferId: id, target: target.id, file: file.name, size: file.size });
  const fileMeta = createFileMeta(id, file);
  setProgress({
    id,
    direction: 'send',
    fileName: file.name,
    bytesTransferred: 0,
    totalBytes: file.size,
    done: false,
    mode: 'direct',
    cancellable: true,
    peerId: target.id,
    statusText: t.value.waitConfirm
  });

  try {
    const accepted = waitForPending(pendingDirectAccepts, id);
    signaling.send({ type: 'direct-transfer-request', to: target.id, fileMeta });
    addLog('direct request sent', { transferId: id, to: target.id });
    await accepted;
    addLog('direct request accepted by peer', { transferId: id });
    updateStatus(id, t.value.savingDisk);

    const result = await uploadWithProgress(file, id, uploaded => updateUploaded(id, uploaded));
    setProgress({
      id,
      direction: 'send',
      fileName: file.name,
      bytesTransferred: file.size,
      totalBytes: file.size,
      done: true,
      mode: 'direct',
      cancellable: false,
      peerId: target.id,
      statusText: `${t.value.savedToPc}: ${result.path}`
    });
  } catch (error) {
    markFailed(id, file, 'direct', error);
  } finally {
    pendingDirectAccepts.delete(id);
    clearTransferBookkeeping(id);
    disableWakeLock();
  }
}

async function sendRelayToBrowserDownload(target: DeviceRecord, file: File) {
  const duplicateId = findActiveSend(target.id, file, 'relay');
  if (duplicateId) {
    updateStatus(duplicateId, t.value.waitPhoneConfirm);
    addLog('duplicate relay send reused', { duplicateId, target: target.id, file: file.name, size: file.size }, 'warn');
    if (pendingRelayAccepts.has(duplicateId)) {
      signaling.send({ type: 'relay-transfer-request', to: target.id, fileMeta: createFileMeta(duplicateId, file) });
      addLog('relay request resent', { transferId: duplicateId, to: target.id });
    }
    return;
  }
  const id = createTransferId();
  trackActiveSend(target.id, file, 'relay', id);
  activePeers.set(id, target.id);
  addLog('relay send created', { transferId: id, target: target.id, file: file.name, size: file.size });
  const fileMeta = createFileMeta(id, file);
  setProgress({
    id,
    direction: 'send',
    fileName: file.name,
    bytesTransferred: 0,
    totalBytes: file.size,
    done: false,
    mode: 'relay',
    cancellable: true,
    peerId: target.id,
    statusText: t.value.waitPhoneConfirm
  });

  try {
    const accepted = waitForPending(pendingRelayAccepts, id);
    signaling.send({ type: 'relay-transfer-request', to: target.id, fileMeta });
    addLog('relay request sent', { transferId: id, to: target.id });
    await accepted;
    addLog('relay request accepted by peer', { transferId: id });
    updateStatus(id, t.value.preparingPhone);

    const result = await uploadRelayWithProgress(file, id, uploaded => {
      updateUploaded(id, uploaded);
      sendRelayProgress(target.id, id, file.name, uploaded, file.size);
    });
    sendRelayProgress(target.id, id, file.name, file.size, file.size, true);
    addLog('relay upload finished', { transferId: id, result });
    signaling.send({
      type: 'relay-transfer-ready',
      to: target.id,
      transferId: id,
      fileName: result.fileName,
      downloadUrl: result.downloadUrl,
      bytesWritten: result.bytesWritten
    });

    setProgress({
      id,
      direction: 'send',
      fileName: file.name,
      bytesTransferred: file.size,
      totalBytes: file.size,
      done: true,
      mode: 'relay',
      cancellable: false,
      peerId: target.id,
      statusText: t.value.linkSentPhone
    });
  } catch (error) {
    markFailed(id, file, 'relay', error);
  } finally {
    pendingRelayAccepts.delete(id);
    clearTransferBookkeeping(id);
    disableWakeLock();
  }
}

function cancelTransfer(item: TransferProgress) {
  addLog('transfer cancel requested', { transferId: item.id, direction: item.direction, mode: item.mode, peerId: item.peerId });
  activeUploads.get(item.id)?.abort();
  activeUploads.delete(item.id);
  rejectPending(pendingDirectAccepts, item.id, t.value.cancelled);
  rejectPending(pendingRelayAccepts, item.id, t.value.cancelled);
  const peerId = item.peerId || activePeers.get(item.id);
  if (peerId) signaling.send({ type: 'transfer-cancel', to: peerId, transferId: item.id, reason: t.value.remoteCancelled });
  markCancelled(item.id, t.value.cancelled);
  disableWakeLock();
}

function handleRemoteCancel(transferId: string, from: string, reason?: string) {
  addLog('remote transfer cancelled', { transferId, from, reason }, 'warn');
  activeUploads.get(transferId)?.abort();
  activeUploads.delete(transferId);
  rejectPending(pendingDirectAccepts, transferId, reason || t.value.remoteCancelled);
  rejectPending(pendingRelayAccepts, transferId, reason || t.value.remoteCancelled);
  markCancelled(transferId, reason || t.value.remoteCancelled, from);
  disableWakeLock();
}

function markCancelled(transferId: string, statusText: string, peerId?: string) {
  const current = progress.value.get(transferId);
  if (!current) return;
  setProgress({
    ...current,
    done: true,
    cancellable: false,
    cancelled: true,
    peerId: peerId || current.peerId,
    statusText
  });
  clearTransferBookkeeping(transferId);
}

function findActiveSend(targetId: string, file: File, mode: 'direct' | 'relay') {
  const key = createFileTransferKey(targetId, file, mode);
  const existingId = activeSendKeys.get(key);
  if (!existingId) return '';
  if (isTransferActive(existingId)) return existingId;
  activeSendKeys.delete(key);
  activeTransferKeys.delete(existingId);
  return '';
}

function trackActiveSend(targetId: string, file: File, mode: 'direct' | 'relay', transferId: string) {
  const key = createFileTransferKey(targetId, file, mode);
  activeSendKeys.set(key, transferId);
  activeTransferKeys.set(transferId, key);
}

function createFileTransferKey(peerId: string, file: File, mode: 'direct' | 'relay') {
  return `${mode}:${peerId}:${file.name}:${file.size}:${file.lastModified}`;
}

function createMetaTransferKey(peerId: string, meta: FileMeta, mode: 'direct' | 'relay') {
  return `${mode}:${peerId}:${meta.name}:${meta.size}:${meta.lastModified}`;
}

function isTransferActive(transferId: string) {
  const item = progress.value.get(transferId);
  return activeUploads.has(transferId) || pendingDirectAccepts.has(transferId) || pendingRelayAccepts.has(transferId) || Boolean(item && !item.done);
}

function clearTransferBookkeeping(transferId: string) {
  const key = activeTransferKeys.get(transferId);
  if (key) {
    if (activeSendKeys.get(key) === transferId) activeSendKeys.delete(key);
    if (incomingPromptKeys.get(key) === transferId) incomingPromptKeys.delete(key);
    activeTransferKeys.delete(transferId);
  }
  activePeers.delete(transferId);
  activeUploads.delete(transferId);
  speedSamples.delete(transferId);
  lastRelayProgressSignalAt.delete(transferId);
}

function createFileMeta(transferId: string, file: File): FileMeta {
  return {
    transferId,
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified
  };
}

function setProgress(item: TransferProgress) {
  progress.value = new Map(progress.value).set(item.id, item);
}

function updateStatus(id: string, statusText: string) {
  const current = progress.value.get(id);
  if (!current) return;
  setProgress({ ...current, statusText });
}

function updateUploaded(id: string, uploaded: number) {
  const current = progress.value.get(id);
  if (!current) return;
  setProgress(withSpeedSample({ ...current, bytesTransferred: uploaded }));
}

function sendRelayProgress(to: string, transferId: string, fileName: string, bytesTransferred: number, totalBytes: number, force = false) {
  const now = performance.now();
  const previous = lastRelayProgressSignalAt.get(transferId) || 0;
  if (!force && bytesTransferred < totalBytes && now - previous < 500) return;
  lastRelayProgressSignalAt.set(transferId, now);
  signaling.send({ type: 'relay-transfer-progress', to, transferId, fileName, bytesTransferred, totalBytes });
}

function markFailed(id: string, file: File, mode: 'direct' | 'relay', error: unknown) {
  const message = error instanceof Error ? error.message : t.value.failed;
  const current = progress.value.get(id);
  addLog('transfer failed', { transferId: id, file: file.name, mode, error: message }, message === t.value.cancelled ? 'warn' : 'error');
  setProgress({
    id,
    direction: 'send',
    fileName: file.name,
    bytesTransferred: current?.bytesTransferred || 0,
    totalBytes: file.size,
    done: true,
    mode,
    cancellable: false,
    cancelled: message === t.value.cancelled || message === t.value.remoteCancelled,
    peerId: current?.peerId,
    statusText: message
  });
}

function uploadWithProgress(file: File, transferId: string, onProgress: (uploaded: number) => void) {
  return uploadFileWithProgress<{ path: string; bytesWritten: number }>('/api/transfers/direct', file, transferId, onProgress);
}

function uploadRelayWithProgress(file: File, transferId: string, onProgress: (uploaded: number) => void) {
  return uploadFileWithProgress<{ fileName: string; downloadUrl: string; bytesWritten: number }>('/api/transfers/relay', file, transferId, onProgress);
}

function uploadFileWithProgress<T extends Record<string, unknown>>(endpoint: string, file: File, transferId: string | undefined, onProgress: (uploaded: number) => void) {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);
    if (transferId) activeUploads.set(transferId, xhr);
    addLog('http upload opened', { endpoint, transferId, file: file.name, size: file.size });
    if (transferId) xhr.setRequestHeader('x-crosslan-transfer-id', transferId);
    xhr.setRequestHeader('x-crosslan-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('x-crosslan-file-size', String(file.size));
    let lastUploadLogAt = 0;
    xhr.upload.onloadstart = () => addLog('http upload started', { endpoint, transferId });
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) {
        onProgress(event.loaded);
        const now = performance.now();
        if (now - lastUploadLogAt > 2000 || event.loaded === event.total) {
          lastUploadLogAt = now;
          addLog('http upload progress', { endpoint, transferId, loaded: event.loaded, total: event.total });
        }
      } else {
        addLog('http upload progress without total', { endpoint, transferId, loaded: event.loaded }, 'warn');
      }
    };
    xhr.onload = () => {
      if (transferId) activeUploads.delete(transferId);
      addLog('http upload response', { endpoint, transferId, status: xhr.status, response: xhr.responseText?.slice(0, 500) });
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText || '{}') as Record<string, unknown>;
      } catch {
        reject(new Error(t.value.parseFailed));
        return;
      }

      if (xhr.status >= 200 && xhr.status < 300 && body.ok) {
        resolve(body as T);
        return;
      }
      reject(new Error(String(body.message || `Upload failed: HTTP ${xhr.status}`)));
    };
    xhr.onerror = () => {
      if (transferId) activeUploads.delete(transferId);
      addLog('http upload network error', { endpoint, transferId }, 'error');
      reject(new Error(t.value.uploadNetworkFailed));
    };
    xhr.onabort = () => {
      if (transferId) activeUploads.delete(transferId);
      addLog('http upload aborted', { endpoint, transferId }, 'warn');
      reject(new Error(t.value.cancelled));
    };
    xhr.send(file);
  });
}

async function loadStorageDir() {
  try {
    const response = await fetch('/api/storage');
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || t.value.loadStorageFailed);
    saveDirInput.value = data.saveDir;
    storageMessage.value = `${t.value.current}: ${data.saveDir}`;
    storageStatusOk.value = true;
  } catch (error) {
    storageMessage.value = error instanceof Error ? error.message : t.value.loadStorageFailed;
    storageStatusOk.value = false;
  }
}

async function saveStorageDir() {
  try {
    const response = await fetch('/api/storage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ saveDir: saveDirInput.value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || t.value.saveStorageFailed);
    saveDirInput.value = data.saveDir;
    storageMessage.value = `${t.value.saved}: ${data.saveDir}`;
    storageStatusOk.value = true;
  } catch (error) {
    storageMessage.value = error instanceof Error ? error.message : t.value.saveStorageFailed;
    storageStatusOk.value = false;
  }
}

function handleVisibility() {
  if (document.visibilityState === 'visible') {
    signaling.requestDeviceList();
  }
}

function cleanup() {
  document.removeEventListener('visibilitychange', handleVisibility);
  window.removeEventListener('beforeunload', cleanup);
  for (const pending of pendingDirectAccepts.values()) window.clearTimeout(pending.timer);
  pendingDirectAccepts.clear();
  for (const pending of pendingRelayAccepts.values()) window.clearTimeout(pending.timer);
  pendingRelayAccepts.clear();
  for (const xhr of activeUploads.values()) xhr.abort();
  activeUploads.clear();
  activePeers.clear();
  activeSendKeys.clear();
  incomingPromptKeys.clear();
  activeTransferKeys.clear();
  lastRelayProgressSignalAt.clear();
  disableWakeLock();
  signaling.close();
}

function percent(item: TransferProgress) {
  if (!item.totalBytes) return 0;
  return Math.min(100, (item.bytesTransferred / item.totalBytes) * 100);
}

function modeLabel(mode?: TransferProgress['mode']) {
  if (mode === 'direct') return t.value.direct;
  if (mode === 'relay') return t.value.browserDownload;
  return t.value.p2p;
}

function formatSpeed(bytesPerSecond?: number) {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond)) return t.value.measuring;
  return formatBytes(bytesPerSecond) + '/s';
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString();
}

function createTransferId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
</script>
