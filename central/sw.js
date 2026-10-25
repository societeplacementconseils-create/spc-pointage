/* Service worker : l'application s'ouvre et fonctionne sans connexion */
const V='spc-central-v2';
const ASSETS=['./','./index.html','./app.js','./manifest.webmanifest','../shared/core.js','../shared/qr.js','../shared/ui.css','../shared/icon-192.png','../shared/icon-512.png','../shared/logo.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin)return;
  e.respondWith(caches.match(e.request,{ignoreSearch:true}).then(hit=>{
    const net=fetch(e.request).then(r=>{if(r.ok){const cp=r.clone();caches.open(V).then(c=>c.put(e.request,cp))}return r}).catch(()=>hit);
    return hit||net;
  }));
});
