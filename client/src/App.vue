<template>
  <main class="min-h-screen bg-mist text-ink">
    <section class="mx-auto max-w-5xl px-4 pb-10 pt-[env(safe-area-inset-top)] sm:px-6">
      <header class="flex items-center justify-between gap-4 py-5">
        <div>
          <h1 class="text-2xl font-800">CrossLAN</h1>
          <p class="text-sm text-ink/60">{{ localStatus }}</p>
        </div>
        <div class="flex items-center gap-2">
          <button class="rounded-full border border-line bg-panel px-3 py-1 text-xs font-700 text-ink/55" type="button" :title="themeTitle" @click="cycleTheme">
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

          <div v-if="targetDevices.length === 0" class="rounded-md border border-dashed border-line p-6 text-center text-sm text-ink/55">
            {{ t.emptyDevices }}
          </div>

          <div v-else class="grid gap-3 sm:grid-cols-2">
            <label
              v-for="device in targetDevices"
              :key="device.id"
              class="tap relative flex min-h-[9rem] flex-col items-stretch justify-start border bg-mist/60 p-4 text-left hover:bg-panel"
              :class="deviceCardClass(device)"
            >
              <div class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                <div class="min-w-0">
                  <p class="break-words font-800 leading-snug">{{ displayDeviceName(device) }}</p>
                  <p class="mt-1 text-sm text-ink/55">IP: {{ device.ip }}</p>
                  <p class="mt-1 break-all text-sm text-ink/55">{{ t.deviceId }}: {{ device.id }}</p>
                </div>
                <span class="shrink-0 whitespace-nowrap rounded px-2 py-1 text-xs font-700" :class="canDirectSaveTo(device) ? 'bg-teal/10 text-teal' : 'bg-ink/8 text-ink/50'">
                  {{ deviceReceiveModeLabel(device) }}
                </span>
              </div>
              <p class="mt-3 text-xs text-ink/45">{{ t.lastSeen }} {{ formatTime(device.lastSeen) }}</p>
              <input
                type="file"
                accept="*/*"
                multiple
                class="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                :aria-label="`${t.selectTarget}: ${displayDeviceName(device)}`"
                @click="handleFileInputClick($event, device)"
                @change="handleFilePicked($event, device)"
              />
            </label>
          </div>
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

          <section v-if="isServiceHost" class="panel p-4">
            <p class="label">{{ t.storage }}</p>
            <h2 class="text-lg font-750">{{ t.saveDirectory }}</h2>
            <p class="mt-2 text-xs text-ink/50">{{ t.storageHint }}</p>
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
import { isBatchTransferMeta } from './transfer/BatchTransfer';
import { TransferEngine } from './transfer/TransferEngine';
import type { BandwidthMode, BatchTransferSummary, DeviceRecord, FileMeta, LocalIdentity, ServerMode, SignalingMessage, TransferBatchMeta, TransferProgress } from './types';

const P2P_MAX_FILE_SIZE = 32 * 1024 * 1024;
const DIRECT_SAVE_THRESHOLD = P2P_MAX_FILE_SIZE;
const SMALL_BATCH_MAX_TOTAL = 64 * 1024 * 1024;
const SMALL_BATCH_MAX_FILE = P2P_MAX_FILE_SIZE;
const ACCEPT_TIMEOUT_MS = 120000;
// A mixed batch can contain multi-minute browser downloads. Keep the receiver's
// one-time approval alive for the whole batch instead of expiring after the
// first few per-file requests.
const INCOMING_BATCH_APPROVAL_TTL_MS = 30 * 60 * 1000;
const RELAY_STATE_CACHE_MS = 300;
const LOCAL_HEALTH_TIMEOUT_MS = 900;
const SPEED_SAMPLE_WINDOW_MS = 3500;
const SPEED_SAMPLE_MIN_INTERVAL_MS = 250;
const SPEED_DISPLAY_REFRESH_MS = 750;
const THEME_STORAGE_KEY = 'crosslan:theme';
const SERVICE_HOST_UI_KEY = 'crosslan:service-host-ui';
const SERVICE_HOST_DEVICE_ID = 'crosslan-service-host';
const ZIP32_MAX = 0xffffffff;
const ZIP_CHUNK_SIZE = 4 * 1024 * 1024;
const textEncoder = new TextEncoder();
const messages = {
  zh: {
    local: '本机', connecting: '正在连接信令服务', online: '在线', offline: '离线', themeSystem: '系统', themeLight: '亮色', themeDark: '深色', themeTitle: '切换外观', devices: '局域网设备', selectTarget: '选择目标设备', refresh: '刷新', emptyDevices: '在同一局域网的另一台设备打开 CrossLAN，它会出现在这里。', deviceId: '设备 ID', lastSeen: '最后在线', transfers: '传输', noTransfers: '还没有传输任务。', clearTransfers: '清空任务', cancel: '取消', send: '发送', receive: '接收', openDownload: '打开下载', storage: '存储', saveDirectory: '服务主机保存目录', storageHint: '发送到运行 CrossLAN 服务的这台主机的大文件会直接保存到这里。', directSaveReceiver: '本机作为服务主机接收', directSaveReceiverHint: '只在运行 CrossLAN 服务的 PC 上开启；开启后其他设备发来的大文件会直存，不再触发浏览器/IDM 下载。', savePath: '保存路径', network: '网络', speedLimit: '速度限制', uploadLimitHint: '限速仅限制本机作为发送方的上传速度；浏览器下载速度由接收端和网络决定。', currentSpeed: '当前', averageSpeed: '平均', peakSpeed: '峰值', elapsed: '用时', unlimited: '不限速', manual: '手动', mbps: 'Mbps', direct: '直存', browserDownload: '浏览器下载', browserDownloadMode: '浏览器接收', p2p: 'P2P', measuring: '测速中', receivePrompt: '接收', receiveLargePrompt: '接收大文件', receiveBatchPrompt: '接收这批文件', receiverRejected: '接收方已拒绝文件。', waitingSender: '已接受，等待发送方...', waitingLink: '已接受，等待下载链接...', receiveComplete: '接收完成', savingDisk: '正在写入服务主机磁盘...', downloadReady: '下载已准备好。如果没有自动打开，请点“打开下载”。', sentDownloadManager: '已交给浏览器下载管理器。', waitConfirm: '等待对方确认...', waitPhoneConfirm: '等待接收端确认...', savedToPc: '已保存到服务主机', preparingPhone: '正在为接收端准备浏览器下载...', linkSentPhone: '下载链接已发送到接收端。', loadStorage: '正在读取保存目录...', loadStorageFailed: '读取保存目录失败。', saveStorageFailed: '保存目录失败。', current: '当前', saved: '已保存', parseFailed: '无法解析服务器响应。', uploadHttpFailed: '上传失败', uploadNetworkFailed: '上传失败：无法连接到 CrossLAN 服务。', cancelled: '传输已取消。', remoteCancelled: '对方已取消传输。', confirmTimeout: '等待对方确认超时。', failed: '传输失败。', duplicateSending: '这个文件正在传输中，已沿用现有任务。', duplicateIncoming: '相同文件已有接收任务，已忽略重复请求。', receivingRelay: '正在通过内存流式中继传输...', packagingBatch: '正在打包批量文件...', batchLabel: '批量文件'
  },
  en: {
    local: 'Local', connecting: 'Connecting to signaling server', online: 'Online', offline: 'Offline', themeSystem: 'System', themeLight: 'Light', themeDark: 'Dark', themeTitle: 'Switch appearance', devices: 'LAN devices', selectTarget: 'Select target device', refresh: 'Refresh', emptyDevices: 'Open CrossLAN on another device in the same LAN and it will appear here.', deviceId: 'Device ID', lastSeen: 'Last seen', transfers: 'Transfers', noTransfers: 'No transfers yet.', clearTransfers: 'Clear tasks', cancel: 'Cancel', send: 'Send', receive: 'Receive', openDownload: 'Open download', storage: 'Storage', saveDirectory: 'Service host save directory', storageHint: 'Large files sent to the host running CrossLAN are saved directly here.', directSaveReceiver: 'Receive as service host', directSaveReceiverHint: 'Enable only on the PC running CrossLAN. Incoming large files are saved directly and will not trigger browser/IDM downloads.', savePath: 'Save path', network: 'Network', speedLimit: 'Speed limit', uploadLimitHint: 'The limit only throttles uploads from this browser; browser download speed is controlled by the receiver and network.', currentSpeed: 'Now', averageSpeed: 'Avg', peakSpeed: 'Peak', elapsed: 'Time', unlimited: 'Unlimited', manual: 'Manual', mbps: 'Mbps', direct: 'Direct save', browserDownload: 'Browser download', browserDownloadMode: 'Browser receive', p2p: 'P2P', measuring: 'measuring', receivePrompt: 'Receive', receiveLargePrompt: 'Receive large file', receiveBatchPrompt: 'Receive this batch', receiverRejected: 'Receiver rejected the file.', waitingSender: 'Accepted. Waiting for sender...', waitingLink: 'Accepted. Waiting for download link...', receiveComplete: 'Receive complete', savingDisk: 'Saving to host disk...', downloadReady: 'Download ready. If it did not open, tap Open download.', sentDownloadManager: 'Sent to browser download manager.', waitConfirm: 'Waiting for receiver confirmation...', waitPhoneConfirm: 'Waiting for receiver confirmation...', savedToPc: 'Saved to service host', preparingPhone: 'Preparing browser download for receiver...', linkSentPhone: 'Download link sent to receiver.', loadStorage: 'Loading save directory...', loadStorageFailed: 'Failed to load directory.', saveStorageFailed: 'Failed to save directory.', current: 'Current', saved: 'Saved', parseFailed: 'Failed to parse server response.', uploadHttpFailed: 'Upload failed', uploadNetworkFailed: 'Upload failed: cannot connect to CrossLAN service.', cancelled: 'Transfer cancelled.', remoteCancelled: 'Peer cancelled the transfer.', confirmTimeout: 'Timed out waiting for receiver confirmation.', failed: 'Transfer failed.', duplicateSending: 'This file is already being transferred. Reusing the existing task.', duplicateIncoming: 'The same file already has a receive task. Ignoring the duplicate request.', receivingRelay: 'Streaming through memory relay...', packagingBatch: 'Packaging batch files...', batchLabel: 'Batch files' }
};

type ThemePreference = 'system' | 'light' | 'dark';
type PendingAccept = { resolve: () => void; reject: (error: Error) => void; timer: number };
type PendingBatchAccept = PendingAccept;
type RelayCompletion = { fileName: string; bytesUploaded: number; bytesDownloaded: number; totalBytes: number };
type PendingRelayCompletion = { resolve: (completion: RelayCompletion) => void; reject: (error: Error) => void };
type DebugLevel = 'info' | 'warn' | 'error';
type IncomingBatchApproval = {
  accepted: boolean;
  transferIds: Set<string>;
  timer: number;
};
type RelayState = {
  ok: boolean;
  failed?: boolean;
  cancelled?: boolean;
  message?: string;
  expectedSize?: number;
  bytesUploaded?: number;
  bytesDownloaded?: number;
  uploadStarted?: boolean;
  downloadStarted?: boolean;
  uploadComplete?: boolean;
  downloadComplete?: boolean;
};
type HealthResponse = { ok?: boolean; name?: string; deploymentMode?: string; instanceId?: string; serverInstanceId?: string };
type HostConnectionRole = { directSave: boolean; hostUi: boolean; serverMode?: ServerMode };
type SpeedSamplePoint = { at: number; bytes: number };
type SpeedSampleState = {
  startedAt: number;
  direction: TransferProgress['direction'];
  mode?: TransferProgress['mode'];
  points: SpeedSamplePoint[];
};

const identity = new DeviceIdentity();
const store = new DeviceStore();
const signaling = new SignalingClient();
const engine = new TransferEngine(signaling, () => identity.getDeviceId());
const noSleep = new NoSleep();

const connected = ref(false);
const localIdentity = ref<LocalIdentity | null>(null);
const devices = ref<DeviceRecord[]>([]);
const discoveredDevices = ref<DeviceRecord[]>([]);
const serverMode = ref<ServerMode>('node');
const progress = ref(new Map<string, TransferProgress>());
const speedSamples = new Map<string, SpeedSampleState>();
const lastDebugProgressAt = new Map<string, number>();
const pendingDirectAccepts = new Map<string, PendingAccept>();
const pendingRelayAccepts = new Map<string, PendingAccept>();
const pendingBatchAccepts = new Map<string, PendingBatchAccept>();
const pendingRelayCompletions = new Map<string, PendingRelayCompletion>();
const activeUploads = new Map<string, { abort: () => void }>();
const activePeers = new Map<string, string>();
const activeSendKeys = new Map<string, string>();
const incomingPromptKeys = new Map<string, string>();
const incomingBatchApprovals = new Map<string, IncomingBatchApproval>();
const activeTransferKeys = new Map<string, string>();
const relayStateCache = new Map<string, { checkedAt: number; state: RelayState }>();
const autoDownloadedTransfers = new Set<string>();
const cancelledTransfers = new Set<string>();
const bandwidthMode = ref<BandwidthMode>('unlimited');
const manualLimitMbps = ref(100);
const themePreference = ref<ThemePreference>(loadThemePreference());
const serviceHostUi = ref(loadServiceHostUiPreference());
const saveDirInput = ref('');
const storageMessage = ref(messages.zh.loadStorage);
const storageStatusOk = ref(true);
let speedDisplayTimer: number | null = null;
let pageHiddenAt: number | null = null;
const progressItems = computed(() => [...progress.value.values()]);
const isZh = computed(() => navigator.language.toLowerCase().startsWith('zh'));
const t = computed(() => isZh.value ? messages.zh : messages.en);
const localStatus = computed(() => {
  const local = localIdentity.value;
  if (!local) return t.value.connecting;
  const hostView = serviceHostUi.value || isLoopbackHost(location.hostname);
  const ip = hostView ? getServiceHostIp(local) : local.ip;
  return `${t.value.local} ${ip}`;
});
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
  if (serviceHostUi.value) return true;
  const local = localIdentity.value;
  if (!local) return false;
  return Boolean(local.canDirectSave || local.serverIps.includes(local.ip));
});
const serviceHostTarget = computed<DeviceRecord | null>(() => {
  const local = localIdentity.value;
  if (serverMode.value !== 'docker') return null;
  if (!local) return null;
  const hostIp = getServiceHostIp(local);
  const hostBrowser = findServiceHostBrowserDevice(hostIp);
  return {
    id: SERVICE_HOST_DEVICE_ID,
    ip: hostIp,
    alias: null,
    userAgent: null,
    canDirectSave: true,
    virtual: true,
    lastSeen: hostBrowser?.lastSeen || Date.now()
  };
});
const targetDevices = computed(() => {
  if (serviceHostUi.value) return devices.value;
  if (isServiceHost.value) return devices.value;
  const serviceHost = serviceHostTarget.value;
  return serviceHost ? [serviceHost, ...devices.value] : devices.value;
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

  engine.onIncoming(async (meta, from) => {
    const ok = await confirmIncomingTransfer(from, meta, t.value.receivePrompt);
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

  void connectSignaling();
  void loadStorageDir();
  startSpeedDisplayTimer();
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('online', handleConnectivityRestore);
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

function loadServiceHostUiPreference() {
  const params = new URLSearchParams(location.search);
  const marker = params.get('serviceHost');
  if (marker === '1') localStorage.setItem(SERVICE_HOST_UI_KEY, '1');
  if (marker === '0') localStorage.removeItem(SERVICE_HOST_UI_KEY);
  return localStorage.getItem(SERVICE_HOST_UI_KEY) === '1';
}

function cycleTheme() {
  const order: ThemePreference[] = ['system', 'light', 'dark'];
  const index = order.indexOf(themePreference.value);
  themePreference.value = order[(index + 1) % order.length];
}

function isLoopbackHost(host: string) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function getServiceHostIp(local: LocalIdentity) {
  const advertisedIp = local.serverIps.find(ip => !isLoopbackHost(ip));
  if (advertisedIp) return advertisedIp;
  if (location.hostname && !isLoopbackHost(location.hostname)) return location.hostname;
  return local.ip || location.hostname;
}

async function connectSignaling() {
  const role = await detectHostConnectionRole();
  if (role.serverMode) serverMode.value = role.serverMode;
  serviceHostUi.value = role.hostUi;
  if (!role.hostUi) localStorage.removeItem(SERVICE_HOST_UI_KEY);
  addLog('signaling role resolved', { directSave: role.directSave, hostUi: role.hostUi, serverMode: role.serverMode, host: location.hostname });
  signaling.connect(identity.getClientId(), role.directSave, role.hostUi);
}

async function detectHostConnectionRole(): Promise<HostConnectionRole> {
  const remoteHealth = await fetchHealth(new URL('/api/health', location.origin).toString());
  const remoteMode = normalizeServerMode(remoteHealth?.deploymentMode);
  if (remoteMode !== 'docker') {
    return { directSave: isLoopbackHost(location.hostname), hostUi: false, serverMode: remoteMode };
  }

  if (serviceHostUi.value || isLoopbackHost(location.hostname)) {
    return { directSave: true, hostUi: true, serverMode: remoteMode };
  }

  const localHealth = await fetchHealth(`${location.protocol}//127.0.0.1:${location.port || '6100'}/api/health`, LOCAL_HEALTH_TIMEOUT_MS);
  const sameDockerServer = Boolean(
    localHealth?.ok &&
    normalizeServerMode(localHealth.deploymentMode) === 'docker' &&
    (!getHealthInstanceId(remoteHealth) || !getHealthInstanceId(localHealth) || getHealthInstanceId(remoteHealth) === getHealthInstanceId(localHealth))
  );

  if (sameDockerServer || await probeLocalDockerHostUi(remoteHealth)) {
    return { directSave: true, hostUi: true, serverMode: remoteMode };
  }

  return { directSave: false, hostUi: false, serverMode: remoteMode };
}

async function fetchHealth(url: string, timeoutMs = LOCAL_HEALTH_TIMEOUT_MS): Promise<HealthResponse | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal, mode: 'cors' });
    if (!response.ok) return null;
    return await response.json() as HealthResponse;
  } catch (error) {
    addLog('health probe failed', { url, error: errorMessage(error) }, 'warn');
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

function getHealthInstanceId(health: HealthResponse | null | undefined) {
  return health?.serverInstanceId || health?.instanceId || '';
}

function probeLocalDockerHostUi(remoteHealth: HealthResponse | null) {
  return new Promise<boolean>(resolve => {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams({
      deviceId: identity.getClientId(),
      directSave: '1',
      hostUi: '1',
      probe: '1'
    });
    const url = `${protocol}://127.0.0.1:${location.port || '6100'}/ws?${params.toString()}`;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // ignore probe close errors
      }
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), LOCAL_HEALTH_TIMEOUT_MS);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      addLog('local host websocket probe failed to start', { url, error: errorMessage(error) }, 'warn');
      window.clearTimeout(timer);
      resolve(false);
      return;
    }
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data) as SignalingMessage & { serverInstanceId?: string };
        const instanceId = message.serverInstanceId || getHealthInstanceId(message as unknown as HealthResponse);
        const ok = message.type === 'hello' &&
          normalizeServerMode(message.serverMode) === 'docker' &&
          (!getHealthInstanceId(remoteHealth) || !instanceId || getHealthInstanceId(remoteHealth) === instanceId);
        finish(ok);
      } catch (error) {
        addLog('local host websocket probe parse failed', { error: errorMessage(error) }, 'warn');
        finish(false);
      }
    });
    socket.addEventListener('error', () => finish(false));
    socket.addEventListener('close', () => finish(done));
  });
}

function findServiceHostBrowserDevice(hostIp: string) {
  return dedupeDevices(discoveredDevices.value).find(device => {
    if (isServiceHostEntry(device)) return false;
    return isLikelyServiceHostBrowser(device, hostIp);
  });
}

function isLocalServiceHostDevice(device: DeviceRecord) {
  if (serverMode.value !== 'docker') return false;
  return isLikelyServiceHostBrowser(device);
}

function dedupeDevices(list: DeviceRecord[]) {
  const byKey = new Map<string, DeviceRecord>();
  for (const device of list) {
    const key = device.id || `${device.ip}|${device.userAgent || ''}`;
    const current = byKey.get(key);
    if (!current || device.lastSeen > current.lastSeen) byKey.set(key, device);
  }
  return [...byKey.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

async function handleAppMessage(message: SignalingMessage) {
  if (message.type === 'hello') {
    serverMode.value = normalizeServerMode(message.serverMode);
    localIdentity.value = identity.applyServerIdentity(message.device, message.serverIps);
    await store.upsert(localIdentity.value);
    return;
  }

  if (message.type === 'device-list') {
    discoveredDevices.value = message.devices;
    const visibleDevices = dedupeDevices(message.devices.filter(device => !isLocalServiceHostDevice(device)));
    devices.value = visibleDevices;
    await store.upsertMany(visibleDevices);
    return;
  }

  if (message.type === 'direct-transfer-request') {
    await handleDirectTransferRequest(message.from, message.fileMeta);
    return;
  }

  if (message.type === 'batch-transfer-request') {
    await handleBatchTransferRequest(message.from, message);
    return;
  }

  if (message.type === 'batch-transfer-accept') {
    resolvePending(pendingBatchAccepts, message.batchId);
    return;
  }

  if (message.type === 'batch-transfer-reject') {
    rejectPending(pendingBatchAccepts, message.batchId, message.reason || t.value.receiverRejected);
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
    updateDirectTransferProgress(message.transferId, message.fileName, message.bytesTransferred, message.totalBytes, false);
    return;
  }

  if (message.type === 'direct-transfer-complete') {
    if (cancelledTransfers.has(message.transferId)) return;
    updateDirectTransferProgress(message.transferId, message.fileName, message.bytesTransferred, message.totalBytes, true, `${t.value.savedToPc}: ${message.path}`);
    disableWakeLock();
    return;
  }

  if (message.type === 'direct-transfer-error') {
    if (cancelledTransfers.has(message.transferId)) return;
    const current = progress.value.get(message.transferId);
    if (current?.done) return;
    if (message.cancelled && current) {
      cancelledTransfers.add(message.transferId);
      autoDownloadedTransfers.add(message.transferId);
      activeUploads.get(message.transferId)?.abort();
      activeUploads.delete(message.transferId);
      markCancelled(
        message.transferId,
        current.direction === 'send' ? t.value.remoteCancelled : t.value.cancelled,
        current.peerId
      );
      disableWakeLock();
      return;
    }
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
    updateRelayTransferProgress(
      message.transferId,
      message.fileName,
      message.bytesTransferred,
      message.totalBytes,
      message.bytesUploaded,
      message.bytesDownloaded
    );
    return;
  }

  if (message.type === 'relay-transfer-ready') {
    if (cancelledTransfers.has(message.transferId)) return;
    handleRelayTransferReady(message.transferId, message.fileName, message.bytesWritten || 0);
    return;
  }

  if (message.type === 'relay-transfer-complete') {
    if (cancelledTransfers.has(message.transferId)) return;
    handleRelayTransferComplete(
      message.transferId,
      message.fileName,
      message.bytesUploaded,
      message.bytesDownloaded,
      message.totalBytes
    );
    return;
  }

  if (message.type === 'relay-transfer-error') {
    handleRelayTransferError(message.transferId, message.fileName, message.message, message.cancelled);
    return;
  }

  if (message.type === 'transfer-cancel') {
    handleRemoteCancel(message.transferId, message.from, message.reason);
    return;
  }

  if (message.type === 'peer-unavailable') {
    rejectPendingTransfersForPeer(message.to, t.value.failed);
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
    copy.fileMeta = {
      transferId: meta.transferId,
      name: meta.name,
      size: meta.size,
      type: meta.type,
      batchId: meta.batchId,
      batchIndex: meta.batchIndex,
      batchTotal: meta.batchTotal,
      packageType: meta.packageType,
      packageCount: meta.packageCount
    };
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
    bytesUploaded: item.bytesUploaded,
    bytesDelivered: item.bytesDelivered,
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

function handleFileInputClick(event: MouseEvent, device: DeviceRecord) {
  const input = event.currentTarget as HTMLInputElement;
  input.value = '';
  addLog('opening native file picker', { target: device.id });
}

async function handleFilePicked(event: Event, target: DeviceRecord) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  if (files.length === 0) return;
  await sendSelectedFiles(target, files);
}

async function sendSelectedFiles(target: DeviceRecord, files: File[]) {
  if (files.length === 1) {
    await sendSelectedFile(target, files[0]);
    return;
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  const plan = createSendPlan(files);
  const batchId = createTransferId();
  addLog('batch files selected', {
    target: target.id,
    batchId,
    count: files.length,
    totalSize,
    plan: plan.map(item => ({ type: Array.isArray(item) ? 'batch' : 'file', count: Array.isArray(item) ? item.length : 1 }))
  });

  // Negotiate one receiver decision before any per-file protocol starts.
  // This covers mixed batches where the first item is P2P and the next item
  // is a browser download or a direct-save upload.
  if (target.id !== SERVICE_HOST_DEVICE_ID) {
    try {
      await requestBatchApproval(target, {
        batchId,
        batchTotal: plan.length,
        fileCount: files.length,
        totalBytes: totalSize
      });
    } catch (error) {
      addLog('batch approval failed', {
        target: target.id,
        batchId,
        fileCount: files.length,
        error: errorMessage(error)
      }, 'warn');
      return;
    }
  }

  for (const [batchIndex, item] of plan.entries()) {
    const file = Array.isArray(item) ? await createBatchZipFile(item) : item;
    await sendSelectedFile(target, file, {
      batchId,
      batchIndex,
      batchTotal: plan.length
    });
    if (wasLastSendCancelledOrFailed(target.id, file)) break;
  }
}

async function sendSelectedFile(target: DeviceRecord, file: File, batchMeta?: TransferBatchMeta) {
  const transferMeta = createTransferMetadata(file, batchMeta);
  addLog('file selected', {
    target: target.id,
    targetIp: target.ip,
    targetUa: target.userAgent,
    file: file.name,
    size: file.size,
    batchId: transferMeta?.batchId,
    batchIndex: transferMeta?.batchIndex,
    batchTotal: transferMeta?.batchTotal,
    direct: shouldDirectSave(target, file),
    relay: shouldRelayToBrowserDownload(target, file)
  });
  enableWakeLock();
  if (shouldDirectSave(target, file)) {
    await sendDirectToServer(target, file, transferMeta);
    return;
  }
  if (shouldRelayToBrowserDownload(target, file)) {
    await sendRelayToBrowserDownload(target, file, transferMeta);
    return;
  }
  try {
    await engine.sendFile(target.id, file, transferMeta);
  } catch (error) {
    addLog('p2p transfer failed', {
      target: target.id,
      file: file.name,
      size: file.size,
      error: errorMessage(error)
    }, 'warn');
  } finally {
    disableWakeLock();
  }
}

async function handleDirectTransferRequest(from: string, meta: FileMeta) {
  addLog('direct request received', { from, transferId: meta.transferId, file: meta.name, size: meta.size });
  if (rejectDuplicateIncoming(from, meta, 'direct')) return;
  const ok = await confirmIncomingTransfer(from, meta, t.value.receiveLargePrompt);
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

async function handleBatchTransferRequest(from: string, message: Extract<SignalingMessage, { type: 'batch-transfer-request' }>) {
  const key = createIncomingBatchKey(from, message.batchId);
  const existing = incomingBatchApprovals.get(key);
  if (existing) {
    refreshIncomingBatchApproval(key, existing);
    signaling.send({
      type: existing.accepted ? 'batch-transfer-accept' : 'batch-transfer-reject',
      to: from,
      batchId: message.batchId,
      reason: existing.accepted ? undefined : t.value.receiverRejected
    });
    addLog('duplicate batch approval request answered', {
      from,
      batchId: message.batchId,
      accepted: existing.accepted
    }, existing.accepted ? 'info' : 'warn');
    return;
  }

  const accepted = window.confirm(
    `${t.value.receiveBatchPrompt} (${message.fileCount} files, ${formatBytes(message.totalBytes)})?`
  );
  storeIncomingBatchApproval(key, {
    accepted,
    transferIds: new Set(),
    timer: 0
  });
  signaling.send({
    type: accepted ? 'batch-transfer-accept' : 'batch-transfer-reject',
    to: from,
    batchId: message.batchId,
    reason: accepted ? undefined : t.value.receiverRejected
  });
  addLog(accepted ? 'batch approval accepted' : 'batch approval rejected', {
    from,
    batchId: message.batchId,
    batchTotal: message.batchTotal,
    fileCount: message.fileCount,
    totalBytes: message.totalBytes
  }, accepted ? 'info' : 'warn');
}

async function handleRelayTransferRequest(from: string, meta: FileMeta) {
  addLog('relay request received', { from, transferId: meta.transferId, file: meta.name, size: meta.size });
  if (rejectDuplicateIncoming(from, meta, 'relay')) return;
  const ok = await confirmIncomingTransfer(from, meta, t.value.receiveLargePrompt);
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

async function confirmIncomingTransfer(from: string, meta: FileMeta, promptLabel: string) {
  // batchTotal is the number of actual transfer jobs, not the number of files.
  // Several small files can be packaged into one ZIP, so a real batch can have
  // batchTotal === 1. batchId is the authoritative batch marker.
  if (!isBatchTransferMeta(meta)) {
    return window.confirm(`${promptLabel} ${meta.name} (${formatBytes(meta.size)})?`);
  }

  const key = createIncomingBatchKey(from, meta.batchId);
  const existing = incomingBatchApprovals.get(key);
  if (existing) {
    refreshIncomingBatchApproval(key, existing);
    const duplicate = existing.transferIds.has(meta.transferId);
    if (!duplicate) existing.transferIds.add(meta.transferId);
    addLog(existing.accepted ? 'batch request auto accepted' : 'batch request auto rejected', {
      from,
      batchId: meta.batchId,
      transferId: meta.transferId,
      batchIndex: meta.batchIndex,
      batchTotal: meta.batchTotal,
      duplicate,
      approvedTransferCount: existing.transferIds.size
    }, existing.accepted ? 'info' : 'warn');
    return existing.accepted;
  }

  const accepted = window.confirm(`${promptLabel} ${meta.name} (${formatBytes(meta.size)})?`);
  storeIncomingBatchApproval(key, {
    accepted,
    transferIds: new Set([meta.transferId]),
    timer: 0
  });
  addLog(accepted ? 'batch request approval created' : 'batch request rejection created', {
    from,
    batchId: meta.batchId,
    transferId: meta.transferId,
    batchIndex: meta.batchIndex,
    batchTotal: meta.batchTotal,
    approvedTransferCount: 1
  }, accepted ? 'info' : 'warn');
  return accepted;
}

function createIncomingBatchKey(from: string, batchId: string) {
  return `${from}:${batchId}`;
}

function storeIncomingBatchApproval(key: string, approval: IncomingBatchApproval) {
  incomingBatchApprovals.set(key, approval);
  refreshIncomingBatchApproval(key, approval);
}

function refreshIncomingBatchApproval(key: string, approval: IncomingBatchApproval) {
  if (approval.timer) window.clearTimeout(approval.timer);
  const timer = window.setTimeout(() => {
    const current = incomingBatchApprovals.get(key);
    if (current?.timer === timer) incomingBatchApprovals.delete(key);
  }, INCOMING_BATCH_APPROVAL_TTL_MS);
  approval.timer = timer;
}

function clearIncomingBatchApproval(key: string) {
  const approval = incomingBatchApprovals.get(key);
  if (!approval) return;
  window.clearTimeout(approval.timer);
  incomingBatchApprovals.delete(key);
}

function clearIncomingBatchApprovalForTransfer(from: string, transferId: string) {
  for (const [key, approval] of incomingBatchApprovals) {
    if (!key.startsWith(`${from}:`) || !approval.transferIds.has(transferId)) continue;
    // Cancelling one item must not revoke the receiver's approval for the
    // remaining files in the same mixed-size batch.
    approval.transferIds.delete(transferId);
  }
}

function clearIncomingBatchApprovals() {
  for (const key of incomingBatchApprovals.keys()) clearIncomingBatchApproval(key);
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

function requestBatchApproval(target: DeviceRecord, summary: BatchTransferSummary) {
  const pending = waitForPending(pendingBatchAccepts, summary.batchId);
  signaling.send({
    type: 'batch-transfer-request',
    to: target.id,
    batchId: summary.batchId,
    batchTotal: summary.batchTotal,
    fileCount: summary.fileCount,
    totalBytes: summary.totalBytes
  });
  addLog('batch approval request sent', {
    target: target.id,
    ...summary
  });
  return pending;
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

function rejectPendingTransfersForPeer(peerId: string, reason: string) {
  for (const [transferId, targetId] of activePeers) {
    if (targetId !== peerId) continue;
    rejectPending(pendingDirectAccepts, transferId, reason);
    rejectPending(pendingRelayAccepts, transferId, reason);
  }
}

function rejectDuplicateIncoming(from: string, meta: FileMeta, mode: 'direct' | 'relay') {
  const key = createMetaTransferKey(from, meta, mode);
  const existingId = incomingPromptKeys.get(key);
  if (!existingId || !isTransferActive(existingId)) {
    if (existingId) incomingPromptKeys.delete(key);
    return false;
  }
  if (existingId === meta.transferId) {
    signaling.send({
      type: mode === 'direct' ? 'direct-transfer-accept' : 'relay-transfer-accept',
      to: from,
      transferId: meta.transferId
    });
    addLog('duplicate accepted request acknowledged again', { from, transferId: meta.transferId, file: meta.name, mode });
    return true;
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

function updateDirectTransferProgress(transferId: string, fileName: string, bytesTransferred: number, totalBytes: number, done: boolean, statusText?: string) {
  if (cancelledTransfers.has(transferId)) return;
  const current = progress.value.get(transferId);
  if (current?.done) return;
  const item = withSpeedSample({
    ...current,
    id: transferId,
    direction: current?.direction || 'receive',
    fileName: current?.fileName || fileName,
    bytesTransferred,
    bytesDelivered: bytesTransferred,
    totalBytes: Math.max(current?.totalBytes || 0, totalBytes || 0),
    done,
    mode: 'direct',
    cancellable: !done,
    peerId: current?.peerId,
    statusText: statusText || (done ? t.value.receiveComplete : t.value.savingDisk)
  });
  setProgress(item);
  if (done) clearTransferBookkeeping(transferId);
}

function updateRelayTransferProgress(transferId: string, fileName: string, bytesTransferred: number, totalBytes: number, bytesUploaded?: number, bytesDownloaded?: number) {
  if (cancelledTransfers.has(transferId)) return;
  const current = progress.value.get(transferId);
  if (current?.done) return;
  const direction = current?.direction || 'receive';
  const safeTotal = Math.max(current?.totalBytes || 0, totalBytes || 0);
  const delivered = Math.max(current?.bytesDelivered || 0, bytesDownloaded ?? bytesTransferred);
  const displayedBytes = safeTotal > 0 ? Math.min(delivered, safeTotal) : delivered;
  const uploaded = typeof bytesUploaded === 'number'
    ? Math.max(current?.bytesUploaded || 0, bytesUploaded)
    : current?.bytesUploaded;
  setProgress(withSpeedSample({
    ...current,
    id: transferId,
    direction,
    fileName: current?.fileName || fileName,
    bytesTransferred: displayedBytes,
    bytesUploaded: uploaded,
    bytesDelivered: delivered,
    totalBytes: safeTotal,
    done: false,
    mode: 'relay',
    cancellable: true,
    peerId: current?.peerId,
    statusText: current?.statusText || t.value.receivingRelay
  }));
}

function handleRelayTransferReady(transferId: string, fileName: string, bytesWritten: number) {
  if (cancelledTransfers.has(transferId)) return;
  const current = progress.value.get(transferId);
  if (!current || current.done) return;
  setProgress({
    ...current,
    fileName: current.fileName || fileName,
    bytesUploaded: Math.max(current.bytesUploaded || 0, bytesWritten || 0),
    cancellable: true,
    needsUserSave: false,
    statusText: current.bytesTransferred > 0 ? t.value.receivingRelay : t.value.sentDownloadManager
  });
}

function handleRelayTransferComplete(transferId: string, fileName: string, bytesUploaded: number, bytesDownloaded: number, totalBytes: number) {
  if (cancelledTransfers.has(transferId)) return;
  const current = progress.value.get(transferId);
  if (current?.done) return;
  const safeTotal = Math.max(current?.totalBytes || 0, totalBytes || 0, bytesDownloaded || 0);
  const delivered = Math.max(current?.bytesDelivered || 0, bytesDownloaded || 0, safeTotal);
  if (!current?.done) {
    setProgress(withSpeedSample({
      ...current,
      id: transferId,
      direction: current?.direction || 'receive',
      fileName: current?.fileName || fileName,
      bytesTransferred: delivered,
      bytesUploaded: Math.max(current?.bytesUploaded || 0, bytesUploaded || 0),
      bytesDelivered: delivered,
      totalBytes: safeTotal,
      done: true,
      mode: 'relay',
      cancellable: false,
      needsUserSave: false,
      peerId: current?.peerId,
      statusText: t.value.receiveComplete
    }));
  }
  resolveRelayCompletion(transferId, { fileName, bytesUploaded, bytesDownloaded: delivered, totalBytes: safeTotal });
  clearTransferBookkeeping(transferId);
  disableWakeLock();
}

function handleRelayTransferError(transferId: string, fileName = 'Relay file', message: string, cancelled = false) {
  const current = progress.value.get(transferId);
  if (current?.done) return;
  rejectRelayCompletion(transferId, message);
  if (cancelledTransfers.has(transferId)) return;
  if (cancelled) {
    cancelledTransfers.add(transferId);
    autoDownloadedTransfers.add(transferId);
    activeUploads.get(transferId)?.abort();
    activeUploads.delete(transferId);
    markCancelled(transferId, t.value.remoteCancelled, current?.peerId);
    disableWakeLock();
    return;
  }
  addLog('relay transfer error received', { transferId, fileName, direction: current?.direction, message }, 'warn');
  setProgress({
    id: transferId,
    direction: current?.direction || 'receive',
    fileName: current?.fileName || fileName,
    bytesTransferred: current?.bytesTransferred || 0,
    bytesUploaded: current?.bytesUploaded,
    bytesDelivered: current?.bytesDelivered,
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
  const previousState = speedSamples.get(item.id);
  const current = progress.value.get(item.id);
  const startedAt = current?.startedAt || item.startedAt || now;
  const safeTotal = Math.max(item.totalBytes || 0, current?.totalBytes || 0);
  const safeBytes = item.done
    ? Math.max(item.bytesTransferred || 0, current?.bytesTransferred || 0)
    : Math.min(safeTotal || item.bytesTransferred || 0, Math.max(item.bytesTransferred || 0, current?.bytesTransferred || 0));
  const normalized = { ...item, bytesTransferred: safeBytes, totalBytes: safeTotal || item.totalBytes, startedAt, completedAt: item.done ? item.completedAt || now : item.completedAt };
  const needsNewSample = !previousState || previousState.direction !== normalized.direction || previousState.mode !== normalized.mode;
  const state = needsNewSample
    ? createSpeedSampleState(normalized, current, startedAt)
    : previousState;

  if (needsNewSample) {
    speedSamples.set(item.id, state);
    if (!normalized.done) return normalized;
  }

  if (normalized.done) {
    const sample = speedSamples.get(item.id) || state;
    const sampleStartedAt = sample.startedAt || startedAt;
    const completedAt = normalized.completedAt || now;
    const elapsedSeconds = Math.max((completedAt - sampleStartedAt) / 1000, 0.001);
    appendSpeedSamplePoint(sample, completedAt, normalized.bytesTransferred);
    const finalWindowSpeed = getWindowSpeed(sample, completedAt);
    const peak = Math.max(current?.peakBytesPerSecond || 0, current?.speedBytesPerSecond || 0, finalWindowSpeed || 0);
    return {
      ...normalized,
      completedAt,
      speedBytesPerSecond: 0,
      averageBytesPerSecond: normalized.bytesTransferred / elapsedSeconds,
      peakBytesPerSecond: peak || current?.peakBytesPerSecond
    };
  }

  const sample = speedSamples.get(item.id) || state;
  appendSpeedSamplePoint(sample, now, normalized.bytesTransferred);
  const windowSpeed = getWindowSpeed(sample, now);
  const smoothedSpeed = smoothSpeed(current?.speedBytesPerSecond, windowSpeed);
  const elapsedSeconds = Math.max((now - sample.startedAt) / 1000, 0.001);
  const sampled = {
    ...normalized,
    speedBytesPerSecond: smoothedSpeed,
    averageBytesPerSecond: normalized.bytesTransferred / elapsedSeconds,
    peakBytesPerSecond: Math.max(current?.peakBytesPerSecond || 0, current?.speedBytesPerSecond || 0, smoothedSpeed || 0)
  };
  return sampled;
}

function createSpeedSampleState(item: TransferProgress, current: TransferProgress | undefined, startedAt: number): SpeedSampleState {
  const initialBytes = Math.min(item.bytesTransferred || 0, Math.max(current?.bytesTransferred || 0, 0));
  return {
    startedAt,
    direction: item.direction,
    mode: item.mode,
    points: [{ at: startedAt, bytes: initialBytes }]
  };
}

function appendSpeedSamplePoint(state: SpeedSampleState, at: number, bytes: number) {
  const last = state.points[state.points.length - 1];
  const safeBytes = Math.max(bytes, last?.bytes || 0);
  if (state.points.length === 1 && last?.bytes === 0 && safeBytes > 0) {
    // Do not let receiver confirmation and WebRTC/HTTP setup dilute the
    // short-window transfer speed once payload bytes actually start moving.
    state.points[0] = { at, bytes: safeBytes };
    return;
  }
  if (!last) {
    state.points.push({ at, bytes: safeBytes });
  } else if (at - last.at < SPEED_SAMPLE_MIN_INTERVAL_MS) {
    last.at = at;
    last.bytes = safeBytes;
  } else if (last.at === at) {
    last.bytes = safeBytes;
  } else {
    state.points.push({ at, bytes: safeBytes });
  }

  const cutoff = at - SPEED_SAMPLE_WINDOW_MS;
  while (state.points.length > 2 && state.points[1].at < cutoff) state.points.shift();
}

function getWindowSpeed(state: SpeedSampleState, now: number) {
  if (state.points.length < 2) return undefined;
  const latest = state.points[state.points.length - 1];
  const cutoff = Math.max(state.points[0].at, now - SPEED_SAMPLE_WINDOW_MS);
  const start = getWindowStartPoint(state.points, cutoff);
  const elapsedMs = Math.max(latest.at - start.at, 1);
  return Math.max(((latest.bytes - start.bytes) / elapsedMs) * 1000, 0);
}

function getWindowStartPoint(points: SpeedSamplePoint[], cutoff: number): SpeedSamplePoint {
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const next = points[index];
    if (next.at < cutoff) continue;
    if (next.at === previous.at) return next;
    const ratio = Math.max(0, Math.min(1, (cutoff - previous.at) / (next.at - previous.at)));
    return {
      at: cutoff,
      bytes: previous.bytes + (next.bytes - previous.bytes) * ratio
    };
  }
  return points[0];
}

function smoothSpeed(previousSpeed: number | undefined, instantSpeed: number | undefined) {
  if (typeof instantSpeed !== 'number' || !Number.isFinite(instantSpeed)) return previousSpeed;
  if (!previousSpeed || !Number.isFinite(previousSpeed)) return instantSpeed;
  const weight = instantSpeed >= previousSpeed ? 0.7 : 0.35;
  return previousSpeed + (instantSpeed - previousSpeed) * weight;
}

function refreshActiveSpeedDisplays() {
  let changed = false;
  const nextProgress = new Map(progress.value);
  for (const item of progress.value.values()) {
    if (item.done || !speedSamples.has(item.id)) continue;
    const sampled = withSpeedSample(item);
    if (
      sampled.speedBytesPerSecond !== item.speedBytesPerSecond ||
      sampled.averageBytesPerSecond !== item.averageBytesPerSecond ||
      sampled.peakBytesPerSecond !== item.peakBytesPerSecond
    ) {
      nextProgress.set(item.id, sampled);
      changed = true;
    }
  }
  if (changed) progress.value = nextProgress;
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
  return file.size > DIRECT_SAVE_THRESHOLD && canDirectSaveTo(target);
}

function shouldRelayToBrowserDownload(target: DeviceRecord, file: File) {
  return file.size > P2P_MAX_FILE_SIZE && !shouldDirectSave(target, file);
}

function canDirectSaveTo(target: DeviceRecord) {
  if (target.canDirectSave) return true;
  const serverIps = localIdentity.value?.serverIps ?? [];
  if (serverIps.includes(target.ip)) return true;
  if (target.ip === location.hostname || target.id === location.hostname) return true;
  return false;
}

function isServiceHostEntry(device: DeviceRecord) {
  return device.id === SERVICE_HOST_DEVICE_ID;
}

function isLikelyServiceHostBrowser(device: DeviceRecord, hostIp?: string) {
  if (isServiceHostEntry(device)) return false;
  if (serverMode.value !== 'docker') return false;
  if (device.hostUi) return true;
  if (device.virtual) return false;
  const serverIps = localIdentity.value?.serverIps ?? [];
  const serviceHostIp = hostIp || (localIdentity.value ? getServiceHostIp(localIdentity.value) : location.hostname);
  const hostCandidates = new Set([serviceHostIp, location.hostname, ...serverIps].filter(Boolean));
  return Boolean(device.canDirectSave && (hostCandidates.has(device.ip) || hostCandidates.has(device.id)));
}

function deviceCardClass(device: DeviceRecord) {
  return 'border-line hover:border-teal/40';
}

function displayDeviceName(device: DeviceRecord) {
  if (isServiceHostEntry(device)) return device.ip;
  return identity.getDisplayName(device);
}

function deviceReceiveModeLabel(device: DeviceRecord) {
  if (canDirectSaveTo(device)) return t.value.direct;
  return t.value.browserDownloadMode;
}

function normalizeServerMode(value?: string): ServerMode {
  return value === 'docker' ? 'docker' : 'node';
}

async function sendDirectToServer(target: DeviceRecord, file: File, batchMeta?: TransferBatchMeta) {
  const duplicateId = findActiveSend(target.id, file, 'direct');
  if (duplicateId) {
    updateStatus(duplicateId, pendingDirectAccepts.has(duplicateId) ? t.value.waitConfirm : t.value.savingDisk);
    addLog('duplicate direct send reused', { duplicateId, target: target.id, file: file.name, size: file.size }, 'warn');
    if (pendingDirectAccepts.has(duplicateId)) {
      signaling.send({ type: 'direct-transfer-request', to: target.id, fileMeta: createFileMeta(duplicateId, file, batchMeta) });
      addLog('direct request resent', { transferId: duplicateId, to: target.id });
    }
    return;
  }
  const id = createTransferId();
  trackActiveSend(target.id, file, 'direct', id);
  activePeers.set(id, target.id);
  addLog('direct send created', { transferId: id, target: target.id, file: file.name, size: file.size });
  const fileMeta = createFileMeta(id, file, batchMeta);
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
    addLog('direct request accepted by peer', { transferId: id, target: target.id });
    updateStatus(id, t.value.savingDisk);
    const result = await uploadWithProgress(file, id, uploaded => updateUploaded(id, uploaded));
    updateDirectTransferProgress(
      id,
      result.fileName || file.name,
      result.bytesWritten,
      file.size,
      true,
      `${t.value.savedToPc}: ${result.path}`
    );
  } catch (error) {
    markFailed(id, file, 'direct', error);
  } finally {
    pendingDirectAccepts.delete(id);
    clearTransferBookkeeping(id);
    disableWakeLock();
  }
}

async function sendRelayToBrowserDownload(target: DeviceRecord, file: File, batchMeta?: TransferBatchMeta) {
  const duplicateId = findActiveSend(target.id, file, 'relay');
  if (duplicateId) {
    updateStatus(duplicateId, t.value.waitPhoneConfirm);
    addLog('duplicate relay send reused', { duplicateId, target: target.id, file: file.name, size: file.size }, 'warn');
    if (pendingRelayAccepts.has(duplicateId)) {
      signaling.send({ type: 'relay-transfer-request', to: target.id, fileMeta: createFileMeta(duplicateId, file, batchMeta) });
      addLog('relay request resent', { transferId: duplicateId, to: target.id });
    }
    return;
  }
  const id = createTransferId();
  trackActiveSend(target.id, file, 'relay', id);
  activePeers.set(id, target.id);
  addLog('relay send created', { transferId: id, target: target.id, file: file.name, size: file.size });
  const fileMeta = createFileMeta(id, file, batchMeta);
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

  const completionPromise = waitForRelayCompletion(id);
  void completionPromise.catch(() => undefined);

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
    if (!progress.value.get(id)?.done) {
      signaling.send({
        type: 'relay-transfer-ready',
        to: target.id,
        transferId: id,
        fileName: result.fileName,
        downloadUrl: `/api/transfers/relay/${encodeURIComponent(id)}/${encodeURIComponent(result.fileName)}`,
        bytesWritten: result.bytesWritten
      });
      updateStatus(id, t.value.receivingRelay);
    }
    const completion = await completionPromise;
    addLog('relay receiver completion confirmed', { transferId: id, completion });
  } catch (error) {
    rejectRelayCompletion(id, errorMessage(error));
    markFailed(id, file, 'relay', error);
  } finally {
    pendingRelayAccepts.delete(id);
    pendingRelayCompletions.delete(id);
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
  rejectRelayCompletion(item.id, t.value.cancelled);
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
  const current = progress.value.get(transferId);
  if (current?.done && !current.cancelled) {
    addLog('remote cancellation ignored after completion', { transferId, from }, 'warn');
    return;
  }
  addLog('remote transfer cancelled', { transferId, from, reason }, 'warn');
  clearIncomingBatchApprovalForTransfer(from, transferId);
  cancelledTransfers.add(transferId);
  autoDownloadedTransfers.add(transferId);
  activeUploads.get(transferId)?.abort();
  activeUploads.delete(transferId);
  cleanupServerTransfer(transferId, progress.value.get(transferId)?.mode);
  rejectPending(pendingDirectAccepts, transferId, reason || t.value.remoteCancelled);
  rejectPending(pendingRelayAccepts, transferId, reason || t.value.remoteCancelled);
  rejectRelayCompletion(transferId, reason || t.value.remoteCancelled);
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
  if (current?.done && !current.cancelled) return;
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

function createFileMeta(transferId: string, file: File, batchMeta?: TransferBatchMeta): FileMeta {
  return {
    transferId,
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    lastModified: file.lastModified,
    ...createTransferMetadata(file, batchMeta)
  };
}

function createTransferMetadata(file: File, batchMeta?: TransferBatchMeta): TransferBatchMeta | undefined {
  const batchCount = getBatchFileCount(file);
  if (!batchMeta && batchCount <= 0) return undefined;
  return {
    ...batchMeta,
    ...(batchCount > 0
      ? { packageType: 'crosslan-zip' as const, packageCount: batchCount }
      : {})
  };
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
  setProgress({ ...current, bytesUploaded: Math.max(current.bytesUploaded || 0, uploaded) });
}

function markFailed(id: string, file: File, mode: 'direct' | 'relay', error: unknown) {
  const current = progress.value.get(id);
  if (current?.done) {
    addLog('transfer failure ignored after terminal state', {
      transferId: id,
      file: file.name,
      mode,
      error: errorMessage(error)
    }, 'warn');
    return;
  }
  if (cancelledTransfers.has(id)) {
    addLog('transfer failure ignored after cancellation', {
      transferId: id,
      file: file.name,
      mode,
      error: errorMessage(error)
    }, 'warn');
    return;
  }
  if (error instanceof Error && error.name === 'RelayCancelledError') {
    cancelledTransfers.add(id);
    autoDownloadedTransfers.add(id);
    markCancelled(id, t.value.remoteCancelled, current?.peerId);
    return;
  }
  const message = error instanceof Error ? error.message : t.value.failed;
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
    return uploadFileChunkedWithThrottle<{ fileName: string; path: string; bytesWritten: number }>(`/api/transfers/direct/${encodeURIComponent(transferId)}/chunk`, file, transferId, onProgress);
  }
  return uploadFileWithProgress<{ fileName: string; path: string; bytesWritten: number }>('/api/transfers/direct', file, transferId, onProgress);
}

function uploadRelayWithProgress(file: File, transferId: string, onProgress: (uploaded: number) => void) {
  if (shouldThrottleHttpUpload()) {
    return uploadFileChunkedWithThrottle<{ fileName: string; bytesWritten: number }>(`/api/transfers/relay/${encodeURIComponent(transferId)}/chunk`, file, transferId, onProgress);
  }
  addLog('relay upload using continuous xhr path', { transferId, file: file.name, size: file.size });
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

async function fetchRelayState(transferId: string, signal: AbortSignal, force = false) {
  const cached = relayStateCache.get(transferId);
  const now = performance.now();
  if (!force && cached && now - cached.checkedAt < RELAY_STATE_CACHE_MS) return cached.state;
  const response = await fetch(`/api/transfers/relay/${encodeURIComponent(transferId)}/state`, { signal, cache: 'no-store' });
  const data = await response.json() as RelayState;
  if (response.status === 410 || data.cancelled) {
    const error = new Error(t.value.remoteCancelled);
    error.name = 'RelayCancelledError';
    throw error;
  }
  if (!response.ok) throw new Error(data.message || `Relay state failed: HTTP ${response.status}`);
  relayStateCache.set(transferId, { checkedAt: now, state: data });
  return data;
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
  if (!isServiceHost.value) {
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
  if (document.visibilityState === 'hidden') {
    pageHiddenAt = performance.now();
    stopSpeedDisplayTimer();
    addLog('page moved to background; active transfers remain attached', {
      transferIds: getActiveTransferIds()
    });
    return;
  }

  const hiddenDurationMs = pageHiddenAt === null ? 0 : Math.max(performance.now() - pageHiddenAt, 0);
  pageHiddenAt = null;
  resetActiveSpeedWindows();
  startSpeedDisplayTimer();
  signaling.requestDeviceList();
  void reconcileActiveRelayTransfers();
  addLog('page returned to foreground', {
    hiddenDurationMs: Math.round(hiddenDurationMs),
    transferIds: getActiveTransferIds()
  });
}

function handleConnectivityRestore() {
  signaling.requestDeviceList();
  resetActiveSpeedWindows();
  void reconcileActiveRelayTransfers();
}

function startSpeedDisplayTimer() {
  if (speedDisplayTimer !== null || document.visibilityState === 'hidden') return;
  speedDisplayTimer = window.setInterval(refreshActiveSpeedDisplays, SPEED_DISPLAY_REFRESH_MS);
}

function stopSpeedDisplayTimer() {
  if (speedDisplayTimer === null) return;
  window.clearInterval(speedDisplayTimer);
  speedDisplayTimer = null;
}

function getActiveTransferIds() {
  return [...progress.value.values()].filter(item => !item.done).map(item => item.id);
}

function resetActiveSpeedWindows() {
  const now = performance.now();
  for (const item of progress.value.values()) {
    if (item.done) continue;
    const state = speedSamples.get(item.id);
    if (!state) continue;
    state.points = [{ at: now, bytes: item.bytesTransferred }];
  }
}

function waitForRelayCompletion(transferId: string) {
  return new Promise<RelayCompletion>((resolve, reject) => {
    pendingRelayCompletions.set(transferId, { resolve, reject });
  });
}

function resolveRelayCompletion(transferId: string, completion: RelayCompletion) {
  const pending = pendingRelayCompletions.get(transferId);
  if (!pending) return;
  pendingRelayCompletions.delete(transferId);
  pending.resolve(completion);
}

function rejectRelayCompletion(transferId: string, reason: string) {
  const pending = pendingRelayCompletions.get(transferId);
  if (!pending) return;
  pendingRelayCompletions.delete(transferId);
  pending.reject(new Error(reason));
}

async function reconcileActiveRelayTransfers() {
  const relayItems = [...progress.value.values()].filter(item => item.mode === 'relay' && !item.done);
  await Promise.all(relayItems.map(async item => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2500);
    try {
      relayStateCache.delete(item.id);
      const state = await fetchRelayState(item.id, controller.signal, true);
      const downloaded = state.bytesDownloaded;
      if (typeof downloaded !== 'number' || !Number.isFinite(downloaded)) return;
      const totalBytes = Math.max(item.totalBytes, state.expectedSize || 0);
      if (state.downloadComplete) {
        handleRelayTransferComplete(
          item.id,
          item.fileName,
          state.bytesUploaded || 0,
          downloaded,
          totalBytes
        );
        return;
      }
      updateRelayTransferProgress(item.id, item.fileName, downloaded, totalBytes, state.bytesUploaded, downloaded);
      addLog('relay progress reconciled after background', {
        transferId: item.id,
        direction: item.direction,
        bytesTransferred: downloaded,
        bytesUploaded: state.bytesUploaded
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'RelayCancelledError') {
        cancelledTransfers.add(item.id);
        autoDownloadedTransfers.add(item.id);
        activeUploads.get(item.id)?.abort();
        activeUploads.delete(item.id);
        markCancelled(item.id, t.value.remoteCancelled, item.peerId);
        return;
      }
      addLog('relay progress reconciliation skipped', {
        transferId: item.id,
        error: errorMessage(error)
      }, 'warn');
    } finally {
      window.clearTimeout(timer);
    }
  }));
}

function cleanup() {
  document.removeEventListener('visibilitychange', handleVisibility);
  window.removeEventListener('online', handleConnectivityRestore);
  window.removeEventListener('beforeunload', cleanup);
  stopSpeedDisplayTimer();
  for (const pending of pendingDirectAccepts.values()) window.clearTimeout(pending.timer);
  pendingDirectAccepts.clear();
  for (const pending of pendingRelayAccepts.values()) window.clearTimeout(pending.timer);
  pendingRelayAccepts.clear();
  for (const pending of pendingBatchAccepts.values()) window.clearTimeout(pending.timer);
  pendingBatchAccepts.clear();
  for (const [transferId, pending] of pendingRelayCompletions) {
    pending.reject(new Error(t.value.cancelled));
    pendingRelayCompletions.delete(transferId);
  }
  for (const upload of activeUploads.values()) upload.abort();
  activeUploads.clear();
  activePeers.clear();
  activeSendKeys.clear();
  clearIncomingBatchApprovals();
  incomingPromptKeys.clear();
  activeTransferKeys.clear();
  relayStateCache.clear();
  disableWakeLock();
  signaling.close();
}

function percent(item: TransferProgress) {
  if (!item.totalBytes) return 0;
  const value = (item.bytesTransferred / item.totalBytes) * 100;
  if (!item.done) return Math.min(99, value);
  return Math.min(100, value);
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



