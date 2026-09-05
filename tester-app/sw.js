/* AquarIApp — Service Worker (PWA).
 * Estratégia segura para um app que mistura estáticos + rotas de API via proxy:
 *  - Assets estáticos (_expo/*, /icons/*, /favicon.ico): cache-first (offline/resiliência).
 *  - Tudo o mais (navegação, catálogos, API, rotas de IA): NETWORK-FIRST.
 *    Nunca respondemos do cache em rotas de API — o servidor é a fonte da verdade.
 */
const CACHE = 'aquariapp-v4';
const ESTATICOS = new Set([
  '/manifest.json',
  '/favicon.ico',
  '/favicon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon.png',
]);

function ehEstatico(url) {
  const p = url.pathname;
  if (ESTATICOS.has(p)) return true;
  return p.startsWith('/_expo/');
}

self.addEventListener('install', (event) => {
  // Precacheia o shell para que o app instalado (PWA) abra mesmo sem internet.
  event.waitUntil(
    caches.open(CACHE).then((c) =>
      c
        .addAll(['/index.html', '/manifest.json'])
        .catch(() => {})
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((chaves) =>
        Promise.all(chaves.filter((c) => c !== CACHE).map((c) => caches.delete(c)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  if (ehEstatico(url)) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((resp) => {
          if (resp && resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return resp;
        });
      })
    );
    return;
  }

  event.respondWith(
    fetch(req).catch((e) => {
      // Falha de rede: em navegação, tenta o cache do shell (index.html).
      if (req.mode === 'navigate') {
        return caches.match('/index.html');
      }
      return caches.match(req);
    })
  );
});

// ---- Web Push (lembretes) ----

self.addEventListener('push', (event) => {
  let dados = null;
  try {
    dados = event.data ? event.data.json() : null;
  } catch (e) {
    dados = null;
  }
  const titulo = (dados && dados.title) || 'AquarIApp';
  const corpo = (dados && dados.body) || '';
  event.waitUntil(
    self.registration.showNotification(titulo, {
      body: corpo,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'aquariapp-lembrete',
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      for (const cliente of lista) {
        if ('focus' in cliente) return cliente.focus();
      }
      return self.clients.openWindow('/');
    })
  );
});

// ---- Keep-alive no Service Worker (best-effort) ----
// Periodic Background Sync mantém o servidor acordado mesmo com o app em
// background (PWA instalado no Android/Chrome). Se o navegador não suportar,
// o app em primeiro plano continua fazendo o ping (keepAlive.js).
const PING_URL = 'https://aquariapp-ia.onrender.com/ping';
const PERIODIC_TAG = 'aquariapp-ping';

async function pingServidor() {
  try {
    await fetch(PING_URL, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
  } catch (e) {
    // silencioso: keep-alive é best-effort
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === PERIODIC_TAG) {
    event.waitUntil(pingServidor());
  }
});

// Registra o periodic sync quando o SW ativa (o app também pode registrá-lo
// via navigator.serviceWorker.ready + registration.periodicSync.register).
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        if ('periodicSync' in self.registration) {
          await self.registration.periodicSync.register(PERIODIC_TAG, {
            minInterval: 15 * 60 * 1000,
          });
        }
      } catch (e) {
        // navegador sem suporte / permissão negada: ignora
      }
    })()
  );
});
