'use strict';
// v8.3.1 refreshes licenses and includes the corresponding Liberation sources.
importScripts('./offline-assets.js');
// Project sites share an origin. Include scope so one site's update cannot
// remove another project's offline models. Legacy shared caches stay intact.
const CACHE_PREFIX='offline-serial-ocr:'+encodeURIComponent(new URL(self.registration.scope).pathname)+':';
const CACHE=CACHE_PREFIX+globalThis.OFFLINE_APP_VERSION;
const FILES=globalThis.OFFLINE_ASSETS;
const ALLOWED=new Set(FILES.map(path=>new URL(path,self.registration.scope).href));
self.addEventListener('install',event=>{event.waitUntil((async()=>{const cache=await caches.open(CACHE);await cache.addAll(FILES.map(path=>new Request(new URL(path,self.registration.scope),{cache:'reload'})));await self.skipWaiting();})());});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith(CACHE_PREFIX)&&key!==CACHE)await caches.delete(key);await self.clients.claim();})());});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET'||!ALLOWED.has(event.request.url))return;event.respondWith((async()=>{const cached=await caches.match(event.request,{cacheName:CACHE});return cached||fetch(event.request);})());});
