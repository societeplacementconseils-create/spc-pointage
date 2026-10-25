/* SPC Superviseur - suivi des équipes, enregistrement des lieux, validations */
(function () {
  'use strict';
  const { esc, toast, modal, closeModal, fdate, hm } = SPC;
  const $ = s => document.querySelector(s);
  const db = SPC.db('spc-superviseur');
  let cfg = null, D = { sites: [], assignments: [], agents: [], validations: [], events: [] }, tab = 'team', pending = 0, lastSync = '', syncing = false, lastErr = '', installEv = null;

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
  async function counts() { pending = (await db.keys('outbox')).length; lastSync = (await db.get('kv', 'lastSync')) || ''; }

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
    const body = tab === 'team' ? teamView() : tab === 'sites' ? sitesView() : tab === 'manual' ? manualView() : settingsView();
    app.innerHTML = `<header class="top"><img src="../shared/logo.png" alt="SPC"><b>SPC Superviseur</b><span><span class="chip ${navigator.onLine ? 'ok' : 'warn'}">${navigator.onLine ? 'En ligne' : 'Hors ligne'}</span>${pending ? ` <span class="chip warn">${pending} à envoyer</span>` : ''}</span></header><main>${body}</main>
      <nav class="tabs">${[['team', 'Équipe'], ['sites', 'Lieux'], ['manual', 'Manuel'], ['set', 'Réglages']].map(([k, l]) => `<button data-act="tab" data-tab="${k}"${tab === k ? ' aria-current="page"' : ''}>${l}</button>`).join('')}</nav>`;
  }

  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return; const d = b.dataset;
    switch (d.act) {
      case 'tab': tab = d.tab; render(); break;
      case 'close': closeModal(); break;
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
