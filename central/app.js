/* SPC Central - gestion des agents, des lieux, des affectations et contrôle des pointages */
(function () {
  'use strict';
  const { esc, toast, modal, closeModal, fdate, hm } = SPC;
  const $ = s => document.querySelector(s);
  const db = SPC.db('spc-central');
  let cfg = null, keys = {}, D = emptyD(), tab = 'day', day = SPC.localDate(), month = SPC.localDate().slice(0, 7), loading = false, lastErr = '', pending = 0, lastSync = '', V = null;
  function emptyD() { return { agents: [], sites: [], assignments: [], validations: [], events: [], deleted: [] }; }

  /* ---------- démarrage ---------- */
  async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    cfg = await db.get('kv', 'cfg'); keys = (await db.get('kv', 'keys')) || {}; D = (await db.get('kv', 'data')) || D;
    await counts(); await verify(); render(); if (cfg) load();
    addEventListener('online', () => load()); addEventListener('offline', render);
  }
  async function counts() { pending = (await db.keys('outbox')).length; lastSync = (await db.get('kv', 'lastSync')) || ''; }

  /* ---------- chargement du dépôt (arbre Git + cache par empreinte) ---------- */
  async function load() {
    if (!cfg || loading) return; loading = true; lastErr = ''; render();
    try {
      if (navigator.onLine) {
        const gh = SPC.gh(cfg), r = await SPC.sync(db, cfg); if (r.err) lastErr = r.err;
        const tree = (await gh.tree()).filter(x => x.type === 'blob' && /^(agents|sites|assignments|validations|pointages)\/.+\.json$/.test(x.path));
        const out = { agents: [], sites: [], assignments: [], validations: [], events: [], deleted: [] };
        for (const t of tree) {
          let j; const ck = await db.get('cache', 'f:' + t.path);
          if (ck && ck.sha === t.sha) j = ck.json; else { const f = await gh.get(t.path); if (!f) continue; j = f.json; await db.set('cache', 'f:' + t.path, { sha: f.sha, json: j }); }
          const top = t.path.split('/')[0];
          if (top === 'pointages') (Array.isArray(j) ? j : []).forEach(e => out.events.push(Object.assign({}, e, { _path: t.path })));
          else if (top === 'validations') out.validations.push(j); else out[top].push(j);
        }
        const seen = (await db.get('kv', 'seen')) || {}, now = new Set(out.events.map(e => e.id));
        out.deleted = Object.values(seen).filter(s => !now.has(s.id));
        out.events.forEach(e => { seen[e.id] = { id: e.id, agentId: e.agentId, date: e.date, type: e.type, t: e.t }; });
        await db.set('kv', 'seen', seen);
        D = out; await db.set('kv', 'data', D);
      }
    } catch (e) { lastErr = e.code === 'auth' ? 'Jeton refusé par GitHub' : (e.message || e.code); }
    loading = false; await counts(); await verify(); render();
  }

  /* ---------- vérification des signatures, des chaînes et des anomalies ---------- */
  async function verify() {
    const flags = {}, add = (id, k, sev) => { (flags[id] = flags[id] || []).push({ k, sev }); };
    const bySigner = {};
    for (const e of D.events) {
      const h = await SPC.sha256(SPC.canon(e));
      if (h !== e.hash) add(e.id, 'Empreinte modifiée', 'bad');
      else {
        const ks = keys[e.signerId] || []; let ok = false;
        for (const k of ks) { if (await SPC.hmac(k, e.hash) === e.sig) { ok = true; break; } }
        if (!ks.length) add(e.id, 'Clé inconnue', 'warn'); else if (!ok) add(e.id, 'Signature invalide', 'bad');
      }
      if (e.zone === 'out') { const v = D.validations.find(x => x.eventId === e.id); add(e.id, v ? (v.decision === 'valide' ? 'Hors zone validé' : 'Hors zone refusé') : 'Hors zone à valider', v ? (v.decision === 'valide' ? 'ok' : 'bad') : 'warn'); }
      if (e.drift != null && Math.abs(e.drift) > 120000) add(e.id, 'Horloge du téléphone décalée', 'warn');
      if (e.tGps && Math.abs(new Date(e.t) - new Date(e.tGps)) > 120000 && e.mode !== 'manuel') add(e.id, 'Heure ≠ heure GPS', 'warn');
      if (e.mode === 'manuel') add(e.id, 'Pointage manuel', 'warn');
      if (e.src === 'native' && e.mode === 'auto') add(e.id, 'Détection automatique (Android)', 'ok');
      (bySigner[e.signerId + '|' + (e.src || '')] = bySigner[e.signerId + '|' + (e.src || '')] || []).push(e);
    }
    for (const list of Object.values(bySigner)) {
      list.sort((a, b) => a.t < b.t ? -1 : 1); let prev = 'GENESIS';
      for (const e of list) { if (e.prev !== prev) add(e.id, 'Chaîne interrompue (pointage manquant ou réinstallation)', 'warn'); prev = e.hash; }
    }
    V = { flags };
  }
  const flagsOf = id => (V && V.flags[id]) || [];
  const chip = f => `<span class="chip ${f.sev}">${esc(f.k)}</span>`;

  /* ---------- calcul des journées ---------- */
  const settings = () => Object.assign({ pause: 1, retard: 5 }, cfg && cfg.settings);
  function dayRows(date) {
    const rows = [], used = new Set();
    for (const a of SPC.activeOn(D.assignments, date)) {
      const evs = D.events.filter(e => e.agentId === a.agentId && e.siteId === a.siteId && e.date === date).sort((x, y) => x.t < y.t ? -1 : 1);
      evs.forEach(e => used.add(e.id)); rows.push(rowOf(a, evs, date));
    }
    const extra = D.events.filter(e => e.date === date && !used.has(e.id));
    const g = {}; extra.forEach(e => (g[e.agentId + '|' + e.siteId] = g[e.agentId + '|' + e.siteId] || []).push(e));
    Object.values(g).forEach(evs => rows.push(rowOf(null, evs.sort((x, y) => x.t < y.t ? -1 : 1), date, evs[0].agentId, evs[0].siteId)));
    return rows;
  }
  function rowOf(a, evs, date, agentId, siteId) {
    const S = settings(), r = { agentId: a ? a.agentId : agentId, siteId: a ? a.siteId : siteId, a, evs, date, hours: 0, retard: 0, flags: [], state: '' };
    let span = 0, segs = 0, open = null;
    for (const e of evs) { if (e.type === 'IN') { if (!open) open = e; } else if (e.type === 'OUT' && open) { span += (new Date(e.t) - new Date(open.t)) / 3600000; segs++; open = null; } }
    r.first = evs.find(e => e.type === 'IN'); r.lastOut = [...evs].reverse().find(e => e.type === 'OUT'); r.open = !!open;
    r.hours = segs === 1 && span >= 6 ? Math.max(0, span - S.pause) : span;
    if (a && r.first && a.debut) { const m = new Date(r.first.t); r.retard = Math.max(0, m.getHours() * 60 + m.getMinutes() - SPC.toMin(a.debut)); }
    evs.forEach(e => flagsOf(e.id).forEach(f => { if (!r.flags.some(x => x.k === f.k)) r.flags.push(f); }));
    const today = SPC.localDate(), nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    if (!evs.length) r.state = date < today || (date === today && a && nowMin > SPC.toMin(a.fin || '23:59')) ? 'Absent (non pointé)' : 'Pas encore pointé';
    else if (open) r.state = date < today || (a && nowMin > SPC.toMin(a.fin || '23:59') + 60) ? 'Départ non pointé' : 'En poste';
    else r.state = 'Présent';
    return r;
  }
  const agentName = id => (D.agents.find(a => a.id === id) || {}).nom || id;
  const site = id => D.sites.find(s => s.id === id) || {};
  const h1 = n => (Math.round(n * 10) / 10).toString().replace('.', ',') + ' h';
  const stChip = r => `<span class="chip ${r.state === 'Présent' || r.state === 'En poste' ? 'ok' : r.state.startsWith('Pas encore') ? '' : 'warn'}">${esc(r.state)}</span>`;

  /* ---------- vues ---------- */
  function dayView() {
    const rows = dayRows(day), pres = rows.filter(r => r.evs.length).length;
    const alerts = D.events.filter(e => flagsOf(e.id).some(f => f.sev === 'bad')).length;
    return `<div class="row" style="margin-bottom:10px"><label class="f grow" style="margin:0">Jour<input type="date" id="day" value="${day}"></label><button data-act="reload">Actualiser</button></div>
      <div class="kpi"><div><b>${rows.length}</b><span class="sub">Lignes du jour</span></div><div><b>${pres}</b><span class="sub">Agents pointés</span></div><div><b>${rows.filter(r => r.state.startsWith('Absent')).length}</b><span class="sub">Absents</span></div><div><b>${alerts}</b><span class="sub">Alertes graves (toutes dates)</span></div></div>
      ${D.deleted.length ? `<div class="banner bad"><b>${D.deleted.length} pointage(s) déjà vus ont disparu du dépôt.</b> Vérifiez l'historique des modifications sur GitHub.</div>` : ''}
      <div class="card scroll"><table><thead><tr><th>Agent</th><th>Lieu</th><th>Prévu</th><th>Arrivée</th><th>Départ</th><th>Heures</th><th>Retard</th><th>Distance</th><th>État</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(agentName(r.agentId))}</td><td>${esc(site(r.siteId).nom || r.siteId)}${r.a ? '' : ' <span class="chip warn">hors planning</span>'}</td><td>${r.a ? esc((r.a.debut || '') + ' à ' + (r.a.fin || '')) : '-'}</td><td>${r.first ? hm(r.first.t) : '-'}</td><td>${r.lastOut ? hm(r.lastOut.t) : '-'}</td><td>${r.evs.length ? h1(r.hours) : '-'}</td><td>${r.retard > settings().retard ? r.retard + ' min' : '-'}</td><td>${r.first && r.first.dist != null ? r.first.dist + ' m' : '-'}</td><td>${stChip(r)} ${r.flags.map(chip).join(' ')}</td></tr>`).join('') || '<tr><td colspan="9" class="sub">Aucune affectation ni pointage ce jour.</td></tr>'}</tbody></table></div>`;
  }
  function monthStats(m) {
    const [Y, M] = m.split('-').map(Number), nd = new Date(Y, M, 0).getDate(), per = {}, entries = [];
    for (let i = 1; i <= nd; i++) {
      const date = m + '-' + String(i).padStart(2, '0');
      for (const r of dayRows(date)) {
        const p = per[r.agentId] = per[r.agentId] || { jours: 0, prevus: 0, heures: 0, retards: 0, alertes: 0 };
        if (r.a) p.prevus++;
        if (r.evs.length) { p.jours++; p.heures += r.hours; if (r.retard > settings().retard) p.retards++; }
        p.alertes += r.flags.filter(f => f.sev !== 'ok').length;
        const s = site(r.siteId);
        if (!r.evs.length && !r.state.startsWith('Absent')) continue;
        entries.push({ date, agentCode: r.agentId, agentNom: agentName(r.agentId), siteId: r.siteId, siteNom: s.nom || '', clientRef: s.clientRef || '', arr: r.first ? hm(r.first.t) : '', dep: r.lastOut ? hm(r.lastOut.t) : '', heures: Math.round(r.hours * 100) / 100, retardMin: r.retard, absent: !r.evs.length && r.state.startsWith('Absent'), etat: r.state, alertes: r.flags.filter(f => f.sev !== 'ok').map(f => f.k), eventIds: r.evs.map(e => e.id) });
      }
    }
    return { per, entries };
  }
  function monthView() {
    const { per } = monthStats(month);
    return `<div class="row" style="margin-bottom:10px"><label class="f grow" style="margin:0">Mois<input type="month" id="month" value="${month}"></label><button data-act="csv">Exporter CSV</button><button class="primary" data-act="json">Exporter pour l'application SPC</button></div>
      <div class="card scroll"><table><thead><tr><th>Agent</th><th>Jours prévus</th><th>Jours pointés</th><th>Heures</th><th>Retards</th><th>Alertes</th></tr></thead><tbody>${Object.entries(per).map(([id, p]) => `<tr><td>${esc(agentName(id))}</td><td>${p.prevus}</td><td>${p.jours}</td><td>${h1(p.heures)}</td><td>${p.retards}</td><td>${p.alertes}</td></tr>`).join('') || '<tr><td colspan="6" class="sub">Aucune donnée ce mois.</td></tr>'}</tbody></table></div>
      <p class="sub">L'export « application SPC » se charge dans l'application de gestion (Rapport journalier) : une ligne par agent, lieu et jour.</p>`;
  }
  function agentsView() {
    return `<div class="row" style="margin-bottom:10px"><button class="primary grow" data-act="newagent">Nouvel agent ou superviseur</button></div>
      ${D.agents.map(a => `<div class="card"><div class="row"><h3 class="grow">${esc(a.nom)}</h3><span class="chip">${a.role === 'superviseur' ? 'Superviseur' : 'Agent'}</span>${a.actif === false ? '<span class="chip bad">inactif</span>' : ''}</div><div class="sub">${esc(a.id)} · ${esc(a.tel || '')}${keys[a.id] ? '' : ' · <b>clé absente sur cet appareil</b>'}</div>
        <div class="row" style="margin-top:8px"><button data-act="link" data-id="${a.id}">Lien d'activation</button><button data-act="rekey" data-id="${a.id}">Nouvelle clé</button><button data-act="toggleagent" data-id="${a.id}">${a.actif === false ? 'Réactiver' : 'Désactiver'}</button></div></div>`).join('') || '<div class="card"><p class="sub">Aucun agent.</p></div>'}`;
  }
  function sitesView() {
    return `<div class="row" style="margin-bottom:10px"><button class="primary grow" data-act="newsite">Nouveau lieu</button></div>
      ${D.sites.map(s => `<div class="card"><div class="row"><h3 class="grow">${esc(s.nom)}</h3>${s.actif === false ? '<span class="chip bad">inactif</span>' : ''}</div><div class="sub">${esc(s.adresse || '')} · client ${esc(s.clientRef || '-')}</div><div class="sub">Zone ${s.rayon} m · ${s.lat}, ${s.lon} (±${s.acc || '?'} m)</div><div class="row" style="margin-top:8px"><a class="btn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=18/${s.lat}/${s.lon}">Carte</a><button data-act="editsite" data-id="${s.id}">Modifier</button><button data-act="togglesite" data-id="${s.id}">${s.actif === false ? 'Réactiver' : 'Désactiver'}</button></div></div>`).join('') || '<div class="card"><p class="sub">Aucun lieu. Les superviseurs peuvent aussi les enregistrer sur place.</p></div>'}`;
  }
  function assignView() {
    return `<div class="row" style="margin-bottom:10px"><button class="primary grow" data-act="newasg">Nouvelle affectation</button></div>
      <div class="card scroll"><table><thead><tr><th>Agent</th><th>Lieu</th><th>Jours</th><th>Horaires</th><th>Période</th><th></th></tr></thead><tbody>${D.assignments.map(a => `<tr><td>${esc(agentName(a.agentId))}</td><td>${esc(site(a.siteId).nom || a.siteId)}</td><td>${(a.jours || []).map(j => SPC.JOURS[j - 1]).join(' ')}</td><td>${esc(a.debut || '')} à ${esc(a.fin || '')}</td><td>${esc(a.du || '')} ${a.au ? '→ ' + esc(a.au) : ''}</td><td><button data-act="editasg" data-id="${a.id}">Modifier</button></td></tr>`).join('') || '<tr><td colspan="6" class="sub">Aucune affectation.</td></tr>'}</tbody></table></div>`;
  }
  function settingsView() {
    return `<div class="card"><h2>Connexion au dépôt de données</h2><p class="sub">${cfg ? esc(cfg.repo) + ' · branche ' + esc(cfg.branch) : ''}</p>
      <p class="sub">Dernière synchronisation : ${lastSync ? new Date(lastSync).toLocaleString('fr-FR') : 'jamais'}${pending ? ` · ${pending} modification(s) à envoyer` : ''}${lastErr ? ' · ' + esc(lastErr) : ''}</p>
      <div class="row"><button class="primary" data-act="reload">Synchroniser</button><button data-act="config">Modifier la connexion</button></div></div>
      <div class="card"><h3>Règles de calcul</h3><label class="f">Pause quotidienne déduite (heures, journée d'un seul tenant de 6 h ou plus)<input id="set_pause" type="number" step="0.5" min="0" value="${settings().pause}"></label><label class="f">Tolérance de retard (minutes)<input id="set_retard" type="number" min="0" value="${settings().retard}"></label><button data-act="saveset">Enregistrer</button></div>
      <div class="card"><h3>Sauvegarde des clés de signature</h3><p class="sub">Les clés ne sont stockées que sur cet appareil (jamais sur GitHub). Sans elles, les signatures des pointages ne peuvent plus être vérifiées. Exportez-les et gardez le fichier en lieu sûr.</p><div class="row"><button data-act="exportkeys">Exporter les clés</button><label class="btn">Importer des clés<input type="file" id="keyfile" accept=".json" style="display:none"></label></div></div>`;
  }
  function setupView() {
    return `<header class="top"><img src="../shared/logo.png" alt="SPC"><b>SPC Central</b></header><main><div class="card"><h2>Connexion au dépôt GitHub</h2><p class="sub">Dépôt privé qui contient les données de pointage (voir le guide de mise en service).</p>
      <label class="f">Dépôt (propriétaire/nom)<input id="c_repo" placeholder="societeplacementconseils-create/spc-pointage-data"></label><label class="f">Branche<input id="c_branch" value="main"></label>
      <label class="f">Jeton central (lecture et écriture sur ce dépôt)<input id="c_token" type="password"></label>
      <label class="f">Jeton des appareils de terrain (lecture et écriture sur ce même dépôt)<input id="c_dtoken" type="password"></label>
      <details><summary class="sub">Avancé</summary><label class="f">Adresse de l'API (laisser vide pour GitHub)<input id="c_api" placeholder="https://api.github.com"></label></details>
      <button class="primary big" data-act="saveconfig">Connecter</button></div></main>`;
  }
  function render() {
    const app = $('#app'); if (!cfg) { app.innerHTML = setupView(); return; }
    const body = { day: dayView, month: monthView, agents: agentsView, sites: sitesView, asg: assignView, set: settingsView }[tab]();
    app.innerHTML = `<header class="top"><img src="../shared/logo.png" alt="SPC"><b>SPC Central</b><span><span class="chip ${navigator.onLine ? 'ok' : 'warn'}">${loading ? 'Synchronisation…' : navigator.onLine ? 'En ligne' : 'Hors ligne'}</span>${pending ? ` <span class="chip warn">${pending} à envoyer</span>` : ''}</span></header><main>${lastErr ? `<div class="banner bad">${esc(lastErr)}</div>` : ''}${body}</main>
      <nav class="tabs">${[['day', 'Jour'], ['month', 'Mois'], ['agents', 'Agents'], ['sites', 'Lieux'], ['asg', 'Plannings'], ['set', 'Réglages']].map(([k, l]) => `<button data-act="tab" data-tab="${k}"${tab === k ? ' aria-current="page"' : ''}>${l}</button>`).join('')}</nav>`;
  }

  /* ---------- écriture (file d'attente hors ligne puis synchronisation) ---------- */
  async function write(path, obj, mode) { await SPC.queueFile(db, path, obj, mode || 'replace'); await counts(); render(); load(); }
  const nextId = (arr, p) => p + '-' + String(Math.max(0, ...arr.filter(a => a.id && a.id.startsWith(p + '-')).map(a => parseInt(a.id.split('-')[1], 10) || 0)) + 1).padStart(3, '0');
  function activation(a) {
    const code = SPC.encJson({ v: 1, repo: cfg.repo, branch: cfg.branch, apiBase: cfg.apiBase || '', token: cfg.deviceToken, agentId: a.id, nom: a.nom, role: a.role, key: keys[a.id][keys[a.id].length - 1] });
    const base = location.href.replace(/central\/.*$/, '') + (a.role === 'superviseur' ? 'supervisor/' : 'agent/');
    return { code, link: base + '#enroll=' + code };
  }
  function showLink(a) {
    if (!keys[a.id] || !keys[a.id].length) return toast('Clé absente : générez une nouvelle clé');
    const { link } = activation(a), msg = `SPC Pointage : activez votre application ${a.role === 'superviseur' ? 'superviseur' : 'agent'} en ouvrant ce lien sur votre téléphone Android (Chrome) : ${link}`;
    modal(`<h3>Lien d'activation de ${esc(a.nom)}</h3><p class="sub">À envoyer uniquement à cette personne : il contient la clé de son appareil.</p><label class="f">Lien<textarea id="lk" rows="5" readonly>${esc(link)}</textarea></label>
      <div class="row"><button class="primary grow" data-act="copy">Copier</button><a class="btn grow" style="text-align:center" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">Envoyer par WhatsApp</a></div><button data-act="close" style="width:100%;margin-top:8px">Fermer</button>`);
  }
  function agentForm() {
    modal(`<h3>Nouvel utilisateur</h3><label class="f">Nom et prénom<input id="a_nom"></label><label class="f">Téléphone<input id="a_tel"></label><label class="f">Rôle<select id="a_role"><option value="agent">Agent</option><option value="superviseur">Superviseur</option></select></label>
      <div class="row"><button class="primary grow" data-act="saveagent">Créer</button><button data-act="close">Annuler</button></div>`);
  }
  async function saveAgent() {
    const nom = $('#a_nom').value.trim(); if (!nom) return toast('Indiquez le nom');
    const role = $('#a_role').value, a = { id: nextId(D.agents, role === 'superviseur' ? 'SUP' : 'AGT'), nom, tel: $('#a_tel').value.trim(), role, actif: true, createdAt: new Date().toISOString() };
    keys[a.id] = [SPC.newKey()]; await db.set('kv', 'keys', keys); D.agents.push(a); closeModal(); await write('agents/' + a.id + '.json', a, 'create'); toast('Utilisateur créé : envoyez-lui son lien d\'activation'); showLink(a);
  }
  function siteForm(s) {
    modal(`<h3>${s ? 'Modifier le lieu' : 'Nouveau lieu'}</h3><label class="f">Nom<input id="s_nom" value="${esc(s ? s.nom : '')}"></label><label class="f">Adresse et repères<input id="s_adr" value="${esc(s ? s.adresse || '' : '')}"></label><label class="f">Référence client SPC (ex. CLI-2026-001)<input id="s_cli" value="${esc(s ? s.clientRef || '' : '')}"></label>
      <div class="row"><label class="f grow">Latitude<input id="s_lat" type="number" step="any" value="${s ? s.lat : ''}"></label><label class="f grow">Longitude<input id="s_lon" type="number" step="any" value="${s ? s.lon : ''}"></label></div>
      <label class="f">Rayon de la zone (mètres)<input id="s_ray" type="number" min="20" step="10" value="${s ? s.rayon : 100}"></label><label class="f">Superviseur responsable<select id="s_sup"><option value="">Aucun</option>${D.agents.filter(a => a.role === 'superviseur').map(a => `<option value="${a.id}"${s && s.superviseurId === a.id ? ' selected' : ''}>${esc(a.nom)}</option>`).join('')}</select></label>
      <div class="row"><button class="primary grow" data-act="savesite" data-id="${s ? s.id : ''}">Enregistrer</button><button data-act="close">Annuler</button></div>`);
  }
  async function saveSite(id) {
    const nom = $('#s_nom').value.trim(), lat = parseFloat($('#s_lat').value), lon = parseFloat($('#s_lon').value), rayon = +$('#s_ray').value;
    if (!nom || isNaN(lat) || isNaN(lon) || !(rayon >= 20)) return toast('Nom, coordonnées et rayon (20 m minimum) sont obligatoires');
    const old = D.sites.find(s => s.id === id), s = Object.assign({ actif: true, createdAt: new Date().toISOString() }, old || {}, { id: id || 'S-' + SPC.uid().slice(0, 8), nom, adresse: $('#s_adr').value.trim(), clientRef: $('#s_cli').value.trim(), lat, lon, rayon, superviseurId: $('#s_sup').value, updatedAt: new Date().toISOString() });
    D.sites = D.sites.filter(x => x.id !== s.id).concat(s); closeModal(); await write('sites/' + s.id + '.json', s, old ? 'replace' : 'create');
  }
  function asgForm(a) {
    const ag = D.agents.filter(x => x.role === 'agent' && x.actif !== false);
    modal(`<h3>${a ? 'Modifier l\'affectation' : 'Nouvelle affectation'}</h3><label class="f">Agent<select id="g_agent">${ag.map(x => `<option value="${x.id}"${a && a.agentId === x.id ? ' selected' : ''}>${esc(x.nom)}</option>`).join('')}</select></label>
      <label class="f">Lieu<select id="g_site">${D.sites.map(x => `<option value="${x.id}"${a && a.siteId === x.id ? ' selected' : ''}>${esc(x.nom)}</option>`).join('')}</select></label>
      <div class="f" style="margin:8px 0"><span>Jours</span><div class="row">${SPC.JOURS.map((j, i) => `<label><input type="checkbox" class="g_j" value="${i + 1}"${(a ? a.jours : [1, 2, 3, 4, 5]).includes(i + 1) ? ' checked' : ''}> ${j}</label>`).join('')}</div></div>
      <div class="row"><label class="f grow">Début<input id="g_deb" type="time" value="${a ? a.debut : '07:30'}"></label><label class="f grow">Fin<input id="g_fin" type="time" value="${a ? a.fin : '17:30'}"></label></div>
      <div class="row"><label class="f grow">Du<input id="g_du" type="date" value="${a ? a.du || '' : SPC.localDate()}"></label><label class="f grow">Au (facultatif)<input id="g_au" type="date" value="${a ? a.au || '' : ''}"></label></div>
      <label class="f"><span><input type="checkbox" id="g_act"${!a || a.actif !== false ? ' checked' : ''}> Affectation active</span></label>
      <div class="row"><button class="primary grow" data-act="saveasg" data-id="${a ? a.id : ''}">Enregistrer</button><button data-act="close">Annuler</button></div>`);
  }
  async function saveAsg(id) {
    const agentId = $('#g_agent').value, siteId = $('#g_site').value; if (!agentId || !siteId) return toast('Choisissez un agent et un lieu');
    const jours = [...document.querySelectorAll('.g_j:checked')].map(x => +x.value); if (!jours.length) return toast('Choisissez au moins un jour');
    const old = D.assignments.find(x => x.id === id), a = Object.assign({}, old || {}, { id: id || 'AFF-' + SPC.uid().slice(0, 8), agentId, siteId, jours, debut: $('#g_deb').value, fin: $('#g_fin').value, du: $('#g_du').value, au: $('#g_au').value, actif: $('#g_act').checked });
    D.assignments = D.assignments.filter(x => x.id !== a.id).concat(a); closeModal(); await write('assignments/' + a.id + '.json', a, old ? 'replace' : 'create');
  }

  /* ---------- exports ---------- */
  function download(name, text, type) { const u = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 2000); }

  document.addEventListener('change', async e => {
    if (e.target.id === 'day') { day = e.target.value || SPC.localDate(); render(); }
    if (e.target.id === 'month') { month = e.target.value || month; render(); }
    if (e.target.id === 'keyfile' && e.target.files[0]) { try { const j = JSON.parse(await e.target.files[0].text()); for (const [k, v] of Object.entries(j)) keys[k] = Array.from(new Set((keys[k] || []).concat(v))); await db.set('kv', 'keys', keys); await verify(); render(); toast('Clés importées'); } catch (er) { toast('Fichier de clés invalide'); } }
  });
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return; const d = b.dataset;
    switch (d.act) {
      case 'tab': tab = d.tab; render(); break;
      case 'close': closeModal(); break;
      case 'reload': load(); break;
      case 'saveconfig': {
        const repo = $('#c_repo').value.trim(), token = $('#c_token').value.trim(), dt = $('#c_dtoken').value.trim();
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token || !dt) return toast('Renseignez le dépôt et les deux jetons');
        cfg = { repo, branch: $('#c_branch').value.trim() || 'main', token, deviceToken: dt, apiBase: $('#c_api').value.trim(), settings: { pause: 1, retard: 5 } }; await db.set('kv', 'cfg', cfg); render(); load(); break;
      }
      case 'config': if (confirm('Modifier la connexion ? Les clés de signature sont conservées.')) { const old = cfg; cfg = null; render(); $('#c_repo').value = old.repo; $('#c_branch').value = old.branch; $('#c_api').value = old.apiBase || ''; } break;
      case 'saveset': cfg.settings = { pause: +$('#set_pause').value || 0, retard: +$('#set_retard').value || 0 }; await db.set('kv', 'cfg', cfg); render(); toast('Règles enregistrées'); break;
      case 'newagent': agentForm(); break;
      case 'saveagent': saveAgent(); break;
      case 'link': showLink(D.agents.find(a => a.id === d.id)); break;
      case 'copy': { const t = $('#lk'); t.select(); try { await navigator.clipboard.writeText(t.value); } catch (er) { document.execCommand('copy'); } toast('Lien copié'); break; }
      case 'rekey': if (confirm("Générer une nouvelle clé ? L'ancien appareil ne pourra plus pointer tant qu'il n'est pas réactivé avec le nouveau lien. Les anciens pointages restent vérifiables.")) { keys[d.id] = (keys[d.id] || []).concat(SPC.newKey()); await db.set('kv', 'keys', keys); showLink(D.agents.find(a => a.id === d.id)); } break;
      case 'toggleagent': { const a = D.agents.find(x => x.id === d.id); a.actif = a.actif === false; write('agents/' + a.id + '.json', a, 'replace'); break; }
      case 'newsite': siteForm(null); break;
      case 'editsite': siteForm(D.sites.find(s => s.id === d.id)); break;
      case 'savesite': saveSite(d.id); break;
      case 'togglesite': { const s = D.sites.find(x => x.id === d.id); s.actif = s.actif === false; write('sites/' + s.id + '.json', s, 'replace'); break; }
      case 'newasg': if (!D.agents.length || !D.sites.length) toast("Créez d'abord au moins un agent et un lieu"); else asgForm(null); break;
      case 'editasg': asgForm(D.assignments.find(a => a.id === d.id)); break;
      case 'saveasg': saveAsg(d.id); break;
      case 'csv': {
        const { entries } = monthStats(month), head = ['Date', 'Code agent', 'Agent', 'Lieu', 'Client', 'Arrivée', 'Départ', 'Heures', 'Retard (min)', 'État', 'Alertes'];
        const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        download('pointages-' + month + '.csv', '\ufeff' + [head.map(q).join(';')].concat(entries.map(r => [r.date, r.agentCode, r.agentNom, r.siteNom, r.clientRef, r.arr, r.dep, String(r.heures).replace('.', ','), r.retardMin, r.etat, r.alertes.join(' | ')].map(q).join(';'))).join('\r\n'), 'text/csv'); break;
      }
      case 'json': { const { entries } = monthStats(month); download('spc-pointages-' + month + '.json', JSON.stringify({ format: 'spc-pointages', version: 1, mois: month, genere: new Date().toISOString(), entrees: entries }, null, 1), 'application/json'); break; }
      case 'exportkeys': download('spc-cles-signature.json', JSON.stringify(keys), 'application/json'); toast('Gardez ce fichier en lieu sûr'); break;
    }
  });
  boot();
})();
