import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './styles.css';

type LaunchState = {
  ready: boolean;
  url: string;
  error: string | null;
};

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('Missing app root.');

const zh = navigator.language.toLowerCase().startsWith('zh');
const text = zh
  ? {
      starting: '正在启动 CrossLAN...',
      detail: '服务就绪后会自动打开系统浏览器',
      retry: '重试',
      failed: '启动失败'
    }
  : {
      starting: 'Starting CrossLAN...',
      detail: 'The transfer page will open in your default browser',
      retry: 'Retry',
      failed: 'Unable to start'
    };

root.innerHTML = `
  <main class="launch-screen">
    <img class="logo" src="/pwa.svg" alt="" />
    <h1>CrossLAN</h1>
    <div class="spinner" aria-hidden="true"></div>
    <p id="status">${text.starting}</p>
    <span id="detail">${text.detail}</span>
    <button id="retry" type="button" hidden>${text.retry}</button>
  </main>
`;

const status = requireElement<HTMLParagraphElement>('status');
const detail = requireElement<HTMLSpanElement>('detail');
const retry = requireElement<HTMLButtonElement>('retry');

let navigating = false;

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing launcher control: ${id}`);
  return element as T;
}

function render(state: LaunchState): void {
  if (state.ready && !navigating) {
    navigating = true;
    status.textContent = text.starting;
    detail.textContent = state.url;
    return;
  }

  if (state.error) {
    document.documentElement.classList.add('failed');
    status.textContent = text.failed;
    detail.textContent = state.error;
    retry.hidden = false;
  } else {
    document.documentElement.classList.remove('failed');
    status.textContent = text.starting;
    detail.textContent = text.detail;
    retry.hidden = true;
  }
}

retry.addEventListener('click', async () => {
  retry.disabled = true;
  render({ ready: false, url: '', error: null });
  try {
    render(await invoke<LaunchState>('restart_service'));
  } catch (error) {
    render({ ready: false, url: '', error: String(error) });
  } finally {
    retry.disabled = false;
  }
});

async function initialize(): Promise<void> {
  await listen<LaunchState>('crosslan://launch-state', event => render(event.payload));
  render(await invoke<LaunchState>('get_launch_state'));
}

void initialize().catch(error => {
  render({ ready: false, url: '', error: String(error) });
});
