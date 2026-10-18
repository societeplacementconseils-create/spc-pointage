/* SPC Pointage - application de l'agent */
(function () {
  'use strict';
  const { esc, toast, modal, closeModal, fdate, hm } = SPC;
  const $ = s => document.querySelector(s);
  const db = SPC.db('spc-agent');
  let cfg = null, data = { sites: [], assignments: [] }, tab = 'today', watchId = null, counts = {}, busy = false, lastFix = null;
  let pending = 0, lastSync = '', syncing = false, installEv = null, authError = false, lastErr = '';
  const NAT = !!(window.SPCNative && window.SPCNative.isNative && window.SPCNative.isNative());   // application Android native
  const nat = (fn, d) => { try { return NAT ? fn() : d; } catch (e) { return d; } };
  const nativeEvents = () => nat(() => JSON.parse(SPCNative.recentEvents()), []).filter(e => !e.ext).map(e => Object.assign({}, e, { agentId: cfg.id, native: true }));
  function pushNative() {
    if (!NAT || !cfg) return;
    try {
      SPCNative.configure(JSON.stringify({ id: cfg.id, nom: cfg.nom, key: cfg.key, repo: cfg.repo, branch: cfg.branch, apiBase: cfg.apiBase, token: cfg.token, auto: cfg.auto !== false }));
      const entries = data.assignments.filter(a => a.agentId === cfg.id && a.actif !== false).map(a => { const s = data.sites.find(x => x.id === a.siteId); return s && s.actif !== false ? { siteId: s.id, nom: s.nom, lat: s.lat, lon: s.lon, rayon: s.rayon, precisionMax: s.precisionMax || 60, jours: a.jours || [1, 2, 3, 4, 5], debut: a.debut || '00:00', fin: a.fin || '23:59', du: a.du || '', au: a.au || '', actif: true } : null; }).filter(Boolean);
      SPCNative.setSites(JSON.stringify(entries));
    } catch (e) { /* le pont natif est facultatif */ }
  }

  /* ---------- démarrage ---------- */
  async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    const m = location.hash.match(/enroll=([\w-]+)/);
    if (m) { try { await enroll(SPC.decJson(m[1])); } catch (e) { toast("Lien d'activation invalide"); } history.replaceState(null, '', location.pathname); }
    cfg = await db.get('kv', 'cfg');
    data = (await db.get('kv', 'data')) || data;
    SPC.clockOffset = (await db.get('kv', 'offset')) ?? null;
    await refreshCounts();
    render();
    if (cfg) { pushNative(); refresh(); startWatch(); }
    addEventListener('online', () => refresh());
    addEventListener('offline', render);
    addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEv = e; render(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); startWatch(); } else stopWatch(); });
    setInterval(() => { if (cfg && navigator.onLine) refresh(); }, 60000);
    setInterval(() => { const c = $('#clock'); if (c) c.textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }, 10000);
  }
  async function enroll(c) {
    if (!c || !c.repo || !c.token || !c.agentId || !c.key) throw new Error('code');
    cfg = { id: c.agentId, nom: c.nom || c.agentId, role: c.role || 'agent', key: c.key, repo: c.repo, branch: c.branch || 'main', apiBase: c.apiBase || '', token: c.token, auto: true };
    await db.set('kv', 'cfg', cfg);
  }
  async function refreshCounts() { pending = (await db.keys('outbox')).length + nat(() => Number(SPCNative.pending()) || 0, 0); lastSync = (await db.get('kv', 'lastSync')) || ''; }

  /* ---------- données et synchronisation ---------- */
  async function refresh() {
    if (!cfg || syncing) return;
    syncing = true; lastErr = '';
    try {
      if (navigator.onLine) {
        const gh = SPC.gh(cfg);
        const [sites, asg] = await Promise.all([SPC.pullDir(db, gh, 'sites'), SPC.pullDir(db, gh, 'assignments')]);
        data = { sites: sites || data.sites, assignments: asg || data.assignments }; await db.set('kv', 'data', data);
        const r = await SPC.sync(db, cfg);
        if (r.err) lastErr = r.err;
        authError = r.err === 'auth';
        pushNative(); nat(() => SPCNative.syncNow());
      }
    } catch (e) { lastErr = e.code || e.message; authError = e.code === 'auth'; }
    syncing = false; await refreshCounts(); render();
  }
  const todayList = () => {
    const d = SPC.localDate();
    return SPC.activeOn(data.assignments.filter(a => a.agentId === cfg.id), d).map(a => ({ a, site: data.sites.find(s => s.id === a.siteId) })).filter(x => x.site && x.site.actif !== false);
  };
  const eventsOf = async (siteId, date) => (await db.all('events')).concat(nativeEvents()).filter(e => e.agentId === cfg.id && e.date === (date || SPC.localDate()) && (!siteId || e.siteId === siteId)).sort((a, b) => a.t < b.t ? -1 : 1);

  /* ---------- pointage ---------- */
  async function punch(siteId, type) {
    if (busy) return; busy = true;
    const site = data.sites.find(s => s.id === siteId);
    modal(`<h3>Localisation en cours…</h3><p class="sub">Restez à l'extérieur, sans bouger. Le GPS fonctionne aussi sans connexion.</p>`);
    let pos;
    try { pos = lastFix && Date.now() - lastFix.t < 8000 && lastFix.acc <= 20 ? lastFix : await SPC.bestPos(14000, 20); }
    catch (e) {
      busy = false;
      modal(`<h3>Position introuvable</h3><p>${e.code === 'denied' ? "L'accès à la position est refusé. Autorisez la localisation pour SPC Pointage dans les réglages du téléphone." : "Le GPS ne répond pas. Activez la localisation, sortez à l'air libre et réessayez."}</p><div class="row"><button class="primary grow" data-act="retry" data-site="${site.id}" data-type="${type}">Réessayer</button><button data-act="close">Fermer</button></div>`);
      return;
    }
    const z = SPC.zone(site, pos);
    if (z.accOk && z.inside) { await record(site, type, pos, z.dist, 'in', '', 'gps'); return; }
    busy = false;
    const msg = !z.accOk ? `Précision GPS insuffisante (±${Math.round(pos.acc)} m, maximum ${z.maxAcc} m).` : `Vous êtes à <b>${Math.round(z.dist)} m</b> du lieu (zone autorisée : ${site.rayon} m).`;
    modal(`<h3>Pointage impossible dans la zone</h3><p>${msg}</p><p class="sub">Rapprochez-vous du lieu et réessayez. Si vous êtes bien sur place, vous pouvez pointer « hors zone » : votre superviseur devra valider.</p>
      <label class="f">Motif (obligatoire pour pointer hors zone)<textarea id="why" rows="2" placeholder="Ex. portail fermé, GPS imprécis dans le bâtiment"></textarea></label>
      <div class="row"><button class="primary grow" data-act="retry" data-site="${site.id}" data-type="${type}">Réessayer</button><button class="grow" data-act="force" data-site="${site.id}" data-type="${type}" data-lat="${pos.lat}" data-lon="${pos.lon}" data-acc="${pos.acc}" data-t="${pos.t}" data-dist="${z.dist}">Pointer hors zone</button></div><button data-act="close" style="width:100%;margin-top:8px">Annuler</button>`);
  }
  async function record(site, type, pos, dist, zone, reason, mode) {
    const e = await SPC.makeEvent(db, cfg, { siteId: site.id, type, pos, dist, zone, mode, reason });
    await SPC.queueEvent(db, e); busy = false;
    nat(() => SPCNative.noteEvent(JSON.stringify({ siteId: site.id, type, t: e.t })));
    await refreshCounts();
    const state = navigator.onLine ? 'Envoi en cours…' : 'Enregistré sur le téléphone : il sera envoyé dès le retour de la connexion.';
    modal(`<h3>${type === 'IN' ? 'Arrivée' : 'Départ'} enregistré${type === 'IN' ? 'e' : ''} à ${hm(e.t)}</h3><p>${esc(site.nom)}${zone === 'in' ? ` : vous êtes à ${Math.round(dist)} m du lieu.` : ' : pointage hors zone, à valider par le superviseur.'}</p><p class="sub">${state}</p><button class="primary big" data-act="close">OK</button>`);
    render(); refresh();
  }
  async function force(d) {
    const why = ($('#why') || {}).value || '';
    if (why.trim().length < 4) { toast('Indiquez le motif du pointage hors zone'); return; }
    busy = true;
    await record(data.sites.find(s => s.id === d.site), d.type, { lat: +d.lat, lon: +d.lon, acc: +d.acc, t: +d.t }, +d.dist, 'out', why.trim(), 'gps');
  }

  /* ---------- détection automatique de l'arrivée (application ouverte) ---------- */
  function startWatch() {
    if (NAT || watchId != null || !cfg || cfg.auto === false || !navigator.geolocation || document.visibilityState !== 'visible') return;
    try { watchId = navigator.geolocation.watchPosition(onFix, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }); } catch (e) { /* ignoré */ }
  }
  function stopWatch() { if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; } }
  async function onFix(p) {
    lastFix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: p.timestamp };
    const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
    for (const { a, site } of todayList()) {
      const el = document.querySelector(`[data-dist="${site.id}"]`);
      const z = SPC.zone(site, lastFix);
      if (el) el.innerHTML = `À <b>${Math.round(z.dist)} m</b> du lieu · ${z.inside ? '<span class="chip ok">dans la zone</span>' : '<span class="chip warn">hors zone</span>'} <span class="sub">(±${Math.round(lastFix.acc)} m)</span>`;
      if (busy || (await eventsOf(site.id)).length) continue;
      const d0 = SPC.toMin(a.debut || '00:00'), d1 = SPC.toMin(a.fin || '23:59');
      if (mins < d0 - 60 || mins > d1) continue;
      if (!z.accOk) continue;
      if (z.inside) { counts[site.id] = (counts[site.id] || 0) + 1; if (counts[site.id] >= 2) { counts[site.id] = 0; busy = true; await record(site, 'IN', lastFix, z.dist, 'in', '', 'auto'); toast('Arrivée enregistrée automatiquement'); } }
      else counts[site.id] = 0;
    }
  }

  /* ---------- affichage ---------- */
  const chips = () => `<span class="chip ${navigator.onLine ? 'ok' : 'warn'}">${navigator.onLine ? 'En ligne' : 'Hors ligne'}</span>${pending ? ` <span class="chip warn">${pending} à envoyer</span>` : ''}`;
  function enrollView() {
    return `<header class="top"><img src="../shared/logo.png" alt="SPC"><b>SPC Pointage</b></header><main><div class="card"><h2>Activer cet appareil</h2><p class="sub">Ouvrez le lien d'activation envoyé par SPC, ou collez ici le code d'activation.</p>
      <label class="f">Code ou lien d'activation<textarea id="code" rows="4"></textarea></label><button class="primary big" data-act="enroll">Activer</button></div>
      <div class="card"><h3>Installer sur Android</h3><p class="sub">Dans Chrome : menu ⋮ puis « Ajouter à l'écran d'accueil ». L'application s'ouvrira ensuite comme une application normale, même sans connexion.</p></div></main>`;
  }
  async function todayView() {
    const list = todayList(), cards = [];
    for (const { a, site } of list) {
      const evs = await eventsOf(site.id), last = evs[evs.length - 1], inside = last && last.type === 'IN';
      const next = inside ? 'OUT' : 'IN';
      const first = evs.find(e => e.type === 'IN'), out = [...evs].reverse().find(e => e.type === 'OUT');
      const status = !evs.length ? '<span class="chip warn">Non pointé</span>' : inside ? `<span class="chip ok">En poste depuis ${hm(last.t)}</span>` : `<span class="chip">Terminé : ${hm(first.t)} à ${hm(out.t)}</span>`;
      cards.push(`<div class="card"><div class="row"><h3 class="grow">${esc(site.nom)}</h3>${status}</div><div class="sub">${esc(site.adresse || '')}</div><div class="sub">Horaires prévus : ${esc(a.debut || '')} à ${esc(a.fin || '')} · zone de ${site.rayon} m</div>
        <p class="dist2" data-dist="${site.id}">${lastFix ? '' : '<span class="sub">Recherche de votre position…</span>'}</p>
        <button class="primary big" data-act="punch" data-site="${site.id}" data-type="${next}">${next === 'IN' ? "Pointer mon arrivée" : "Pointer mon départ"}</button></div>`);
    }
    const drift = SPC.clockOffset != null && Math.abs(SPC.clockOffset) > 120000;
    return `${authError ? '<div class="banner bad">Le jeton d\'accès est refusé. Demandez un nouveau lien d\'activation à SPC. Vos pointages restent enregistrés sur le téléphone.</div>' : ''}
      ${drift ? '<div class="banner">L\'heure de votre téléphone semble incorrecte. Activez « Date et heure automatiques » dans les réglages Android.</div>' : ''}
      <div class="card"><div class="row"><div class="grow"><h2 style="margin:0">Bonjour ${esc(cfg.nom)}</h2><div class="sub">${esc(fdate(SPC.localDate()))}</div></div><div class="dist" id="clock">${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</div></div></div>
      ${cards.join('') || '<div class="card"><h3>Aucun lieu prévu aujourd\'hui</h3><p class="sub">Si vous devez travailler aujourd\'hui, contactez votre superviseur.</p></div>'}
      <p class="sub">${cfg.auto === false ? 'Pointage automatique désactivé.' : NAT ? "Détection automatique Android : l'arrivée et le départ sont détectés même quand l'application est fermée (voir Réglages)." : "Pointage automatique de l'arrivée : actif quand l'application est ouverte et que vous êtes dans la zone."}</p>`;
  }
  async function historyView() {
    const evs = (await db.all('events')).concat(nativeEvents()).filter(e => e.agentId === cfg.id).sort((a, b) => a.t < b.t ? 1 : -1).slice(0, 60);
    const name = id => (data.sites.find(s => s.id === id) || {}).nom || id;
    return `<div class="card"><h2>Mes pointages</h2>${evs.length ? `<div class="scroll"><table><thead><tr><th>Date</th><th>Heure</th><th></th><th>Lieu</th><th>État</th></tr></thead><tbody>${evs.map(e => `<tr><td>${esc(e.date)}</td><td>${hm(e.t)}</td><td>${e.type === 'IN' ? 'Arrivée' : 'Départ'}</td><td>${esc(name(e.siteId))}${e.zone === 'out' ? ' <span class="chip warn">hors zone</span>' : ''}${e.mode === 'auto' ? ' <span class="chip">auto</span>' : ''}${e.native ? ' <span class="chip">Android</span>' : ''}</td><td>${e.synced ? '<span class="chip ok">envoyé</span>' : '<span class="chip warn">en attente</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="sub">Aucun pointage sur cet appareil.</p>'}</div>`;
  }
  function nativeCard() {
    if (!NAT) return '';
    const p = nat(() => JSON.parse(SPCNative.permissions()), {}), ok = p.fine && p.background;
    const chip = (v, y, n) => `<span class="chip ${v ? 'ok' : 'warn'}">${v ? y : n}</span>`;
    return `<div class="card"><h3>Détection en arrière-plan (Android)</h3><p class="sub">L'application détecte votre arrivée sur le lieu et votre sortie même fermée, à partir des coordonnées enregistrées pour le lieu. Votre position n'est enregistrée qu'à l'arrivée et au départ.</p>
      <p>${chip(p.fine, 'Localisation précise', 'Localisation refusée')} ${chip(p.background, 'Toujours autorisée', 'Pas « toujours »')} ${chip(p.notifications, 'Notifications', 'Notifications refusées')} ${chip(p.battery, 'Batterie non limitée', 'Batterie limitée')}</p>
      <p class="sub">${p.geofences || 0} lieu(x) surveillé(s)${ok ? '' : ' : autorisez la localisation « tout le temps » pour activer la détection'}.</p>
      <div class="row"><button class="primary" data-act="natperm">Autoriser la détection</button><button data-act="natbat">Désactiver l'optimisation de batterie</button><button data-act="natset">Réglages Android</button></div></div>`;
  }
  function settingsView() {
    return nativeCard() + `<div class="card"><h2>Mon appareil</h2><p>${esc(cfg.nom)} <span class="sub">(${esc(cfg.id)})</span></p><p class="sub">Dernière synchronisation : ${lastSync ? new Date(lastSync).toLocaleString('fr-FR') : 'jamais'}${lastErr ? ' · dernier message : ' + esc(lastErr) : ''}</p>
      <div class="row"><button class="primary" data-act="sync">Synchroniser maintenant</button>${installEv ? '<button data-act="install">Installer l\'application</button>' : ''}</div></div>
      <div class="card"><h3>Pointage automatique</h3><p class="sub">${NAT ? "Android : l'arrivée est détectée à l'entrée dans la zone et le départ à la sortie (confirmé après un délai sans retour). Vous pouvez toujours pointer à la main." : "Quand l'application est ouverte, l'arrivée est enregistrée seule dès que vous êtes dans la zone du lieu. Le départ se pointe toujours à la main."}</p><button data-act="auto">${cfg.auto === false ? 'Activer' : 'Désactiver'}</button></div>
      <div class="card"><h3>Réinitialiser l'appareil</h3><p class="sub">Efface la configuration de ce téléphone${pending ? ` et ${pending} pointage(s) pas encore envoyé(s)` : ''}.</p><button class="danger" data-act="reset">Réinitialiser</button></div>`;
  }
  async function render() {
    const app = $('#app');
    if (!cfg) { app.innerHTML = enrollView(); return; }
    const body = tab === 'today' ? await todayView() : tab === 'hist' ? await historyView() : settingsView();
    app.innerHTML = `<header class="top"><img src="../shared/logo.png" alt="SPC"><b>SPC Pointage</b><span>${chips()}</span></header><main>${body}</main>
      <nav class="tabs">${[['today', "Aujourd'hui"], ['hist', 'Historique'], ['set', 'Réglages']].map(([k, l]) => `<button data-act="tab" data-tab="${k}"${tab === k ? ' aria-current="page"' : ''}>${l}</button>`).join('')}</nav>`;
    if (lastFix) for (const { site } of todayList()) { const el = document.querySelector(`[data-dist="${site.id}"]`); if (el) { const z = SPC.zone(site, lastFix); el.innerHTML = `À <b>${Math.round(z.dist)} m</b> du lieu · ${z.inside ? '<span class="chip ok">dans la zone</span>' : '<span class="chip warn">hors zone</span>'} <span class="sub">(±${Math.round(lastFix.acc)} m)</span>`; } }
  }

  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const d = b.dataset;
    switch (d.act) {
      case 'tab': tab = d.tab; render(); break;
      case 'punch': case 'retry': punch(d.site, d.type); break;
      case 'force': force(d); break;
      case 'close': busy = false; closeModal(); break;
      case 'natperm': nat(() => SPCNative.requestPermissions()); setTimeout(render, 4000); break;
      case 'natbat': nat(() => SPCNative.requestBatteryExemption()); break;
      case 'natset': nat(() => SPCNative.openAppSettings()); break;
      case 'sync': toast('Synchronisation…'); await refresh(); toast(pending ? pending + ' pointage(s) en attente' : 'Tout est à jour'); break;
      case 'auto': cfg.auto = cfg.auto === false; await db.set('kv', 'cfg', cfg); cfg.auto ? startWatch() : stopWatch(); pushNative(); render(); break;
      case 'install': if (installEv) { installEv.prompt(); installEv = null; render(); } break;
      case 'enroll': {
        const raw = ($('#code') || {}).value || ''; const m = raw.match(/enroll=([\w-]+)/) || raw.trim().match(/^([\w-]{20,})$/);
        try { await enroll(SPC.decJson(m[1])); data = { sites: [], assignments: [] }; await db.set('kv', 'data', data); render(); refresh(); startWatch(); } catch (er) { toast("Code d'activation invalide"); }
        break;
      }
      case 'reset': if (confirm("Réinitialiser cet appareil ? Les pointages non envoyés seront perdus.")) { for (const s of ['kv', 'events', 'outbox', 'cache']) for (const k of await db.keys(s)) await db.del(s, k); cfg = null; render(); } break;
    }
  });
  boot();
})();
