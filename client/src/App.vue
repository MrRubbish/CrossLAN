<template>
  <main class="min-h-screen bg-mist text-ink">
    <section class="mx-auto max-w-5xl px-4 pb-10 pt-[env(safe-area-inset-top)] sm:px-6">
      <header class="flex items-center justify-between gap-4 py-5">
        <div>
          <h1 class="text-2xl font-800">CrossLAN</h1>
          <p class="text-sm text-ink/60">{{ localStatus }}</p>
        </div>
        <div class="flex items-center gap-2">
          <button class="tap border border-line bg-panel px-3 py-1 text-xs font-800 text-ink/65" type="button" :title="themeTitle" @click="cycleTheme">
            {{ themeButtonLabel }}
          </button>
          <span class="rounded-full border border-line bg-panel px-3 py-1 text-xs font-700 text-ink/55">{{ protocolLabel }}</span>
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
            <button v-for="device in devices" :key="device.id" class="tap border border-line bg-mist/60 p-4 text-left hover:border-teal/40 hover:bg-panel" @click="chooseAndSend(device)">
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
            <div class="flex items-center justify-between gap-2">
              <p class="label">{{ t.transfers }}</p>
              <button v-if="progressItems.length" class="tap border border-line px-3 py-1 text-xs font-800" type="button" @click="clearTransfers">{{ t.clearTransfers }}</button>
            </div>
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
                {{ item.direction === 'send' ? t.send : t.receive }} | {{ modeLabel(item.mode) }} | {{ formatBytes(item.bytesTransferred) }} / {{ formatBytes(item.totalBytes) }}
              </p>
              <p class="mt-1 text-xs text-ink/45">
                {{ formatSpeedLine(item) }}
              </p>
              <p v-if="item.statusText" class="mt-1 break-all text-xs" :class="item.done && item.bytesTransferred < item.totalBytes ? 'text-coral' : 'text-ink/45'">{{ item.statusText }}</p>
              <a v-if="item.downloadUrl" class="tap mt-2 inline-flex border border-teal/30 bg-teal/10 px-3 py-2 text-xs font-800 text-teal" :href="item.downloadUrl" :download="item.fileName" target="_blank" rel="noopener" @click="logDownloadOpen(item)">{{ t.openDownload }}</a>
            </div>
          </section>

          <section class="panel p-4">
            <p class="label">{{ t.storage }}</p>
            <h2 class="text-lg font-750">{{ t.saveDirectory }}</h2>
            <p class="mt-2 text-xs text-ink/50">{{ t.storageHint }}</p>
            <label class="mt-3 flex items-start gap-2 text-sm">
              <input v-model="directSaveReceiver" class="mt-1" type="checkbox" />
              <span>
                <span class="block font-800">{{ t.directSaveReceiver }}</span>
                <span class="mt-1 block text-xs text-ink/50">{{ t.directSaveReceiverHint }}</span>
              </span>
            </label>
            <input v-model="saveDirInput" class="mt-3 w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-ink" placeholder="/data/CrossLAN" />
            <button class="tap mt-3 w-full bg-ink px-3 py-2 text-sm font-800 text-mist" @click="saveStorageDir">{{ t.savePath }}</button>
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
              <label class="flex items-center overflow-hidden rounded-md border border-line bg-panel">
                <input v-model.number="manualLimitMbps" :disabled="bandwidthMode !== 'manual'" type="number" min="1" class="min-w-0 flex-1 border-0 bg-transparent px-3 py-2 text-sm outline-none disabled:bg-line/30" />
                <span class="border-l border-line px-3 text-xs font-800 text-ink/55">{{ t.mbps }}</span>
              </label>
              <p class="text-xs text-ink/45">{{ t.uploadLimitHint }}</p>
            </div>
          </section>
        </aside>
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

const PHONE_RELAY_THRESHOLD = 8 * 1024 * 1024;
const DIRECT_SAVE_THRESHOLD = PHONE_RELAY_THRESHOLD;
const SMALL_BATCH_MAX_TOTAL = 64 * 1024 * 1024;
const SMALL_BATCH_MAX_FILE = PHONE_RELAY_THRESHOLD;
const ACCEPT_TIMEOUT_MS = 120000;
const RELAY_PACE_POLL_MS = 120;
const RELAY_STATE_CACHE_MS = 300;
const RELAY_MIN_TARGET_BUFFER = 8 * 1024 * 1024;
const RELAY_MAX_TARGET_BUFFER = 96 * 1024 * 1024;
const RELAY_PACING_FLAG = 'crosslan:relay-pacing';
const THEME_STORAGE_KEY = 'crosslan:theme';
const DIRECT_SAVE_RECEIVER_KEY = 'crosslan:direct-save-receiver';
const ZIP32_MAX = 0xffffffff;
const ZIP_CHUNK_SIZE = 4 * 1024 * 1024;
const textEncoder = new TextEncoder();
const messages = {
  zh: {
    local: '本机', connecting: '正在连接信令服务', online: '在线', offline: '离线', themeSystem: '系统', themeLight: '亮色', themeDark: '深色', themeTitle: '切换外观', devices: '局域网设备', selectTarget: '选择目标设备', refresh: '刷新', emptyDevices: '在同一局域网的另一台设备打开 CrossLAN，它会出现在这里。', deviceId: '设备 ID', lastSeen: '最后在线', transfers: '传输', noTransfers: '还没有传输任务。', clearTransfers: '清空任务', cancel: '取消', send: '发送', receive: '接收', openDownload: '打开下载', storage: '存储', saveDirectory: '服务主机保存目录', storageHint: '发送到运行 CrossLAN 服务的这台主机的大文件会直接保存到这里。Docker 通常映射到 /data/CrossLAN。', directSaveReceiver: '本机作为服务主机接收', directSaveReceiverHint: '只在运行 CrossLAN 服务的 PC 上开启；开启后其他设备发来的大文件会直存，不再触发浏览器/IDM 下载。', savePath: '保存路径', network: '网络', speedLimit: '速度限制', uploadLimitHint: '限速仅限制本机作为发送方的上传速度；浏览器下载速度由接收端和网络决定。', currentSpeed: '当前', averageSpeed: '平均', peakSpeed: '峰值', elapsed: '用时', unlimited: '不限速', manual: '手动', mbps: 'Mbps', direct: '直存', browserDownload: '浏览器下载', p2p: 'P2P', measuring: '测速中', receivePrompt: '接收', receiveLargePrompt: '接收大文件', receiverRejected: '接收方已拒绝文件。', waitingSender: '已接受，等待发送方...', waitingLink: '已接受，等待下载链接...', receiveComplete: '接收完成', savingDisk: '正在写入服务主机磁盘...', downloadReady: '下载已准备好。如果没有自动打开，请点“打开下载”。', sentDownloadManager: '已交给浏览器下载管理器。', waitConfirm: '等待对方确认...', waitPhoneConfirm: '等待接收端确认...', savedToPc: '已保存到服务主机', preparingPhone: '正在为接收端准备浏览器下载...', linkSentPhone: '下载链接已发送到接收端。', loadStorage: '正在读取保存目录...', loadStorageFailed: '读取保存目录失败。', saveStorageFailed: '保存目录失败。', current: '当前', saved: '已保存', parseFailed: '无法解析服务器响应。', uploadHttpFailed: '上传失败', uploadNetworkFailed: '上传失败：无法连接到 CrossLAN 服务。', cancelled: '传输已取消。', remoteCancelled: '对方已取消传输。', confirmTimeout: '等待对方确认超时。', failed: '传输失败。', duplicateSending: '这个文件正在传输中，已沿用现有任务。', duplicateIncoming: '相同文件已有接收任务，已忽略重复请求。', receivingRelay: '正在通过内存流式中继传输...', packagingBatch: '正在打包批量文件...', batchLabel: '批量文件'
  },
  en: {
    local: 'Local', connecting: 'Connecting to signaling server', online: 'Online', offline: 'Offline', themeSystem: 'System', themeLight: 'Light', themeDark: 'Dark', themeTitle: 'Switch appearance', devices: 'LAN devices', selectTarget: 'Select target device', refresh: 'Refresh', emptyDevices: 'Open CrossLAN on another device in the same LAN and it will appear here.', deviceId: 'Device ID', lastSeen: 'Last seen', transfers: 'Transfers', noTransfers: 'No transfers yet.', clearTransfers: 'Clear tasks', cancel: 'Cancel', send: 'Send', receive: 'Receive', openDownload: 'Open download', storage: 'Storage', saveDirectory: 'Service host save directory', storageHint: 'Large files sent to the host running CrossLAN are saved directly here. Docker usually maps this to /data/CrossLAN.', directSaveReceiver: 'Receive as service host', directSaveReceiverHint: 'Enable only on the PC running CrossLAN. Incoming large files are saved directly and will not trigger browser/IDM downloads.', savePath: 'Save path', network: 'Network', speedLimit: 'Speed limit', uploadLimitHint: 'The limit only throttles uploads from this browser; browser download speed is controlled by the receiver and network.', currentSpeed: 'Now', averageSpeed: 'Avg', peakSpeed: 'Peak', elapsed: 'Time', unlimited: 'Unlimited', manual: 'Manual', mbps: 'Mbps', direct: 'Direct save', browserDownload: 'Browser download', p2p: 'P2P', measuring: 'measuring', receivePrompt: 'Receive', receiveLargePrompt: 'Receive large file', receiverRejected: 'Receiver rejected the file.', waitingSender: 'Accepted. Waiting for sender...', waitingLink: 'Accepted. Waiting for download link...', receiveComplete: 'Receive complete', savingDisk: 'Saving to host disk...', downloadReady: 'Download ready. If it did not open, tap Open download.', sentDownloadManager: 'Sent to browser download manager.', waitConfirm: 'Waiting for receiver confirmation...', waitPhoneConfirm: 'Waiting for receiver confirmation...', savedToPc: 'Saved to service host', preparingPhone: 'Preparing browser download for receiver...', linkSentPhone: 'Download link sent to receiver.', loadStorage: 'Loading save directory...', loadStorageFailed: 'Failed to load directory.', saveStorageFailed: 'Failed to save directory.', current: 'Current', saved: 'Saved', parseFailed: 'Failed to parse server response.', uploadHttpFailed: 'Upload failed', uploadNetworkFailed: 'Upload failed: cannot connect to CrossLAN service.', cancelled: 'Transfer cancelled.', remoteCancelled: 'Peer cancelled the transfer.', confirmTimeout: 'Timed out waiting for receiver confirmation.', failed: 'Transfer failed.', duplicateSending: 'This file is already being transferred. Reusing the existing task.', duplicateIncoming: 'The same file already has a receive task. Ignoring the duplicate request.', receivingRelay: 'Streaming through memory relay...', packagingBatch: 'Packaging batch files...', batchLabel: 'Batch files' }
};

type ThemePreference = 'system' | 'light' | 'dark';
type PendingAccept = { resolve: () => void; reject: (error: Error) => void; timer: number };
type DebugLevel = 'info' | 'warn' | 'error';
type RelayState = { ok: boolean; failed?: boolean; message?: string; bufferBytes: number; bufferedBytes: number };

const identity = new DeviceIdentity();
const store = new DeviceStore();
const signaling = new SignalingClient();
const engine = new TransferEngine(signaling, () => identity.getDeviceId());
const noSleep = new NoSleep();

const connected = ref(false);
const localIdentity = ref<LocalIdentity | null>(null);
const devices = ref<DeviceRecord[]>([]);
const progress = ref(new Map<string, TransferProgress>());
const speedSamples = new Map<string, { startedAt: number; lastAt: number; lastBytes: number; direction: TransferProgress['direction']; mode?: TransferProgress['mode'] }>();
const lastDebugProgressAt = new Map<string, number>();
const pendingDirectAccepts = new Map<string, PendingAccept>();
const pendingRelayAccepts = new Map<string, PendingAccept>();
const activeUploads = new Map<string, { abort: () => void }>();
const activePeers = new Map<string, string>();
const activeSendKeys = new Map<string, string>();
const incomingPromptKeys = new Map<string, string>();
const activeTransferKeys = new Map<string, string>();
const relayStateCache = new Map<string, { checkedAt: number; state: RelayState }>();
const autoDownloadedTransfers = new Set<string>();
const cancelledTransfers = new Set<string>();
const fileInput = ref<HTMLInputElement | null>(null);
const pendingTarget = ref<DeviceRecord | null>(null);
const bandwidthMode = ref<BandwidthMode>('unlimited');
const manualLimitMbps = ref(100);
const themePreference = ref<ThemePreference>(loadThemePreference());
const directSaveReceiver = ref(loadDirectSaveReceiverPreference());
const saveDirInput = ref('');
const storageMessage = ref(messages.zh.loadStorage);
const storageStatusOk = ref(true);
const progressItems = computed(() => [...progress.value.values()]);
const isZh = computed(() => navigator.language.toLowerCase().startsWith('zh'));
const t = computed(() => isZh.value ? messages.zh : messages.en);
const localStatus = computed(() => localIdentity.value ? `${t.value.local} ${localIdentity.value.ip}` : t.value.connecting);
const protocolLabel = computed(() => location.protocol === 'https:' ? 'HTTPS' : 'HTTP LAN');
const themeButtonLabel = computed(() => {
  if (themePreference.value === 'light') return t.value.themeLight;
  if (themePreference.value === 'dark') return t.value.themeDark;
  return t.value.themeSystem;
});
const themeTitle = computed(() => `${t.value.themeTitle}: ${themeButtonLabel.value}`);
const isServiceHost = computed(() => {
  const host = location.hostname;
  if (isLoopbackHost(host)) return true;
  const local = localIdentity.value;
  if (!local) return false;
  return local.serverIps.includes(local.ip);
});

onMounted(() => {
  applyThemePreference(themePreference.value);
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

  signaling.connect(identity.getClientId(), directSaveReceiver.value || isServiceHost.value);
  void loadStorageDir();
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('beforeunload', cleanup);
});

onUnmounted(cleanup);

watch([bandwidthMode, manualLimitMbps], () => {
  engine.setBandwidthLimit({
    mode: bandwidthMode.value,
    bytesPerSecond: getManualLimitBytesPerSecond()
  });
});

watch(themePreference, value => {
  applyThemePreference(value);
  saveThemePreference(value);
});

watch(directSaveReceiver, value => {
  localStorage.setItem(DIRECT_SAVE_RECEIVER_KEY, value ? '1' : '0');
  signaling.reconnect(identity.getClientId(), value || isServiceHost.value);
});

function getManualLimitBytesPerSecond() {
  const mbps = Number(manualLimitMbps.value);
  if (bandwidthMode.value !== 'manual' || !Number.isFinite(mbps) || mbps <= 0) return null;
  return (mbps * 1000 * 1000) / 8;
}

function loadThemePreference(): ThemePreference {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

function saveThemePreference(value: ThemePreference) {
  localStorage.setItem(THEME_STORAGE_KEY, value);
}

function applyThemePreference(value: ThemePreference) {
  if (value === 'system') {
    document.documentElement.removeAttribute('data-theme');
    return;
  }
  document.documentElement.dataset.theme = value;
}

function loadDirectSaveReceiverPreference() {
  const stored = localStorage.getItem(DIRECT_SAVE_RECEIVER_KEY);
  if (stored === '1') return true;
  if (stored === '0') return false;
  return isLoopbackHost(location.hostname);
}

function cycleTheme() {
  const order: ThemePreference[] = ['system', 'light', 'dark'];
  const index = order.indexOf(themePreference.value);
  themePreference.value = order[(index + 1) % order.length];
}

function isLoopbackHost(host: string) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

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
    if (cancelledTransfers.has(message.transferId)) return;
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
    clearTransferBookkeeping(message.transferId);
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
    if (cancelledTransfers.has(message.transferId)) return;
    handleRelayTransferReady(message.transferId, message.fileName, message.bytesWritten || 0);
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
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  method('[CrossLAN]', message, details ?? '');
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
  if (cancelledTransfers.has(transferId)) return;
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
  if (done) clearTransferBookkeeping(transferId);
}

function updateRelayTransferProgress(transferId: string, fileName: string, bytesTransferred: number, totalBytes: number) {
  if (cancelledTransfers.has(transferId)) return;
  const current = progress.value.get(transferId);
  if (current?.done) return;
  if (current?.direction === 'send') {
    setProgress({
      ...current,
      fileName: current.fileName || fileName,
      totalBytes: Math.max(current.totalBytes || 0, totalBytes || 0),
      statusText: current.statusText || t.value.preparingPhone
    });
    return;
  }
  const direction = current?.direction || 'receive';
  const done = totalBytes > 0 && bytesTransferred >= totalBytes;
  setProgress(withSpeedSample({
    id: transferId,
    direction,
    fileName,
    bytesTransferred,
    totalBytes,
    done,
    mode: 'relay',
    cancellable: !done,
    peerId: current?.peerId,
    statusText: done ? t.value.receiveComplete : current?.statusText || t.value.receivingRelay
  }));
  if (done) {
    clearTransferBookkeeping(transferId);
    disableWakeLock();
  }
}

function handleRelayTransferReady(transferId: string, fileName: string, bytesWritten: number) {
  if (cancelledTransfers.has(transferId)) return;
  const current = progress.value.get(transferId);
  if (!current) return;
  if (current.direction === 'receive') {
    setProgress({
      ...current,
      fileName: current.fileName || fileName,
      cancellable: true,
      needsUserSave: false,
      statusText: current.bytesTransferred > 0 ? t.value.receivingRelay : t.value.sentDownloadManager
    });
    return;
  }

  const totalBytes = Math.max(current.totalBytes || 0, bytesWritten || 0);
  setProgress(withSpeedSample({
    ...current,
    fileName: current.fileName || fileName,
    bytesTransferred: totalBytes,
    totalBytes,
    done: true,
    cancellable: false,
    needsUserSave: false,
    statusText: t.value.sentDownloadManager
  }));
  clearTransferBookkeeping(transferId);
  disableWakeLock();
}

function handleRelayTransferError(transferId: string, fileName = 'Relay file', message: string) {
  if (cancelledTransfers.has(transferId)) return;
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
  const startedAt = current?.startedAt || item.startedAt || now;
  const safeTotal = Math.max(item.totalBytes || 0, current?.totalBytes || 0);
  const safeBytes = item.done
    ? Math.max(item.bytesTransferred || 0, current?.bytesTransferred || 0)
    : Math.min(safeTotal || item.bytesTransferred || 0, Math.max(item.bytesTransferred || 0, current?.bytesTransferred || 0));
  const normalized = { ...item, bytesTransferred: safeBytes, totalBytes: safeTotal || item.totalBytes, startedAt, completedAt: item.done ? item.completedAt || now : item.completedAt };
  const needsNewSample = !previous || previous.direction !== normalized.direction || previous.mode !== normalized.mode;
  const baseSample = needsNewSample
    ? { startedAt, lastAt: now, lastBytes: current?.bytesTransferred ?? 0, direction: normalized.direction, mode: normalized.mode }
    : previous;

  if (needsNewSample) {
    speedSamples.set(item.id, baseSample);
    if (!normalized.done) return normalized;
  }

  if (normalized.done) {
    const sample = speedSamples.get(item.id) || baseSample;
    const sampleStartedAt = sample.startedAt || startedAt;
    const completedAt = normalized.completedAt || now;
    const elapsedSeconds = Math.max((completedAt - sampleStartedAt) / 1000, 0.001);
    const finalDeltaMs = Math.max(completedAt - sample.lastAt, 1);
    const finalDeltaBytes = Math.max(normalized.bytesTransferred - sample.lastBytes, 0);
    const finalInstantSpeed = (finalDeltaBytes / finalDeltaMs) * 1000;
    const peak = Math.max(current?.peakBytesPerSecond || 0, current?.speedBytesPerSecond || 0, Number.isFinite(finalInstantSpeed) ? finalInstantSpeed : 0);
    speedSamples.set(item.id, { ...sample, lastAt: completedAt, lastBytes: normalized.bytesTransferred });
    return {
      ...normalized,
      completedAt,
      speedBytesPerSecond: 0,
      averageBytesPerSecond: normalized.bytesTransferred / elapsedSeconds,
      peakBytesPerSecond: peak || current?.peakBytesPerSecond
    };
  }

  const sample = speedSamples.get(item.id) || baseSample;
  const deltaMs = Math.max(now - sample.lastAt, 1);
  const deltaBytes = Math.max(normalized.bytesTransferred - sample.lastBytes, 0);
  const elapsedSeconds = Math.max((now - sample.startedAt) / 1000, 0.001);
  const sampled = {
    ...normalized,
    speedBytesPerSecond: smoothSpeed(current?.speedBytesPerSecond, (deltaBytes / deltaMs) * 1000),
    averageBytesPerSecond: normalized.bytesTransferred / elapsedSeconds,
    peakBytesPerSecond: Math.max(current?.peakBytesPerSecond || 0, current?.speedBytesPerSecond || 0, (deltaBytes / deltaMs) * 1000)
  };
  speedSamples.set(item.id, { ...sample, lastAt: now, lastBytes: normalized.bytesTransferred });
  return sampled;
}

function smoothSpeed(previousSpeed: number | undefined, instantSpeed: number) {
  if (!Number.isFinite(instantSpeed)) return previousSpeed;
  if (!previousSpeed || !Number.isFinite(previousSpeed)) return instantSpeed;
  return previousSpeed * 0.72 + instantSpeed * 0.28;
}

function maybeAutoDownload(item: TransferProgress): TransferProgress {
  if (cancelledTransfers.has(item.id)) return { ...item, downloadUrl: undefined, needsUserSave: false };
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
  return file.size >= PHONE_RELAY_THRESHOLD && !shouldDirectSave(target, file);
}

function canDirectSaveTo(target: DeviceRecord) {
  if (target.canDirectSave) return true;
  const serverIps = localIdentity.value?.serverIps ?? [];
  if (serverIps.includes(target.ip)) return true;
  if (target.ip === location.hostname || target.id === location.hostname) return true;
  return false;
}


function deviceReceiveModeLabel(device: DeviceRecord) {
  if (canDirectSaveTo(device)) return t.value.direct;
  return t.value.browserDownload;
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
    setProgress(withSpeedSample({
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
    }));
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

    setProgress(withSpeedSample({
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
    }));
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
  cancelledTransfers.add(item.id);
  autoDownloadedTransfers.add(item.id);
  activeUploads.get(item.id)?.abort();
  activeUploads.delete(item.id);
  cleanupServerTransfer(item.id, item.mode);
  engine.cancelTransfer(item.id);
  rejectPending(pendingDirectAccepts, item.id, t.value.cancelled);
  rejectPending(pendingRelayAccepts, item.id, t.value.cancelled);
  const peerId = item.peerId || activePeers.get(item.id);
  if (peerId) signaling.send({ type: 'transfer-cancel', to: peerId, transferId: item.id, reason: t.value.remoteCancelled });
  markCancelled(item.id, t.value.cancelled);
  disableWakeLock();
}

function clearTransfers() {
  const next = new Map<string, TransferProgress>();
  for (const [id, item] of progress.value.entries()) {
    if (!item.done) {
      next.set(id, item);
      continue;
    }
    if (item.downloadUrl?.startsWith('blob:')) URL.revokeObjectURL(item.downloadUrl);
    clearTransferBookkeeping(id);
    if (!item.cancelled) autoDownloadedTransfers.delete(id);
  }
  progress.value = next;
}

function handleRemoteCancel(transferId: string, from: string, reason?: string) {
  addLog('remote transfer cancelled', { transferId, from, reason }, 'warn');
  cancelledTransfers.add(transferId);
  autoDownloadedTransfers.add(transferId);
  activeUploads.get(transferId)?.abort();
  activeUploads.delete(transferId);
  cleanupServerTransfer(transferId, progress.value.get(transferId)?.mode);
  engine.cancelTransfer(transferId);
  rejectPending(pendingDirectAccepts, transferId, reason || t.value.remoteCancelled);
  rejectPending(pendingRelayAccepts, transferId, reason || t.value.remoteCancelled);
  markCancelled(transferId, reason || t.value.remoteCancelled, from);
  disableWakeLock();
}

function cleanupServerTransfer(transferId: string, mode?: TransferProgress['mode']) {
  if (mode !== 'direct' && mode !== 'relay') return;
  fetch(`/api/transfers/${mode}/${encodeURIComponent(transferId)}`, {
    method: 'DELETE',
    cache: 'no-store'
  }).catch(error => {
    addLog('server transfer cleanup failed', { transferId, mode, error: error instanceof Error ? error.message : String(error) }, 'warn');
  });
}

function markCancelled(transferId: string, statusText: string, peerId?: string) {
  const current = progress.value.get(transferId);
  if (!current) {
    progress.value = new Map(progress.value).set(transferId, {
      id: transferId,
      direction: 'receive',
      fileName: 'Transfer',
      bytesTransferred: 0,
      totalBytes: 0,
      done: true,
      cancellable: false,
      cancelled: true,
      peerId,
      statusText
    });
    clearTransferBookkeeping(transferId);
    return;
  }
  if (current.downloadUrl?.startsWith('blob:')) URL.revokeObjectURL(current.downloadUrl);
  setProgress({
    ...current,
    done: true,
    cancellable: false,
    cancelled: true,
    downloadUrl: undefined,
    needsUserSave: false,
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
  relayStateCache.delete(transferId);
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
  if (message === t.value.cancelled || message === t.value.remoteCancelled) {
    cancelledTransfers.add(id);
    autoDownloadedTransfers.add(id);
  }
  if (current?.downloadUrl?.startsWith('blob:')) URL.revokeObjectURL(current.downloadUrl);
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
    downloadUrl: undefined,
    needsUserSave: false,
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
  if (shouldThrottleHttpUpload()) {
    return uploadFileChunkedWithThrottle<{ path: string; bytesWritten: number }>(`/api/transfers/direct/${encodeURIComponent(transferId)}/chunk`, file, transferId, onProgress);
  }
  return uploadFileWithProgress<{ path: string; bytesWritten: number }>('/api/transfers/direct', file, transferId, onProgress);
}

function uploadRelayWithProgress(file: File, transferId: string, onProgress: (uploaded: number) => void) {
  if (shouldThrottleHttpUpload()) {
    return uploadFileChunkedWithThrottle<{ fileName: string; bytesWritten: number }>(`/api/transfers/relay/${encodeURIComponent(transferId)}/chunk`, file, transferId, onProgress);
  }
  if (isRelayPacingEnabled() && supportsStreamingUpload()) return uploadRelayStreamWithPacing(file, transferId, onProgress);
  addLog('relay upload using stable xhr path', { transferId, file: file.name, size: file.size, pacingEnabled: isRelayPacingEnabled() });
  return uploadFileWithProgress<{ fileName: string; bytesWritten: number }>(`/api/transfers/relay/${encodeURIComponent(transferId)}`, file, transferId, onProgress);
}

function shouldThrottleHttpUpload() {
  return Boolean(getManualLimitBytesPerSecond());
}

function uploadFileWithProgress<T extends Record<string, unknown>>(endpoint: string, file: File, transferId: string | undefined, onProgress: (uploaded: number) => void) {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);
    if (transferId) activeUploads.set(transferId, { abort: () => xhr.abort() });
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

async function uploadFileChunkedWithThrottle<T extends Record<string, unknown>>(endpoint: string, file: File, transferId: string, onProgress: (uploaded: number) => void) {
  let uploaded = 0;
  let finalResponse: T | null = null;
  let throttleStartedAt = performance.now();
  addLog('throttled chunk upload opened', { endpoint, transferId, file: file.name, size: file.size, limitMbps: manualLimitMbps.value });

  while (uploaded < file.size) {
    const limit = getManualLimitBytesPerSecond();
    if (!limit) throttleStartedAt = performance.now();
    const chunkSize = getThrottleChunkSize(limit);
    const end = Math.min(uploaded + chunkSize, file.size);
    const chunk = file.slice(uploaded, end);
    const isFinal = end >= file.size;
    const result = await uploadChunk<T>(endpoint, file, chunk, transferId, uploaded, isFinal);
    uploaded = end;
    onProgress(uploaded);
    if (isFinal) finalResponse = result;
    if (limit) {
      const idealElapsedMs = (uploaded / limit) * 1000;
      const waitMs = throttleStartedAt + idealElapsedMs - performance.now();
      if (waitMs > 1) await sleepForThrottle(waitMs, transferId);
    }
  }

  if (!finalResponse) throw new Error(t.value.uploadHttpFailed);
  return finalResponse;
}

function getThrottleChunkSize(bytesPerSecond: number | null) {
  if (!bytesPerSecond) return 1024 * 1024;
  const targetIntervalMs = 120;
  const targetBytes = Math.round((bytesPerSecond * targetIntervalMs) / 1000);
  return Math.min(512 * 1024, Math.max(64 * 1024, targetBytes));
}

function uploadChunk<T extends Record<string, unknown>>(endpoint: string, file: File, chunk: Blob, transferId: string, offset: number, isFinal: boolean) {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', endpoint);
    activeUploads.set(transferId, { abort: () => xhr.abort() });
    xhr.setRequestHeader('x-crosslan-transfer-id', transferId);
    xhr.setRequestHeader('x-crosslan-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('x-crosslan-file-size', String(file.size));
    xhr.setRequestHeader('x-crosslan-offset', String(offset));
    xhr.setRequestHeader('x-crosslan-final', isFinal ? '1' : '0');
    xhr.onload = () => {
      activeUploads.delete(transferId);
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
      activeUploads.delete(transferId);
      reject(new Error(t.value.uploadNetworkFailed));
    };
    xhr.onabort = () => {
      activeUploads.delete(transferId);
      reject(new Error(t.value.cancelled));
    };
    xhr.send(chunk);
  });
}

function sleepForThrottle(ms: number, transferId: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    activeUploads.set(transferId, {
      abort: () => {
        window.clearTimeout(timer);
        reject(new Error(t.value.cancelled));
      }
    });
  }).finally(() => {
    if (activeUploads.get(transferId)) activeUploads.delete(transferId);
  });
}

async function uploadRelayStreamWithPacing(file: File, transferId: string, onProgress: (uploaded: number) => void) {
  const endpoint = `/api/transfers/relay/${encodeURIComponent(transferId)}`;
  const controller = new AbortController();
  activeUploads.set(transferId, { abort: () => controller.abort() });
  addLog('paced relay upload opened', { endpoint, transferId, file: file.name, size: file.size });

  let uploaded = 0;
  const reader = file.stream().getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      await waitForRelayBufferRoom(transferId, controller.signal);
      const result = await reader.read();
      if (result.done) {
        streamController.close();
        return;
      }
      const chunk = result.value;
      uploaded += chunk.byteLength;
      onProgress(uploaded);
      streamController.enqueue(chunk);
    },
    cancel() {
      void reader.cancel();
    }
  });

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-crosslan-transfer-id': transferId,
        'x-crosslan-file-name': encodeURIComponent(file.name),
        'x-crosslan-file-size': String(file.size)
      },
      body,
      signal: controller.signal,
      duplex: 'half'
    } as RequestInit & { duplex: 'half' });
    const text = await response.text();
    addLog('paced relay upload response', { endpoint, transferId, status: response.status, response: text.slice(0, 500) });
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text || '{}') as Record<string, unknown>;
    } catch {
      throw new Error(t.value.parseFailed);
    }
    if (!response.ok || !data.ok) throw new Error(String(data.message || `Upload failed: HTTP ${response.status}`));
    return data as { fileName: string; bytesWritten: number };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(t.value.cancelled);
    throw error;
  } finally {
    activeUploads.delete(transferId);
  }
}

function supportsStreamingUpload() {
  try {
    let duplexAccessed = false;
    const body = new ReadableStream({
      start(controller) {
        controller.close();
      }
    });
    const request = new Request(location.href, {
      method: 'POST',
      body,
      get duplex() {
        duplexAccessed = true;
        return 'half';
      }
    } as RequestInit & { duplex: 'half' });
    return duplexAccessed && request.headers instanceof Headers;
  } catch {
    return false;
  }
}

function isRelayPacingEnabled() {
  return localStorage.getItem(RELAY_PACING_FLAG) === '1';
}

async function waitForRelayBufferRoom(transferId: string, signal: AbortSignal) {
  while (!signal.aborted) {
    const state = await fetchRelayState(transferId, signal);
    if (!state.ok || state.failed) throw new Error(state.message || t.value.failed);
    const targetBuffered = Math.min(RELAY_MAX_TARGET_BUFFER, Math.max(RELAY_MIN_TARGET_BUFFER, state.bufferBytes * 0.5));
    if (state.bufferedBytes <= targetBuffered) return;
    await delay(RELAY_PACE_POLL_MS, signal);
  }
  throw new Error(t.value.cancelled);
}

async function fetchRelayState(transferId: string, signal: AbortSignal) {
  const cached = relayStateCache.get(transferId);
  const now = performance.now();
  if (cached && now - cached.checkedAt < RELAY_STATE_CACHE_MS) return cached.state;
  const response = await fetch(`/api/transfers/relay/${encodeURIComponent(transferId)}/state`, { signal, cache: 'no-store' });
  const data = await response.json() as RelayState;
  if (!response.ok) throw new Error(data.message || `Relay state failed: HTTP ${response.status}`);
  relayStateCache.set(transferId, { checkedAt: now, state: data });
  return data;
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new Error(t.value.cancelled));
    }, { once: true });
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
  if (!isServiceHost.value && !directSaveReceiver.value) {
    storageMessage.value = t.value.saveStorageFailed;
    storageStatusOk.value = false;
    return;
  }
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
  for (const upload of activeUploads.values()) upload.abort();
  activeUploads.clear();
  activePeers.clear();
  activeSendKeys.clear();
  incomingPromptKeys.clear();
  activeTransferKeys.clear();
  relayStateCache.clear();
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

function formatSpeedLine(item: TransferProgress) {
  if (item.done) {
    return `${t.value.averageSpeed} ${formatSpeed(item.averageBytesPerSecond)} | ${t.value.peakSpeed} ${formatSpeed(item.peakBytesPerSecond)} | ${t.value.elapsed} ${formatElapsed(item)}`;
  }
  return `${t.value.currentSpeed} ${formatSpeed(item.speedBytesPerSecond)} | ${t.value.averageSpeed} ${formatSpeed(item.averageBytesPerSecond)} | ${t.value.peakSpeed} ${formatSpeed(item.peakBytesPerSecond)}`;
}

function formatSpeed(bytesPerSecond?: number) {
  if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return t.value.measuring;
  return formatBytes(bytesPerSecond) + '/s';
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatElapsed(item: TransferProgress) {
  if (!item.startedAt || !item.completedAt) return t.value.measuring;
  const totalSeconds = Math.max(0, Math.round((item.completedAt - item.startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString();
}

function createTransferId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
</script>
