<template>
  <dialog ref="dialog" class="share-dialog" aria-labelledby="share-dialog-title" @close="emit('close')" @click="handleBackdropClick">
    <div class="share-dialog-content">
      <header class="share-dialog-header">
        <div>
          <p class="share-brand">CrossLAN</p>
          <h2 id="share-dialog-title">{{ labels.title }}</h2>
        </div>
        <button class="share-icon-button" type="button" :aria-label="labels.close" :title="labels.close" @click="dialog?.close()">
          <X :size="20" aria-hidden="true" />
        </button>
      </header>
      <div class="share-qr" :aria-busy="Boolean(selectedAddress && !qrImage && !qrError)">
        <img v-if="qrImage" :src="qrImage" :alt="labels.title" width="280" height="280" />
        <p v-else role="status" :class="{ 'share-error': qrError }">{{ qrError ? labels.failed : selectedAddress ? labels.loading : labels.unavailable }}</p>
      </div>
      <label class="share-address-label" for="share-address">{{ labels.address }}</label>
      <div class="share-address-row">
        <select v-if="addresses.length > 1" id="share-address" v-model="selectedAddress">
          <option v-for="address in addresses" :key="address" :value="address">{{ address }}</option>
        </select>
        <input v-else id="share-address" :value="selectedAddress" readonly @click="($event.target as HTMLInputElement).select()" />
        <button class="share-icon-button" type="button" :disabled="!selectedAddress" :aria-label="copied ? labels.copied : labels.copy" :title="copied ? labels.copied : labels.copy" @click="copyAddress">
          <Check v-if="copied" :size="19" aria-hidden="true" />
          <Copy v-else :size="19" aria-hidden="true" />
        </button>
      </div>
      <p class="share-copy-status" role="status" :class="{ 'share-error': copyFailed }">{{ copyFailed ? labels.copyFailed : copied ? labels.copied : '' }}</p>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { Check, Copy, X } from 'lucide-vue-next';
import { onMounted, onUnmounted, ref, watch } from 'vue';

const props = defineProps<{
  addresses: string[];
  labels: {
    title: string; address: string; close: string; copy: string; copied: string;
    unavailable: string; loading: string; failed: string; copyFailed: string;
  };
}>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const selectedAddress = ref('');
const qrImage = ref('');
const qrError = ref(false);
const copied = ref(false);
const copyFailed = ref(false);
let generation = 0;
let copyTimer: ReturnType<typeof setTimeout> | undefined;

watch(() => props.addresses, addresses => {
  if (!addresses.includes(selectedAddress.value)) selectedAddress.value = addresses[0] || '';
}, { immediate: true });

watch(selectedAddress, async address => {
  const request = ++generation;
  qrImage.value = '';
  qrError.value = false;
  copied.value = false;
  copyFailed.value = false;
  if (copyTimer !== undefined) clearTimeout(copyTimer);
  if (!address) return;
  try {
    const QRCode = (await import('qrcode')).default;
    const image = await QRCode.toDataURL(address, {
      width: 280, margin: 4, errorCorrectionLevel: 'M',
      color: { dark: '#000000ff', light: '#ffffffff' }
    });
    if (request === generation) qrImage.value = image;
  } catch {
    if (request === generation) qrError.value = true;
  }
}, { immediate: true });

onMounted(() => dialog.value?.showModal());
onUnmounted(() => {
  generation += 1;
  if (copyTimer !== undefined) clearTimeout(copyTimer);
});

function handleBackdropClick(event: MouseEvent): void {
  if (event.target !== dialog.value || !dialog.value) return;
  const bounds = dialog.value.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.value.close();
}

async function copyAddress(): Promise<void> {
  const address = selectedAddress.value;
  const request = generation;
  copyFailed.value = false;
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(address);
    } else {
      // LAN HTTP pages lack Clipboard API access; keep the fallback inside the modal.
      const input = document.createElement('textarea');
      input.value = address;
      input.className = 'share-copy-input';
      const previousFocus = document.activeElement as HTMLElement | null;
      dialog.value?.append(input);
      try {
        input.select();
        if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
      } finally {
        input.remove();
        previousFocus?.focus();
      }
    }
    if (request !== generation) return;
    copied.value = true;
    if (copyTimer !== undefined) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    if (request === generation) copyFailed.value = true;
  }
}
</script>

<style scoped>
.share-dialog {
  width: min(420px, calc(100% - 32px));
  max-height: calc(100dvh - 32px);
  padding: 0;
  overflow: auto;
  border: 0;
  border-radius: var(--control-popup-radius);
  background: rgb(var(--color-panel));
  color: rgb(var(--color-ink));
  box-shadow: 0 20px 60px rgb(0 0 0 / 25%);
}
.share-dialog::backdrop { background: rgb(0 0 0 / 42%); }
.share-dialog-content { padding: 22px; }
.share-dialog-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.share-brand { margin: 0 0 3px; color: rgb(var(--color-teal)); font-size: 12px; font-weight: 700; }
.share-dialog-header h2 { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 750; }
.share-qr {
  display: grid;
  width: min(280px, 100%);
  aspect-ratio: 1;
  margin: 24px auto;
  place-items: center;
  background: #fff;
  color: #17211f;
}
.share-qr img { display: block; width: 100%; height: auto; }
.share-qr p { padding: 20px; font-size: 13px; text-align: center; }
.share-address-label { display: block; margin-bottom: 7px; font-size: 12px; font-weight: 650; }
.share-address-row { display: flex; gap: 8px; }
.share-address-row input, .share-address-row select {
  width: 100%;
  min-width: 0;
  height: 40px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--control-radius);
  background: rgb(var(--color-mist));
  color: inherit;
  font: inherit;
  font-size: 13px;
}
.share-icon-button {
  display: grid;
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  place-items: center;
  border: 0;
  border-radius: var(--control-radius);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.share-icon-button:hover { background: rgb(var(--color-teal) / 8%); }
.share-icon-button:disabled { opacity: 0.4; cursor: default; }
.share-dialog :focus-visible { outline: 2px solid rgb(var(--color-teal)); outline-offset: 2px; }
.share-copy-status { min-height: 18px; margin: 8px 0 0; color: rgb(var(--color-teal)); font-size: 12px; }
.share-error { color: rgb(var(--color-coral)); }
.share-copy-input { position: fixed; width: 1px; height: 1px; opacity: 0; }
</style>
