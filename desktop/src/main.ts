import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open } from '@tauri-apps/plugin-dialog';
import { Check, ChevronDown, FolderOpen, Languages, Power, Save, createElement } from 'lucide';
import { bindChoicePicker } from '../../shared/ChoicePicker';
import './styles.css';
import '../../shared/ui-controls.css';

type LaunchState = {
  ready: boolean;
  url: string;
  error: string | null;
};

type DesktopConfig = {
  port: number;
  saveDir: string;
  networkAdapter: string;
  locale: LocalePreference;
  theme: ThemePreference;
};

type NetworkAdapter = {
  id: string;
  name: string;
  ip: string;
};

const rootElement = document.querySelector<HTMLDivElement>('#app');
if (!rootElement) throw new Error('Missing app root.');
const root: HTMLDivElement = rootElement;

type LocalePreference = 'system' | 'zh-CN' | 'en-US';
type ThemePreference = 'system' | 'light' | 'dark';

function isChineseBrowser(): boolean {
  return navigator.language.toLowerCase().startsWith('zh');
}

function textFor(locale: LocalePreference) {
  const zh = locale === 'zh-CN' || (locale === 'system' && isChineseBrowser());
  return zh
    ? {
      starting: '正在启动 CrossLAN...',
      detail: '服务就绪后会自动打开系统浏览器',
      retry: '重试',
      failed: '启动失败',
      settings: 'CrossLAN 配置',
      settingsSubtitle: '选择局域网入口和本地存储位置',
      serviceRunning: '服务运行中',
      serviceStarting: '启动中',
      serviceFailed: '服务异常',
      connection: '连接',
      port: '服务端口',
      networkAdapter: '局域网网卡',
      autoAdapter: '自动选择（推荐）',
      noAdapters: '未检测到可用的 IPv4 网卡',
      adapterHint: '用于设备发现、网页地址和局域网传输；修改后会重启服务。',
      files: '文件',
      saveDir: '默认保存目录',
      chooseFolder: '选择文件夹',
      saveHint: '发送到本机直存入口的文件会保存到这里。',
      preferences: '偏好',
      appearance: '外观',
      light: '浅色',
      dark: '深色',
      save: '保存设置',
      quit: '退出 CrossLAN',
      saving: '正在保存...',
      language: '界面语言',
      followSystem: '跟随系统',
      chinese: '简体中文',
      english: 'English'
    }
    : {
      starting: 'Starting CrossLAN...',
      detail: 'The transfer page will open in your default browser',
      retry: 'Retry',
      failed: 'Unable to start',
      settings: 'CrossLAN settings',
      settingsSubtitle: 'Choose the LAN address and local storage location',
      serviceRunning: 'Service running',
      serviceStarting: 'Starting',
      serviceFailed: 'Service error',
      connection: 'Connection',
      port: 'Service port',
      networkAdapter: 'LAN adapter',
      autoAdapter: 'Automatic (Recommended)',
      noAdapters: 'No available IPv4 adapter detected',
      adapterHint: 'Used for discovery, the Web UI address, and LAN transfers. Changes restart the service.',
      files: 'Files',
      saveDir: 'Default save directory',
      chooseFolder: 'Choose folder',
      saveHint: 'Files sent to this computer through direct save are stored here.',
      preferences: 'Preferences',
      appearance: 'Appearance',
      light: 'Light',
      dark: 'Dark',
      save: 'Save settings',
      quit: 'Quit CrossLAN',
      saving: 'Saving...',
      language: 'Interface language',
      followSystem: 'Follow system',
      chinese: '简体中文',
      english: 'English'
    };
}

let currentView: 'launch' | 'config' = 'launch';
let latestLaunchState: LaunchState = { ready: false, url: '', error: null };
let navigating = false;
let currentLocale: LocalePreference = 'system';
let currentTheme: ThemePreference = 'system';
let text = textFor(currentLocale);
let disposeLocalePicker: (() => void) | undefined;

function disposeChoicePicker(): void {
  disposeLocalePicker?.();
  disposeLocalePicker = undefined;
}

function icon(node: Parameters<typeof createElement>[0], className = ''): string {
  return createElement(node, { width: '16', height: '16', 'aria-hidden': 'true', class: className }).outerHTML;
}

function updateServiceStatus(state: LaunchState): void {
  const status = document.getElementById('service-status');
  const label = document.getElementById('service-status-label');
  if (status) status.dataset.tone = state.error ? 'negative' : state.ready ? 'positive' : 'neutral';
  if (label) label.textContent = state.error ? text.serviceFailed : state.ready ? text.serviceRunning : text.serviceStarting;
}

function setTheme(theme: ThemePreference): void {
  currentTheme = theme;
  document.documentElement.dataset.theme = theme;
  if (isTauri()) {
    void getCurrentWindow().setTheme(theme === 'system' ? null : theme).catch(error => {
      console.error('Unable to update window theme:', error);
    });
  }
}

function setLocale(locale: LocalePreference): void {
  currentLocale = locale;
  text = textFor(locale);
  document.documentElement.lang =
    locale === 'zh-CN' || (locale === 'system' && isChineseBrowser()) ? 'zh-CN' : 'en';
}

function renderLaunch(state: LaunchState): void {
  latestLaunchState = state;
  disposeChoicePicker();
  root.innerHTML = `
    <main class="launch-screen">
      <img class="logo" src="/pwa.svg" alt="" />
      <h1>CrossLAN</h1>
      <div class="spinner" aria-hidden="true"></div>
      <p>${state.error ? text.failed : text.starting}</p>
      <span>${escapeHtml(state.error || (state.ready && !navigating ? state.url : text.detail))}</span>
      <button id="retry" type="button" ${state.error ? '' : 'hidden'}>${text.retry}</button>
    </main>
  `;
  document.documentElement.classList.toggle('failed', Boolean(state.error));

  const retry = document.getElementById('retry') as HTMLButtonElement | null;
  retry?.addEventListener('click', async () => {
    retry.disabled = true;
    navigating = false;
    renderLaunch({ ready: false, url: '', error: null });
    try {
      renderLaunch(await invoke<LaunchState>('restart_service'));
    } catch (error) {
      renderLaunch({ ready: false, url: '', error: String(error) });
    }
  });
}

function render(state: LaunchState): void {
  latestLaunchState = state;
  if (currentView === 'config') {
    updateServiceStatus(state);
    return;
  }
  if (state.ready && !navigating) navigating = true;
  renderLaunch(state);
}

async function showConfig(): Promise<void> {
  currentView = 'config';
  disposeChoicePicker();
  root.innerHTML = `<main class="settings-screen"><div class="spinner" aria-hidden="true"></div><p>${text.settings}</p></main>`;
  try {
    let adapterError = '';
    const [config, adapters] = await Promise.all([
      invoke<DesktopConfig>('get_desktop_config'),
      invoke<NetworkAdapter[]>('list_network_adapters').catch(error => {
        adapterError = String(error);
        return [];
      })
    ]);
    setLocale(config.locale);
    setTheme(config.theme ?? 'system');
    renderConfig(config, adapters, adapterError);
  } catch (error) {
    renderConfig(null, [], String(error));
  }
}

function renderConfig(config: DesktopConfig | null, adapters: NetworkAdapter[], error = ''): void {
  disposeChoicePicker();
  const value = config || {
    port: 6100, saveDir: '', networkAdapter: 'auto', locale: currentLocale, theme: currentTheme
  };
  const selectedAdapterExists = value.networkAdapter === 'auto'
    || adapters.some(adapter => adapter.id === value.networkAdapter);
  const adapterOptions = [
    `<option value="auto" ${value.networkAdapter === 'auto' ? 'selected' : ''}>${text.autoAdapter}</option>`,
    ...(!selectedAdapterExists
      ? [`<option value="${escapeHtml(value.networkAdapter)}" selected>${escapeHtml(value.networkAdapter)}</option>`]
      : []),
    ...adapters.map(adapter => `<option value="${escapeHtml(adapter.id)}" ${adapter.id === value.networkAdapter ? 'selected' : ''}>${escapeHtml(adapter.name)} · ${escapeHtml(adapter.ip)}</option>`),
    ...(adapters.length === 0
      ? [`<option value="" disabled>${text.noAdapters}</option>`]
      : [])
  ].join('');
  const localeOptions = [
    { value: 'system', label: text.followSystem },
    { value: 'zh-CN', label: text.chinese },
    { value: 'en-US', label: text.english }
  ];
  const localeLabel = localeOptions.find(option => option.value === value.locale)?.label || text.followSystem;
  root.innerHTML = `
    <main class="settings-screen">
      <header class="settings-header">
        <img class="settings-logo" src="/pwa.svg" width="42" height="42" alt="" />
        <div>
          <h1>${text.settings}</h1>
          <p>${text.settingsSubtitle}</p>
        </div>
        <span id="service-status" class="ui-surface ui-status" role="status">
          <span class="service-status-dot" aria-hidden="true"></span>
          <span id="service-status-label"></span>
        </span>
      </header>
      <form id="settings-form" class="settings-form">
        <section class="settings-section" aria-labelledby="connection-heading">
          <h2 id="connection-heading">${text.connection}</h2>
          <div class="field-grid">
            <label class="field">
              <span>${text.networkAdapter}</span>
              <select id="network-adapter">${adapterOptions}</select>
            </label>
            <label class="field field-port">
              <span>${text.port}</span>
              <input id="port" type="number" min="1024" max="65535" value="${value.port}" required />
            </label>
          </div>
          <small>${text.adapterHint}</small>
        </section>
        <section class="settings-section" aria-labelledby="files-heading">
          <h2 id="files-heading">${text.files}</h2>
          <label class="field">
            <span>${text.saveDir}</span>
            <span class="path-picker">
              <input id="save-dir" type="text" value="${escapeHtml(value.saveDir)}" readonly required />
              <button id="choose-save-dir" class="ui-surface ui-control secondary-button" type="button">${icon(FolderOpen)}${text.chooseFolder}</button>
            </span>
          </label>
          <small>${text.saveHint}</small>
        </section>
        <section class="settings-section" aria-labelledby="preferences-heading">
          <h2 id="preferences-heading">${text.preferences}</h2>
          <div class="preferences-grid">
            <fieldset class="theme-field">
              <legend>${text.appearance}</legend>
              <div class="ui-segments theme-control">
                ${(['system', 'light', 'dark'] as const).map(theme => `
                  <label>
                    <input type="radio" name="theme" value="${theme}" ${currentTheme === theme ? 'checked' : ''} />
                    <span>${theme === 'system' ? text.followSystem : text[theme]}</span>
                  </label>
                `).join('')}
              </div>
            </fieldset>
            <div class="field">
              <span id="locale-label">${text.language}</span>
              <details id="locale" class="ui-picker locale-picker">
                <summary class="ui-surface ui-control" aria-label="${text.language}: ${localeLabel}" title="${text.language}: ${localeLabel}">
                  ${icon(Languages)}<span class="locale-value">${localeLabel}</span>${icon(ChevronDown, 'choice-chevron')}
                </summary>
                <div class="ui-choice-panel">
                  <fieldset class="ui-choice-options">
                    <legend class="ui-visually-hidden">${text.language}</legend>
                    ${localeOptions.map(option => `
                      <label class="ui-choice-option">
                        <input type="radio" name="locale" value="${option.value}" ${value.locale === option.value ? 'checked' : ''} />
                        <span class="ui-option-row"><span>${option.label}</span>${icon(Check, 'ui-choice-check')}</span>
                      </label>
                    `).join('')}
                  </fieldset>
                </div>
              </details>
            </div>
          </div>
        </section>
        <div class="settings-footer">
          <button id="quit" class="ui-surface ui-control quit-button" type="button">${icon(Power)}${text.quit}</button>
          <div class="save-area">
            <p id="settings-status" class="settings-status" role="status">${escapeHtml(error)}</p>
            <button id="save" type="submit">${icon(Save)}<span>${text.save}</span></button>
          </div>
        </div>
      </form>
    </main>
  `;

  updateServiceStatus(latestLaunchState);
  const localePicker = document.getElementById('locale') as HTMLDetailsElement;
  disposeLocalePicker = bindChoicePicker(localePicker, next => {
    const label = localeOptions.find(option => option.value === next)?.label || text.followSystem;
    const trigger = localePicker.querySelector('summary');
    const selected = localePicker.querySelector('.locale-value');
    if (selected) selected.textContent = label;
    trigger?.setAttribute('aria-label', `${text.language}: ${label}`);
    trigger?.setAttribute('title', `${text.language}: ${label}`);
  });

  document.getElementById('quit')?.addEventListener('click', async () => {
    await invoke('quit_app');
  });

  root.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) setTheme(input.value as ThemePreference);
    });
  });

  const saveDirInput = document.getElementById('save-dir') as HTMLInputElement | null;
  const chooseSaveDir = document.getElementById('choose-save-dir') as HTMLButtonElement | null;
  chooseSaveDir?.addEventListener('click', async () => {
    chooseSaveDir.disabled = true;
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        defaultPath: saveDirInput?.value || undefined
      });
      if (typeof selected === 'string' && saveDirInput) saveDirInput.value = selected;
    } catch (pickerError) {
      const status = document.getElementById('settings-status');
      if (status) status.textContent = String(pickerError);
    } finally {
      chooseSaveDir.disabled = false;
    }
  });

  const form = document.getElementById('settings-form') as HTMLFormElement | null;
  const save = document.getElementById('save') as HTMLButtonElement | null;
  const status = document.getElementById('settings-status');
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!save) return;
    save.disabled = true;
    if (status) status.textContent = text.saving;
    const port = Number((document.getElementById('port') as HTMLInputElement).value);
    const saveDir = saveDirInput?.value || '';
    const networkAdapter = (document.getElementById('network-adapter') as HTMLSelectElement).value;
    const locale = (form?.querySelector<HTMLInputElement>('input[name="locale"]:checked')?.value || 'system') as LocalePreference;
    try {
      currentView = 'launch';
      navigating = false;
      const launchState = await invoke<LaunchState>('save_desktop_config', {
        config: { port, saveDir, networkAdapter, locale, theme: currentTheme }
      });
      setLocale(locale);
      renderLaunch(launchState);
    } catch (saveError) {
      currentView = 'config';
      save.disabled = false;
      if (status) status.textContent = String(saveError);
    }
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function initialize(): Promise<void> {
  await listen<LaunchState>('crosslan://launch-state', event => render(event.payload));
  await listen('crosslan://open-config', () => {
    void showConfig();
  });
  try {
    const config = await invoke<DesktopConfig>('get_desktop_config');
    setLocale(config.locale);
    setTheme(config.theme ?? 'system');
  } catch {
    // The browser language remains the initial fallback if config loading fails.
  }
  render(await invoke<LaunchState>('get_launch_state'));
}

void initialize().catch(error => {
  renderLaunch({ ready: false, url: '', error: String(error) });
});
