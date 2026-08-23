/* AquarIApp — Service Worker (PWA).
 * Estratégia segura para um app que mistura estáticos + rotas de API via proxy:
 *  - Assets estáticos (_expo/*, /icons/*, /favicon.ico): cache-first (offline/resiliência).
 *  - Tudo o mais (navegação, catálogos, API, rotas de IA): NETWORK-FIRST.
 *    Nunca respondemos do cache em rotas de API — o servidor é a fonte da verdade.
 */
const CACHE = 'aquariapp-v3';
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
