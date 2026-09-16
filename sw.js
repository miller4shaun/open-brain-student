const CACHE = 'open-brain-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', () => self.clients.claim())

self.addEventListener('fetch', event => {
  // Only touch same-origin GETs. Saving a thought is a POST to Supabase —
  // that goes straight to the network, untouched.
  if (event.request.method !== 'GET') return
  if (new URL(event.request.url).origin !== self.location.origin) return

  event.respondWith(
    fetch(event.request)
      .then(res => {
        const copy = res.clone()
        caches.open(CACHE).then(c => c.put(event.request, copy))
        return res
      })
      .catch(async () => {
        const hit = await caches.match(event.request)
        return hit || new Response('Offline and not cached', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        })
      })
  )
})
