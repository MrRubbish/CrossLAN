import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './styles.css';

type LaunchState = {
  ready: boolean;
  url: string;
  error: string | null;
};

type DesktopConfig = {
  port: number;
  saveDir: string;
  locale: LocalePreference;
};

const rootElement = document.querySelector<HTMLDivElement>('#app');
if (!rootElement) throw new Error('Missing app root.');
const root: HTMLDivElement = rootElement;

type LocalePreference = 'system' | 'zh-CN' | 'en-US';

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
      port: '服务端口',
      saveDir: '默认保存目录',
      saveHint: '修改端口或保存目录后会重启本地服务',
      save: '保存设置',
      cancel: '取消',
      quit: '退出 CrossLAN',
      saving: '正在保存...',
      back: '返回',
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
      port: 'Service port',
      saveDir: 'Default save directory',
      saveHint: 'Changing the port or save directory restarts the local service',
      save: 'Save settings',
      cancel: 'Cancel',
      quit: 'Quit CrossLAN',
      saving: 'Saving...',
      back: 'Back',
      language: 'Interface language',
      followSystem: 'Follow system',
      chinese: 'Simplified Chinese',
      english: 'English'
    };
}

let currentView: 'launch' | 'config' = 'launch';
let latestLaunchState: LaunchState = { ready: false, url: '', error: null };
let navigating = false;
let currentLocale: LocalePreference = 'system';
let text = textFor(currentLocale);

function setLocale(locale: LocalePreference): void {
  currentLocale = locale;
  text = textFor(locale);
  document.documentElement.lang =
    locale === 'zh-CN' || (locale === 'system' && isChineseBrowser()) ? 'zh-CN' : 'en';
}

function renderLaunch(state: LaunchState): void {
  latestLaunchState = state;
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
  if (currentView === 'config') return;
  if (state.ready && !navigating) navigating = true;
  renderLaunch(state);
}

async function showConfig(): Promise<void> {
  currentView = 'config';
  root.innerHTML = `<main class="settings-screen"><div class="spinner" aria-hidden="true"></div><p>${text.settings}</p></main>`;
  try {
    const config = await invoke<DesktopConfig>('get_desktop_config');
    setLocale(config.locale);
    renderConfig(config);
  } catch (error) {
    renderConfig(null, String(error));
  }
}

function renderConfig(config: DesktopConfig | null, error = ''): void {
  const value = config || { port: 6100, saveDir: '', locale: currentLocale };
  root.innerHTML = `
    <main class="settings-screen">
      <header class="settings-header">
        <button id="back" class="secondary-button" type="button">${text.back}</button>
        <h1>${text.settings}</h1>
      </header>
      <form id="settings-form" class="settings-form">
        <label>
          <span>${text.port}</span>
          <input id="port" type="number" min="1024" max="65535" value="${value.port}" required />
        </label>
        <label>
          <span>${text.saveDir}</span>
          <input id="save-dir" type="text" value="${escapeHtml(value.saveDir)}" required />
        </label>
        <label>
          <span>${text.language}</span>
          <select id="locale">
            <option value="system" ${value.locale === 'system' ? 'selected' : ''}>${text.followSystem}</option>
            <option value="zh-CN" ${value.locale === 'zh-CN' ? 'selected' : ''}>${text.chinese}</option>
            <option value="en-US" ${value.locale === 'en-US' ? 'selected' : ''}>${text.english}</option>
          </select>
        </label>
        <small>${text.saveHint}</small>
        <p id="settings-status" class="settings-status">${escapeHtml(error)}</p>
        <div class="settings-actions">
          <button id="cancel" class="secondary-button" type="button">${text.cancel}</button>
          <button id="save" type="submit">${text.save}</button>
        </div>
      </form>
      <button id="quit" class="danger-button" type="button">${text.quit}</button>
    </main>
  `;

  const closeSettings = () => {
    currentView = 'launch';
    navigating = false;
    if (latestLaunchState.error) {
      renderLaunch(latestLaunchState);
      return;
    }
    void getCurrentWindow().hide();
  };
  document.getElementById('back')?.addEventListener('click', closeSettings);
  document.getElementById('cancel')?.addEventListener('click', closeSettings);
  document.getElementById('quit')?.addEventListener('click', async () => {
    await invoke('quit_app');
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
    const saveDir = (document.getElementById('save-dir') as HTMLInputElement).value;
    const locale = (document.getElementById('locale') as HTMLSelectElement)
      .value as LocalePreference;
    try {
      currentView = 'launch';
      navigating = false;
      const launchState = await invoke<LaunchState>('save_desktop_config', {
        config: { port, saveDir, locale }
      });
      setLocale(locale);
      renderLaunch(launchState);
    } catch (saveError) {
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
  } catch {
    // The browser language remains the initial fallback if config loading fails.
  }
  render(await invoke<LaunchState>('get_launch_state'));
}

void initialize().catch(error => {
  renderLaunch({ ready: false, url: '', error: String(error) });
});
