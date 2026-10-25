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
SCAN_MOCK="""(()=>{window.BarcodeDetector=class{constructor(o){}async detect(){return window.__qr?[{rawValue:window.__qr}]:[]}};})()"""
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
    sc,sp=ctx(None); sp.goto(links['Mamadou Sylla']); sp.wait_for_timeout(2000); body=sp.inner_text('body'); check("équipe du jour visible",'Fanta Camara' in body and 'Aminata Bah' in body,body[:200])
    sp.click('[data-act=tab][data-tab=sites]'); sp.wait_for_timeout(200); t=sp.inner_text('body'); check("la liste des lieux est en lecture seule (pas de création de lieu)",'Résidence Test' in t and 'QR actif' in t and 'Enregistrer un nouveau lieu' not in t)
    sp.click('[data-act=tab][data-tab=manual]'); sp.select_option('#m_agent',label='Aminata Bah'); sp.select_option('#m_site',label='Résidence Test'); sp.select_option('#m_type','OUT'); sp.fill('#m_why','Téléphone en panne'); sp.click('[data-act=manual]'); sp.wait_for_timeout(2800)
    e2=json.loads(dump().get(dayfile('AGT-002'),'[]')); check('pointage manuel signé par le superviseur',any(e['mode']=='manuel' and e['signerId']=='SUP-001' and e['agentId']=='AGT-002' for e in e2),e2)
    # ---------- Central : contrôle ----------
    print('5. Contrôle par le central')
    cp.click('[data-act=tab][data-tab=day]'); cp.click('[data-act=reload]'); cp.wait_for_timeout(3000); t=cp.inner_text('body')
    check('journée affichée avec les deux agents',('Fanta Camara' in t) and ('Aminata Bah' in t),t[:300])
    check('pointage manuel signalé','Pointage manuel' in t); check('aucune signature invalide sur les données saines','Signature invalide' not in t and 'Empreinte modifiée' not in t)
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
    cc.set_offline(True); cp.reload(); cp.wait_for_timeout(1500); check('central consultable hors connexion','Fanta Camara' in cp.inner_text('body') or 'Jour' in cp.inner_text('body'))
    b.close()
finally:
  for pr in procs: pr.terminate()
print('\nERREURS DE SCRIPT :',errs or 'aucune'); ok=sum(1 for _,c in OK if c); print(f'RÉSULTAT : {ok}/{len(OK)} contrôles réussis'); sys.exit(0 if ok==len(OK) and not errs else 1)
