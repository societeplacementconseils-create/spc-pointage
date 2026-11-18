/* SPC Central - gestion des agents, des lieux, des affectations et contrôle des pointages */
(function () {
  'use strict';
  const { esc, toast, modal, closeModal, fdate, hm } = SPC;
  const $ = s => document.querySelector(s);
  const db = SPC.db('spc-central');
  let cfg = null, keys = {}, D = emptyD(), tab = 'day', day = SPC.localDate(), month = SPC.localDate().slice(0, 7), loading = false, lastErr = '', pending = 0, lastSync = '', V = null, pubInfo = null, CL = null, FI = {}, PL = null, XK = '';
  function emptyD() { return { agents: [], sites: [], assignments: [], validations: [], events: [], deleted: [] }; }

  /* ---------- démarrage ---------- */
  async function boot() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    cfg = await db.get('kv', 'cfg'); keys = (await db.get('kv', 'keys')) || {}; D = (await db.get('kv', 'data')) || D; CL = (await db.get('kv', 'clients')) || null; FI = (await db.get('kv', 'fiches')) || {}; PL = (await db.get('kv', 'plannings')) || null;
    await counts(); await verify(); render(); if (cfg) load();
    addEventListener('online', () => load()); addEventListener('offline', render);
  }
  async function counts() { XK = await xkey(); pending = (await db.keys('outbox')).length; lastSync = (await db.get('kv', 'lastSync')) || ''; pubInfo = (await db.get('kv', 'pub:' + month)) || null; }

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
        try { const cf = await readEnc(gh, 'echange/clients.json', 'spc-clients'); CL = cf && Array.isArray(cf.clients) ? cf : null; await db.set('kv', 'clients', CL); } catch (e) { /* le fichier de clients est facultatif */ }
        try { const pf = await readEnc(gh, 'echange/plannings.json', 'spc-plannings'); PL = pf && Array.isArray(pf.plannings) ? pf : null; await db.set('kv', 'plannings', PL); } catch (e) { /* facultatif */ }
        if (!Object.keys(FI).length && D.agents.length) { try { const ef = await readEnc(gh, 'exports/employes.json', 'spc-employes'); if (ef && Array.isArray(ef.employes)) { for (const e of ef.employes) FI[e.code] = { prenoms: e.prenoms, nom: e.nomFamille, naissance: e.naissance, adresse: e.adresse, piece: e.piece, cnss: e.cnss, poste: e.poste, garants: e.garants, notes: e.notes }; await db.set('kv', 'fiches', FI); } } catch (e) { /* facultatif */ } }
      }
    } catch (e) { lastErr = e.code === 'auth' ? 'Jeton refusé par GitHub' : (e.message || e.code); }
    if (cfg && navigator.onLine && (D.sites.some(s => !s.qrHash) || D.agents.some(a => !a.badgeHash))) { try { await ensureQr(); await db.set('kv', 'data', D); } catch (e) { /* réessayé au prochain chargement */ } }
    loading = false; await counts(); await verify(); render();
    if (cfg && navigator.onLine) autoPublish().then(async () => { await counts(); render(); }).catch(() => {});
  }

  /* ---------- échanges chiffrés avec SPC Gestion ---------- */
  async function xkey() { if (!keys.__echange || !keys.__echange.length) { keys.__echange = [SPC.newKey()]; await db.set('kv', 'keys', keys); } return keys.__echange[keys.__echange.length - 1]; }
  /** Toutes les clés d'échange, de la plus récente à la plus ancienne : une clé remplacée reste utilisable pour lire les anciens fichiers. */
  const xkeys = () => (keys.__echange || []).slice().reverse();
  async function readEnc(gh, path, fmt) {
    const f = await gh.get(path); if (!f || !f.json || f.json.format !== fmt) return null;
    if (!f.json.chiffre) return f.json;
    for (const k of xkeys()) { try { return Object.assign({ format: fmt }, await SPC.xDecrypt(k, f.json)); } catch (e) { /* clé suivante */ } }
    return null;
  }

  /* ---------- codes QR des lieux ---------- */
  async function master() { if (!keys.__master || !keys.__master.length) { keys.__master = [SPC.newKey()]; await db.set('kv', 'keys', keys); } return keys.__master[keys.__master.length - 1]; }
  const agentCode = async a => SPC.codeFromHex(await SPC.hmac(await master(), 'badge:' + a.id + ':' + (a.badgeVersion || 1)));
  const siteCode = async s => SPC.codeFromHex(await SPC.hmac(await master(), 'qr:' + s.id + ':' + (s.qrVersion || 1)));
  async function ensureQr() {
    let n = 0;
    for (const s of D.sites) {
      if (s.qrHash) continue;
      s.qrVersion = s.qrVersion || 1; s.qrHash = await SPC.qrHash(s.id, await siteCode(s));
      await SPC.queueFile(db, 'sites/' + s.id + '.json', s, 'replace'); n++;
    }
    for (const a of D.agents) {
      if (a.badgeHash) continue;
      a.badgeVersion = a.badgeVersion || 1; a.badgeHash = await SPC.badgeHash(a.id, await agentCode(a));
      await SPC.queueFile(db, 'agents/' + a.id + '.json', a, 'replace'); n++;
    }
    if (n) { await SPC.sync(db, cfg); await counts(); }
    return n;
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
      if (settings().gpsAlert > 0 && e.mode === 'qr' && e.dist != null && e.dist > settings().gpsAlert) add(e.id, 'Scan à ' + e.dist + ' m du lieu', 'warn');
      if (e.drift != null && Math.abs(e.drift) > 120000) add(e.id, 'Horloge du téléphone décalée', 'warn');
      if (e.tGps && Math.abs(new Date(e.t) - new Date(e.tGps)) > 120000 && e.mode !== 'manuel') add(e.id, 'Heure ≠ heure GPS', 'warn');
      if (e.mode === 'manuel') add(e.id, 'Pointage manuel', 'warn');
      if (e.mode === 'badge') add(e.id, 'Badge scanné par ' + (e.signerId || '?'), 'ok');
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
  const settings = () => Object.assign({ pause: 1, retard: 5, gpsAlert: 0 }, cfg && cfg.settings);
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
      <div class="card scroll"><table><thead><tr><th>Agent</th><th>Lieu</th><th>Prévu</th><th>Arrivée</th><th>Départ</th><th>Heures</th><th>Retard</th><th>Distance (info)</th><th>État</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(agentName(r.agentId))}</td><td>${esc(site(r.siteId).nom || r.siteId)}${r.a ? '' : ' <span class="chip warn">hors planning</span>'}</td><td>${r.a ? esc((r.a.debut || '') + ' à ' + (r.a.fin || '')) : '-'}</td><td>${r.first ? hm(r.first.t) : '-'}</td><td>${r.lastOut ? hm(r.lastOut.t) : '-'}</td><td>${r.evs.length ? h1(r.hours) : '-'}</td><td>${r.retard > settings().retard ? r.retard + ' min' : '-'}</td><td>${r.first && r.first.dist != null ? r.first.dist + ' m' : '-'}</td><td>${stChip(r)} ${r.flags.map(chip).join(' ')}</td></tr>`).join('') || '<tr><td colspan="9" class="sub">Aucune affectation ni pointage ce jour.</td></tr>'}</tbody></table></div>`;
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
        entries.push({ date, agentCode: r.agentId, agentNom: agentName(r.agentId), siteId: r.siteId, siteNom: s.nom || '', clientRef: s.clientRef || '', arr: r.first ? hm(r.first.t) : '', dep: r.lastOut ? hm(r.lastOut.t) : '', heures: Math.round(r.hours * 100) / 100, retardMin: r.retard, absent: !r.evs.length && r.state.startsWith('Absent'), etat: r.state, alertes: r.flags.filter(f => f.sev !== 'ok').map(f => f.k), modes: [...new Set(r.evs.map(e => e.mode))], signataires: [...new Set(r.evs.map(e => e.signerId))], eventIds: r.evs.map(e => e.id) });
      }
    }
    return { per, entries };
  }
  function buildExport(m) {
    const { entries } = monthStats(m);
    return { format: 'spc-pointages', version: 2, mois: m, genere: new Date().toISOString(), source: 'central', entrees: entries };
  }
  const exportPath = m => 'exports/pointages-' + m + '.json';
  /** Fiche du personnel : le central est la source ; SPC Gestion la récupère (fichier chiffré, jamais de clé ni d'empreinte). */
  function buildEmployes() {
    return { genere: new Date().toISOString(), employes: D.agents.map(a => { const f = FI[a.id] || {};
      return { code: a.id, role: a.role, nom: a.nom, prenoms: f.prenoms || '', nomFamille: f.nom || '', naissance: f.naissance || '', tel: a.tel || '', adresse: f.adresse || '', piece: f.piece || '', cnss: f.cnss || '', poste: f.poste || '', garants: f.garants || [], notes: f.notes || '', actif: a.actif !== false, creeLe: a.createdAt || '' }; }) };
  }
  async function publishEmployes(force) {
    if (!cfg) return false;
    const plain = buildEmployes(); if (!plain.employes.length && !force) return false;
    const h = await SPC.sha256(JSON.stringify(plain.employes)), last = (await db.get('kv', 'pub:employes')) || {}, obj = Object.assign({ format: 'spc-employes', version: 2, source: 'central', genere: plain.genere }, await SPC.xEncrypt(await xkey(), plain));
    if (!force && last.h === h) return false;
    await SPC.queueFile(db, 'exports/employes.json', obj, 'replace'); await db.set('kv', 'pub:employes', { h, t: new Date().toISOString(), n: plain.employes.length });
    return true;
  }
  /** Écrit dans le dépôt le fichier vérifié que l'application de gestion vient chercher. */
  async function publishExport(m, force) {
    if (!cfg) return false;
    const obj = buildExport(m); if (!obj.entrees.length && !force) return false;
    const h = await SPC.sha256(JSON.stringify(obj.entrees)), last = (await db.get('kv', 'pub:' + m)) || {};
    if (!force && last.h === h) return false;
    await SPC.queueFile(db, exportPath(m), obj, 'replace');
    await db.set('kv', 'pub:' + m, { h, t: new Date().toISOString(), n: obj.entrees.length });
    return true;
  }
  async function autoPublish() {
    if (!cfg || settings().autoExport === false) return;
    const now = new Date(), months = [SPC.localDate().slice(0, 7)];
    if (now.getDate() <= 7) { const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1); months.push(pm.getFullYear() + '-' + String(pm.getMonth() + 1).padStart(2, '0')); }
    let any = false; for (const m of months) any = (await publishExport(m)) || any;
    any = (await publishEmployes()) || any;
    if (any) { try { await SPC.sync(db, cfg); } catch (e) { /* réessayé au prochain chargement */ } }
  }
  function monthView() {
    const { per } = monthStats(month);
    return `<div class="row" style="margin-bottom:10px"><label class="f grow" style="margin:0">Mois<input type="month" id="month" value="${month}"></label><button data-act="csv">Exporter CSV</button><button class="primary" data-act="json">Exporter pour l'application SPC</button></div>
      <div class="card scroll"><table><thead><tr><th>Agent</th><th>Jours prévus</th><th>Jours pointés</th><th>Heures</th><th>Retards</th><th>Alertes</th></tr></thead><tbody>${Object.entries(per).map(([id, p]) => `<tr><td>${esc(agentName(id))}</td><td>${p.prevus}</td><td>${p.jours}</td><td>${h1(p.heures)}</td><td>${p.retards}</td><td>${p.alertes}</td></tr>`).join('') || '<tr><td colspan="6" class="sub">Aucune donnée ce mois.</td></tr>'}</tbody></table></div>
      <div class="card"><h3>Envoi vers l'application de gestion</h3><p>${pubInfo ? `<span class="chip ok">Publié</span> le ${new Date(pubInfo.t).toLocaleString('fr-FR')} · ${pubInfo.n} ligne(s)` : '<span class="chip warn">Pas encore publié pour ce mois</span>'}</p>
        <p class="sub">Le fichier vérifié <b>${exportPath(month)}</b> est écrit dans le dépôt de données ${settings().autoExport === false ? '(publication automatique désactivée dans Réglages)' : 'automatiquement à chaque ouverture du central'}. L'application de gestion le récupère (Réglages, Pointages) : une ligne par agent, lieu et jour.</p>
        <div class="row"><button class="primary" data-act="publish">Publier maintenant</button></div></div>`;
  }
  function agentsView() {
    return `<div class="row" style="margin-bottom:10px"><button class="primary grow" data-act="newagent">Nouvel agent ou superviseur</button><button data-act="badgeall">Imprimer tous les badges</button></div>
      ${D.agents.map(a => `<div class="card"><div class="row"><h3 class="grow">${esc(a.nom)}</h3><span class="chip">${a.role === 'superviseur' ? 'Superviseur' : 'Agent'}</span>${a.actif === false ? '<span class="chip bad">inactif</span>' : ''}</div><div class="sub">${esc(a.id)} · ${esc(a.tel || '')}${(FI[a.id] || {}).poste ? ' · ' + esc((POSTES.find(p => p[0] === FI[a.id].poste) || [0, ''])[1]) : ''}${keys[a.id] ? '' : ' · <b>clé absente sur cet appareil</b>'}</div>
        <div class="row" style="margin-top:8px"><button data-act="editagent" data-id="${a.id}">Fiche</button><button data-act="link" data-id="${a.id}">Lien d'activation</button>${a.role === 'agent' ? `<button data-act="badge" data-id="${a.id}">Badge</button>` : ''}<button data-act="rekey" data-id="${a.id}">Nouvelle clé</button><button data-act="toggleagent" data-id="${a.id}">${a.actif === false ? 'Réactiver' : 'Désactiver'}</button></div></div>`).join('') || '<div class="card"><p class="sub">Aucun agent.</p></div>'}`;
  }
  const siteOf = c => D.sites.find(s => s.clientRef === c.ref);
  function clientsCard() {
    if (!CL || !CL.clients.length) return `<div class="card"><h3>Clients de SPC Gestion</h3><p class="sub">Aucun client reçu. Les fiches clients sont gérées dans <b>SPC Gestion</b> : ouvrez l'application de gestion (fichier local), Réglages, Pointages, puis <b>Envoyer les clients vers le central</b>.</p></div>`;
    const miss = CL.clients.filter(c => !siteOf(c));
    return `<div class="card"><div class="row"><h3 class="grow">Clients de SPC Gestion</h3><span class="chip">${CL.clients.length} client(s)</span></div><p class="sub">Reçus le ${new Date(CL.genere).toLocaleString('fr-FR')}. Les informations clients ne se modifient que dans SPC Gestion.</p>
      ${CL.clients.map(c => { const s = siteOf(c), diff = s && (s.nom !== c.nom || (s.adresse || '') !== (c.adresse || ''));
        return `<div class="row" style="padding:6px 0;border-top:1px solid var(--line)"><div class="grow"><b>${esc(c.nom)}</b> <span class="sub">${esc(c.ref)}</span><div class="sub">${esc(c.adresse || '')}</div></div>${s ? (diff ? `<span class="chip warn">Différent de SPC Gestion</span><button data-act="syncsite" data-id="${s.id}">Mettre à jour</button>` : '<span class="chip ok">Lieu créé</span>') : `<span class="chip warn">Sans lieu</span><button class="primary" data-act="sitefromclient" data-ref="${esc(c.ref)}">Créer le lieu</button>`}</div>`; }).join('')}
      ${miss.length ? `<div class="row" style="margin-top:8px"><button class="primary" data-act="sitesfromclients">Créer les ${miss.length} lieu(x) manquant(s)</button></div>` : ''}</div>`;
  }
  async function createSiteFromClient(c) {
    const s = { id: 'S-' + SPC.uid().slice(0, 8), nom: c.nom, adresse: c.adresse || '', clientRef: c.ref, lat: null, lon: null, superviseurId: '', actif: true, qrVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    s.qrHash = await SPC.qrHash(s.id, await siteCode(s)); D.sites.push(s); await SPC.queueFile(db, 'sites/' + s.id + '.json', s, 'create'); return s;
  }
  function sitesView() {
    return clientsCard() + `<div class="row" style="margin-bottom:10px"><button class="primary grow" data-act="newsite">Nouveau lieu</button><button data-act="posterall">Imprimer tous les codes</button></div>
      ${D.sites.map(s => `<div class="card"><div class="row"><h3 class="grow">${esc(s.nom)}</h3>${s.qrHash ? '<span class="chip ok">QR actif</span>' : '<span class="chip warn">QR en préparation</span>'}${s.actif === false ? '<span class="chip bad">inactif</span>' : ''}</div><div class="sub">${esc(s.adresse || '')} · client ${esc(s.clientRef || '-')}</div><div class="sub">${s.lat != null && s.lat !== '' ? 'Coordonnées : ' + s.lat + ', ' + s.lon + ' (information)' : 'Coordonnées non renseignées (facultatif)'}</div><div class="row" style="margin-top:8px"><button class="primary" data-act="qr" data-id="${s.id}">Code QR</button>${s.lat != null && s.lat !== '' ? `<a class="btn" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=18/${s.lat}/${s.lon}">Carte</a>` : ''}<button data-act="editsite" data-id="${s.id}">Modifier</button><button data-act="togglesite" data-id="${s.id}">${s.actif === false ? 'Réactiver' : 'Désactiver'}</button></div></div>`).join('') || '<div class="card"><p class="sub">Aucun lieu. Créez un lieu : son code QR est généré tout de suite.</p></div>'}`;
  }
  const plState = p => { const ag = D.agents.find(a => a.id === p.agentCode), st = D.sites.find(s => s.clientRef === p.clientRef), ex = D.assignments.find(x => x.affRef === p.ref);
    if (!ag) return { k: 'agent', l: 'Agent non enregistré', c: 'bad' }; if (!st) return { k: 'site', l: 'Lieu manquant : créez le lieu du client', c: 'warn' }; if (!ex) return { k: 'new', l: 'À créer', c: 'warn', ag, st };
    const same = JSON.stringify(ex.jours) === JSON.stringify(p.jours) && ex.debut === p.debut && ex.fin === p.fin && (ex.du || '') === (p.du || '') && ex.siteId === st.id && ex.agentId === ag.id;
    return same ? { k: 'ok', l: 'En place', c: 'ok', ag, st, ex } : { k: 'diff', l: 'Différent de SPC Gestion', c: 'warn', ag, st, ex }; };
  function plCard() {
    if (!PL || !PL.plannings.length) return `<div class="card"><h3>Plannings proposés par SPC Gestion</h3><p class="sub">Aucun planning reçu. SPC Gestion prépare les plannings à partir de ses affectations : menu Robot opérationnel, Planification, bouton Envoyer les plannings au central.</p></div>`;
    const todo = PL.plannings.filter(p => ['new', 'diff'].includes(plState(p).k));
    return `<div class="card"><div class="row"><h3 class="grow">Plannings proposés par SPC Gestion</h3><span class="chip">${PL.plannings.length}</span></div><p class="sub">Reçus le ${new Date(PL.genere).toLocaleString('fr-FR')}. Source : les affectations de SPC Gestion.</p>
      ${PL.plannings.map(p => { const s = plState(p); return `<div class="row" style="padding:6px 0;border-top:1px solid var(--line)"><div class="grow"><b>${esc(p.agentNom || p.agentCode)}</b> <span class="sub">${esc(p.agentCode)}</span> chez <b>${esc(p.clientNom || p.clientRef)}</b><div class="sub">${(p.jours || []).map(j => SPC.JOURS[j - 1]).join(' ')} · ${esc(p.debut)} à ${esc(p.fin)} · à partir du ${esc(p.du || '-')}</div></div><span class="chip ${s.c}">${s.l}</span>${['new', 'diff'].includes(s.k) ? `<button class="primary" data-act="applypl" data-ref="${esc(p.ref)}">${s.k === 'new' ? 'Appliquer' : 'Mettre à jour'}</button>` : ''}</div>`; }).join('')}
      ${todo.length ? `<div class="row" style="margin-top:8px"><button class="primary" data-act="applyplall">Appliquer les ${todo.length} planning(s)</button></div>` : ''}</div>`;
  }
  async function applyPlanning(p) {
    const s = plState(p); if (!['new', 'diff'].includes(s.k)) return false;
    const a = Object.assign({}, s.ex || {}, { id: s.ex ? s.ex.id : 'AFF-' + SPC.uid().slice(0, 8), agentId: s.ag.id, siteId: s.st.id, jours: p.jours, debut: p.debut, fin: p.fin, du: p.du || '', au: p.au || '', actif: true, source: 'gestion', affRef: p.ref });
    D.assignments = D.assignments.filter(x => x.id !== a.id).concat(a); await SPC.queueFile(db, 'assignments/' + a.id + '.json', a, s.ex ? 'replace' : 'create'); return true;
  }
  function assignView() {
    return plCard() + `<div class="row" style="margin-bottom:10px"><button class="primary grow" data-act="newasg">Nouvelle affectation</button></div>
      <div class="card scroll"><table><thead><tr><th>Agent</th><th>Lieu</th><th>Jours</th><th>Horaires</th><th>Période</th><th></th></tr></thead><tbody>${D.assignments.map(a => `<tr><td>${esc(agentName(a.agentId))}</td><td>${esc(site(a.siteId).nom || a.siteId)}</td><td>${(a.jours || []).map(j => SPC.JOURS[j - 1]).join(' ')}</td><td>${esc(a.debut || '')} à ${esc(a.fin || '')}</td><td>${esc(a.du || '')} ${a.au ? '→ ' + esc(a.au) : ''}</td><td><button data-act="editasg" data-id="${a.id}">Modifier</button></td></tr>`).join('') || '<tr><td colspan="6" class="sub">Aucune affectation.</td></tr>'}</tbody></table></div>`;
  }
  function settingsView() {
    return `<div class="card"><h2>Connexion au dépôt de données</h2><p class="sub">${cfg ? esc(cfg.repo) + ' · branche ' + esc(cfg.branch) : ''}</p>
      <p class="sub">Dernière synchronisation : ${lastSync ? new Date(lastSync).toLocaleString('fr-FR') : 'jamais'}${pending ? ` · ${pending} modification(s) à envoyer` : ''}${lastErr ? ' · ' + esc(lastErr) : ''}</p>
      <div class="row"><button class="primary" data-act="reload">Synchroniser</button><button data-act="config">Modifier la connexion</button></div></div>
      <div class="card"><h3>Clé d'échange avec SPC Gestion</h3><p class="sub">Cette clé chiffre la fiche du personnel (identité, adresse, CNSS, garants), la liste des clients et les plannings dans le dépôt : les téléphones de terrain peuvent lire le dépôt mais pas ces fichiers. Copiez-la dans SPC Gestion (Réglages, Pointages). Gardez-la secrète : elle fait partie de la sauvegarde des clés.</p>
        <label class="f">Clé d'échange (masquée par défaut)<input id="xkeyshow" type="password" readonly value="${esc(XK)}"></label><div class="row"><button data-act="copyxkey">Copier la clé</button><button data-act="showxkey">Afficher ou masquer</button><button class="danger" data-act="regenx">Régénérer la clé</button></div><p class="sub">Si la clé a été vue par une personne qui ne devrait pas la connaître (capture d'écran, message), régénérez-la puis copiez la nouvelle dans SPC Gestion.</p></div>
      <div class="card"><h3>Règles de calcul</h3><label class="f">Pause quotidienne déduite (heures, journée d'un seul tenant de 6 h ou plus)<input id="set_pause" type="number" step="0.5" min="0" value="${settings().pause}"></label><label class="f"><span><input id="set_auto" type="checkbox"${settings().autoExport === false ? '' : ' checked'}> Publier automatiquement les pointages vers l'application de gestion</span></label><label class="f">Tolérance de retard (minutes)<input id="set_retard" type="number" min="0" value="${settings().retard}"></label><label class="f">Alerte si le scan est à plus de ... mètres du lieu (0 = désactivée, utile seulement si les coordonnées du lieu sont fiables)<input id="set_gps" type="number" min="0" value="${settings().gpsAlert}"></label><button data-act="saveset">Enregistrer</button></div>
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
  const POSTES = [['', 'Non précisé'], ['menage', 'Femme de Ménage'], ['nounou_std', 'Nounou Standard (1 à 2 enfants)'], ['nounou_int', 'Nounou Interne / Logée'], ['nounou_menage', 'Nounou & Ménage (Polyvalente)'], ['elite', 'Profil Élite / VIP'], ['autre', 'Autre poste']];
  function agentForm(a) {
    const f = a ? (FI[a.id] || { nom: a.nom }) : {}, g = f.garants || [];
    modal(`<h3>${a ? 'Fiche de ' + esc(a.nom) : 'Nouvel employé ou utilisateur'}</h3><p class="sub">Toutes ces informations sont transmises (chiffrées) à SPC Gestion pour le suivi du personnel.</p>
      <label class="f">Rôle<select id="a_role"${a ? ' disabled' : ''}><option value="agent"${a && a.role === 'agent' ? ' selected' : ''}>Agent de terrain</option><option value="superviseur"${a && a.role === 'superviseur' ? ' selected' : ''}>Superviseur, chef d'équipe</option></select></label>
      <div class="row"><label class="f grow">Prénoms<input id="a_prenoms" value="${esc(f.prenoms || '')}"></label><label class="f grow">Nom<input id="a_nom" value="${esc(f.nom || '')}"></label></div>
      <div class="row"><label class="f grow">Date de naissance<input id="a_naiss" type="date" value="${esc(f.naissance || '')}"></label><label class="f grow">Téléphone<input id="a_tel" value="${esc(a ? a.tel || '' : '')}"></label></div>
      <label class="f">Adresse<input id="a_adr" value="${esc(f.adresse || '')}"></label>
      <div class="row"><label class="f grow">Pièce d'identité (type et numéro)<input id="a_piece" value="${esc(f.piece || '')}"></label><label class="f grow">N° CNSS<input id="a_cnss" value="${esc(f.cnss || '')}"></label></div>
      <label class="f">Poste ou profil<select id="a_poste">${POSTES.map(([k, l]) => `<option value="${k}"${(f.poste || '') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      ${[0, 1].map(i => `<div class="row"><label class="f grow">Garant ${i + 1} : nom<input id="a_g${i}n" value="${esc((g[i] || {}).nom || '')}"></label><label class="f grow">Téléphone<input id="a_g${i}t" value="${esc((g[i] || {}).tel || '')}"></label><label class="f grow">Lien<input id="a_g${i}l" value="${esc((g[i] || {}).lien || '')}"></label></div>`).join('')}
      <label class="f">Notes<input id="a_notes" value="${esc(f.notes || '')}"></label>
      <div class="row"><button class="primary grow" data-act="saveagent" data-id="${a ? a.id : ''}">Enregistrer</button><button data-act="close">Annuler</button></div>`);
  }
  async function saveAgent(id) {
    const prenoms = $('#a_prenoms').value.trim(), nomF = $('#a_nom').value.trim(), nom = (prenoms + ' ' + nomF).trim(); if (!nom) return toast('Indiquez le nom');
    const fiche = { prenoms, nom: nomF, naissance: $('#a_naiss').value, adresse: $('#a_adr').value.trim(), piece: $('#a_piece').value.trim(), cnss: $('#a_cnss').value.trim(), poste: $('#a_poste').value === 'autre' ? '' : $('#a_poste').value, notes: $('#a_notes').value.trim(),
      garants: [0, 1].map(i => ({ nom: $('#a_g' + i + 'n').value.trim(), tel: $('#a_g' + i + 't').value.trim(), lien: $('#a_g' + i + 'l').value.trim() })) };
    const old = D.agents.find(x => x.id === id), role = old ? old.role : $('#a_role').value;
    const a = old ? Object.assign(old, { nom, tel: $('#a_tel').value.trim() }) : { id: nextId(D.agents, role === 'superviseur' ? 'SUP' : 'AGT'), nom, tel: $('#a_tel').value.trim(), role, actif: true, createdAt: new Date().toISOString(), badgeVersion: 1 };
    if (!old) { keys[a.id] = [SPC.newKey()]; await db.set('kv', 'keys', keys); a.badgeHash = await SPC.badgeHash(a.id, await agentCode(a)); D.agents.push(a); }
    FI[a.id] = fiche; await db.set('kv', 'fiches', FI); closeModal();
    try { await publishEmployes(true); } catch (e) { /* republié au prochain chargement */ }
    await write('agents/' + a.id + '.json', a, old ? 'replace' : 'create');
    if (old) toast('Fiche enregistrée et transmise à SPC Gestion'); else { toast('Utilisateur créé : envoyez-lui son lien d\'activation'); showLink(a); }
  }
  function siteForm(s) {
    modal(`<h3>${s ? 'Modifier le lieu' : 'Nouveau lieu'}</h3>${CL && CL.clients.length ? `<label class="f">Client de SPC Gestion (remplit les champs ci-dessous)<select id="s_client"><option value="">Choisir un client...</option>${CL.clients.map(c => `<option value="${esc(c.ref)}">${esc(c.nom)} (${esc(c.ref)})</option>`).join('')}</select></label>` : ''}<label class="f">Nom du lieu (client)<input id="s_nom" value="${esc(s ? s.nom : '')}"></label><label class="f">Adresse et repères<input id="s_adr" value="${esc(s ? s.adresse || '' : '')}"></label><label class="f">Référence client SPC (ex. CLI-2026-001)<input id="s_cli" value="${esc(s ? s.clientRef || '' : '')}"></label>
      <p class="sub">Coordonnées GPS : facultatives, à titre d'information. Le pointage se fait par le code QR du lieu.</p>
      <div class="row"><label class="f grow">Latitude<input id="s_lat" type="number" step="any" value="${s && s.lat != null ? s.lat : ''}"></label><label class="f grow">Longitude<input id="s_lon" type="number" step="any" value="${s && s.lon != null ? s.lon : ''}"></label></div>
      <label class="f">Superviseur responsable<select id="s_sup"><option value="">Aucun</option>${D.agents.filter(a => a.role === 'superviseur').map(a => `<option value="${a.id}"${s && s.superviseurId === a.id ? ' selected' : ''}>${esc(a.nom)}</option>`).join('')}</select></label>
      <div class="row"><button class="primary grow" data-act="savesite" data-id="${s ? s.id : ''}">Enregistrer</button><button data-act="close">Annuler</button></div>`);
  }
  async function saveSite(id) {
    const nom = $('#s_nom').value.trim(), la = $('#s_lat').value.trim(), lo = $('#s_lon').value.trim();
    if (!nom) return toast('Le nom du lieu est obligatoire');
    if ((la === '') !== (lo === '') || (la !== '' && (isNaN(+la) || isNaN(+lo)))) return toast('Renseignez la latitude et la longitude ensemble, ou aucune des deux');
    const old = D.sites.find(s => s.id === id);
    const s = Object.assign({ actif: true, createdAt: new Date().toISOString(), qrVersion: 1 }, old || {}, { id: id || 'S-' + SPC.uid().slice(0, 8), nom, adresse: $('#s_adr').value.trim(), clientRef: $('#s_cli').value.trim(), lat: la === '' ? null : +la, lon: lo === '' ? null : +lo, superviseurId: $('#s_sup').value, updatedAt: new Date().toISOString() });
    if (!s.qrHash) s.qrHash = await SPC.qrHash(s.id, await siteCode(s));
    D.sites = D.sites.filter(x => x.id !== s.id).concat(s); closeModal(); await write('sites/' + s.id + '.json', s, old ? 'replace' : 'create');
    if (!old) { toast('Lieu créé : imprimez son code QR'); showQr(s); }
  }
  async function showQr(s) {
    const code = await siteCode(s), text = SPC.qrText(s.id, code);
    modal(`<h3>Code QR : ${esc(s.nom)}</h3><div style="text-align:center;max-width:260px;margin:auto">${SPCQR.svg(text)}</div><p style="text-align:center;font-size:20px"><b>${SPC.fmtCode(code)}</b></p>
      <p class="sub">Code de secours à taper si la caméra ne fonctionne pas. Imprimez l'affiche et placez-la à un endroit visible du lieu.</p><input type="hidden" id="qrtext" value="${esc(text)}">
      <div class="row"><button class="primary grow" data-act="poster" data-id="${s.id}">Imprimer l'affiche</button><button class="grow danger" data-act="regen" data-id="${s.id}">Remplacer le code</button></div><button data-act="close" style="width:100%;margin-top:8px">Fermer</button>`);
  }
  async function badgeHtml(a) {
    const code = await agentCode(a), text = SPC.badgeText(a.id, code);
    return `<div class="badge"><div class="bhead"><img src="../shared/logo.png" alt="SPC"><span>BADGE DE POINTAGE</span></div><div class="bbody"><div class="bqr">${SPCQR.svg(text)}</div><div class="binfo"><b class="bname">${esc(a.nom)}</b><span>${esc(a.id)}</span><span class="bcode">${SPC.fmtCode(code)}</span></div></div></div>`;
  }
  async function showBadge(a) {
    const code = await agentCode(a), text = SPC.badgeText(a.id, code);
    modal(`<h3>Badge de ${esc(a.nom)}</h3><div style="max-width:420px;margin:auto">${await badgeHtml(a)}</div><input type="hidden" id="badgetext" value="${esc(text)}">
      <p class="sub">Le chef d'équipe scanne ce code avec l'application SPC Superviseur pour pointer l'agent. Imprimez le badge et plastifiez-le.</p>
      <div class="row"><button class="primary grow" data-act="badgeprint" data-id="${a.id}">Imprimer le badge</button><button class="grow danger" data-act="badgeregen" data-id="${a.id}">Remplacer le badge</button></div><button data-act="close" style="width:100%;margin-top:8px">Fermer</button>`);
  }
  async function showBadges(list) {
    const html = (await Promise.all(list.map(badgeHtml))).join('');
    let v = document.getElementById('posterView');
    if (!v) { v = document.createElement('div'); v.id = 'posterView'; document.body.appendChild(v); }
    v.innerHTML = `<div class="pbar"><b>Badge${list.length > 1 ? 's' : ''} de pointage</b><button class="primary" data-act="print">Imprimer</button><button data-act="closeposter">Fermer</button></div><div class="bsheet">${html}</div>`;
    v.classList.add('on'); closeModal();
  }
  async function posterHtml(s) {
    const code = await siteCode(s), text = SPC.qrText(s.id, code);
    return `<section class="poster"><img class="plogo" src="../shared/logo.png" alt="SPC"><h1>POINTAGE DES AGENTS</h1><h2>${esc(s.nom)}</h2><div class="pqr">${SPCQR.svg(text)}</div><p class="pstep"><b>À l'arrivée et au départ :</b><br>ouvrez l'application <b>SPC Pointage</b>, touchez <b>« Scanner le code QR du lieu »</b> et visez ce code.</p><p class="pcode">Code de secours : <b>${SPC.fmtCode(code)}</b></p><p class="pfoot">${esc(s.adresse || '')}<br>SPC - Service de Placement et de Conseils · +224 628 142 188 · info@spc-guinee.com</p></section>`;
  }
  async function showPoster(list) {
    const html = (await Promise.all(list.map(posterHtml))).join('');
    let v = document.getElementById('posterView');
    if (!v) { v = document.createElement('div'); v.id = 'posterView'; document.body.appendChild(v); }
    v.innerHTML = `<div class="pbar"><b>Affiche${list.length > 1 ? 's' : ''} de pointage</b><button class="primary" data-act="print">Imprimer</button><button data-act="closeposter">Fermer</button></div><div class="psheets">${html}</div>`;
    v.classList.add('on'); closeModal();
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
    if (e.target.id === 's_client') { const c = CL && CL.clients.find(x => x.ref === e.target.value); if (c) { $('#s_nom').value = c.nom; $('#s_adr').value = c.adresse || ''; $('#s_cli').value = c.ref; } }
    if (e.target.id === 'day') { day = e.target.value || SPC.localDate(); render(); }
    if (e.target.id === 'month') { month = e.target.value || month; counts().then(render); }
    if (e.target.id === 'keyfile' && e.target.files[0]) { try { const j = JSON.parse(await e.target.files[0].text()); for (const [k, v] of Object.entries(j)) keys[k] = Array.from(new Set((keys[k] || []).concat(v))); await db.set('kv', 'keys', keys); await verify(); render(); toast('Clés importées'); } catch (er) { toast('Fichier de clés invalide'); } }
  });
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return; const d = b.dataset;
    switch (d.act) {
      case 'tab': tab = d.tab; render(); break;
      case 'close': closeModal(); break;
      case 'reload': load(); break;
      case 'showxkey': { const i = $('#xkeyshow'); i.type = i.type === 'password' ? 'text' : 'password'; break; }
      case 'regenx': if (confirm("Régénérer la clé d'échange ? La fiche du personnel est rechiffrée tout de suite. SPC Gestion devra recevoir la nouvelle clé (Réglages, Pointages) et renverra les clients et les plannings.")) { keys.__echange.push(SPC.newKey()); await db.set('kv', 'keys', keys); XK = await xkey(); try { await publishEmployes(true); await SPC.sync(db, cfg); } catch (er) { /* republié au prochain chargement */ } await counts(); render(); toast("Nouvelle clé générée : copiez-la dans SPC Gestion"); } break;
      case 'copyxkey': try { await navigator.clipboard.writeText(XK); toast('Clé copiée'); } catch (er) { $('#xkeyshow').select(); toast('Sélectionnée : copiez-la avec Ctrl + C'); } break;
      case 'publish': { const pe = await publishEmployes(true), pp = await publishExport(month, true), ok = pe || pp; if (ok) { try { await SPC.sync(db, cfg); } catch (er) { /* hors connexion : parti plus tard */ } } await counts(); render(); toast(ok ? (navigator.onLine ? 'Publié dans le dépôt' : 'Enregistré : sera envoyé au retour de la connexion') : 'Rien à publier'); break; }
      case 'saveconfig': {
        const repo = $('#c_repo').value.trim(), token = $('#c_token').value.trim(), dt = $('#c_dtoken').value.trim();
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token || !dt) return toast('Renseignez le dépôt et les deux jetons');
        cfg = { repo, branch: $('#c_branch').value.trim() || 'main', token, deviceToken: dt, apiBase: $('#c_api').value.trim(), settings: { pause: 1, retard: 5 } }; await db.set('kv', 'cfg', cfg); render(); load(); break;
      }
      case 'config': if (confirm('Modifier la connexion ? Les clés de signature sont conservées.')) { const old = cfg; cfg = null; render(); $('#c_repo').value = old.repo; $('#c_branch').value = old.branch; $('#c_api').value = old.apiBase || ''; } break;
      case 'saveset': cfg.settings = { pause: +$('#set_pause').value || 0, retard: +$('#set_retard').value || 0, gpsAlert: +$('#set_gps').value || 0, autoExport: $('#set_auto').checked }; await verify(); await db.set('kv', 'cfg', cfg); render(); toast('Règles enregistrées'); break;
      case 'applypl': { const p = PL.plannings.find(x => x.ref === d.ref); if (p && await applyPlanning(p)) { await counts(); render(); load(); toast('Planning appliqué'); } break; }
      case 'applyplall': { let n = 0; for (const p of PL.plannings) if (await applyPlanning(p)) n++; await counts(); render(); load(); toast(n + ' planning(s) appliqué(s)'); break; }
      case 'newagent': agentForm(); break;
      case 'editagent': agentForm(D.agents.find(a => a.id === d.id)); break;
      case 'saveagent': saveAgent(d.id); break;
      case 'link': showLink(D.agents.find(a => a.id === d.id)); break;
      case 'copy': { const t = $('#lk'); t.select(); try { await navigator.clipboard.writeText(t.value); } catch (er) { document.execCommand('copy'); } toast('Lien copié'); break; }
      case 'rekey': if (confirm("Générer une nouvelle clé ? L'ancien appareil ne pourra plus pointer tant qu'il n'est pas réactivé avec le nouveau lien. Les anciens pointages restent vérifiables.")) { keys[d.id] = (keys[d.id] || []).concat(SPC.newKey()); await db.set('kv', 'keys', keys); showLink(D.agents.find(a => a.id === d.id)); } break;
      case 'toggleagent': { const a = D.agents.find(x => x.id === d.id); a.actif = a.actif === false; write('agents/' + a.id + '.json', a, 'replace'); break; }
      case 'sitefromclient': { const c = CL.clients.find(x => x.ref === d.ref); if (c) { await createSiteFromClient(c); await counts(); render(); load(); toast('Lieu créé : imprimez son code QR'); } break; }
      case 'sitesfromclients': { const l = CL.clients.filter(c => !siteOf(c)); for (const c of l) await createSiteFromClient(c); await counts(); render(); load(); toast(l.length + ' lieu(x) créé(s)'); break; }
      case 'syncsite': { const s = D.sites.find(x => x.id === d.id), c = CL && CL.clients.find(x => x.ref === s.clientRef); if (s && c) { s.nom = c.nom; s.adresse = c.adresse || ''; s.updatedAt = new Date().toISOString(); await write('sites/' + s.id + '.json', s, 'replace'); toast('Lieu mis à jour depuis SPC Gestion'); } break; }
      case 'newsite': siteForm(null); break;
      case 'editsite': siteForm(D.sites.find(s => s.id === d.id)); break;
      case 'savesite': saveSite(d.id); break;
      case 'badge': await showBadge(D.agents.find(a => a.id === d.id)); break;
      case 'badgeprint': showBadges([D.agents.find(a => a.id === d.id)]); break;
      case 'badgeall': { const l = D.agents.filter(a => a.role === 'agent' && a.actif !== false && a.badgeHash); if (!l.length) toast('Aucun agent avec un badge actif'); else showBadges(l); break; }
      case 'badgeregen': if (confirm("Remplacer ce badge ? L'ancien badge sera refusé dès que les téléphones se seront synchronisés.")) { const a = D.agents.find(x => x.id === d.id); a.badgeVersion = (a.badgeVersion || 1) + 1; a.badgeHash = await SPC.badgeHash(a.id, await agentCode(a)); await write('agents/' + a.id + '.json', a, 'replace'); await showBadge(a); } break;
      case 'qr': await showQr(D.sites.find(s => s.id === d.id)); break;
      case 'poster': showPoster([D.sites.find(s => s.id === d.id)]); break;
      case 'posterall': { const l = D.sites.filter(s => s.actif !== false && s.qrHash); if (!l.length) toast('Aucun lieu avec un code QR actif'); else showPoster(l); break; }
      case 'print': window.print(); break;
      case 'closeposter': document.getElementById('posterView').classList.remove('on'); break;
      case 'regen': if (confirm("Remplacer le code QR de ce lieu ? Les affiches déjà imprimées ne fonctionneront plus : il faudra imprimer et poser la nouvelle.")) { const s = D.sites.find(x => x.id === d.id); s.qrVersion = (s.qrVersion || 1) + 1; s.qrHash = await SPC.qrHash(s.id, await siteCode(s)); await write('sites/' + s.id + '.json', s, 'replace'); await showQr(s); } break;
      case 'togglesite': { const s = D.sites.find(x => x.id === d.id); s.actif = s.actif === false; write('sites/' + s.id + '.json', s, 'replace'); break; }
      case 'newasg': if (!D.agents.length || !D.sites.length) toast("Créez d'abord au moins un agent et un lieu"); else asgForm(null); break;
      case 'editasg': asgForm(D.assignments.find(a => a.id === d.id)); break;
      case 'saveasg': saveAsg(d.id); break;
      case 'csv': {
        const { entries } = monthStats(month), head = ['Date', 'Code agent', 'Agent', 'Lieu', 'Client', 'Arrivée', 'Départ', 'Heures', 'Retard (min)', 'État', 'Alertes'];
        const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
        download('pointages-' + month + '.csv', '\ufeff' + [head.map(q).join(';')].concat(entries.map(r => [r.date, r.agentCode, r.agentNom, r.siteNom, r.clientRef, r.arr, r.dep, String(r.heures).replace('.', ','), r.retardMin, r.etat, r.alertes.join(' | ')].map(q).join(';'))).join('\r\n'), 'text/csv'); break;
      }
      case 'json': download('spc-pointages-' + month + '.json', JSON.stringify(buildExport(month), null, 1), 'application/json'); break;
      case 'exportkeys': download('spc-cles-signature.json', JSON.stringify(keys), 'application/json'); toast('Gardez ce fichier en lieu sûr'); break;
    }
  });
  boot();
})();
