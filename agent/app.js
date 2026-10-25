/* SPC Pointage - application de l'agent : pointage par scan du code QR du lieu */
(function () {
  'use strict';
  const { esc, toast, modal, closeModal, fdate, hm } = SPC;
  const $ = s => document.querySelector(s);
  const db = SPC.db('spc-agent');
  let cfg = null, data = { sites: [], assignments: [] }, tab = 'today', busy = false, stream = null, scanning = false;
  let pending = 0, lastSync = '', syncing = false, installEv = null, authError = false, lastErr = '';

  /* ---------- démarrage ---------- */
  async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    const m = location.hash.match(/enroll=([\w-]+)/);
    if (m) { try { await enroll(SPC.decJson(m[1])); } catch (e) { toast("Lien d'activation invalide"); } history.replaceState(null, '', location.pathname); }
    cfg = await db.get('kv', 'cfg');
    data = (await db.get('kv', 'data')) || data;
    SPC.clockOffset = (await db.get('kv', 'offset')) ?? null;
    await refreshCounts(); render();
    if (cfg) refresh();
    addEventListener('online', () => refresh()); addEventListener('offline', render);
    addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEv = e; render(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });
    setInterval(() => { if (cfg && navigator.onLine) refresh(); }, 60000);
    setInterval(() => { const c = $('#clock'); if (c) c.textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }, 10000);
  }
  async function enroll(c) {
    if (!c || !c.repo || !c.token || !c.agentId || !c.key) throw new Error('code');
    cfg = { id: c.agentId, nom: c.nom || c.agentId, role: c.role || 'agent', key: c.key, repo: c.repo, branch: c.branch || 'main', apiBase: c.apiBase || '', token: c.token };
    await db.set('kv', 'cfg', cfg);
  }
  async function refreshCounts() { pending = (await db.keys('outbox')).length; lastSync = (await db.get('kv', 'lastSync')) || ''; }

  /* ---------- données et synchronisation ---------- */
  async function refresh() {
    if (!cfg || syncing) return; syncing = true; lastErr = '';
    try {
      if (navigator.onLine) {
        const gh = SPC.gh(cfg);
        const [sites, asg] = await Promise.all([SPC.pullDir(db, gh, 'sites'), SPC.pullDir(db, gh, 'assignments')]);
        data = { sites: sites || data.sites, assignments: asg || data.assignments }; await db.set('kv', 'data', data);
        const r = await SPC.sync(db, cfg); if (r.err) lastErr = r.err; authError = r.err === 'auth';
      }
    } catch (e) { lastErr = e.code || e.message; authError = e.code === 'auth'; }
    syncing = false; await refreshCounts(); render();
  }
  const todayList = () => SPC.activeOn(data.assignments.filter(a => a.agentId === cfg.id), SPC.localDate()).map(a => ({ a, site: data.sites.find(s => s.id === a.siteId) })).filter(x => x.site && x.site.actif !== false);
  const eventsOf = async (siteId, date) => (await db.all('events')).filter(e => e.agentId === cfg.id && e.date === (date || SPC.localDate()) && (!siteId || e.siteId === siteId)).sort((a, b) => a.t < b.t ? -1 : 1);

  /* ---------- scan du code QR ---------- */
  function stopCamera() { scanning = false; if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }
  const scanMsg = m => { const el = $('#scanmsg'); if (el) el.innerHTML = m; };
  function openScanner() {
    if (busy) return;
    modal(`<h3>Scannez le code du lieu</h3><video id="scanv" playsinline muted style="width:100%;max-height:50vh;border-radius:12px;background:#000"></video><p class="sub" id="scanmsg">Visez le code QR affiché sur le lieu de travail.</p><div class="row"><button class="grow" data-act="manual">Saisir le code</button><button class="grow" data-act="close">Annuler</button></div>`);
    startCamera();
  }
  async function startCamera() {
    if (!('BarcodeDetector' in window)) return scanMsg("Ce téléphone ne lit pas les codes QR dans le navigateur. Touchez <b>Saisir le code</b> et tapez le code inscrit sous le QR.");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      const v = $('#scanv'); if (!v) return stopCamera();
      v.srcObject = stream; await v.play();
      const det = new BarcodeDetector({ formats: ['qr_code'] }); scanning = true;
      const loop = async () => {
        if (!scanning) return;
        try { const r = await det.detect(v); if (r.length) { stopCamera(); await handleText(r[0].rawValue); return; } } catch (e) { /* image pas prête */ }
        setTimeout(loop, 250);
      };
      loop();
    } catch (e) { scanMsg(e && e.name === 'NotAllowedError' ? "L'accès à la caméra est refusé. Autorisez la caméra pour SPC Pointage, ou touchez <b>Saisir le code</b>." : "La caméra est indisponible. Touchez <b>Saisir le code</b>."); }
  }
  function openManual() {
    stopCamera();
    modal(`<h3>Saisir le code du lieu</h3><p class="sub">Tapez le code de secours inscrit sous le QR (16 caractères).</p><label class="f">Code du lieu<input id="mcode" autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX-XXXX"></label><div class="row"><button class="primary grow" data-act="mvalid">Valider</button><button class="grow" data-act="close">Annuler</button></div>`);
  }
  function problem(msg) {
    modal(`<h3>Pointage impossible</h3><p>${msg}</p><div class="row"><button class="primary grow" data-act="scan">Réessayer</button><button class="grow" data-act="close">Fermer</button></div>`);
  }
  async function handleText(text) {
    const p = SPC.qrParse(text);
    if (!p) return problem("Ce code n'est pas un code SPC. Scannez le code affiché sur le lieu de travail.");
    const known = data.sites.find(s => s.id === p.siteId);
    if (!known) return problem("Ce lieu n'est pas connu de votre téléphone. Connectez-vous à Internet puis réessayez, ou contactez SPC.");
    if (!known.qrHash) return problem("Le code QR de ce lieu n'est pas encore activé. Contactez le central SPC.");
    if (!(await SPC.qrCheck(known, p.code))) return problem("Code invalide ou périmé : il a peut-être été remplacé. Demandez le nouveau code au superviseur.");
    if (!todayList().some(x => x.site.id === known.id)) return problem(`Le lieu « ${esc(known.nom)} » n'est pas dans votre planning aujourd'hui. Si vous devez y travailler, prévenez votre superviseur.`);
    await confirmPunch(known);
  }
  async function manualCheck() {
    const code = SPC.normCode(($('#mcode') || {}).value);
    if (code.length !== 16) return toast('Le code comporte 16 caractères');
    for (const { site } of todayList()) { if (await SPC.qrCheck(site, code)) return confirmPunch(site); }
    problem("Ce code ne correspond à aucun de vos lieux d'aujourd'hui. Vérifiez la saisie (le code est sur l'affiche du lieu).");
  }
  async function confirmPunch(site) {
    const evs = await eventsOf(site.id), inside = evs.length && evs[evs.length - 1].type === 'IN', next = inside ? 'OUT' : 'IN', other = inside ? 'IN' : 'OUT';
    const lab = t => t === 'IN' ? "l'arrivée" : 'le départ';
    modal(`<h3>${esc(site.nom)}</h3><p>Il est <b>${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</b>. Confirmez-vous ${lab(next)} ?</p>
      <button class="primary big" data-act="confirm" data-site="${site.id}" data-type="${next}">Confirmer ${lab(next)}</button>
      <div class="row" style="margin-top:10px"><button class="grow" data-act="confirm" data-site="${site.id}" data-type="${other}">Plutôt ${lab(other)}</button><button class="grow" data-act="close">Annuler</button></div>`);
  }
  async function punch(siteId, type) {
    if (busy) return; busy = true;
    const site = data.sites.find(s => s.id === siteId);
    modal(`<h3>Enregistrement…</h3>`);
    const pos = await SPC.quickPos(3500);
    const dist = pos && site.lat != null && site.lon != null ? SPC.dist(pos.lat, pos.lon, site.lat, site.lon) : null;
    const e = await SPC.makeEvent(db, cfg, { siteId, type, pos: pos || undefined, dist, zone: 'qr', mode: 'qr', reason: '' });
    await SPC.queueEvent(db, e); busy = false; await refreshCounts();
    modal(`<h3>${type === 'IN' ? 'Arrivée' : 'Départ'} enregistré${type === 'IN' ? 'e' : ''} à ${hm(e.t)}</h3><p>${esc(site.nom)}</p><p class="sub">${navigator.onLine ? 'Envoi en cours…' : 'Enregistré sur le téléphone : il sera envoyé dès le retour de la connexion.'}</p><button class="primary big" data-act="close">OK</button>`);
    render(); refresh();
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
      const first = evs.find(e => e.type === 'IN'), out = [...evs].reverse().find(e => e.type === 'OUT');
      const status = !evs.length ? '<span class="chip warn">Non pointé</span>' : inside ? `<span class="chip ok">En poste depuis ${hm(last.t)}</span>` : `<span class="chip">Terminé : ${hm(first.t)} à ${hm(out.t)}</span>`;
      cards.push(`<div class="card"><div class="row"><h3 class="grow">${esc(site.nom)}</h3>${status}</div><div class="sub">${esc(site.adresse || '')}</div><div class="sub">Horaires prévus : ${esc(a.debut || '')} à ${esc(a.fin || '')}</div>${site.qrHash ? '' : '<div class="chip warn" style="margin-top:6px">Code QR pas encore activé</div>'}</div>`);
    }
    const drift = SPC.clockOffset != null && Math.abs(SPC.clockOffset) > 120000;
    return `${authError ? '<div class="banner bad">Le jeton d\'accès est refusé. Demandez un nouveau lien d\'activation à SPC. Vos pointages restent enregistrés sur le téléphone.</div>' : ''}
      ${drift ? '<div class="banner">L\'heure de votre téléphone semble incorrecte. Activez « Date et heure automatiques » dans les réglages Android.</div>' : ''}
      <div class="card"><div class="row"><div class="grow"><h2 style="margin:0">Bonjour ${esc(cfg.nom)}</h2><div class="sub">${esc(fdate(SPC.localDate()))}</div></div><div class="dist" id="clock">${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</div></div></div>
      <div class="card"><button class="primary big" data-act="scan">Scanner le code QR du lieu</button><div class="row" style="margin-top:10px;justify-content:center"><button data-act="manual">Saisir le code à la place</button></div><p class="sub" style="margin:10px 0 0;text-align:center">Scannez à votre arrivée, puis à votre départ. Cela fonctionne aussi sans connexion.</p></div>
      ${cards.join('') || '<div class="card"><h3>Aucun lieu prévu aujourd\'hui</h3><p class="sub">Si vous devez travailler aujourd\'hui, contactez votre superviseur.</p></div>'}`;
  }
  async function historyView() {
    const evs = (await db.all('events')).filter(e => e.agentId === cfg.id).sort((a, b) => a.t < b.t ? 1 : -1).slice(0, 60);
    const name = id => (data.sites.find(s => s.id === id) || {}).nom || id;
    return `<div class="card"><h2>Mes pointages</h2>${evs.length ? `<div class="scroll"><table><thead><tr><th>Date</th><th>Heure</th><th></th><th>Lieu</th><th>État</th></tr></thead><tbody>${evs.map(e => `<tr><td>${esc(e.date)}</td><td>${hm(e.t)}</td><td>${e.type === 'IN' ? 'Arrivée' : 'Départ'}</td><td>${esc(name(e.siteId))}${e.mode === 'qr' ? ' <span class="chip">QR</span>' : ''}${e.mode === 'manuel' ? ' <span class="chip warn">manuel</span>' : ''}</td><td>${e.synced ? '<span class="chip ok">envoyé</span>' : '<span class="chip warn">en attente</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="sub">Aucun pointage sur cet appareil.</p>'}</div>`;
  }
  function settingsView() {
    return `<div class="card"><h2>Mon appareil</h2><p>${esc(cfg.nom)} <span class="sub">(${esc(cfg.id)})</span></p><p class="sub">Dernière synchronisation : ${lastSync ? new Date(lastSync).toLocaleString('fr-FR') : 'jamais'}${lastErr ? ' · dernier message : ' + esc(lastErr) : ''}</p>
      <div class="row"><button class="primary" data-act="sync">Synchroniser maintenant</button>${installEv ? '<button data-act="install">Installer l\'application</button>' : ''}</div></div>
      <div class="card"><h3>Comment pointer</h3><p class="sub">Un code QR est affiché sur chaque lieu de travail. Touchez « Scanner le code QR du lieu », visez le code, puis confirmez. Si la caméra ne fonctionne pas, saisissez le code de secours inscrit sous le QR.</p></div>
      <div class="card"><h3>Réinitialiser l'appareil</h3><p class="sub">Efface la configuration de ce téléphone${pending ? ` et ${pending} pointage(s) pas encore envoyé(s)` : ''}.</p><button class="danger" data-act="reset">Réinitialiser</button></div>`;
  }
  async function render() {
    const app = $('#app');
    if (!cfg) { app.innerHTML = enrollView(); return; }
    const body = tab === 'today' ? await todayView() : tab === 'hist' ? await historyView() : settingsView();
    app.innerHTML = `<header class="top"><img src="../shared/logo.png" alt="SPC"><b>SPC Pointage</b><span>${chips()}</span></header><main>${body}</main>
      <nav class="tabs">${[['today', "Aujourd'hui"], ['hist', 'Historique'], ['set', 'Réglages']].map(([k, l]) => `<button data-act="tab" data-tab="${k}"${tab === k ? ' aria-current="page"' : ''}>${l}</button>`).join('')}</nav>`;
  }

  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const d = b.dataset;
    switch (d.act) {
      case 'tab': tab = d.tab; render(); break;
      case 'scan': openScanner(); break;
      case 'manual': openManual(); break;
      case 'mvalid': manualCheck(); break;
      case 'confirm': punch(d.site, d.type); break;
      case 'close': stopCamera(); busy = false; closeModal(); break;
      case 'sync': toast('Synchronisation…'); await refresh(); toast(pending ? pending + ' pointage(s) en attente' : 'Tout est à jour'); break;
      case 'install': if (installEv) { installEv.prompt(); installEv = null; render(); } break;
      case 'enroll': {
        const raw = ($('#code') || {}).value || ''; const m = raw.match(/enroll=([\w-]+)/) || raw.trim().match(/^([\w-]{20,})$/);
        try { await enroll(SPC.decJson(m[1])); data = { sites: [], assignments: [] }; await db.set('kv', 'data', data); render(); refresh(); } catch (er) { toast("Code d'activation invalide"); }
        break;
      }
      case 'reset': if (confirm("Réinitialiser cet appareil ? Les pointages non envoyés seront perdus.")) { for (const s of ['kv', 'events', 'outbox', 'cache']) for (const k of await db.keys(s)) await db.del(s, k); cfg = null; render(); } break;
    }
  });
  boot();
})();
