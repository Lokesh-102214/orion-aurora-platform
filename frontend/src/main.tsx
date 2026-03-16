import React from 'react';
import ReactDOM from 'react-dom/client';
import SiteApp from './SiteApp';
import './index.css';

// Point Cesium's runtime asset loader to copied static assets.
(window as any).CESIUM_BASE_URL = '/cesium/Cesium';

const SW_RECOVERY_KEY = 'orion-sw-recovered-once';

async function recoverFromStaleAssets() {
  if (sessionStorage.getItem(SW_RECOVERY_KEY) === '1') return;
  sessionStorage.setItem(SW_RECOVERY_KEY, '1');

  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // Best-effort cleanup only; reload is still attempted below.
  }

  window.location.reload();
}

window.addEventListener('vite:preloadError', (event: Event) => {
  event.preventDefault();
  recoverFromStaleAssets();
});

window.addEventListener('error', (event: ErrorEvent) => {
  const msg = String(event?.message || '');
  if (msg.includes('ChunkLoadError') || msg.includes('Failed to fetch dynamically imported module')) {
    recoverFromStaleAssets();
  }
});

// Clear one-shot recovery flag after a healthy boot.
setTimeout(() => sessionStorage.removeItem(SW_RECOVERY_KEY), 3000);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <SiteApp />
  </React.StrictMode>
);
