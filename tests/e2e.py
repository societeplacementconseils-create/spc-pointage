"""Test de bout en bout du pointage par code QR : central, superviseur, deux agents, coupure de connexion, falsification.
Usage : python3 tests/e2e.py   (Playwright + Chromium + OpenCV requis ; un faux serveur GitHub est lancé automatiquement)"""
import json, subprocess, time, urllib.request, os, sys, re
from playwright.sync_api import sync_playwright
import numpy as np, cv2
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE=(9.5785,-13.6330)
TODAY=time.strftime('%Y-%m-%d'); MONTH=time.strftime('%Y-%m')
def geo(lat,lon,acc=8): return {'latitude':lat,'longitude':lon,'accuracy':acc}
def dump(): return json.load(urllib.request.urlopen('http://localhost:4010/__admin/dump'))
def post(path,obj): urllib.request.urlopen(urllib.request.Request('http://localhost:4010/__admin/'+path,json.dumps(obj).encode(),{'Content-Type':'application/json'}))
def dayfile(agent): return f'pointages/{MONTH}/{TODAY}/{agent}.json'
procs=[subprocess.Popen(['node',ROOT+'/tests/mock-github.js','4010'],stdout=subprocess.DEVNULL),subprocess.Popen(['python3','-m','http.server','4020','--directory',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)]
time.sleep(1.2); errs=[]; OK=[]
def check(label,cond,extra=''):
    OK.append((label,bool(cond))); print(('  [OK] ' if cond else '  [ÉCHEC] ')+label+(' '+str(extra) if extra and not cond else ''))
SCAN_MOCK="""(()=>{window.BarcodeDetector=class{constructor(o){}async detect(){const q=window.__qrq;if(q&&q.length)return [{rawValue:q.shift()}];return window.__qr?[{rawValue:window.__qr}]:[]}};})()"""
try:
  with sync_playwright() as p:
    b=p.chromium.launch(args=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
    def ctx(g=None,perm=('geolocation','camera'),scan=False):
        c=b.new_context(viewport={'width':420,'height':860},geolocation=g,permissions=list(perm) if g else ['camera'],accept_downloads=True)
        if scan: c.add_init_script(SCAN_MOCK)
        pg=c.new_page(); pg.on('pageerror',lambda e:(errs.append(str(e)),print('   erreur page:',str(e)[:200]))); return c,pg
    def agent_text(pg): return pg.inner_text('body')
    # ---------- 1. Central ----------
    print('1. Application centrale : utilisateurs, lieu, code QR, affiche, planning')
    cc,cp=ctx(None); cp.goto('http://localhost:4020/central/index.html'); cp.wait_for_timeout(400)
    cp.fill('#c_repo','spc/data'); cp.fill('#c_token','test-token'); cp.fill('#c_dtoken','test-token'); cp.evaluate("document.querySelector('details').open=true"); cp.fill('#c_api','http://localhost:4010'); cp.click('[data-act=saveconfig]'); cp.wait_for_timeout(600)
    links={}
    for nom,role in [('Mamadou Sylla','superviseur'),('Fanta Camara','agent'),('Aminata Bah','agent')]:
        cp.click('[data-act=tab][data-tab=agents]'); cp.click('[data-act=newagent]'); cp.fill('#a_nom',nom); cp.select_option('#a_role',role); cp.click('[data-act=saveagent]'); cp.wait_for_timeout(500)
        links[nom]=cp.input_value('#lk'); cp.click('[data-act=close]')
    check('3 utilisateurs créés avec lien d\'activation',all('#enroll=' in v for v in links.values()))
    cp.click('[data-act=tab][data-tab=sites]'); cp.click('[data-act=newsite]'); cp.fill('#s_nom','Résidence Test'); cp.fill('#s_adr','Kipé, Ratoma'); cp.fill('#s_cli','CLI-2026-001'); cp.fill('#s_lat',str(SITE[0])); cp.fill('#s_lon',str(SITE[1])); cp.select_option('#s_sup',index=1); cp.click('[data-act=savesite]'); cp.wait_for_timeout(900)
    QR=cp.evaluate("document.getElementById('qrtext').value"); m=re.match(r'^SPC1\|(S-[0-9a-f]+)\|([0-9A-Z]{4}(-[0-9A-Z]{4}){3})$',QR)
    check('le code QR du lieu est généré à la création (format SPC1|identifiant|code)',bool(m),QR)
    SID=m.group(1); CODE=m.group(2)
    site=json.loads(dump()['sites/'+SID+'.json']); check("l'empreinte du code (et non le code) est écrite dans le dépôt",site.get('qrHash') and CODE not in json.dumps(dump()) and site['qrVersion']==1)
    cp.click('[data-act=poster]'); cp.wait_for_timeout(500); check("l'affiche s'affiche avec le nom du lieu, le logo et le code de secours",cp.locator('#posterView.on .poster').count()==1 and 'Résidence Test' in cp.inner_text('#posterView') and CODE in cp.inner_text('#posterView'))
    cp.locator('.pqr svg').screenshot(path='/tmp/poster-qr.png'); img=cv2.imread('/tmp/poster-qr.png'); img=cv2.resize(img,None,fx=2,fy=2,interpolation=cv2.INTER_NEAREST)
    val,_,_=cv2.QRCodeDetector().detectAndDecode(img); check("le code QR de l'affiche est lisible par un lecteur externe (OpenCV) et contient le bon texte",val==QR,val)
    if os.environ.get('SHOTS'): cp.set_viewport_size({'width':900,'height':900}); cp.screenshot(path='/tmp/shot_poster.png'); cp.set_viewport_size({'width':420,'height':860})
    cp.click('[data-act=closeposter]')
    for nom in ['Fanta Camara','Aminata Bah']:
        cp.click('[data-act=tab][data-tab=asg]'); cp.click('[data-act=newasg]'); cp.select_option('#g_agent',label=nom)
        for i in range(6,8): cp.check(f'.g_j[value="{i}"]')
        cp.fill('#g_deb','00:00'); cp.fill('#g_fin','23:59'); cp.click('[data-act=saveasg]'); cp.wait_for_timeout(500)
    d=dump(); check('agents, lieu et affectations écrits dans le dépôt',len([k for k in d if k.startswith('agents/')])==3 and len([k for k in d if k.startswith('assignments/')])==2)
    cp.click('[data-act=tab][data-tab=agents]'); cp.wait_for_timeout(300)
    BT={}
    for nom,key in [('Fanta Camara','F'),('Aminata Bah','A')]:
        cp.locator('.card',has_text=nom).locator('[data-act=badge]').click(); cp.wait_for_timeout(500)
        BT[key]=cp.evaluate("document.getElementById('badgetext').value")
        if key=='F':
            cp.locator('.badge .bqr svg').first.screenshot(path='/tmp/badge-qr.png'); img=cv2.imread('/tmp/badge-qr.png'); img=cv2.resize(img,None,fx=3,fy=3,interpolation=cv2.INTER_NEAREST)
            val,_,_=cv2.QRCodeDetector().detectAndDecode(img); check('le QR du badge est lisible par un lecteur externe et contient le bon texte',val==BT['F'],val)
            check('le badge affiche le nom, l\'identifiant et le code de secours','Fanta Camara' in cp.inner_text('#modal') and 'AGT-001' in cp.inner_text('#modal'))
        cp.click('[data-act=close]')
    check('badges des agents au format SPC1B|identifiant|code',all(re.match(r'^SPC1B\|AGT-00[12]\|([0-9A-Z]{4}-){3}[0-9A-Z]{4}$',v) for v in BT.values()),BT)
    CODE_BF=BT['F'].split('|')[2]; check("l'empreinte du badge (et non son code) est dans le dépôt",json.loads(dump()['agents/AGT-001.json']).get('badgeHash') and CODE_BF not in json.dumps(dump()))
    cp.click('[data-act=badgeall]'); cp.wait_for_timeout(600); check("l'impression de tous les badges produit une planche avec un badge par agent",cp.locator('#posterView.on .badge').count()==2); 
    if os.environ.get('SHOTS'): cp.set_viewport_size({'width':900,'height':500}); cp.wait_for_timeout(300); cp.screenshot(path='/tmp/shot_badgesheet.png'); cp.set_viewport_size({'width':420,'height':860})
    cp.click('[data-act=closeposter]')
    # lieu ancien sans code QR (créé avant la nouveauté) : le central le complète
    post('set',{'path':'sites/S-ancien.json','content':json.dumps({'id':'S-ancien','nom':'Ancien lieu','actif':True,'lat':9.6,'lon':-13.6,'rayon':100})})
    cp.click('[data-act=tab][data-tab=day]'); cp.click('[data-act=reload]'); cp.wait_for_timeout(3000)
    old=json.loads(dump()['sites/S-ancien.json']); check('un lieu existant sans code QR reçoit automatiquement son code',bool(old.get('qrHash')) and old.get('qrVersion')==1,old)
    # ---------- 2. Agent : saisie du code, scan, hors connexion ----------
    print('2. Agent (Fanta) : saisie du code, scan caméra, hors connexion, position facultative')
    ac,ap=ctx(geo(*SITE),scan=True); ap.goto(links['Fanta Camara']); ap.wait_for_timeout(1800)
    body=agent_text(ap); check('lieu du jour et bouton « Scanner le code QR du lieu » affichés','Résidence Test' in body and 'Scanner le code QR du lieu' in body)
    if os.environ.get('SHOTS'): ap.screenshot(path='/tmp/shot_agent.png')
    ap.click('[data-act=manual]'); ap.fill('#mcode','aaaa-bbbb-cccc-dddd'); ap.click('[data-act=mvalid]'); ap.wait_for_timeout(500); check('un mauvais code est refusé','Pointage impossible' in ap.inner_text('#modal'),ap.inner_text('#modal')[:80]); ap.click('[data-act=close]')
    ap.click('[data-act=manual]'); ap.fill('#mcode',CODE.lower().replace('-',' ')); ap.click('[data-act=mvalid]'); ap.wait_for_timeout(500)
    t=ap.inner_text('#modal'); check("le code saisi (minuscules, espaces) identifie le lieu et propose l'arrivée",'Résidence Test' in t and "l'arrivée" in t,t[:100])
    ap.click('[data-act=confirm]'); ap.wait_for_timeout(3000); check('arrivée enregistrée','Arrivée enregistrée' in ap.inner_text('#modal'),ap.inner_text('#modal')[:80]); ap.click('[data-act=close]'); ap.wait_for_timeout(500)
    ev=json.loads(dump().get(dayfile('AGT-001'),'[]')); check("l'arrivée est dans le dépôt, signée, mode « qr », avec la position à titre d'information",len(ev)==1 and ev[0]['mode']=='qr' and ev[0]['zone']=='qr' and ev[0]['sig'] and ev[0]['dist'] is not None and ev[0]['dist']<100,ev)
    ap.evaluate("window.__qr='SPC1|S-inconnu|AAAA-BBBB-CCCC-DDDD'"); ap.click('[data-act=scan]'); ap.wait_for_timeout(1800); check('un code QR d\'un lieu inconnu est refusé','Pointage impossible' in ap.inner_text('#modal'),ap.inner_text('#modal')[:80]); ap.evaluate("window.__qr=null"); ap.click('[data-act=close]')
    bad=QR[:-4]+('ABCD' if not QR.endswith('ABCD') else 'WXYZ'); ap.evaluate("v=>window.__qr=v",bad); ap.click('[data-act=scan]'); ap.wait_for_timeout(1800); t=ap.inner_text('#modal'); check('un code QR falsifié (bon lieu, mauvais code) est refusé','invalide' in t,t[:100]); ap.evaluate("window.__qr=null"); ap.click('[data-act=close]')
    ac.set_offline(True); ap.wait_for_timeout(300)
    ap.evaluate("v=>window.__qr=v",QR); ap.click('[data-act=scan]'); ap.wait_for_timeout(2000); t=ap.inner_text('#modal'); check("scan caméra hors connexion : le lieu est reconnu et le départ proposé",'Résidence Test' in t and 'le départ' in t,t[:120]); ap.evaluate("window.__qr=null")
    ap.click('[data-act=confirm]'); ap.wait_for_timeout(3000); t=ap.inner_text('#modal'); check('départ enregistré hors connexion','Départ enregistré' in t and 'retour de la connexion' in t,t[:120]); ap.click('[data-act=close]'); ap.wait_for_timeout(500)
    check('1 pointage en attente affiché','1 à envoyer' in ap.inner_text('header'),ap.inner_text('header'))
    ap.reload(); ap.wait_for_timeout(1500); check('application ouverte sans connexion','Résidence Test' in ap.inner_text('body') and 'Hors ligne' in ap.inner_text('header'))
    ac.set_offline(False); ap.wait_for_timeout(300); ap.evaluate("window.dispatchEvent(new Event('online'))"); ap.wait_for_timeout(2800)
    ev=json.loads(dump().get(dayfile('AGT-001'),'[]')); check('synchronisation au retour de la connexion : 2 événements, chaîne intacte',len(ev)==2 and ev[1]['prev']==ev[0]['hash'] and ev[1]['type']=='OUT')
    ac.set_geolocation(geo(SITE[0]+0.003,SITE[1],8)); ap.wait_for_timeout(300)
    ap.evaluate("v=>window.__qr=v",QR); ap.click('[data-act=scan]'); ap.wait_for_timeout(2000); ap.evaluate("window.__qr=null"); ap.click('[data-act=confirm]'); ap.wait_for_timeout(3200); ap.click('[data-act=close]'); ap.wait_for_timeout(500)
    ev=json.loads(dump().get(dayfile('AGT-001'),'[]')); check("une position éloignée (~330 m) n'empêche pas le pointage QR : distance enregistrée à titre d'information",len(ev)==3 and ev[2]['type']=='IN' and ev[2]['dist']>250,ev[-1:])
    ac.grant_permissions([]); 
    # ---------- Agent 2 : sans autorisation de position ----------
    print('3. Agent (Aminata) : sans position GPS')
    bc,bp=ctx(None,scan=True); bp.goto(links['Aminata Bah']); bp.wait_for_timeout(1800)
    bp.evaluate("v=>window.__qr=v",QR); bp.click('[data-act=scan]'); bp.wait_for_timeout(2000); bp.evaluate("window.__qr=null"); bp.click('[data-act=confirm]'); bp.wait_for_timeout(3500); bp.click('[data-act=close]'); bp.wait_for_timeout(500)
    e2=json.loads(dump().get(dayfile('AGT-002'),'[]')); check('pointage QR possible sans aucune position GPS (la position reste vide)',len(e2)==1 and e2[0]['lat'] is None and e2[0]['mode']=='qr',e2)
    # ---------- Superviseur ----------
    print('4. Superviseur : équipe, lieux en lecture seule, pointage manuel')
    sc,sp=ctx(None,scan=True); sp.goto(links['Mamadou Sylla']); sp.wait_for_timeout(2000); body=sp.inner_text('body'); check("équipe du jour visible",'Fanta Camara' in body and 'Aminata Bah' in body,body[:200])
    sp.click('[data-act=tab][data-tab=sites]'); sp.wait_for_timeout(200); t=sp.inner_text('body'); check("la liste des lieux est en lecture seule (pas de création de lieu)",'Résidence Test' in t and 'QR actif' in t and 'Enregistrer un nouveau lieu' not in t)
    sp.click('[data-act=tab][data-tab=manual]'); sp.select_option('#m_agent',label='Aminata Bah'); sp.select_option('#m_site',label='Résidence Test'); sp.select_option('#m_type','OUT'); sp.fill('#m_why','Téléphone en panne'); sp.click('[data-act=manual]'); sp.wait_for_timeout(2800)
    e2=json.loads(dump().get(dayfile('AGT-002'),'[]')); check('pointage manuel signé par le superviseur',any(e['mode']=='manuel' and e['signerId']=='SUP-001' and e['agentId']=='AGT-002' for e in e2),e2)
    # ---------- Superviseur : pointage par badges ----------
    print('4b. Superviseur : pointage d\'un groupe par badges')
    sp.click('[data-act=tab][data-tab=badges]'); sp.wait_for_timeout(300); tb=sp.inner_text('body'); check("l'écran Badges liste l'appel du jour",'Pointage par badges' in tb and 'Appel du jour' in tb and 'Fanta Camara' in tb and 'Aminata Bah' in tb)
    wrong='SPC1B|AGT-002|AAAA-BBBB-CCCC-DDDD'
    sp.evaluate("q=>window.__qrq=q",[BT['F'],BT['A'],BT['F'],'SPC1B|AGT-009|AAAA-BBBB-CCCC-DDDD',wrong,'SPC1|S-xyz|AAAA-BBBB-CCCC-DDDD'])
    sp.click('[data-act=bscan]'); sp.wait_for_timeout(4500); feed=sp.inner_text('#bfeed')
    if os.environ.get('SHOTS'): sp.screenshot(path='/tmp/shot_badges.png')
    check("les badges du groupe sont scannés l'un après l'autre (2 agents pointés)",'Fanta Camara :' in feed and 'Aminata Bah :' in feed,feed)
    check('badge inconnu, badge falsifié et code qui n\'est pas un badge sont refusés','Badge inconnu' in feed and 'invalide' in feed and "pas un badge" in feed,feed)
    sp.click('[data-act=bstop]'); sp.wait_for_timeout(3000)
    def badge_events(agent): return [e for e in json.loads(dump().get(dayfile(agent),'[]')) if e['mode']=='badge']
    bf,ba=badge_events('AGT-001'),badge_events('AGT-002')
    check("un pointage par badge est signé par le chef d'équipe, mode « badge » ; le second scan du même badge est ignoré",len(bf)==1 and len(ba)==1 and bf[0]['signerId']=='SUP-001' and bf[0]['agentId']=='AGT-001' and bf[0]['zone']=='badge' and bf[0]['sig'],(bf,ba))
    sc.set_offline(True); sp.wait_for_timeout(300)
    sp.click('[data-act=bmanual]'); sp.fill('#bcode',CODE_BF.lower()); sp.click('[data-act=bcode]'); sp.wait_for_timeout(1500)
    check('pointage par code de badge saisi, hors connexion : mis en attente','à envoyer' in sp.inner_text('header'),sp.inner_text('header'))
    sc.set_offline(False); sp.wait_for_timeout(300); sp.evaluate("window.dispatchEvent(new Event('online'))"); sp.wait_for_timeout(3000)
    check('le pointage par badge hors connexion arrive au retour du réseau',len(badge_events('AGT-001'))==2)
    ap.click('[data-act=tab][data-tab=set]'); ap.click('[data-act=sync]'); ap.wait_for_timeout(2800); ap.click('[data-act=tab][data-tab=hist]'); ap.wait_for_timeout(400)
    check("l'agent voit sur son téléphone les pointages faits par badge (historique)",'badge' in ap.inner_text('body'),ap.inner_text('body')[:300]); ap.click('[data-act=tab][data-tab=today]')
    # ---------- Central : contrôle ----------
    print('5. Contrôle par le central')
    cp.click('[data-act=tab][data-tab=day]'); cp.click('[data-act=reload]'); cp.wait_for_timeout(3000); t=cp.inner_text('body')
    check('journée affichée avec les deux agents',('Fanta Camara' in t) and ('Aminata Bah' in t),t[:300])
    check('pointage manuel signalé','Pointage manuel' in t); check('pointages par badge signalés avec le chef d\'équipe','Badge scanné par SUP-001' in t); check('aucune signature invalide sur les données saines','Signature invalide' not in t and 'Empreinte modifiée' not in t)
    # ---------- Renvoi vers l'application de gestion : fichier vérifié publié par le central ----------
    print("5b. Publication automatique vers l'application de gestion")
    d=dump(); exk=[k for k in d if k.startswith('exports/pointages-')]
    check('le central publie automatiquement exports/pointages-AAAA-MM.json dans le dépôt de données',exk==['exports/pointages-'+MONTH+'.json'],exk)
    pub=json.loads(d[exk[0]]) if exk else {}
    check('le fichier publié est au format spc-pointages v2 avec le mode de chaque pointage (qr, badge, manuel)',pub.get('format')=='spc-pointages' and pub.get('version')==2 and pub.get('mois')==MONTH and any('qr' in e.get('modes',[]) for e in pub.get('entrees',[])) and any('badge' in e.get('modes',[]) for e in pub.get('entrees',[])) and any('manuel' in e.get('modes',[]) for e in pub.get('entrees',[])),json.dumps(pub)[:300])
    check("le fichier contient le code client du lieu, l'agent, les heures d'arrivée et de départ",all(e.get('clientRef')=='CLI-2026-001' and e.get('agentCode') and e.get('agentNom') for e in pub.get('entrees',[])) and any(e.get('arr') for e in pub.get('entrees',[])))
    json.dump(pub,open('/tmp/published-export.json','w'))
    cp.click('[data-act=tab][data-tab=month]'); cp.wait_for_timeout(500); t2=cp.inner_text('body')
    check("l'onglet Mois indique la dernière publication et propose « Publier maintenant »",'Publié' in t2 and 'Publier maintenant' in t2,t2[-300:])
    before=json.loads(dump()['exports/pointages-'+MONTH+'.json'])['genere']; cp.click('[data-act=publish]'); cp.wait_for_timeout(2500)
    after=json.loads(dump()['exports/pointages-'+MONTH+'.json'])['genere']; check('« Publier maintenant » réécrit le fichier dans le dépôt',after!=before)
    cp.click('[data-act=tab][data-tab=day]')
    if os.environ.get('SHOTS'): cp.set_viewport_size({'width':1100,'height':800}); cp.wait_for_timeout(300); cp.screenshot(path='/tmp/shot_central.png'); cp.set_viewport_size({'width':420,'height':860})
    cp.click('[data-act=tab][data-tab=set]'); cp.fill('#set_gps','200'); cp.click('[data-act=saveset]'); cp.wait_for_timeout(300); cp.click('[data-act=tab][data-tab=day]'); cp.wait_for_timeout(300)
    check("l'alerte facultative « scan loin du lieu » signale le scan à ~330 m",re.search(r'Scan à \d{3} m du lieu',cp.inner_text('body')) is not None)
    cp.click('[data-act=tab][data-tab=set]'); cp.fill('#set_gps','0'); cp.click('[data-act=saveset]'); cp.wait_for_timeout(300)
    # remplacement du code QR
    cp.click('[data-act=tab][data-tab=sites]'); cp.locator('[data-act=qr]').first.click(); cp.wait_for_timeout(600); cp.once('dialog',lambda d:d.accept()); cp.click('[data-act=regen]'); cp.wait_for_timeout(2800)
    QR2=cp.evaluate("document.getElementById('qrtext').value"); check('le remplacement du code produit un nouveau code',QR2!=QR and QR2.split('|')[1]==SID,(QR,QR2)); cp.click('[data-act=close]')
    ap.click('[data-act=tab][data-tab=set]'); ap.click('[data-act=sync]'); ap.wait_for_timeout(2800); ap.click('[data-act=tab][data-tab=today]'); ap.wait_for_timeout(300)
    ap.evaluate("v=>window.__qr=v",QR); ap.click('[data-act=scan]'); ap.wait_for_timeout(1800); t=ap.inner_text('#modal'); check("l'ancien code QR est refusé après le remplacement",'invalide' in t,t[:100]); ap.evaluate("window.__qr=null"); ap.click('[data-act=close]')
    ap.evaluate("v=>window.__qr=v",QR2); ap.click('[data-act=scan]'); ap.wait_for_timeout(1800); t=ap.inner_text('#modal'); check('le nouveau code QR est accepté','Résidence Test' in t and 'Confirmer' in t,t[:100]); ap.evaluate("window.__qr=null"); ap.click('[data-act=close]')
    cp.click('[data-act=tab][data-tab=agents]'); cp.locator('.card',has_text='Fanta Camara').locator('[data-act=badge]').click(); cp.wait_for_timeout(500); cp.once('dialog',lambda d:d.accept()); cp.click('[data-act=badgeregen]'); cp.wait_for_timeout(2800)
    BF2=cp.evaluate("document.getElementById('badgetext').value"); check('le remplacement du badge produit un nouveau code',BF2!=BT['F'] and BF2.startswith('SPC1B|AGT-001|'),BF2); cp.click('[data-act=close]')
    sp.click('[data-act=tab][data-tab=set]'); sp.click('[data-act=sync]'); sp.wait_for_timeout(3000); sp.click('[data-act=tab][data-tab=badges]'); sp.click('[data-act=bmanual]'); sp.fill('#bcode',CODE_BF); sp.click('[data-act=bcode]'); sp.wait_for_timeout(600)
    check("l'ancien badge est refusé après son remplacement","Aucun badge ne correspond" in sp.inner_text('body'),sp.inner_text('body')[-200:]); sp.click('[data-act=bstop]')
    # falsification et suppression
    day=dayfile('AGT-001'); raw=json.loads(dump()[day]); raw[0]['t']=raw[0]['t'].replace('T','T0',1) if False else raw[0]['t']; raw[0]['dist']=raw[0]['dist']+7; post('set',{'path':day,'content':json.dumps(raw)})
    cp.click('[data-act=tab][data-tab=day]'); cp.click('[data-act=reload]'); cp.wait_for_timeout(2500); check('modification d\'un pointage détectée','Empreinte modifiée' in cp.inner_text('body'))
    raw=json.loads(dump()[day]); post('set',{'path':day,'content':json.dumps(raw[1:])})
    cp.click('[data-act=reload]'); cp.wait_for_timeout(2500); check("suppression d'un pointage détectée",'disparu' in cp.inner_text('body'))
    cp.click('[data-act=tab][data-tab=month]'); cp.wait_for_timeout(300)
    with cp.expect_download() as dl: cp.click('[data-act=json]')
    ex=json.load(open(dl.value.path())); check("export JSON pour l'application SPC",ex['format']=='spc-pointages' and len(ex['entrees'])>=2 and ex['entrees'][0]['clientRef']=='CLI-2026-001',list(ex)[:4]); json.dump(ex,open('/tmp/export-pointages.json','w'))
    cp.click('[data-act=tab][data-tab=set]'); 
    with cp.expect_download() as dl: cp.click('[data-act=exportkeys]')
    kj=json.load(open(dl.value.path())); check('la sauvegarde des clés contient la clé maîtresse des codes QR et les clés des agents','__master' in kj and 'AGT-001' in kj,list(kj))
    # ---------- Échanges avec SPC Gestion : employés (central -> gestion), clients (gestion -> central) ----------
    print("6. Échanges de données : employés vers la gestion, clients vers le central")
    emp=json.loads(dump().get('exports/employes.json','{}'))
    raw_emp=dump().get('exports/employes.json','')
    check("le central publie la fiche du personnel dans exports/employes.json, CHIFFRÉE (illisible sans la clé d'échange)",emp.get('format')=='spc-employes' and emp.get('version')==2 and emp.get('chiffre') is True and emp.get('data') and 'Fanta' not in raw_emp and 'AGT-001' not in raw_emp,list(emp))
    xk=cp.evaluate("SPC.db('spc-central').get('kv','keys').then(k=>k.__echange[k.__echange.length-1])")
    dec=cp.evaluate("([k,e])=>SPC.xDecrypt(k,e)",[xk,emp]); codes=sorted(e['code'] for e in dec['employes'])
    check("avec la clé d'échange, la fiche contient les 2 agents et le superviseur, sans clé de signature ni empreinte",codes==['AGT-001','AGT-002','SUP-001'] and 'badgeHash' not in json.dumps(dec) and all('nomFamille' in e for e in dec['employes']),codes)
    cl={'format':'spc-clients','version':1,'genere':time.strftime('%Y-%m-%dT%H:%M:%S.000Z'),'source':'gestion','clients':[
      {'ref':'CLI-2026-001','nom':'Résidence Test','adresse':'Kipé, Ratoma, près du rond-point','poles':['Placement RH'],'horaires':'7h30 à 17h30'},
      {'ref':'CLI-2026-002','nom':'Famille Bah','adresse':'Lambanyi, Ratoma','poles':['Placement RH'],'horaires':'8h à 16h'},
      {'ref':'CLI-2026-003','nom':'Famille Sow','adresse':'Nongo, Ratoma','poles':[],'horaires':''}]}
    post('set',{'path':'echange/clients.json','content':json.dumps(cl)})
    cp.click('[data-act=tab][data-tab=day]'); cp.click('[data-act=reload]'); cp.wait_for_timeout(3000); cp.click('[data-act=tab][data-tab=sites]'); cp.wait_for_timeout(400); tx=cp.inner_text('body')
    check("l'onglet Lieux affiche les clients reçus de SPC Gestion avec l'état de chaque lieu",'Clients de SPC Gestion' in tx and 'Famille Bah' in tx and 'Famille Sow' in tx and 'Sans lieu' in tx and 'Différent de SPC Gestion' in tx,tx[:400])
    cp.locator('[data-act=sitefromclient][data-ref="CLI-2026-002"]').click(); cp.wait_for_timeout(3000)
    sites={k:json.loads(v) for k,v in dump().items() if k.startswith('sites/')}; bah=[s for s in sites.values() if s.get('clientRef')=='CLI-2026-002']
    check("« Créer le lieu » crée le lieu du client (nom, adresse, code client) avec son code QR",len(bah)==1 and bah[0]['nom']=='Famille Bah' and bah[0]['adresse']=='Lambanyi, Ratoma' and bah[0].get('qrHash'),bah)
    cp.click('[data-act=sitesfromclients]'); cp.wait_for_timeout(3000); sites={k:json.loads(v) for k,v in dump().items() if k.startswith('sites/')}
    check("« Créer les lieux manquants » crée le lieu des autres clients, sans doublon",len([s for s in sites.values() if s.get('clientRef')=='CLI-2026-003'])==1 and len([s for s in sites.values() if s.get('clientRef')=='CLI-2026-002'])==1)
    cp.locator('[data-act=syncsite]').first.click(); cp.wait_for_timeout(3000); sites={k:json.loads(v) for k,v in dump().items() if k.startswith('sites/')}
    check("« Mettre à jour » reprend l'adresse du client de SPC Gestion dans le lieu existant",[s['adresse'] for s in sites.values() if s.get('clientRef')=='CLI-2026-001']==['Kipé, Ratoma, près du rond-point'])
    cp.click('[data-act=newsite]'); cp.wait_for_timeout(300); check("le formulaire de lieu propose de choisir un client de SPC Gestion",cp.locator('#s_client').count()==1)
    cp.select_option('#s_client','CLI-2026-003'); cp.wait_for_timeout(200); check("le choix du client remplit le nom, l'adresse et le code client",cp.input_value('#s_nom')=='Famille Sow' and cp.input_value('#s_adr')=='Nongo, Ratoma' and cp.input_value('#s_cli')=='CLI-2026-003'); cp.click('[data-act=close]')
    # ---------- Personnel : fiche complète au central, transmise chiffrée à SPC Gestion ----------
    print("7. Fiche du personnel complète (chiffrée) et plannings reçus de SPC Gestion")
    def decrypt_file(path):
        env=json.loads(dump()[path]); return cp.evaluate("([k,e])=>SPC.xDecrypt(k,e)",[xk,env])
    cp.click('[data-act=tab][data-tab=agents]'); cp.click('[data-act=newagent]'); cp.wait_for_timeout(300)
    for sel,val in [('#a_prenoms','Mariama Binta'),('#a_nom','Soumah'),('#a_naiss','1995-03-12'),('#a_tel','+224 622 33 44 55'),('#a_adr','Kipé, Ratoma, Conakry'),('#a_piece','CNI 123456789'),('#a_cnss','CNSS-998877'),('#a_g0n','Oumar Soumah'),('#a_g0t','+224 600 00 00 11'),('#a_g0l','Frère'),('#a_g1n','Hawa Bah'),('#a_g1t','+224 600 00 00 22'),('#a_g1l','Ancienne employeuse'),('#a_notes','Parle français et soussou')]: cp.fill(sel,val)
    cp.select_option('#a_poste','nounou_std'); cp.click('[data-act=saveagent]'); cp.wait_for_timeout(3500); cp.click('[data-act=close]')
    dec=decrypt_file('exports/employes.json'); me=[e for e in dec['employes'] if e['nomFamille']=='Soumah']
    check("le formulaire du central enregistre toute la fiche : identité, naissance, adresse, pièce, CNSS, poste, garants, notes",len(me)==1 and me[0]['prenoms']=='Mariama Binta' and me[0]['naissance']=='1995-03-12' and me[0]['adresse']=='Kipé, Ratoma, Conakry' and me[0]['piece']=='CNI 123456789' and me[0]['cnss']=='CNSS-998877' and me[0]['poste']=='nounou_std' and me[0]['garants'][0]['nom']=='Oumar Soumah' and me[0]['garants'][1]['lien']=='Ancienne employeuse' and me[0]['notes']=='Parle français et soussou' and me[0]['nom']=='Mariama Binta Soumah',me)
    allraw=json.dumps(dump()); check("les informations sensibles (CNSS, pièce, adresse, naissance, garants) ne sont lisibles nulle part en clair dans le dépôt",not any(x in allraw for x in ['CNSS-998877','CNI 123456789','1995-03-12','Oumar Soumah','Parle français']))
    cp.locator('.card',has_text='Mariama Binta Soumah').locator('[data-act=editagent]').click(); cp.wait_for_timeout(300); check("la fiche se rouvre avec les informations saisies",cp.input_value('#a_cnss')=='CNSS-998877' and cp.input_value('#a_g1n')=='Hawa Bah')
    cp.fill('#a_tel','+224 611 00 00 00'); cp.fill('#a_adr','Lambanyi, Ratoma'); cp.click('[data-act=saveagent]'); cp.wait_for_timeout(3500)
    dec=decrypt_file('exports/employes.json'); me=[e for e in dec['employes'] if e['nomFamille']=='Soumah'][0]; check("une modification de la fiche est transmise (téléphone et adresse)",me['tel']=='+224 611 00 00 00' and me['adresse']=='Lambanyi, Ratoma',me)
    encc=cp.evaluate("([k,o])=>SPC.xEncrypt(k,o)",[xk,{'genere':time.strftime('%Y-%m-%dT%H:%M:%S.000Z'),'clients':[{'ref':'CLI-2026-077','nom':'Entreprise Test SA','adresse':'Kaloum, Conakry','poles':['Accueil'],'horaires':'8h à 17h'}]}])
    post('set',{'path':'echange/clients.json','content':json.dumps(dict({'format':'spc-clients','version':2,'source':'gestion'},**encc))})
    cp.click('[data-act=tab][data-tab=day]'); cp.click('[data-act=reload]'); cp.wait_for_timeout(3000); cp.click('[data-act=tab][data-tab=sites]'); cp.wait_for_timeout(400)
    check("le central déchiffre la liste des clients envoyée par SPC Gestion",'Entreprise Test SA' in cp.inner_text('body') and 'CLI-2026-077' in cp.inner_text('body'))
    encp=cp.evaluate("([k,o])=>SPC.xEncrypt(k,o)",[xk,{'genere':time.strftime('%Y-%m-%dT%H:%M:%S.000Z'),'plannings':[
      {'ref':'AFF-2026-001','agentCode':'AGT-002','agentNom':'Aminata Bah','clientRef':'CLI-2026-001','clientNom':'Résidence Test','jours':[1,2,3,4,5],'debut':'07:30','fin':'17:30','du':time.strftime('%Y-%m-%d'),'au':''},
      {'ref':'AFF-2026-002','agentCode':'AGT-099','agentNom':'Inconnue','clientRef':'CLI-2026-001','clientNom':'Résidence Test','jours':[1,2,3],'debut':'08:00','fin':'16:00','du':time.strftime('%Y-%m-%d'),'au':''}]}])
    post('set',{'path':'echange/plannings.json','content':json.dumps(dict({'format':'spc-plannings','version':1,'source':'gestion'},**encp))})
    cp.click('[data-act=tab][data-tab=day]'); cp.click('[data-act=reload]'); cp.wait_for_timeout(3000); cp.click('[data-act=tab][data-tab=asg]'); cp.wait_for_timeout(400); tx=cp.inner_text('body')
    check("l'onglet Plannings affiche les plannings reçus avec leur état (à créer, agent non enregistré)",'Plannings proposés par SPC Gestion' in tx and 'À créer' in tx and 'Agent non enregistré' in tx,tx[:500])
    cp.locator('[data-act=applypl][data-ref="AFF-2026-001"]').click(); cp.wait_for_timeout(3000)
    asg=[json.loads(v) for k,v in dump().items() if k.startswith('assignments/')]; g=[a for a in asg if a.get('affRef')=='AFF-2026-001']
    check("« Appliquer » crée l'affectation de présence (agent, lieu, jours, horaires) marquée comme venant de SPC Gestion",len(g)==1 and g[0]['agentId']=='AGT-002' and g[0]['jours']==[1,2,3,4,5] and g[0]['debut']=='07:30' and g[0]['source']=='gestion',g)
    check("le planning appliqué passe à « En place » et l'agent inconnu reste signalé",'En place' in cp.inner_text('body') and 'Agent non enregistré' in cp.inner_text('body'))
    cc.set_offline(True); cp.reload(); cp.wait_for_timeout(1500); check('central consultable hors connexion','Fanta Camara' in cp.inner_text('body') or 'Jour' in cp.inner_text('body'))
    b.close()
finally:
  for pr in procs: pr.terminate()
print('\nERREURS DE SCRIPT :',errs or 'aucune'); ok=sum(1 for _,c in OK if c); print(f'RÉSULTAT : {ok}/{len(OK)} contrôles réussis'); sys.exit(0 if ok==len(OK) and not errs else 1)
