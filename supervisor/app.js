/* SPC Superviseur - suivi des équipes, enregistrement des lieux, validations */
(function () {
  'use strict';
  const { esc, toast, modal, closeModal, fdate, hm } = SPC;
  const $ = s => document.querySelector(s);
  const db = SPC.db('spc-superviseur');
  let cfg = null, D = { sites: [], assignments: [], agents: [], validations: [], events: [] }, tab = 'team', pending = 0, lastSync = '', syncing = false, lastErr = '', installEv = null, bsite = '', bmode = 'auto', bres = [], stream = null, scanning = false, localEv = [];
  const seen = new Map();

  async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    const m = location.hash.match(/enroll=([\w-]+)/);
    if (m) { try { await enroll(SPC.decJson(m[1])); } catch (e) { toast("Lien d'activation invalide"); } history.replaceState(null, '', location.pathname); }
    cfg = await db.get('kv', 'cfg'); D = (await db.get('kv', 'data')) || D; SPC.clockOffset = (await db.get('kv', 'offset')) ?? null;
    await counts(); render(); if (cfg) refresh();
    addEventListener('online', () => refresh()); addEventListener('offline', render);
    addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEv = e; render(); });
    setInterval(() => { if (cfg && navigator.onLine) refresh(); }, 90000);
  }
  async function enroll(c) {
    if (!c || !c.repo || !c.token || !c.agentId || !c.key) throw new Error('code');
    cfg = { id: c.agentId, nom: c.nom || c.agentId, role: 'superviseur', key: c.key, repo: c.repo, branch: c.branch || 'main', apiBase: c.apiBase || '', token: c.token };
    await db.set('kv', 'cfg', cfg);
  }
  async function counts() { localEv = await db.all('events'); pending = (await db.keys('outbox')).length; lastSync = (await db.get('kv', 'lastSync')) || ''; }

  async function refresh() {
    if (!cfg || syncing) return; syncing = true; lastErr = '';
    try {
      if (navigator.onLine) {
        const gh = SPC.gh(cfg), r0 = await SPC.sync(db, cfg); if (r0.err) lastErr = r0.err;
        const [sites, assignments, agents, validations] = await Promise.all(['sites', 'assignments', 'agents', 'validations'].map(d => SPC.pullDir(db, gh, d)));
        const events = [];
        for (let i = 0; i < 7; i++) { const dt = new Date(); dt.setDate(dt.getDate() - i); const date = SPC.localDate(dt); ((await SPC.pullDir(db, gh, 'pointages/' + date.slice(0, 7) + '/' + date)) || []).forEach(a => events.push(...(Array.isArray(a) ? a : []))); }
        const mine = (await db.all('events')).filter(e => !events.some(x => x.id === e.id)); // pointages manuels pas encore envoyés
        D = { sites: sites || D.sites, assignments: assignments || D.assignments, agents: agents || D.agents, validations: validations || D.validations, events: events.concat(mine) }; await db.set('kv', 'data', D);
      }
    } catch (e) { lastErr = e.code || e.message; }
    syncing = false; await counts(); render();
  }
  const siteName = id => (D.sites.find(s => s.id === id) || {}).nom || id;
  const agentName = id => (D.agents.find(a => a.id === id) || {}).nom || id;
  const myScope = () => { const mine = D.sites.filter(s => s.superviseurId === cfg.id).map(s => s.id); return mine.length ? mine : D.sites.map(s => s.id); };
  const validationOf = id => D.validations.find(v => v.eventId === id);

  function teamView() {
    const today = SPC.localDate(), scope = myScope();
    const rows = SPC.activeOn(D.assignments, today).filter(a => scope.includes(a.siteId)).map(a => {
      const evs = D.events.filter(e => e.agentId === a.agentId && e.siteId === a.siteId && e.date === today).sort((x, y) => x.t < y.t ? -1 : 1);
      const last = evs[evs.length - 1], first = evs.find(e => e.type === 'IN');
      const st = !evs.length ? '<span class="chip warn">Non pointé</span>' : last.type === 'IN' ? '<span class="chip ok">En poste</span>' : '<span class="chip">Parti</span>';
      return `<tr><td>${esc(agentName(a.agentId))}</td><td>${esc(siteName(a.siteId))}<div class="sub">${esc(a.debut || '')} à ${esc(a.fin || '')}</div></td><td>${first ? hm(first.t) : '-'}</td><td>${last && last.type === 'OUT' ? hm(last.t) : '-'}</td><td>${st}${evs.some(e => e.zone === 'out') ? ' <span class="chip warn">hors zone</span>' : ''}${evs.some(e => e.mode === 'manuel') ? ' <span class="chip">manuel</span>' : ''}</td></tr>`;
    });
    const todo = D.events.filter(e => e.zone === 'out' && !validationOf(e.id) && scope.includes(e.siteId)).sort((a, b) => a.t < b.t ? 1 : -1);
    return `<div class="card"><h2>Aujourd'hui</h2><div class="sub">${esc(fdate(today))}</div>${rows.length ? `<div class="scroll"><table><thead><tr><th>Agent</th><th>Lieu</th><th>Arrivée</th><th>Départ</th><th>État</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="sub">Aucune affectation prévue aujourd\'hui sur vos lieux.</p>'}</div>
      <div class="card"><h3>Pointages à valider (7 jours)</h3>${todo.length ? todo.map(e => `<div class="card" style="margin:8px 0"><b>${esc(agentName(e.agentId))}</b> · ${esc(siteName(e.siteId))}<div class="sub">${esc(e.date)} à ${hm(e.t)} · ${e.type === 'IN' ? 'arrivée' : 'départ'} · à ${e.dist} m (±${e.acc} m)</div><div>« ${esc(e.reason || 'sans motif')} »</div><div class="row" style="margin-top:8px"><button class="primary grow" data-act="valid" data-id="${e.id}" data-d="valide">Valider</button><button class="grow danger" data-act="valid" data-id="${e.id}" data-d="refuse">Refuser</button></div></div>`).join('') : '<p class="sub">Rien à valider.</p>'}</div>`;
  }
  /* ---------- pointage par badges : le chef d'équipe scanne les badges du groupe ---------- */
  const eventsToday = (agentId, siteId) => { const m = new Map(); D.events.concat(localEv).forEach(e => { if (e.agentId === agentId && e.siteId === siteId && e.date === SPC.localDate()) m.set(e.id, e); }); return [...m.values()].sort((a, b) => a.t < b.t ? -1 : 1); };
  const lastType = (agentId, siteId) => { const l = eventsToday(agentId, siteId); return l.length ? l[l.length - 1].type : null; };
  const modeLab = () => bmode === 'IN' ? 'arrivées seulement' : bmode === 'OUT' ? 'départs seulement' : 'arrivée puis départ automatiques';
  function badgesView() {
    const scope = myScope(), sites = D.sites.filter(s => scope.includes(s.id) && s.actif !== false);
    if (!bsite || !sites.some(s => s.id === bsite)) bsite = sites[0] ? sites[0].id : '';
    const team = SPC.activeOn(D.assignments, SPC.localDate()).filter(a => a.siteId === bsite);
    const rows = team.map(a => { const evs = eventsToday(a.agentId, bsite), last = evs[evs.length - 1], first = evs.find(e => e.type === 'IN');
      const st = !evs.length ? '<span class="chip warn">Non pointé</span>' : last.type === 'IN' ? `<span class="chip ok">En poste depuis ${hm(last.t)}</span>` : `<span class="chip">Parti à ${hm(last.t)}</span>`;
      return `<tr><td>${esc(agentName(a.agentId))}</td><td>${first ? hm(first.t) : '-'}</td><td>${st}${evs.some(e => e.mode === 'badge') ? ' <span class="chip">badge</span>' : ''}</td></tr>`; });
    return `<div class="card"><h2>Pointage par badges</h2><p class="sub">Placez-vous sur le lieu, choisissez le mode, puis scannez les badges des employés un par un.</p>
      <label class="f">Lieu<select id="bsite">${sites.map(s => `<option value="${s.id}"${s.id === bsite ? ' selected' : ''}>${esc(s.nom)}</option>`).join('')}</select></label>
      <label class="f">Mode<select id="bmode"><option value="auto"${bmode === 'auto' ? ' selected' : ''}>Automatique : arrivée puis départ</option><option value="IN"${bmode === 'IN' ? ' selected' : ''}>Arrivées seulement</option><option value="OUT"${bmode === 'OUT' ? ' selected' : ''}>Départs seulement</option></select></label>
      <button class="primary big" data-act="bscan"${bsite ? '' : ' disabled'}>Scanner les badges</button><div class="row" style="margin-top:8px;justify-content:center"><button data-act="bmanual">Saisir le code d'un badge</button></div></div>
      ${bres.length ? `<div class="card"><h3>Derniers pointages</h3>${bres.slice(0, 12).map(r => `<div class="row" style="padding:4px 0"><span class="chip ${r.ok ? 'ok' : 'bad'}">${r.ok ? 'OK' : 'Refusé'}</span><span class="grow">${esc(r.msg)}</span></div>`).join('')}</div>` : ''}
      <div class="card"><h3>Appel du jour</h3>${rows.length ? `<div class="scroll"><table><thead><tr><th>Agent</th><th>Arrivée</th><th>État</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : "<p class=\"sub\">Aucune affectation prévue aujourd'hui sur ce lieu.</p>"}</div>`;
  }
  function beep(ok) { try { const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator(); o.frequency.value = ok ? 880 : 220; o.connect(c.destination); o.start(); setTimeout(() => { o.stop(); c.close(); }, ok ? 120 : 320); } catch (e) { /* silence */ } if (navigator.vibrate) navigator.vibrate(ok ? 80 : [80, 60, 80]); }
  function feed(ok, msg) {
    bres.unshift({ ok, msg }); beep(ok);
    const el = document.getElementById('bfeed'); if (el) el.innerHTML = bres.slice(0, 6).map(r => `<div class="row" style="padding:3px 0"><span class="chip ${r.ok ? 'ok' : 'bad'}">${r.ok ? 'OK' : 'Refusé'}</span><span class="grow">${esc(r.msg)}</span></div>`).join('');
  }
  async function punchBadge(agent) {
    const last = lastType(agent.id, bsite), type = bmode === 'auto' ? (last === 'IN' ? 'OUT' : 'IN') : bmode;
    const planned = SPC.activeOn(D.assignments, SPC.localDate()).some(a => a.agentId === agent.id && a.siteId === bsite);
    const ev = await SPC.makeEvent(db, cfg, { agentId: agent.id, siteId: bsite, type, zone: 'badge', mode: 'badge', reason: planned ? '' : 'Hors planning' });
    await SPC.queueEvent(db, ev); localEv.push(ev);
    feed(true, `${agent.nom} : ${type === 'IN' ? 'arrivée' : 'départ'} à ${hm(ev.t)}${planned ? '' : ' (hors planning)'}`);
  }
  async function handleBadge(raw) {
    const now = Date.now(); if (seen.has(raw) && now - seen.get(raw) < 60000) return; seen.set(raw, now);
    const bad = m => { seen.set(raw, now - 52000); feed(false, m); };
    const p = SPC.badgeParse(raw);
    if (!p) return bad("Ce code n'est pas un badge SPC");
    const agent = D.agents.find(a => a.id === p.agentId);
    if (!agent) return bad('Badge inconnu de ce téléphone : synchronisez puis réessayez');
    if (agent.actif === false) return bad(agent.nom + ' : agent désactivé');
    if (!agent.badgeHash) return bad(agent.nom + ' : badge pas encore activé par le central');
    if (!(await SPC.badgeCheck(agent, p.code))) return bad(agent.nom + ' : badge invalide ou remplacé');
    await punchBadge(agent);
  }
  function stopCamera() { scanning = false; if (stream) { stream.getTracks().forEach(x => x.stop()); stream = null; } }
  async function finishScan() { stopCamera(); closeModal(); await counts(); render(); refresh(); }
  function openBadgeScanner() {
    if (!bsite) return toast('Aucun lieu disponible');
    bres = []; seen.clear();
    modal(`<h3>Scan des badges</h3><p class="sub">${esc(siteName(bsite))} · ${esc(modeLab())}</p><video id="bv" playsinline muted style="width:100%;max-height:38vh;border-radius:12px;background:#000"></video><div id="bfeed" style="margin:8px 0;max-height:24vh;overflow:auto"><span class="sub" id="bmsg">Présentez les badges devant la caméra, un par un.</span></div><div class="row"><button class="grow" data-act="bmanual">Saisir un code</button><button class="primary grow" data-act="bstop">Terminer</button></div>`);
    startBadgeCamera();
  }
  async function startBadgeCamera() {
    const msg = m => { const el = document.getElementById('bmsg'); if (el) el.innerHTML = m; };
    if (!('BarcodeDetector' in window)) return msg('Ce téléphone ne lit pas les codes QR dans le navigateur : utilisez « Saisir un code ».');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      const v = document.getElementById('bv'); if (!v) return stopCamera();
      v.srcObject = stream; await v.play(); const det = new BarcodeDetector({ formats: ['qr_code'] }); scanning = true;
      const loop = async () => { if (!scanning) return; try { for (const r of await det.detect(v)) await handleBadge(r.rawValue); } catch (e) { /* image pas prête */ } setTimeout(loop, 300); };
      loop();
    } catch (e) { msg(e && e.name === 'NotAllowedError' ? 'Caméra refusée : autorisez-la, ou utilisez « Saisir un code ».' : 'Caméra indisponible : utilisez « Saisir un code ».'); }
  }
  function openBadgeManual() {
    stopCamera();
    modal(`<h3>Saisir le code d'un badge</h3><p class="sub">Code de 16 caractères inscrit sur le badge.</p><label class="f">Code du badge<input id="bcode" autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX-XXXX"></label><div class="row"><button class="primary grow" data-act="bcode">Valider</button><button class="grow" data-act="bstop">Fermer</button></div>`);
  }
  async function badgeByCode() {
    const code = SPC.normCode((document.getElementById('bcode') || {}).value); if (code.length !== 16) return toast('Le code comporte 16 caractères');
    bres = [];
    for (const a of D.agents.filter(x => x.role === 'agent')) { if (await SPC.badgeCheck(a, code)) { seen.clear(); await punchBadge(a); await finishScan(); return; } }
    toast('Aucun badge ne correspond à ce code');
  }

  function sitesView() {
    return `<p class="sub">Les lieux et leurs codes QR sont gérés par le central. Pour pointer, les agents scannent le code QR affiché sur le lieu.</p>
      ${D.sites.map(s => `<div class="card"><div class="row"><h3 class="grow">${esc(s.nom)}</h3>${s.qrHash ? '<span class="chip ok">QR actif</span>' : '<span class="chip warn">QR en préparation</span>'}</div><div class="sub">${esc(s.adresse || '')}</div>${s.lat != null && s.lat !== '' ? `<div class="row" style="margin-top:8px"><a class="btn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=18/${s.lat}/${s.lon}">Voir sur la carte</a></div>` : ''}</div>`).join('') || '<div class="card"><p class="sub">Aucun lieu enregistré.</p></div>'}`;
  }
  function manualView() {
    const agents = D.agents.filter(a => a.role === 'agent' && a.actif !== false);
    return `<div class="card"><h2>Pointage manuel</h2><p class="sub">Pour un agent sans téléphone ou en panne. L'événement est signé à votre nom et marqué « manuel ».</p>
      <label class="f">Agent<select id="m_agent">${agents.map(a => `<option value="${a.id}">${esc(a.nom)}</option>`).join('')}</select></label>
      <label class="f">Lieu<select id="m_site">${D.sites.map(s => `<option value="${s.id}">${esc(s.nom)}</option>`).join('')}</select></label>
      <label class="f">Type<select id="m_type"><option value="IN">Arrivée</option><option value="OUT">Départ</option></select></label>
      <label class="f">Heure<input id="m_time" type="time" value="${new Date().toTimeString().slice(0, 5)}"></label>
      <label class="f">Motif (obligatoire)<textarea id="m_why" rows="2"></textarea></label>
      <button class="primary big" data-act="manual">Enregistrer le pointage</button></div>`;
  }
  function settingsView() {
    return `<div class="card"><h2>Mon appareil</h2><p>${esc(cfg.nom)} <span class="sub">(${esc(cfg.id)}, superviseur)</span></p><p class="sub">Dernière synchronisation : ${lastSync ? new Date(lastSync).toLocaleString('fr-FR') : 'jamais'}${lastErr ? ' · dernier message : ' + esc(lastErr) : ''}</p><div class="row"><button class="primary" data-act="sync">Synchroniser maintenant</button>${installEv ? '<button data-act="install">Installer l\'application</button>' : ''}</div></div>
      <div class="card"><h3>Réinitialiser</h3><p class="sub">Efface la configuration de ce téléphone${pending ? ` et ${pending} élément(s) pas encore envoyé(s)` : ''}.</p><button class="danger" data-act="reset">Réinitialiser</button></div>`;
  }
  function render() {
    const app = $('#app');
    if (!cfg) { app.innerHTML = `<header class="top"><img src="../shared/logo.png" alt="SPC"><b>SPC Superviseur</b></header><main><div class="card"><h2>Activer cet appareil</h2><p class="sub">Ouvrez le lien d'activation envoyé par SPC, ou collez ici le code.</p><label class="f">Code ou lien<textarea id="code" rows="4"></textarea></label><button class="primary big" data-act="enroll">Activer</button></div></main>`; return; }
    const body = tab === 'team' ? teamView() : tab === 'badges' ? badgesView() : tab === 'sites' ? sitesView() : tab === 'manual' ? manualView() : settingsView();
    app.innerHTML = `<header class="top"><img src="../shared/logo.png" alt="SPC"><b>SPC Superviseur</b><span><span class="chip ${navigator.onLine ? 'ok' : 'warn'}">${navigator.onLine ? 'En ligne' : 'Hors ligne'}</span>${pending ? ` <span class="chip warn">${pending} à envoyer</span>` : ''}</span></header><main>${body}</main>
      <nav class="tabs">${[['team', 'Équipe'], ['badges', 'Badges'], ['sites', 'Lieux'], ['manual', 'Manuel'], ['set', 'Réglages']].map(([k, l]) => `<button data-act="tab" data-tab="${k}"${tab === k ? ' aria-current="page"' : ''}>${l}</button>`).join('')}</nav>`;
  }

  document.addEventListener('change', e => { if (e.target.id === 'bsite') { bsite = e.target.value; render(); } if (e.target.id === 'bmode') { bmode = e.target.value; render(); } });
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return; const d = b.dataset;
    switch (d.act) {
      case 'tab': tab = d.tab; render(); break;
      case 'bscan': openBadgeScanner(); break;
      case 'bmanual': openBadgeManual(); break;
      case 'bcode': badgeByCode(); break;
      case 'bstop': await finishScan(); break;
      case 'close': stopCamera(); closeModal(); break;
      case 'sync': toast('Synchronisation…'); await refresh(); toast(pending ? pending + ' élément(s) en attente' : 'Tout est à jour'); break;
      case 'install': if (installEv) { installEv.prompt(); installEv = null; render(); } break;
      case 'valid': {
        const v = { eventId: d.id, decision: d.d, by: cfg.id, at: new Date().toISOString(), comment: '' };
        await SPC.queueFile(db, 'validations/' + d.id + '.json', v, 'create'); D.validations.push(v); await db.set('kv', 'data', D); await counts(); render(); toast(d.d === 'valide' ? 'Pointage validé' : 'Pointage refusé'); refresh(); break;
      }
      case 'manual': {
        const why = $('#m_why').value.trim(); if (why.length < 4) return toast('Le motif est obligatoire');
        const agentId = $('#m_agent').value, siteId = $('#m_site').value; if (!agentId || !siteId) return toast('Choisissez un agent et un lieu');
        const t = new Date(SPC.localDate() + 'T' + $('#m_time').value + ':00').toISOString();
        const ev = await SPC.makeEvent(db, cfg, { agentId, siteId, type: $('#m_type').value, t, zone: 'manual', mode: 'manuel', reason: why });
        await SPC.queueEvent(db, ev); $('#m_why').value = ''; await counts(); render(); toast('Pointage manuel enregistré'); refresh(); break;
      }
      case 'enroll': {
        const raw = ($('#code') || {}).value || ''; const m = raw.match(/enroll=([\w-]+)/) || raw.trim().match(/^([\w-]{20,})$/);
        try { await enroll(SPC.decJson(m[1])); render(); refresh(); } catch (er) { toast("Code d'activation invalide"); } break;
      }
      case 'reset': if (confirm('Réinitialiser cet appareil ? Les éléments non envoyés seront perdus.')) { for (const s of ['kv', 'events', 'outbox', 'cache']) for (const k of await db.keys(s)) await db.del(s, k); cfg = null; render(); } break;
    }
  });
  boot();
})();
