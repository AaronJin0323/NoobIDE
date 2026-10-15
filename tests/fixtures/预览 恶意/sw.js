// S05.5: a service worker would survive refreshes and restarts and could answer requests in place of the project's
// files. The preview refuses to register it.
self.addEventListener('fetch', (event) => event.respondWith(new Response('served by a service worker')));
