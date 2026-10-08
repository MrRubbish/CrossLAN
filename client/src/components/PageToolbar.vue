<template>
  <div class="page-toolbar">
    <div class="toolbar-actions" role="group" :aria-label="labels.tools">
      <button class="ui-surface ui-control toolbar-control share-toolbar-button" type="button" :title="shareLabel" :aria-label="shareLabel" @click="emit('share')">
        <QrCode :size="18" aria-hidden="true" />
      </button>
      <button class="ui-surface ui-control toolbar-control toolbar-theme" type="button" :data-preference="theme" :title="themeTitle" :aria-label="themeTitle" @click="cycleTheme">
        <component :is="themeIcon" :size="16" aria-hidden="true" />
        <span>{{ themeLabel }}</span>
      </button>
      <details ref="localePicker" class="ui-picker locale-picker">
        <summary class="ui-surface ui-control toolbar-control" :title="localeTitle" :aria-label="localeTitle">
          <Languages class="locale-icon" :size="16" aria-hidden="true" />
          <span translate="no">{{ localeLabel }}</span>
          <ChevronDown class="choice-chevron" :size="12" aria-hidden="true" />
        </summary>
        <div class="ui-choice-panel">
          <fieldset class="ui-choice-options">
            <legend class="ui-visually-hidden">{{ labels.language }}</legend>
            <label v-for="option in localeOptions" :key="option.value" class="ui-choice-option">
              <input type="radio" name="locale" :value="option.value" :checked="locale === option.value" />
              <span class="ui-option-row">
                <span :lang="option.value === 'zh-CN' ? 'zh-CN' : option.value === 'en-US' ? 'en-US' : undefined" translate="no">{{ option.label }}</span>
                <Check class="ui-choice-check" :size="16" aria-hidden="true" />
              </span>
            </label>
          </fieldset>
        </div>
      </details>
    </div>
    <div class="toolbar-status" role="group" :aria-label="labels.status">
      <span class="ui-surface ui-status toolbar-badge toolbar-protocol" translate="no">{{ protocolLabel }}</span>
      <span class="ui-surface ui-status toolbar-badge toolbar-connection" :class="{ 'is-online': connected }" :data-tone="connected ? 'positive' : 'negative'" role="status">
        <span class="status-dot" aria-hidden="true"></span>
        {{ statusLabel }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Check, ChevronDown, Languages, Monitor, Moon, QrCode, Sun } from 'lucide-vue-next';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { bindChoicePicker } from '../../../shared/ChoicePicker';
import '../../../shared/ui-controls.css';
import type { LocalePreference } from '../preferences/LocalePreference';

type ThemePreference = 'system' | 'light' | 'dark';
const props = defineProps<{
  theme: ThemePreference;
  locale: LocalePreference;
  connected: boolean;
  protocolLabel: string;
  statusLabel: string;
  shareLabel: string;
  labels: {
    tools: string; status: string; theme: string; language: string;
    system: string; systemShort: string; auto: string; light: string; dark: string; chinese: string; english: string;
  };
}>();
const emit = defineEmits<{
  share: [];
  'update:theme': [value: ThemePreference];
  'update:locale': [value: LocalePreference];
}>();
const themeIcon = computed(() => props.theme === 'dark' ? Moon : props.theme === 'light' ? Sun : Monitor);
const themeLabel = computed(() => props.theme === 'system' ? props.labels.systemShort : props.labels[props.theme]);
const themeTitle = computed(() => `${props.labels.theme}: ${props.labels[props.theme]}`);
const localeLabel = computed(() => props.locale === 'system' ? props.labels.auto : props.locale === 'zh-CN' ? '中文' : 'EN');
const localeOptions = computed(() => [
  { value: 'system', label: props.labels.system },
  { value: 'zh-CN', label: props.labels.chinese },
  { value: 'en-US', label: props.labels.english }
]);
const localeTitle = computed(() => {
  const selected = props.locale === 'zh-CN' ? props.labels.chinese
    : props.locale === 'en-US' ? props.labels.english : props.labels.system;
  return `${props.labels.language}: ${selected}`;
});

function cycleTheme(): void {
  const next: Record<ThemePreference, ThemePreference> = { system: 'light', light: 'dark', dark: 'system' };
  emit('update:theme', next[props.theme]);
}

const localePicker = ref<HTMLDetailsElement | null>(null);
let disposeLocalePicker: (() => void) | undefined;
onMounted(() => {
  if (localePicker.value) disposeLocalePicker = bindChoicePicker(localePicker.value, value => emit('update:locale', value as LocalePreference));
});
onUnmounted(() => disposeLocalePicker?.());
</script>

<style scoped>
.page-toolbar { --toolbar-width: 144px; display: flex; max-width: 100%; align-items: center; flex-wrap: wrap; gap: 12px 24px; }
.toolbar-actions { display: flex; align-items: center; gap: 12px; }
.share-toolbar-button { width: 40px; padding: 0; }
.toolbar-theme { width: var(--toolbar-width); }
.locale-picker { width: var(--toolbar-width); flex: 0 0 auto; }
.toolbar-status {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  font-weight: 650;
  line-height: 1.4;
  cursor: default;
}
.toolbar-badge { width: var(--toolbar-width); }
.status-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: rgb(var(--color-coral)); }
.is-online .status-dot { background: rgb(var(--color-teal)); }

@media (max-width: 900px) {
  .page-toolbar { display: grid; width: 100%; max-width: 352px; grid-template-columns: 40px repeat(2, minmax(0, 1fr)); gap: 12px; }
  .toolbar-actions { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; }
  .toolbar-status { display: grid; grid-column: 2 / -1; grid-template-columns: subgrid; }
  .toolbar-theme, .locale-picker, .toolbar-badge { width: 100%; }
  .toolbar-theme, .toolbar-badge { padding: 0 12px; }
}

@media (max-width: 640px) {
  .page-toolbar { max-width: none; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .share-toolbar-button { display: none; }
  .toolbar-status { grid-column: 1 / -1; }
}
</style>
