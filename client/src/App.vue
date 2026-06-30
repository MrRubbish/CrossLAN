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

          <input ref="fileInput" type="file" accept="*/*" multiple class="hidden" @change="handleFilePicked" />
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
const SMALL_BATCH_MAX_TOTAL = 64 * 1024 * 1024;
const SMALL_BATCH_MAX_FILE = PHONE_RELAY_THRESHOLD;
const ACCEPT_TIMEOUT_MS = 120000;
const ZIP32_MAX = 0xffffffff;
const ZIP_CHUNK_SIZE = 4 * 1024 * 1024;
const textEncoder = new TextEncoder();
const messages = {
  zh: {
    local: '本机', connecting: '正在连接信令服务', online: '在线', offline: '离线', devices: '局域网设备', selectTarget: '选择目标设备', refresh: '刷新', emptyDevices: '在同一局域网的另一台设备打开 CrossLAN，它会出现在这里。', deviceId: '设备 ID', lastSeen: '最后在线', transfers: '传输', noTransfers: '还没有传输任务。', cancel: '取消', send: '发送', receive: '接收', openDownload: '打开下载', storage: '存储', saveDirectory: 'PC 保存目录', storageHint: '发送到这台 PC 的大文件会直接保存到这里。Docker 通常映射到 /data/CrossLAN。', savePath: '保存路径', network: '网络', speedLimit: '速度限制', unlimited: '不限速', manual: '手动', auto: '自动', diagnostics: '诊断', recentEvents: '最近事件', clear: '清空', noDebugEvents: '暂无诊断事件。', direct: '直存', browserDownload: '浏览器下载', p2p: 'P2P', measuring: '测速中', receivePrompt: '接收', receiveLargePrompt: '接收大文件', receiverRejected: '接收方已拒绝文件。', waitingSender: '已接受，等待发送方...', waitingLink: '已接受，等待下载链接...', receiveComplete: '接收完成', savingDisk: '正在写入 PC 磁盘...', downloadReady: '下载已准备好。如果没有自动打开，请点“打开下载”。', sentDownloadManager: '已交给浏览器下载管理器。', waitConfirm: '等待对方确认...', waitPhoneConfirm: '等待手机确认...', savedToPc: '已保存到 PC', preparingPhone: '正在为手机准备浏览器下载...', linkSentPhone: '下载链接已发送到手机。', loadStorage: '正在读取保存目录...', loadStorageFailed: '读取保存目录失败。', saveStorageFailed: '保存目录失败。', current: '当前', saved: '已保存', parseFailed: '无法解析服务器响应。', uploadHttpFailed: '上传失败', uploadNetworkFailed: '上传失败：无法连接到 PC 服务。', cancelled: '传输已取消。', remoteCancelled: '对方已取消传输。', confirmTimeout: '等待对方确认超时。', failed: '传输失败。', duplicateSending: '这个文件正在传输中，已沿用现有任务。', duplicateIncoming: '相同文件已有接收任务，已忽略重复请求。', receivingRelay: '正在通过内存流式中继传输...', packagingBatch: '正在打包批量文件...', batchLabel: '批量文件'
  },
  en: {
    local: 'Local', connecting: 'Connecting to signaling server', online: 'Online', offline: 'Offline', devices: 'LAN devices', selectTarget: 'Select target device', refresh: 'Refresh', emptyDevices: 'Open CrossLAN on another device in the same LAN and it will appear here.', deviceId: 'Device ID', lastSeen: 'Last seen', transfers: 'Transfers', noTransfers: 'No transfers yet.', cancel: 'Cancel', send: 'Send', receive: 'Receive', openDownload: 'Open download', storage: 'Storage', saveDirectory: 'PC save directory', storageHint: 'Large files sent to this PC are saved directly here. Docker usually maps this to /data/CrossLAN.', savePath: 'Save path', network: 'Network', speedLimit: 'Speed limit', unlimited: 'Unlimited', manual: 'Manual', auto: 'Auto', diagnostics: 'Diagnostics', recentEvents: 'Recent events', clear: 'Clear', noDebugEvents: 'No debug events yet.', direct: 'Direct save', browserDownload: 'Browser download', p2p: 'P2P', measuring: 'measuring', receivePrompt: 'Receive', receiveLargePrompt: 'Receive large file', receiverRejected: 'Receiver rejected the file.', waitingSender: 'Accepted. Waiting for sender...', waitingLink: 'Accepted. Waiting for download link...', receiveComplete: 'Receive complete', savingDisk: 'Saving to PC disk...', downloadReady: 'Download ready. If it did not open, tap Open download.', sentDownloadManager: 'Sent to browser download manager.', waitConfirm: 'Waiting for receiver confirmation...', waitPhoneConfirm: 'Waiting for phone confirmation...', savedToPc: 'Saved to PC', preparingPhone: 'Preparing browser download for phone...', linkSentPhone: 'Download link sent to phone.', loadStorage: 'Loading save directory...', loadStorageFailed: 'Failed to load save directory.', saveStorageFailed: 'Failed to save directory.', current: 'Current', saved: 'Saved', parseFailed: 'Failed to parse server response.', uploadHttpFailed: 'Upload failed', uploadNetworkFailed: 'Upload failed: cannot connect to PC service.', cancelled: 'Transfer cancelled.', remoteCancelled: 'Peer cancelled the transfer.', confirmTimeout: 'Timed out waiting for receiver confirmation.', failed: 'Transfer failed.', duplicateSending: 'This file is already being transferred. Reusing the existing task.', duplicateIncoming: 'The same file already has a receive task. Ignoring the duplicate request.', receivingRelay: 'Streaming through memory relay...', packagingBatch: 'Packaging batch files...', batchLabel: 'Batch files' }
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
    updateRelayTransferProgress(message.transferId, message.fileName, message.bytesTransferred, message.totalBytes);
    return;
  }

  if (message.type === 'relay-transfer-ready') {
    updateStatus(message.transferId, t.value.sentDownloadManager);
    return;
  }

  if (message.type === 'relay-transfer-error') {
    handleRelayTransferError(message.transferId, message.fileName, message.message);
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
      const handles = await window.showOpenFilePicker({ multiple: true });
      const files = await Promise.all(handles.map(handle => handle.getFile()));
      if (files.length > 0) {
        await sendSelectedFiles(device, files);
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
  const files = [...(input.files ?? [])];
  const target = pendingTarget.value;
  input.value = '';
  if (files.length === 0 || !target) return;
  await sendSelectedFiles(target, files);
}

async function sendSelectedFiles(target: DeviceRecord, files: File[]) {
  if (files.length === 1) {
    await sendSelectedFile(target, files[0]);
    return;
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const plan = createSendPlan(files);
  addLog('batch files selected', { target: target.id, count: files.length, totalSize, plan: plan.map(item => ({ type: Array.isArray(item) ? 'batch' : 'file', count: Array.isArray(item) ? item.length : 1 })) });

  for (const item of plan) {
    const file = Array.isArray(item) ? await createBatchZipFile(item) : item;
    await sendSelectedFile(target, file);
    if (wasLastSendCancelledOrFailed(target.id, file)) break;
  }
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
  const downloadUrl = `/api/transfers/relay/${encodeURIComponent(meta.transferId)}/${encodeURIComponent(meta.name)}?size=${encodeURIComponent(String(meta.size))}`;
  const absoluteUrl = new URL(downloadUrl, location.origin).toString();
  progress.value = new Map(progress.value).set(meta.transferId, {
    id: meta.transferId,
    direction: 'receive',
    fileName: meta.name,
    bytesTransferred: 0,
    totalBytes: meta.size,
    done: false,
    mode: 'relay',
    downloadUrl: absoluteUrl,
    needsUserSave: false,
    cancellable: true,
    peerId: from,
    statusText: t.value.receivingRelay
  });
  signaling.send({ type: 'relay-transfer-accept', to: from, transferId: meta.transferId });
  addLog('relay request accepted', { to: from, transferId: meta.transferId, downloadUrl: absoluteUrl });
  triggerBrowserDownload(absoluteUrl, meta.name);
  signaling.send({ type: 'relay-transfer-ready', to: from, transferId: meta.transferId, fileName: meta.name, downloadUrl, bytesWritten: 0 });
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

function updateRelayTransferProgress(transferId: string, fileName: string, bytesTransferred: number, totalBytes: number) {
  const current = progress.value.get(transferId);
  if (current?.done) return;
  const direction = current?.direction || 'receive';
  setProgress(withSpeedSample({
    id: transferId,
    direction,
    fileName,
    bytesTransferred,
    totalBytes,
    done: false,
    mode: 'relay',
    cancellable: true,
    peerId: current?.peerId,
    statusText: direction === 'send' ? t.value.receivingRelay : t.value.receivingRelay
  }));
}

function handleRelayTransferError(transferId: string, fileName = 'Relay file', message: string) {
  const current = progress.value.get(transferId);
  if (current?.direction === 'send') return;
  addLog('relay transfer error received', { transferId, fileName, direction: current?.direction, message }, 'warn');
  setProgress({
    id: transferId,
    direction: 'receive',
    fileName: current?.fileName || fileName,
    bytesTransferred: current?.bytesTransferred || 0,
    totalBytes: current?.totalBytes || 0,
    done: true,
    mode: 'relay',
    cancellable: false,
    cancelled: message === t.value.cancelled || message === t.value.remoteCancelled,
    peerId: current?.peerId,
    statusText: message
  });
  clearTransferBookkeeping(transferId);
  disableWakeLock();
}
function withSpeedSample(item: TransferProgress): TransferProgress {
  const now = performance.now();
  const previous = speedSamples.get(item.id);
  const current = progress.value.get(item.id);
  const safeTotal = Math.max(item.totalBytes || 0, current?.totalBytes || 0);
  const safeBytes = item.done
    ? Math.max(item.bytesTransferred || 0, current?.bytesTransferred || 0)
    : Math.min(safeTotal || item.bytesTransferred || 0, Math.max(item.bytesTransferred || 0, current?.bytesTransferred || 0));
  const normalized = { ...item, bytesTransferred: safeBytes, totalBytes: safeTotal || item.totalBytes };
  if (!previous) {
    speedSamples.set(item.id, { startedAt: now, lastAt: now, lastBytes: normalized.bytesTransferred });
    return normalized;
  }

  const deltaMs = Math.max(now - previous.lastAt, 1);
  const deltaBytes = Math.max(normalized.bytesTransferred - previous.lastBytes, 0);
  const elapsedSeconds = Math.max((now - previous.startedAt) / 1000, 0.001);
  const sampled = {
    ...normalized,
    speedBytesPerSecond: (deltaBytes / deltaMs) * 1000,
    averageBytesPerSecond: normalized.bytesTransferred / elapsedSeconds
  };
  speedSamples.set(item.id, { ...previous, lastAt: now, lastBytes: normalized.bytesTransferred });
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
      addRelayUploadDebug(id, uploaded, file.size);
    });
    addLog('relay upload finished', { transferId: id, result });
    signaling.send({
      type: 'relay-transfer-ready',
      to: target.id,
      transferId: id,
      fileName: result.fileName,
      downloadUrl: `/api/transfers/relay/${encodeURIComponent(id)}/${encodeURIComponent(result.fileName)}`,
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
      statusText: t.value.sentDownloadManager
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

function wasLastSendCancelledOrFailed(targetId: string, file: File) {
  const candidates = [...progress.value.values()].filter(item => item.direction === 'send' && item.peerId === targetId && item.fileName === file.name && item.totalBytes === file.size);
  const latest = candidates.at(-1);
  return Boolean(latest?.done && (latest.cancelled || (latest.bytesTransferred < latest.totalBytes)));
}

function createSendPlan(files: File[]) {
  const plan: Array<File | File[]> = [];
  let smallBatch: File[] = [];
  let smallBatchSize = 0;

  const flushSmallBatch = () => {
    if (smallBatch.length === 1) {
      plan.push(smallBatch[0]);
    } else if (smallBatch.length > 1) {
      plan.push([...smallBatch]);
    }
    smallBatch = [];
    smallBatchSize = 0;
  };

  for (const file of files) {
    const isSmall = file.size <= SMALL_BATCH_MAX_FILE;
    if (!isSmall) {
      flushSmallBatch();
      plan.push(file);
      continue;
    }

    if (smallBatchSize + file.size > SMALL_BATCH_MAX_TOTAL) flushSmallBatch();
    smallBatch.push(file);
    smallBatchSize += file.size;
  }

  flushSmallBatch();
  return plan;
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
}

function createFileMeta(transferId: string, file: File): FileMeta {
  const meta: FileMeta = {
    transferId,
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified
  };
  const batchCount = getBatchFileCount(file);
  if (batchCount > 0) {
    meta.packageType = 'crosslan-zip';
    meta.packageCount = batchCount;
  }
  return meta;
}

type BatchZipFile = File & { __crosslanPackageType?: 'crosslan-zip'; __crosslanPackageCount?: number };
type ZipEntryInfo = { file: File; name: string; encodedName: Uint8Array; crc: number; offset: number };

function getBatchFileCount(file: File) {
  return (file as BatchZipFile).__crosslanPackageType === 'crosslan-zip' ? ((file as BatchZipFile).__crosslanPackageCount || 0) : 0;
}

async function createBatchZipFile(files: File[]) {
  const safeFiles = files.map((file, index) => ({ file, name: createUniqueZipName(file.name || `file-${index + 1}.bin`, index) }));
  const totalSize = safeFiles.reduce((sum, item) => sum + item.file.size, 0);
  if (files.length > ZIP32_MAX || totalSize > ZIP32_MAX) {
    throw new Error('Batch ZIP is limited to 4 GB in this version.');
  }

  const entries: ZipEntryInfo[] = [];
  const parts: BlobPart[] = [];
  let offset = 0;

  for (const item of safeFiles) {
    const encodedName = textEncoder.encode(item.name);
    const crc = await crc32File(item.file);
    const header = createZipLocalHeader(encodedName, crc, item.file.size);
    entries.push({ ...item, encodedName, crc, offset });
    parts.push(header, item.file);
    offset += header.byteLength + item.file.size;
  }

  const centralStart = offset;
  for (const entry of entries) {
    const central = createZipCentralHeader(entry);
    parts.push(central);
    offset += central.byteLength;
  }
  parts.push(createZipEnd(entries.length, offset - centralStart, centralStart));

  const name = `CrossLAN-${formatBatchTimestamp(new Date())}-${files.length}-files.zip`;
  const zip = new File(parts, name, { type: 'application/zip', lastModified: Date.now() }) as BatchZipFile;
  zip.__crosslanPackageType = 'crosslan-zip';
  zip.__crosslanPackageCount = files.length;
  return zip;
}

function createUniqueZipName(name: string, index: number) {
  const cleaned = name.replace(/\\/g, '/').split('/').filter(Boolean).join('/').replace(/^\.+/, '') || `file-${index + 1}.bin`;
  return `${String(index + 1).padStart(3, '0')}-${cleaned}`;
}

async function crc32File(file: File) {
  let crc = 0xffffffff;
  for (let offset = 0; offset < file.size; offset += ZIP_CHUNK_SIZE) {
    const chunk = new Uint8Array(await file.slice(offset, Math.min(offset + ZIP_CHUNK_SIZE, file.size)).arrayBuffer());
    for (const byte of chunk) {
      crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZipLocalHeader(fileName: Uint8Array, crc: number, size: number) {
  const buffer = new ArrayBuffer(30 + fileName.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0x0800, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, fileName.length, true);
  view.setUint16(28, 0, true);
  new Uint8Array(buffer, 30).set(fileName);
  return buffer;
}

function createZipCentralHeader(entry: ZipEntryInfo) {
  const buffer = new ArrayBuffer(46 + entry.encodedName.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0x0800, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.file.size, true);
  view.setUint32(24, entry.file.size, true);
  view.setUint16(28, entry.encodedName.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, entry.offset, true);
  new Uint8Array(buffer, 46).set(entry.encodedName);
  return buffer;
}

function createZipEnd(entryCount: number, centralSize: number, centralOffset: number) {
  const buffer = new ArrayBuffer(22);
  const view = new DataView(buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  return buffer;
}

function formatBatchTimestamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < CRC32_TABLE.length; i += 1) {
  let crc = i;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  CRC32_TABLE[i] = crc >>> 0;
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

function addRelayUploadDebug(transferId: string, uploaded: number, totalBytes: number) {
  const now = performance.now();
  const previous = lastDebugProgressAt.get(transferId) || 0;
  if (uploaded < totalBytes && now - previous < 2000) return;
  lastDebugProgressAt.set(transferId, now);
  addLog('relay upload buffered', { transferId, uploaded, totalBytes });
}

function uploadWithProgress(file: File, transferId: string, onProgress: (uploaded: number) => void) {
  return uploadFileWithProgress<{ path: string; bytesWritten: number }>('/api/transfers/direct', file, transferId, onProgress);
}

function uploadRelayWithProgress(file: File, transferId: string, onProgress: (uploaded: number) => void) {
  return uploadFileWithProgress<{ fileName: string; bytesWritten: number }>(`/api/transfers/relay/${encodeURIComponent(transferId)}`, file, transferId, onProgress);
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
