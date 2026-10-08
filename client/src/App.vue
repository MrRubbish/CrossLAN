<template>
  <main class="min-h-screen bg-mist text-ink">
    <ShareDialog v-if="shareDialogOpen" :addresses="shareAddresses" :labels="t.share" @close="shareDialogOpen = false" />
    <div v-if="serviceRelocation" class="fixed inset-0 z-50 grid place-items-center bg-mist/95 px-5" role="status" aria-live="polite">
      <section class="w-full max-w-sm rounded-md bg-panel p-6 text-center shadow-xl">
        <div v-if="!serviceRelocation.failed" class="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-line border-t-teal" aria-hidden="true"></div>
        <h2 class="mt-4 text-lg font-800">{{ t.relocatingService }}</h2>
        <p class="mt-2 text-sm text-ink/55">
          {{ serviceRelocation.failed ? t.relocationFailed : t.relocationWaiting }}
        </p>
        <p class="mt-3 break-all text-xs text-ink/45">{{ serviceRelocation.targetUrl }}</p>
        <a v-if="serviceRelocation.failed" class="tap mt-4 inline-flex bg-teal/10 px-4 py-2 text-sm font-800 text-teal" :href="serviceRelocation.redirectUrl">
          {{ t.openNewAddress }}
        </a>
      </section>
    </div>
    <section class="transfer-page">
      <header class="site-header">
        <div>
          <h1 class="page-title" translate="no">CrossLAN</h1>
          <p class="muted">{{ localStatus }}</p>
        </div>
        <PageToolbar
          v-model:theme="themePreference"
          v-model:locale="localePreference"
          :labels="t.toolbar"
          :share-label="t.share.title"
          :protocol-label="protocolLabel"
          :connected="connected"
          :status-label="connected ? t.online : t.offline"
          @share="shareDialogOpen = true"
        />
        <button class="ui-surface ui-control mobile-share-button" type="button" :title="t.share.title" :aria-label="t.share.title" @click="shareDialogOpen = true">
          <QrCode :size="18" aria-hidden="true" />
        </button>
      </header>

      <div class="workspace">
        <section class="devices-section" :aria-label="t.selectTarget">
          <header class="section-heading">
            <h2>{{ t.selectTarget }}</h2>
            <button class="ui-surface ui-control icon-button" type="button" :title="t.refresh" :aria-label="t.refresh" @click="requestRefresh"><RefreshCw :size="18" aria-hidden="true" /></button>
          </header>

          <p v-if="targetDevices.length === 0" class="muted empty-state">
            {{ t.emptyDevices }}
          </p>

          <div v-else class="device-grid">
            <label
              v-for="device in targetDevices"
              :key="device.id"
              class="tap relative flex min-h-[9rem] flex-col items-stretch justify-start bg-panel p-4 text-left hover:bg-teal/8"
            >
              <div class="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                <div class="min-w-0">
                  <p class="break-words font-800 leading-snug">{{ displayDeviceName(device) }}</p>
                  <p class="mt-1 text-sm text-ink/55">IP: {{ device.ip }}</p>
                  <p class="mt-1 break-all text-sm text-ink/55">{{ t.deviceId }}: {{ device.id }}</p>
                </div>
                <span class="shrink-0 whitespace-nowrap rounded-md px-2 py-1 text-xs font-700" :class="canDirectSaveTo(device) ? 'bg-teal/10 text-teal' : 'bg-ink/8 text-ink/50'">
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

        <aside class="transfer-sidebar">
          <section class="limit-section" :aria-label="t.uploadLimit">
            <header class="section-heading"><h2>{{ t.uploadLimit }}</h2></header>
            <div class="ui-segments" role="group" :aria-label="t.uploadLimit">
              <label><input v-model="bandwidthMode" name="bandwidth" value="unlimited" type="radio" /><span>{{ t.unlimited }}</span></label>
              <label><input v-model="bandwidthMode" name="bandwidth" value="manual" type="radio" /><span>{{ t.manual }}</span></label>
            </div>
            <label class="limit-input">
              <input v-model.number="manualLimitMbps" :disabled="bandwidthMode !== 'manual'" type="number" min="1" :aria-label="t.uploadLimit" />
              <span>{{ t.mbps }}</span>
            </label>
            <p class="muted limit-hint">{{ t.uploadLimitHint }}</p>
          </section>

          <section v-if="showStorageSettings" class="storage-section" :aria-label="t.saveDirectory">
            <header class="section-heading"><h2>{{ t.saveDirectory }}</h2></header>
            <p class="mt-2 text-xs text-ink/50">{{ t.storageHint }}</p>
            <input v-model="saveDirInput" class="mt-3 w-full rounded-md bg-panel px-5 py-2 text-sm text-ink" placeholder="/data/CrossLAN" />
            <button class="tap mt-3 w-full bg-ink px-3 py-2 text-sm font-800 text-mist" @click="saveStorageDir">{{ t.savePath }}</button>
            <p class="mt-2 break-all text-xs" :class="storageStatusOk ? 'text-teal' : 'text-coral'">{{ displayStoredMessage(storageMessage) }}</p>
          </section>

          <section class="tasks-section" :aria-label="t.transferTasks">
            <header class="section-heading">
              <h2>{{ t.transferTasks }}</h2>
              <button class="ui-surface ui-control icon-button" :disabled="!progressItems.some(item => item.done)" type="button" :title="t.clearFinishedTransfers" :aria-label="t.clearFinishedTransfers" @click="clearTransfers"><ListX :size="18" aria-hidden="true" /></button>
            </header>
            <p v-if="progressItems.length === 0" class="muted empty-state">{{ t.noTransfers }}</p>
            <article v-for="item in progressItems" :key="item.id" class="transfer-task" :data-transfer-id="item.id" :data-mode="item.mode" :data-done="item.done" :data-cancelled="Boolean(item.cancelled)" :data-bytes="item.bytesTransferred">
              <div class="task-heading">
                <h3>{{ item.fileName }}</h3>
                <button v-if="item.cancellable && !item.done" class="ui-surface ui-control icon-button" type="button" :title="t.cancel" :aria-label="`${t.cancel}: ${item.fileName}`" @click="cancelTransfer(item)"><X :size="18" aria-hidden="true" /></button>
                <Check v-else-if="isTransferSuccessful(item)" :size="19" class="success" aria-hidden="true" />
              </div>
              <progress :value="percent(item)" max="100" :aria-label="item.fileName"></progress>
              <div class="task-metrics">
                <span>{{ item.direction === 'send' ? t.send : t.receive }} · {{ modeLabel(item.mode) }}</span>
                <strong>{{ Math.round(percent(item)) }}%</strong>
              </div>
              <p class="muted">{{ formatBytes(item.bytesTransferred) }} / {{ formatBytes(item.totalBytes) }}</p>
              <p class="muted task-speed">{{ formatSpeedLine(item) }}</p>
              <p v-if="item.statusText" class="task-status" :class="item.done && !isTransferSuccessful(item) ? 'failure' : 'muted'">{{ displayStoredMessage(item.statusText) }}</p>
              <a v-if="item.downloadUrl" class="ui-surface ui-control task-download" :href="item.downloadUrl" :download="item.fileName" target="_blank" rel="noopener" @click="logDownloadOpen(item)"><Download :size="17" aria-hidden="true" />{{ t.openDownload }}</a>
            </article>
          </section>
        </aside>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import NoSleep from 'nosleep.js';
import { Check, Download, ListX, QrCode, RefreshCw, X } from 'lucide-vue-next';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import PageToolbar from './components/PageToolbar.vue';
import ShareDialog from './components/ShareDialog.vue';
import { DeviceIdentity } from './identity/DeviceIdentity';
import { SignalingClient } from './signaling/SignalingClient';
import { getShareAddressOptions } from './sharing/ShareAddress';
import { normalizeLocalePreference, resolveUiLocale, type LocalePreference } from './preferences/LocalePreference';
import { DeviceStore } from './storage/DeviceStore';
import { isBatchTransferMeta } from './transfer/BatchTransfer';
import { TransferEngine } from './transfer/TransferEngine';
import { BlobReceiveSink } from './transfer/ReceiveSink';
import { P2P_MAX_FILE_SIZE, resolveAutomaticTransferRoute } from './transfer/TransferPolicy';
import type { BandwidthMode, BatchTransferSummary, DeviceRecord, FileMeta, LocalIdentity, ServerMode, SignalingMessage, TransferBatchMeta, TransferProgress } from './types';

const SMALL_BATCH_MAX_TOTAL = 64 * 1024 * 1024;
const SMALL_BATCH_MAX_FILE = P2P_MAX_FILE_SIZE;
const ACCEPT_TIMEOUT_MS = 120000;
// A mixed batch can contain multi-minute browser downloads. Keep the receiver's
// one-time approval alive for the whole batch instead of expiring after the
// first few per-file requests.
const INCOMING_BATCH_APPROVAL_TTL_MS = 30 * 60 * 1000;
const RELAY_STATE_CACHE_MS = 300;
const LOCAL_HEALTH_TIMEOUT_MS = 900;
const RELOCATION_HEALTH_TIMEOUT_MS = 900;
const RELOCATION_FAST_RETRY_MS = 300;
const RELOCATION_SLOW_RETRY_MS = 1500;
const RELOCATION_FAST_WINDOW_MS = 15000;
const SPEED_SAMPLE_WINDOW_MS = 3500;
const SPEED_SAMPLE_MIN_INTERVAL_MS = 250;
const SPEED_DISPLAY_REFRESH_MS = 750;
const THEME_STORAGE_KEY = 'crosslan:theme';
const LOCALE_STORAGE_KEY = 'crosslan:locale';
const SERVICE_HOST_UI_KEY = 'crosslan:service-host-ui';
const SERVICE_HOST_DEVICE_ID = 'crosslan-service-host';
const ZIP32_MAX = 0xffffffff;
const ZIP_CHUNK_SIZE = 4 * 1024 * 1024;
const textEncoder = new TextEncoder();
const messages = {
  zh: {
    uploadLimit: '上传限速', transferTasks: '传输任务', clearFinishedTransfers: '清空已结束任务',
    toolbar: { tools: '网页设置', status: '连接状态', theme: '外观', language: '界面语言', system: '跟随系统', systemShort: '系统', auto: '自动', light: '浅色', dark: '深色', chinese: '简体中文', english: 'English' },
    share: { title: '扫码打开网页', address: '访问地址', close: '关闭', copy: '复制地址', copied: '已复制', unavailable: '暂无可分享的局域网地址', loading: '正在生成二维码...', failed: '二维码生成失败', copyFailed: '复制失败' },
    relocatingService: '服务正在切换网络', relocationWaiting: '正在等待新地址就绪，连接恢复后会自动跳转。', relocationFailed: '暂时无法连接新地址，请确认设备与所选网卡位于同一局域网。', openNewAddress: '打开新地址',
    local: '本机', connecting: '正在连接信令服务', online: '在线', offline: '离线', themeSystem: '系统', themeLight: '亮色', themeDark: '深色', themeTitle: '切换外观', devices: '局域网设备', selectTarget: '选择目标设备', refresh: '刷新', emptyDevices: '在同一局域网的另一台设备打开 CrossLAN，它会出现在这里。', deviceId: '设备 ID', lastSeen: '最后在线', transfers: '传输', noTransfers: '还没有传输任务。', clearTransfers: '清空任务', cancel: '取消', send: '发送', receive: '接收', openDownload: '打开下载', storage: '存储', saveDirectory: '服务主机保存目录', storageHint: '发送到运行 CrossLAN 服务的这台主机的大文件会直接保存到这里。Docker 通常映射到 /data/CrossLAN。', directSaveReceiver: '本机作为服务主机接收', directSaveReceiverHint: '只在运行 CrossLAN 服务的 PC 上开启；开启后其他设备发来的大文件会直存，不再触发浏览器/IDM 下载。', savePath: '保存路径', network: '网络', speedLimit: '速度限制', uploadLimitHint: '限速仅限制本机作为发送方的上传速度；浏览器下载速度由接收端和网络决定。', currentSpeed: '当前', averageSpeed: '平均', peakSpeed: '峰值', elapsed: '用时', unlimited: '不限速', manual: '手动', mbps: 'Mbps', direct: '直存', browserDownload: '浏览器下载', browserDownloadMode: '浏览器接收', p2p: 'P2P', measuring: '测速中', receivePrompt: '接收', receiveLargePrompt: '接收大文件', receiveBatchPrompt: '接收这批文件', receiverRejected: '接收方已拒绝文件。', waitingSender: '已接受，等待发送方...', waitingLink: '已接受，等待下载链接...', receiveComplete: '接收完成', savingDisk: '正在写入服务主机磁盘...', downloadReady: '下载已准备好。如果没有自动打开，请点“打开下载”。', sentDownloadManager: '已交给浏览器下载管理器。', waitConfirm: '等待对方确认...', waitPhoneConfirm: '等待接收端确认...', savedToPc: '已保存到服务主机', preparingPhone: '正在为接收端准备浏览器下载...', linkSentPhone: '下载链接已发送到接收端。', loadStorage: '正在读取保存目录...', loadStorageFailed: '读取保存目录失败。', saveStorageFailed: '保存目录失败。', current: '当前', saved: '已保存', parseFailed: '无法解析服务器响应。', uploadHttpFailed: '上传失败', uploadNetworkFailed: '上传失败：无法连接到 CrossLAN 服务。', cancelled: '传输已取消。', remoteCancelled: '对方已取消传输。', confirmTimeout: '等待对方确认超时。', failed: '传输失败。', duplicateSending: '这个文件正在传输中，已沿用现有任务。', duplicateIncoming: '相同文件已有接收任务，已忽略重复请求。', receivingRelay: '正在通过内存流式中继传输...', packagingBatch: '正在打包批量文件...', batchLabel: '批量文件'
  },
  en: {
    uploadLimit: 'Upload limit', transferTasks: 'Transfers', clearFinishedTransfers: 'Clear finished tasks',
    toolbar: { tools: 'Page settings', status: 'Connection status', theme: 'Appearance', language: 'Interface language', system: 'Follow system', systemShort: 'System', auto: 'Auto', light: 'Light', dark: 'Dark', chinese: '简体中文', english: 'English' },
    share: { title: 'Open via QR code', address: 'Web address', close: 'Close', copy: 'Copy address', copied: 'Copied', unavailable: 'No LAN address available', loading: 'Generating QR code...', failed: 'Unable to generate QR code', copyFailed: 'Unable to copy address' },
    relocatingService: 'Switching service network', relocationWaiting: 'Waiting for the new address. This page will redirect automatically when it is ready.', relocationFailed: 'The new address is not reachable yet. Check that this device is on the selected adapter network.', openNewAddress: 'Open new address',
    local: 'Local', connecting: 'Connecting to signaling server', online: 'Online', offline: 'Offline', themeSystem: 'System', themeLight: 'Light', themeDark: 'Dark', themeTitle: 'Switch appearance', devices: 'LAN devices', selectTarget: 'Select target device', refresh: 'Refresh', emptyDevices: 'Open CrossLAN on another device in the same LAN and it will appear here.', deviceId: 'Device ID', lastSeen: 'Last seen', transfers: 'Transfers', noTransfers: 'No transfers yet.', clearTransfers: 'Clear tasks', cancel: 'Cancel', send: 'Send', receive: 'Receive', openDownload: 'Open download', storage: 'Storage', saveDirectory: 'Service host save directory', storageHint: 'Large files sent to the host running CrossLAN are saved directly here. Docker usually maps this to /data/CrossLAN.', directSaveReceiver: 'Receive as service host', directSaveReceiverHint: 'Enable only on the PC running CrossLAN. Incoming large files are saved directly and will not trigger browser/IDM downloads.', savePath: 'Save path', network: 'Network', speedLimit: 'Speed limit', uploadLimitHint: 'The limit only throttles uploads from this browser; browser download speed is controlled by the receiver and network.', currentSpeed: 'Now', averageSpeed: 'Avg', peakSpeed: 'Peak', elapsed: 'Time', unlimited: 'Unlimited', manual: 'Manual', mbps: 'Mbps', direct: 'Direct save', browserDownload: 'Browser download', browserDownloadMode: 'Browser receive', p2p: 'P2P', measuring: 'measuring', receivePrompt: 'Receive', receiveLargePrompt: 'Receive large file', receiveBatchPrompt: 'Receive this batch', receiverRejected: 'Receiver rejected the file.', waitingSender: 'Accepted. Waiting for sender...', waitingLink: 'Accepted. Waiting for download link...', receiveComplete: 'Receive complete', savingDisk: 'Saving to host disk...', downloadReady: 'Download ready. If it did not open, tap Open download.', sentDownloadManager: 'Sent to browser download manager.', waitConfirm: 'Waiting for receiver confirmation...', waitPhoneConfirm: 'Waiting for receiver confirmation...', savedToPc: 'Saved to service host', preparingPhone: 'Preparing browser download for receiver...', linkSentPhone: 'Download link sent to receiver.', loadStorage: 'Loading save directory...', loadStorageFailed: 'Failed to load directory.', saveStorageFailed: 'Failed to save directory.', current: 'Current', saved: 'Saved', parseFailed: 'Failed to parse server response.', uploadHttpFailed: 'Upload failed', uploadNetworkFailed: 'Upload failed: cannot connect to CrossLAN service.', cancelled: 'Transfer cancelled.', remoteCancelled: 'Peer cancelled the transfer.', confirmTimeout: 'Timed out waiting for receiver confirmation.', failed: 'Transfer failed.', duplicateSending: 'This file is already being transferred. Reusing the existing task.', duplicateIncoming: 'The same file already has a receive task. Ignoring the duplicate request.', receivingRelay: 'Streaming through memory relay...', packagingBatch: 'Packaging batch files...', batchLabel: 'Batch files' }
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
type HealthResponse = { ok?: boolean; name?: string; deploymentMode?: string; desktopManaged?: boolean; instanceId?: string; serverInstanceId?: string };
type HostConnectionRole = { directSave: boolean; hostUi: boolean; serverMode?: ServerMode; desktopManaged?: boolean };
type SpeedSamplePoint = { at: number; bytes: number };
type SpeedSampleState = {
  startedAt: number;
  direction: TransferProgress['direction'];
  mode?: TransferProgress['mode'];
  points: SpeedSamplePoint[];
};

const messageKeysByText = new Map<string, keyof typeof messages.zh>();
for (const key of Object.keys(messages.zh) as (keyof typeof messages.zh)[]) {
  for (const language of ['zh', 'en'] as const) {
    const value = messages[language][key];
    if (typeof value === 'string') messageKeysByText.set(value, key);
  }
}
type ServiceRelocationState = {
  targetUrl: string;
  redirectUrl: string;
  failed: boolean;
};

const identity = new DeviceIdentity();
const store = new DeviceStore();
const signaling = new SignalingClient();
const engine = new TransferEngine(signaling, () => identity.getDeviceId());
const noSleep = new NoSleep();

const connected = ref(false);
const shareDialogOpen = ref(false);
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
const activeThrottleWaits = new Map<string, () => void>();
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
const localePreference = ref<LocalePreference>(loadLocalePreference());
const browserLanguage = ref(navigator.language);
const serviceHostUi = ref(loadServiceHostUiPreference());
const storageManagedByDesktop = ref(false);
const hostRoleResolved = ref(false);
const saveDirInput = ref('');
const storageMessage = ref(messages.zh.loadStorage);
const storageStatusOk = ref(true);
const serviceRelocation = ref<ServiceRelocationState | null>(null);
let speedDisplayTimer: number | null = null;
let pageHiddenAt: number | null = null;
let relocationAttempt = 0;
const progressItems = computed(() => [...progress.value.values()]);
const resolvedLocale = computed(() => resolveUiLocale(localePreference.value, browserLanguage.value));
const isZh = computed(() => resolvedLocale.value === 'zh-CN');
const t = computed(() => isZh.value ? messages.zh : messages.en);
const shareAddresses = computed(() => getShareAddressOptions(location.href, localIdentity.value?.serverIps));
const localStatus = computed(() => {
  const local = localIdentity.value;
  if (!local) return t.value.connecting;
  const hostView = serviceHostUi.value || isLoopbackHost(location.hostname);
  const ip = hostView ? getServiceHostIp(local) : local.ip;
  return `${t.value.local} ${ip}`;
});
const protocolLabel = computed(() => location.protocol === 'https:' ? 'HTTPS' : 'HTTP LAN');
const isServiceHost = computed(() => {
  const host = location.hostname;
  if (isLoopbackHost(host)) return true;
  if (serviceHostUi.value) return true;
  const local = localIdentity.value;
  if (!local) return false;
  return Boolean(local.canDirectSave || local.serverIps.includes(local.ip));
});
const showStorageSettings = computed(() => hostRoleResolved.value && isServiceHost.value && !storageManagedByDesktop.value);
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

watch(showStorageSettings, visible => {
  if (visible) void loadStorageDir();
  else {
    saveDirInput.value = '';
    storageMessage.value = '';
  }
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

  engine.onIncoming(prepareP2PReceive);

  engine.onProgress(handleP2PProgress);

  void connectSignaling();
  startSpeedDisplayTimer();
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('online', handleConnectivityRestore);
  window.addEventListener('languagechange', handleLanguageChange);
  window.addEventListener('beforeunload', cleanup);
});

onUnmounted(cleanup);

function handleP2PProgress(item: TransferProgress) {
  if (cancelledTransfers.has(item.id) && !item.cancelled) return;
  const current = progress.value.get(item.id);
  // A channel error may arrive before the peer's cancellation over WebSocket.
  if (current?.done && !(current.failed && item.cancelled)) return;
  logProgress(item);
  const sampled = withSpeedSample(item);
  const finalItem = maybeAutoDownload(sampled);
  progress.value = new Map(progress.value).set(finalItem.id, finalItem);
  if (finalItem.done) {
    speedSamples.delete(finalItem.id);
    disableWakeLock();
  }
}

watch([bandwidthMode, manualLimitMbps], () => {
  for (const resume of activeThrottleWaits.values()) resume();
  engine.setBandwidthLimit({
    mode: bandwidthMode.value,
    bytesPerSecond: getManualLimitBytesPerSecond()
  });
}, { immediate: true });

watch(themePreference, value => {
  applyThemePreference(value);
  saveThemePreference(value);
});

watch(localePreference, value => {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, value);
  } catch {
    // The selected language still works when browser storage is unavailable.
  }
});

watch(resolvedLocale, value => {
  document.documentElement.lang = value;
}, { immediate: true });

function loadLocalePreference(): LocalePreference {
  try {
    return normalizeLocalePreference(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

function handleLanguageChange(): void {
  browserLanguage.value = navigator.language;
}

function displayStoredMessage(value: string): string {
  for (const key of ['current', 'saved'] as const) {
    for (const language of ['zh', 'en'] as const) {
      const prefix = `${messages[language][key]}: `;
      if (value.startsWith(prefix)) return `${t.value[key]}: ${value.slice(prefix.length)}`;
    }
  }
  const key = messageKeysByText.get(value);
  const translated = key ? t.value[key] : value;
  return typeof translated === 'string' ? translated : value;
}

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
  storageManagedByDesktop.value = Boolean(role.desktopManaged);
  hostRoleResolved.value = true;
  if (!role.hostUi) localStorage.removeItem(SERVICE_HOST_UI_KEY);
  addLog('signaling role resolved', { directSave: role.directSave, hostUi: role.hostUi, serverMode: role.serverMode, host: location.hostname });
  signaling.connect(identity.getClientId(), role.directSave, role.hostUi);
}

async function detectHostConnectionRole(): Promise<HostConnectionRole> {
  const remoteHealth = await fetchHealth(new URL('/api/health', location.origin).toString());
  const remoteMode = normalizeServerMode(remoteHealth?.deploymentMode);
  if (remoteMode !== 'docker') {
    return { directSave: isLoopbackHost(location.hostname), hostUi: false, serverMode: remoteMode, desktopManaged: remoteHealth?.desktopManaged };
  }

  if (serviceHostUi.value || isLoopbackHost(location.hostname)) {
    return { directSave: true, hostUi: true, serverMode: remoteMode, desktopManaged: remoteHealth?.desktopManaged };
  }

  const localHealth = await fetchHealth(`${location.protocol}//127.0.0.1:${location.port || '6100'}/api/health`, LOCAL_HEALTH_TIMEOUT_MS);
  const sameDockerServer = Boolean(
    localHealth?.ok &&
    normalizeServerMode(localHealth.deploymentMode) === 'docker' &&
    (!getHealthInstanceId(remoteHealth) || !getHealthInstanceId(localHealth) || getHealthInstanceId(remoteHealth) === getHealthInstanceId(localHealth))
  );

  if (sameDockerServer || await probeLocalDockerHostUi(remoteHealth)) {
    return { directSave: true, hostUi: true, serverMode: remoteMode, desktopManaged: remoteHealth?.desktopManaged };
  }

  return { directSave: false, hostUi: false, serverMode: remoteMode, desktopManaged: remoteHealth?.desktopManaged };
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

function beginServiceRelocation(value: string, delayMs: number) {
  const target = normalizeServiceRelocationUrl(value);
  if (!target || target.origin === location.origin) return;
  shareDialogOpen.value = false;

  const attempt = ++relocationAttempt;
  const redirectTarget = new URL(target);
  const desktopToken = sessionStorage.getItem('crosslan:desktop-session')?.trim();
  if (desktopToken) redirectTarget.searchParams.set('crosslanDesktopToken', desktopToken);
  serviceRelocation.value = {
    targetUrl: target.toString(),
    redirectUrl: redirectTarget.toString(),
    failed: false
  };
  connected.value = false;
  signaling.close();
  void waitForRelocationTarget(target, redirectTarget, delayMs, attempt);
}

function normalizeServiceRelocationUrl(value: string) {
  try {
    const target = new URL(value);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    if (!target.hostname || target.username || target.password) return null;
    target.pathname = '/';
    target.search = '';
    target.hash = '';
    return target;
  } catch {
    return null;
  }
}

async function waitForRelocationTarget(target: URL, redirectTarget: URL, delayMs: number, attempt: number) {
  const grace = Number.isFinite(delayMs) ? Math.min(5000, Math.max(0, delayMs)) : 1500;
  if (grace > 250) await waitForRelocationDelay(grace - 250);
  const fastDeadline = Date.now() + RELOCATION_FAST_WINDOW_MS;

  while (attempt === relocationAttempt) {
    if (await probeRelocationTarget(target)) {
      location.replace(redirectTarget.toString());
      return;
    }
    const failed = Date.now() >= fastDeadline;
    if (failed && serviceRelocation.value && attempt === relocationAttempt) {
      serviceRelocation.value = { ...serviceRelocation.value, failed: true };
    }
    await waitForRelocationDelay(failed ? RELOCATION_SLOW_RETRY_MS : RELOCATION_FAST_RETRY_MS);
  }
}

async function probeRelocationTarget(target: URL) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), RELOCATION_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(new URL('/api/health', target).toString(), {
      cache: 'no-store',
      mode: 'cors',
      signal: controller.signal
    });
    if (!response.ok) return false;
    const health = await response.json() as HealthResponse;
    return health.ok === true && health.name === 'CrossLAN';
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

function waitForRelocationDelay(delayMs: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, delayMs));
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
  if (message.type === 'service-relocating') {
    beginServiceRelocation(message.targetUrl, message.delayMs);
    return;
  }

  if (message.type === 'hello') {
    serverMode.value = normalizeServerMode(message.serverMode);
    localIdentity.value = identity.applyServerIdentity(message.device, message.serverIps);
    signaling.send({ type: 'transfer-state-request', transferIds: getActiveTransferIds() });
    void reconcileActiveRelayTransfers();
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
      rejectPending(pendingDirectAccepts, message.transferId, t.value.remoteCancelled);
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
      failed: true,
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

async function prepareP2PReceive(meta: FileMeta, from: string) {
  if (cancelledTransfers.has(meta.transferId) || progress.value.get(meta.transferId)?.done) {
    return { accepted: false as const, reason: t.value.cancelled };
  }
  if (meta.size > P2P_MAX_FILE_SIZE) {
    return { accepted: false as const, reason: 'WebRTC files are limited to 64 MiB. Please resend using Relay or direct save.' };
  }
  const accepted = await confirmIncomingTransfer(from, meta, t.value.receivePrompt);
  if (!accepted || cancelledTransfers.has(meta.transferId)) {
    return { accepted: false as const, reason: accepted ? t.value.cancelled : t.value.receiverRejected };
  }
  enableWakeLock();
  return {
    accepted: true as const,
    sink: new BlobReceiveSink({ size: meta.size, type: meta.type || 'application/octet-stream' })
  };
}

async function handleDirectTransferRequest(from: string, meta: FileMeta) {
  if (cancelledTransfers.has(meta.transferId) || progress.value.get(meta.transferId)?.done) return;
  addLog('direct request received', { from, transferId: meta.transferId, file: meta.name, size: meta.size });
  if (rejectDuplicateIncoming(from, meta, 'direct')) return;
  const ok = await confirmIncomingTransfer(from, meta, t.value.receiveLargePrompt);
  if (cancelledTransfers.has(meta.transferId)) return;
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
  if (cancelledTransfers.has(meta.transferId) || progress.value.get(meta.transferId)?.done) return;
  addLog('relay request received', { from, transferId: meta.transferId, file: meta.name, size: meta.size });
  if (rejectDuplicateIncoming(from, meta, 'relay')) return;
  const ok = await confirmIncomingTransfer(from, meta, t.value.receiveLargePrompt);
  if (cancelledTransfers.has(meta.transferId)) return;
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
  rejectPending(pendingRelayAccepts, transferId, message);
  rejectRelayCompletion(transferId, message);
  activeUploads.get(transferId)?.abort();
  activeUploads.delete(transferId);
  if (cancelledTransfers.has(transferId)) return;
  if (cancelled) {
    cancelledTransfers.add(transferId);
    autoDownloadedTransfers.add(transferId);
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
    failed: message !== t.value.cancelled && message !== t.value.remoteCancelled,
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
  if (current?.done && !(current.failed && item.cancelled)) return current;
  const startedAt = current?.startedAt || item.startedAt || now;
  const safeTotal = Math.max(item.totalBytes || 0, current?.totalBytes || 0);
  const safeBytes = item.done
    ? Math.max(item.bytesTransferred || 0, current?.bytesTransferred || 0)
    : Math.min(safeTotal || item.bytesTransferred || 0, Math.max(item.bytesTransferred || 0, current?.bytesTransferred || 0));
  const normalized = { ...current, ...item, bytesTransferred: safeBytes, totalBytes: safeTotal || item.totalBytes, startedAt, completedAt: item.done ? item.completedAt || now : item.completedAt };
  // WebRTC already measures bytes acknowledged by the receiver; do not resample them.
  if (normalized.mode === 'p2p') {
    speedSamples.delete(item.id);
    return normalized;
  }
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
  return resolveAutomaticTransferRoute(file.size, canDirectSaveTo(target)) === 'direct';
}

function shouldRelayToBrowserDownload(target: DeviceRecord, file: File) {
  return resolveAutomaticTransferRoute(file.size, canDirectSaveTo(target)) === 'relay';
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
    if (cancelledTransfers.has(id)) throw new Error(t.value.cancelled);
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
    if (cancelledTransfers.has(id)) throw new Error(t.value.cancelled);
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
  if (current?.done && !current.cancelled && !current.failed) {
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
  if (current?.done && !current.cancelled && !current.failed) return;
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
    failed: false,
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
  return Boolean(latest?.done && (latest.cancelled || latest.failed || (latest.bytesTransferred < latest.totalBytes)));
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
    failed: message !== t.value.cancelled && message !== t.value.remoteCancelled,
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
  let throttleStartBytes = 0;
  let throttleLimit = getManualLimitBytesPerSecond();
  addLog('throttled chunk upload opened', { endpoint, transferId, file: file.name, size: file.size, limitMbps: manualLimitMbps.value });

  while (uploaded < file.size) {
    if (cancelledTransfers.has(transferId)) throw new Error(t.value.cancelled);
    const limit = getManualLimitBytesPerSecond();
    if (limit !== throttleLimit) {
      throttleLimit = limit;
      throttleStartedAt = performance.now();
      throttleStartBytes = uploaded;
    }
    const chunkSize = getThrottleChunkSize(limit);
    const end = Math.min(uploaded + chunkSize, file.size);
    const chunk = file.slice(uploaded, end);
    const isFinal = end >= file.size;
    const result = await uploadChunk<T>(endpoint, file, chunk, transferId, uploaded, isFinal);
    uploaded = end;
    onProgress(uploaded);
    if (isFinal) finalResponse = result;
    if (!isFinal && limit && limit === getManualLimitBytesPerSecond()) {
      const idealElapsedMs = ((uploaded - throttleStartBytes) / limit) * 1000;
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
  let pending: { abort: () => void };
  let resume: () => void;
  return new Promise<void>((resolve, reject) => {
    if (cancelledTransfers.has(transferId)) {
      reject(new Error(t.value.cancelled));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    resume = () => {
      window.clearTimeout(timer);
      resolve();
    };
    pending = {
      abort: () => {
        window.clearTimeout(timer);
        reject(new Error(t.value.cancelled));
      }
    };
    activeUploads.set(transferId, pending);
    activeThrottleWaits.set(transferId, resume);
  }).finally(() => {
    if (activeUploads.get(transferId) === pending) activeUploads.delete(transferId);
    if (activeThrottleWaits.get(transferId) === resume) activeThrottleWaits.delete(transferId);
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
  if (!showStorageSettings.value) return;
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
  if (!showStorageSettings.value) {
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
      if (state.failed) {
        handleRelayTransferError(item.id, item.fileName, state.message || t.value.failed, state.cancelled);
        return;
      }
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
        rejectPending(pendingRelayAccepts, item.id, t.value.remoteCancelled);
        rejectRelayCompletion(item.id, t.value.remoteCancelled);
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
  relocationAttempt += 1;
  document.removeEventListener('visibilitychange', handleVisibility);
  window.removeEventListener('online', handleConnectivityRestore);
  window.removeEventListener('languagechange', handleLanguageChange);
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
  engine.close();
  signaling.close();
}

function isTransferSuccessful(item: TransferProgress) {
  return item.done && !item.cancelled && !item.failed && item.bytesTransferred >= item.totalBytes;
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
  return new Date(ts).toLocaleTimeString(resolvedLocale.value);
}

function createTransferId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
</script>

<style scoped>
.transfer-page { max-width: 1400px; margin: auto; padding: max(28px, env(safe-area-inset-top)) 28px 40px; }
.site-header { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
.page-title { font-size: 26px; font-weight: 800; line-height: 1.25; }
.workspace { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(320px, 1fr); gap: 32px; }
.workspace > *, .transfer-sidebar > section { min-width: 0; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 40px; margin-bottom: 16px; }
.section-heading h2 { font-size: 18px; font-weight: 750; }
.device-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.device-grid > label { border-radius: var(--control-radius, 10px); }
.device-grid > label:focus-within { outline: 2px solid rgb(var(--color-teal)); outline-offset: 2px; }
.ui-control { gap: 8px; border: 0; }
.icon-button { width: 40px; height: 40px; padding: 0; flex-shrink: 0; }
.icon-button:disabled { opacity: .4; cursor: not-allowed; background: rgb(var(--color-panel)); }
.muted { color: rgb(var(--color-ink) / .6); font-size: 12px; line-height: 1.65; }
.empty-state { padding: 20px 0; }
.transfer-sidebar > section + section { margin-top: 28px; padding-top: 24px; }
.limit-input { display: flex; align-items: center; border-radius: var(--control-radius, 10px); margin-top: 12px; overflow: hidden; background: rgb(var(--color-panel)); }
.limit-input:focus-within { outline: 2px solid rgb(var(--color-teal)); outline-offset: 2px; }
.limit-input input { width: 100%; min-width: 0; background: transparent; padding: 12px 20px; font-size: 14px; outline: none; }
.limit-input span { padding: 0 20px; font-size: 12px; font-weight: 700; color: rgb(var(--color-ink) / .6); }
.limit-input input:disabled { opacity: .5; }
.limit-hint { margin-top: 12px; }
.transfer-task { background: rgb(var(--color-panel)); border-radius: var(--control-radius, 10px); padding: 20px; margin-bottom: 12px; }
.task-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; }
.task-heading h3 { min-width: 0; font-size: 15px; font-weight: 700; overflow-wrap: anywhere; }
.transfer-task progress { width: 100%; height: 8px; display: block; margin: 12px 0; border-radius: var(--control-radius, 10px); overflow: hidden; appearance: none; }
.transfer-task progress::-webkit-progress-bar { background: rgb(var(--color-line)); }
.transfer-task progress::-webkit-progress-value { background: rgb(var(--color-teal)); border-radius: var(--control-radius, 10px); }
.transfer-task progress::-moz-progress-bar { background: rgb(var(--color-teal)); }
.task-metrics { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 12px; margin-bottom: 4px; }
.task-metrics span { min-width: 0; overflow-wrap: anywhere; }
.task-metrics strong { flex-shrink: 0; font-variant-numeric: tabular-nums; }
.task-speed { margin-top: 2px; overflow-wrap: anywhere; }
.task-status { font-size: 12px; margin-top: 10px; overflow-wrap: anywhere; }
.success { color: rgb(var(--color-teal)); flex-shrink: 0; }
.failure { color: rgb(var(--color-coral)); }
.task-download { margin-top: 12px; max-width: 100%; }
@media (max-width: 1100px) { .site-header { align-items: flex-start; flex-wrap: wrap; } .device-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) { .transfer-page { padding: max(20px, env(safe-area-inset-top)) 16px 32px; } .workspace { grid-template-columns: minmax(0, 1fr); gap: 28px; } }
@media (max-width: 640px) { .site-header { display: grid; gap: 18px 12px; } }
</style>
