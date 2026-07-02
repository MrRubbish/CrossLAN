import '@unocss/reset/tailwind.css';
import 'virtual:uno.css';
import './styles.css';
import { createApp } from 'vue';
import App from './App.vue';

void clearStaleAppCaches();

createApp(App).mount('#app');

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
