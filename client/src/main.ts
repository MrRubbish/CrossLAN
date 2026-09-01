import '@unocss/reset/tailwind.css';
import 'virtual:uno.css';
import './styles.css';
import { createApp } from 'vue';
import App from './App.vue';

initializeDesktopSession();
void clearStaleAppCaches();

createApp(App).mount('#app');

function initializeDesktopSession(): void {
  const url = new URL(window.location.href);
  const queryToken = url.searchParams.get('crosslanDesktopToken')?.trim() || '';
  const storedToken = window.sessionStorage.getItem('crosslan:desktop-session')?.trim() || '';
  const token = queryToken || storedToken;
  if (!token) return;

  window.sessionStorage.setItem('crosslan:desktop-session', token);
  if (queryToken) {
    url.searchParams.delete('crosslanDesktopToken');
    const cleanUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, document.title, cleanUrl);
  }

  void fetch('/api/desktop/session/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
    cache: 'no-store',
    keepalive: true
  }).catch(() => {
    // A normal non-desktop page or a service that does not support this control
    // should continue to work without showing a lifecycle error.
  });

  // Let the tray launcher reopen the page after this browser tab is closed.
  // This endpoint only clears the launcher UI state; it never stops the service.
  let notifiedPageClose = false;
  const notifyPageClose = () => {
    if (notifiedPageClose) return;
    notifiedPageClose = true;
    const body = JSON.stringify({ token });
    const blob = new Blob([body], { type: 'application/json' });
    if (navigator.sendBeacon('/api/desktop/session/close', blob)) return;
    void fetch('/api/desktop/session/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      cache: 'no-store',
      keepalive: true
    }).catch(() => {});
  };
  window.addEventListener('pagehide', notifyPageClose, { once: true });
}

async function clearStaleAppCaches() {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(registration => registration.unregister()));
    }
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(name => caches.delete(name)));
    }
  } catch {
    // Cache cleanup is best-effort; the app should still start normally.
  }
}
