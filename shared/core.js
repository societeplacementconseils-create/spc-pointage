/* SPC Pointage - noyau partagé par les trois applications (agent, superviseur, central).
   Aucune dépendance externe. Fonctionne hors connexion (IndexedDB) et se synchronise via l'API GitHub. */
(function (g) {
  'use strict';
  const SPC = { version: '1.0.0', clockOffset: null };
  const te = new TextEncoder(), td = new TextDecoder();
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

  /* ---------- encodage ---------- */
  const b64uEnc = u8 => btoa(String.fromCharCode.apply(null, u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64uDec = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
  SPC.encJson = o => b64uEnc(te.encode(JSON.stringify(o)));
  SPC.decJson = s => JSON.parse(td.decode(b64uDec(s)));
  const toB64 = str => { const u = te.encode(str); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(s); };
  const fromB64 = b => td.decode(Uint8Array.from(atob(String(b).replace(/\s/g, '')), c => c.charCodeAt(0)));
  SPC.uid = () => hex(crypto.getRandomValues(new Uint8Array(6))) + Date.now().toString(36);

  /* ---------- dates (heure locale de l'appareil) ---------- */
  const p2 = n => String(n).padStart(2, '0');
  SPC.localDate = (d = new Date()) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  SPC.hm = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : p2(d.getHours()) + ':' + p2(d.getMinutes()); };
  SPC.fdate = s => s ? new Date(s + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : '';
  SPC.dow = date => (new Date(date + 'T12:00:00').getDay() + 6) % 7 + 1; // lundi = 1 ... dimanche = 7
  SPC.toMin = t => { if (!t) return null; const [a, b] = t.split(':').map(Number); return a * 60 + b; };
  SPC.dayPath = (agentId, date) => 'pointages/' + date.slice(0, 7) + '/' + date + '/' + agentId + '.json';
  SPC.JOURS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  SPC.activeOn = (assignments, date) => assignments.filter(a => a.actif !== false && (!a.du || a.du <= date) && (!a.au || a.au >= date) && (a.jours || [1, 2, 3, 4, 5]).includes(SPC.dow(date)));

  /* ---------- interface minimale ---------- */
  SPC.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  SPC.toast = (m, ms = 3200) => { const t = document.getElementById('toast'); if (!t) return; t.textContent = m; t.style.display = 'block'; clearTimeout(SPC._tt); SPC._tt = setTimeout(() => t.style.display = 'none', ms); };
  SPC.modal = html => { let m = document.getElementById('modal'); if (!m) { m = document.createElement('div'); m.id = 'modal'; m.innerHTML = '<div class="sheet"></div>'; document.body.appendChild(m); } m.firstChild.innerHTML = html; m.classList.add('on'); return m.firstChild; };
  SPC.closeModal = () => { const m = document.getElementById('modal'); if (m) m.classList.remove('on'); };

  /* ---------- stockage hors ligne (IndexedDB) ---------- */
  SPC.db = name => {
    let p;
    const open = () => new Promise((res, rej) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => { ['kv', 'events', 'outbox', 'cache'].forEach(s => r.result.createObjectStore(s)); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const tx = async (store, mode, fn) => {
      const d = await (p || (p = open()));
      return new Promise((res, rej) => { const t = d.transaction(store, mode); const r = fn(t.objectStore(store)); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); });
    };
    return {
      get: (s, k) => tx(s, 'readonly', o => o.get(k)),
      set: (s, k, v) => tx(s, 'readwrite', o => o.put(v, k)),
      del: (s, k) => tx(s, 'readwrite', o => o.delete(k)),
      all: s => tx(s, 'readonly', o => o.getAll()),
      keys: s => tx(s, 'readonly', o => o.getAllKeys()),
    };
  };

  /* ---------- cryptographie : empreinte et signature ---------- */
  SPC.sha256 = async s => hex(await crypto.subtle.digest('SHA-256', te.encode(s)));
  SPC.hmac = async (keyB64u, msg) => {
    const k = await crypto.subtle.importKey('raw', b64uDec(keyB64u), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', k, te.encode(msg)));
  };
  SPC.newKey = () => b64uEnc(crypto.getRandomValues(new Uint8Array(32)));

  /* ---------- géolocalisation ---------- */
  SPC.dist = (la1, lo1, la2, lo2) => {
    const R = 6371000, t = x => x * Math.PI / 180, dl = t(la2 - la1), dn = t(lo2 - lo1);
    const a = Math.sin(dl / 2) ** 2 + Math.cos(t(la1)) * Math.cos(t(la2)) * Math.sin(dn / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };
  const toPos = p => ({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: p.timestamp });
  SPC.bestPos = (ms = 10000, goodAcc = 20) => new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(Object.assign(new Error('nogeo'), { code: 'nogeo' }));
    let best = null, id, done = false, tm;
    const fin = () => { if (done) return; done = true; navigator.geolocation.clearWatch(id); clearTimeout(tm); best ? resolve(best) : reject(Object.assign(new Error('nofix'), { code: 'nofix' })); };
    const onP = p => { const c = toPos(p); if (!best || c.acc < best.acc) best = c; if (best.acc <= goodAcc) fin(); };
    navigator.geolocation.getCurrentPosition(onP, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: ms });
    id = navigator.geolocation.watchPosition(onP,
      e => { if (!best) { done = true; clearTimeout(tm); navigator.geolocation.clearWatch(id); reject(Object.assign(new Error('geo'), { code: e.code === 1 ? 'denied' : 'nofix' })); } },
      { enableHighAccuracy: true, maximumAge: 0, timeout: ms });
    tm = setTimeout(fin, ms);
  });

  /* ---------- événements de pointage signés et chaînés ---------- */
  SPC.canon = e => { const a = [e.id, e.agentId, e.siteId, e.type, e.t, e.tGps || '', e.lat, e.lon, e.acc, e.dist, e.zone, e.mode, e.reason || '', e.signerId, e.prev, e.drift == null ? '' : e.drift]; if (e.src) a.push(e.src); return JSON.stringify(a); };
  SPC.makeEvent = async (db, cfg, f) => {
    const prev = (await db.get('kv', 'last:' + cfg.id)) || 'GENESIS';
    const pos = f.pos || {};
    const e = {
      id: SPC.uid(), agentId: f.agentId || cfg.id, siteId: f.siteId, type: f.type, t: f.t || new Date().toISOString(),
      tGps: pos.t ? new Date(pos.t).toISOString() : '', lat: pos.lat != null ? +pos.lat.toFixed(6) : null, lon: pos.lon != null ? +pos.lon.toFixed(6) : null,
      acc: pos.acc != null ? Math.round(pos.acc) : null, dist: f.dist != null ? Math.round(f.dist) : null, zone: f.zone, mode: f.mode, reason: f.reason || '',
      signerId: cfg.id, prev, drift: SPC.clockOffset == null ? null : Math.round(SPC.clockOffset), date: SPC.localDate(f.t ? new Date(f.t) : new Date()), app: SPC.version,
    };
    e.hash = await SPC.sha256(SPC.canon(e));
    e.sig = await SPC.hmac(cfg.key, e.hash);
    await db.set('kv', 'last:' + cfg.id, e.hash);
    return e;
  };
  SPC.queueEvent = async (db, e) => {
    await db.set('events', e.id, Object.assign({}, e, { synced: false }));
    await db.set('outbox', 'ev:' + e.id, { kind: 'event', path: SPC.dayPath(e.agentId, e.date), id: e.id });
  };
  SPC.queueFile = (db, path, data, mode = 'create') => db.set('outbox', 'f:' + path, { kind: 'file', path, data, mode });
  const strip = e => { const r = Object.assign({}, e); delete r.synced; delete r.srvTime; return r; };

  /* ---------- client de l'API GitHub (contenu d'un dépôt) ---------- */
  SPC.gh = cfg => {
    const base = cfg.apiBase || 'https://api.github.com';
    const [owner, repo] = String(cfg.repo || '/').split('/');
    const branch = cfg.branch || 'main';
    const H = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + cfg.token, 'X-GitHub-Api-Version': '2022-11-28' };
    const url = p => `${base}/repos/${owner}/${repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;
    const req = async (u, opt) => {
      let res;
      try { res = await fetch(u, Object.assign({ headers: H, cache: 'no-store' }, opt)); }
      catch (e) { throw Object.assign(new Error('Pas de connexion'), { code: 'offline' }); }
      if (res.status === 401) throw Object.assign(new Error('Jeton refusé'), { code: 'auth' });
      if (res.status === 403) throw Object.assign(new Error(res.headers.get('x-ratelimit-remaining') === '0' ? 'Limite GitHub atteinte' : 'Accès refusé'), { code: res.headers.get('x-ratelimit-remaining') === '0' ? 'rate' : 'auth' });
      return res;
    };
    return {
      async get(path) {
        const res = await req(url(path) + '?ref=' + encodeURIComponent(branch));
        if (res.status === 404) return null;
        if (!res.ok) throw Object.assign(new Error('GitHub ' + res.status), { code: 'http' });
        const j = await res.json();
        if (Array.isArray(j)) return { dir: true, items: j };
        const text = fromB64(j.content || '');
        let json = null; try { json = JSON.parse(text); } catch (e) { /* texte */ }
        return { sha: j.sha, text, json };
      },
      async put(path, obj, sha, msg) {
        const body = { message: msg || 'pointage', content: toB64(JSON.stringify(obj, null, 1)), branch };
        if (sha) body.sha = sha;
        const res = await req(url(path), { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: JSON.stringify(body) });
        if (res.status === 409 || res.status === 422) throw Object.assign(new Error('conflit'), { code: 'conflict' });
        if (!res.ok) throw Object.assign(new Error('GitHub ' + res.status), { code: 'http' });
        const j = await res.json();
        const time = (j.commit && ((j.commit.committer && j.commit.committer.date) || (j.commit.author && j.commit.author.date))) || new Date().toISOString();
        SPC.clockOffset = Date.parse(time) - Date.now();
        return { sha: j.content && j.content.sha, time };
      },
      async tree() {
        const res = await req(`${base}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
        if (!res.ok) throw Object.assign(new Error('GitHub ' + res.status), { code: 'http' });
        return (await res.json()).tree || [];
      },
    };
  };

  /* ---------- lecture d'un dossier avec cache hors ligne ---------- */
  SPC.pullDir = async (db, gh, dir) => {
    let list;
    try { list = await gh.get(dir); }
    catch (e) { if (e.code === 'offline') { const c = await db.get('cache', 'dir:' + dir); return c == null ? null : c; } throw e; }
    if (!list || !list.items) return [];
    const out = [];
    for (const it of list.items.filter(x => x.type === 'file' && x.name.endsWith('.json'))) {
      const ck = await db.get('cache', 'f:' + it.path);
      let j;
      if (ck && ck.sha === it.sha) j = ck.json;
      else { const f = await gh.get(it.path); if (!f) continue; j = f.json; await db.set('cache', 'f:' + it.path, { sha: f.sha, json: j }); }
      out.push(j);
    }
    await db.set('cache', 'dir:' + dir, out);
    return out;
  };

  /* ---------- synchronisation : envoie la file d'attente, fusionne sans perdre de pointage ---------- */
  SPC.sync = async (db, cfg) => {
    const gh = SPC.gh(cfg);
    const keys = await db.keys('outbox');
    const items = [];
    for (const k of keys) items.push([k, await db.get('outbox', k)]);
    let sent = 0, err = null;
    try {
      const byPath = {};
      for (const [k, it] of items) if (it.kind === 'event') (byPath[it.path] = byPath[it.path] || []).push([k, it]);
      for (const [path, list] of Object.entries(byPath)) {
        const evs = [];
        for (const [, it] of list) { const e = await db.get('events', it.id); if (e) evs.push(strip(e)); }
        for (let attempt = 0; attempt < 4; attempt++) {
          const remote = await gh.get(path);
          const cur = remote && Array.isArray(remote.json) ? remote.json : [];
          const have = new Set(cur.map(x => x.id));
          const merged = cur.concat(evs.filter(e => !have.has(e.id))).sort((a, b) => (a.t < b.t ? -1 : 1));
          try {
            const r = await gh.put(path, merged, remote && remote.sha, 'pointage ' + path.split('/').pop());
            for (const [k, it] of list) { const e = await db.get('events', it.id); if (e) { e.synced = true; e.srvTime = r.time; await db.set('events', e.id, e); } await db.del('outbox', k); sent++; }
            break;
          } catch (er) { if (er.code === 'conflict' && attempt < 3) continue; throw er; }
        }
      }
      for (const [k, it] of items) {
        if (it.kind !== 'file') continue;
        try { await gh.put(it.path, it.data, null, 'maj ' + it.path); }
        catch (er) {
          if (er.code !== 'conflict') throw er;
          if (it.mode === 'replace') { const cur = await gh.get(it.path); await gh.put(it.path, it.data, cur && cur.sha, 'maj ' + it.path); }
        }
        await db.del('outbox', k); sent++;
      }
      await db.set('kv', 'offset', SPC.clockOffset);
      await db.set('kv', 'lastSync', new Date().toISOString());
    } catch (e) { err = e.code || e.message; }
    return { sent, left: (await db.keys('outbox')).length, err };
  };

  /* ---------- règles de zone ---------- */
  SPC.zone = (site, pos) => {
    const d = SPC.dist(pos.lat, pos.lon, site.lat, site.lon), maxAcc = site.precisionMax || 60;
    return { dist: d, accOk: pos.acc <= maxAcc, inside: d <= site.rayon, maxAcc };
  };

  g.SPC = SPC;
})(window);
