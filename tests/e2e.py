"""Test de bout en bout : central, superviseur et deux agents, avec coupure de connexion, contre un faux GitHub.
Usage : python3 tests/e2e.py   (Playwright + Chromium requis)"""
import json, subprocess, time, urllib.request, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from native_ref import make as native_make
import datetime
from playwright.sync_api import sync_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE=(9.5785,-13.6330)   # centre du lieu de test (Conakry)
def geo(lat,lon,acc=8): return {'latitude':lat,'longitude':lon,'accuracy':acc}
def dump(): return json.load(urllib.request.urlopen('http://localhost:4010/__admin/dump'))
def post(path,obj): urllib.request.urlopen(urllib.request.Request('http://localhost:4010/__admin/'+path,json.dumps(obj).encode(),{'Content-Type':'application/json'}))
procs=[subprocess.Popen(['node',ROOT+'/tests/mock-github.js','4010'],stdout=subprocess.DEVNULL),subprocess.Popen(['python3','-m','http.server','4020','--directory',ROOT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)]
time.sleep(1.2); errs=[]; OK=[]
def check(label,cond,extra=''):
    OK.append((label,bool(cond))); print(('  [OK] ' if cond else '  [ÉCHEC] ')+label+(' '+str(extra) if extra and not cond else ''))
try:
  with sync_playwright() as p:
    b=p.chromium.launch()
    def ctx(g=None,perm=True):
        c=b.new_context(viewport={'width':420,'height':860},geolocation=g,permissions=['geolocation'] if perm else [],accept_downloads=True)
        pg=c.new_page(); pg.on('pageerror',lambda e:(errs.append(str(e)),print('   erreur page:',str(e)[:200]))); pg.on('console',lambda m:print('   console:',m.text[:200]) if os.environ.get('DEBUG') and m.type in ('error','warning') else None); return c,pg
    # ---------- Central : connexion, utilisateurs, lieu, planning ----------
    print('1. Application centrale')
    cc,cp=ctx(None,False); cp.goto('http://localhost:4020/central/index.html'); cp.wait_for_timeout(400)
    cp.fill('#c_repo','spc/data'); cp.fill('#c_token','test-token'); cp.fill('#c_dtoken','test-token'); cp.evaluate("document.querySelector('details').open=true"); cp.fill('#c_api','http://localhost:4010'); cp.click('[data-act=saveconfig]'); cp.wait_for_timeout(600)
    links={}
    for nom,role in [('Mamadou Sylla','superviseur'),('Fanta Camara','agent'),('Aminata Bah','agent')]:
        cp.click('[data-act=tab][data-tab=agents]'); cp.click('[data-act=newagent]'); cp.fill('#a_nom',nom); cp.select_option('#a_role',role); cp.click('[data-act=saveagent]'); cp.wait_for_timeout(500)
        links[nom]=cp.input_value('#lk'); cp.click('[data-act=close]')
    check('3 utilisateurs créés avec lien d\'activation',all('#enroll=' in v for v in links.values()))
    cp.click('[data-act=tab][data-tab=sites]'); cp.click('[data-act=newsite]'); cp.fill('#s_nom','Résidence Test'); cp.fill('#s_adr','Kipé, Ratoma'); cp.fill('#s_cli','CLI-2026-001'); cp.fill('#s_lat',str(SITE[0])); cp.fill('#s_lon',str(SITE[1])); cp.fill('#s_ray','100'); cp.select_option('#s_sup',index=1); cp.click('[data-act=savesite]'); cp.wait_for_timeout(500)
    for nom in ['Fanta Camara','Aminata Bah']:
        cp.click('[data-act=tab][data-tab=asg]'); cp.click('[data-act=newasg]'); cp.select_option('#g_agent',label=nom)
        for i in range(6,8): cp.check(f'.g_j[value="{i}"]')
        cp.fill('#g_deb','00:00'); cp.fill('#g_fin','23:59'); cp.click('[data-act=saveasg]'); cp.wait_for_timeout(500)
    d=dump(); check('agents, lieu et affectations écrits dans le dépôt',len([k for k in d if k.startswith('agents/')])==3 and any(k.startswith('sites/') for k in d) and len([k for k in d if k.startswith('assignments/')])==2)
    # ---------- Agent 1 : pointage dans la zone, coupure, hors zone ----------
    print('2. Agent (Fanta) : dans la zone, hors connexion, hors zone')
    ac,ap=ctx(geo(*SITE)); ap.goto(links['Fanta Camara']); ap.wait_for_timeout(1500)
    check('lieu du jour affiché après activation','Résidence Test' in ap.inner_text('body'))
    if os.environ.get('SHOTS'): ap.screenshot(path='/tmp/shot_agent1.png')
    ap.click('[data-act=punch]'); ap.wait_for_timeout(2500); check('arrivée enregistrée dans la zone','Arrivée enregistrée' in ap.inner_text('#modal'),ap.inner_text('#modal')[:80]); ap.click('[data-act=close]'); ap.wait_for_timeout(1200)
    ac.set_offline(True); ap.wait_for_timeout(300)
    ap.click('[data-act=punch]'); ap.wait_for_timeout(2500); txt=ap.inner_text('#modal'); check('départ enregistré hors connexion','Départ enregistré' in txt and 'retour de la connexion' in txt,txt[:100]); ap.click('[data-act=close]'); ap.wait_for_timeout(500)
    check('1 pointage en attente affiché','1 à envoyer' in ap.inner_text('header'),ap.inner_text('header'))
    ap.reload(); ap.wait_for_timeout(1500); check('application ouverte sans connexion (service worker)','Résidence Test' in ap.inner_text('body') and 'Hors ligne' in ap.inner_text('header'))
    n_before=len(json.loads(dump().get('pointages/'+time.strftime('%Y-%m')+'/'+time.strftime('%Y-%m-%d')+'/AGT-001.json','[]')))
    ac.set_offline(False); ap.wait_for_timeout(300); ap.evaluate("window.dispatchEvent(new Event('online'))"); ap.wait_for_timeout(2500)
    day='pointages/'+time.strftime('%Y-%m')+'/'+time.strftime('%Y-%m-%d')+'/AGT-001.json'
    evs=json.loads(dump().get(day,'[]')); check('synchronisation au retour de la connexion : 2 événements dans le dépôt',len(evs)==2 and n_before<2,(n_before,len(evs)))
    check('signature et chaîne présentes',all(e.get('sig') and e.get('hash') for e in evs) and evs[1]['prev']==evs[0]['hash'])
    check('coordonnées et distance enregistrées',evs[0]['lat'] and evs[0]['dist']<100 and evs[0]['zone']=='in',evs[0])
    ac.set_geolocation(geo(SITE[0]+0.003,SITE[1],8)); ap.wait_for_timeout(500)   # ~330 m
    ap.click('[data-act=punch]'); ap.wait_for_timeout(2500); txt=ap.inner_text('#modal')
    if os.environ.get('SHOTS'): ap.screenshot(path='/tmp/shot_agent2.png')
    check('arrivée refusée hors zone avec distance affichée','Pointage impossible' in txt and ' m' in txt,txt[:120])
    ap.click('[data-act=force]'); ap.wait_for_timeout(300); check('motif obligatoire pour pointer hors zone',ap.evaluate("document.querySelector('#modal')!==null")); 
    ap.fill('#why','Portail fermé, attente du gardien'); ap.click('[data-act=force]'); ap.wait_for_timeout(3000)
    evs=json.loads(dump().get(day,'[]')); check('pointage hors zone enregistré et envoyé',len(evs)==3 and evs[2]['zone']=='out' and 'Portail' in evs[2]['reason'])
    # ---------- Agent 2 : arrivée automatique ----------
    print('3. Agent (Aminata) : arrivée automatique')
    bc,bp=ctx(geo(SITE[0]+0.004,SITE[1])); bp.goto(links['Aminata Bah']); bp.wait_for_timeout(1500)
    bc.set_geolocation(geo(SITE[0]+0.0002,SITE[1])); bp.wait_for_timeout(1200); bc.set_geolocation(geo(SITE[0]+0.0001,SITE[1]+0.0001)); bp.wait_for_timeout(3000)
    day2=day.replace('AGT-001','AGT-002'); e2=json.loads(dump().get(day2,'[]')); check('arrivée automatique après 2 positions dans la zone',len(e2)==1 and e2[0]['mode']=='auto' and e2[0]['type']=='IN',e2)
    # ---------- Superviseur : validation, lieu capturé sur place, pointage manuel ----------
    print('4. Superviseur')
    sc,sp=ctx(geo(9.5900,-13.6500,6)); sp.goto(links['Mamadou Sylla']); sp.wait_for_timeout(2000)
    body=sp.inner_text('body'); check("équipe du jour et pointage hors zone à valider visibles",'Fanta Camara' in body and 'Portail fermé' in body,body[:200])
    if os.environ.get('SHOTS'): sp.screenshot(path='/tmp/shot_sup.png')
    sp.click('[data-act=valid][data-d=valide]'); sp.wait_for_timeout(2500); check('validation écrite dans le dépôt',any(k.startswith('validations/') for k in dump()))
    sp.click('[data-act=tab][data-tab=sites]'); sp.click('[data-act=newsite]'); sp.fill('#s_nom','Chantier Nongo'); sp.fill('#s_ray','80'); sp.click('[data-act=capture]'); sp.wait_for_timeout(2500)
    check('position capturée avec précision','±' in sp.inner_text('#s_pos') or 'précision' in sp.inner_text('#s_pos'),sp.inner_text('#s_pos'))
    sp.click('[data-act=savesite]'); sp.wait_for_timeout(2500); sites=[json.loads(v) for k,v in dump().items() if k.startswith('sites/')]
    nongo=[s for s in sites if s['nom']=='Chantier Nongo']; check('nouveau lieu enregistré avec les coordonnées GPS relevées',nongo and abs(nongo[0]['lat']-9.59)<0.0005 and nongo[0]['rayon']==80,nongo)
    sp.click('[data-act=tab][data-tab=manual]'); sp.select_option('#m_agent',label='Aminata Bah'); sp.select_option('#m_type','OUT'); sp.fill('#m_why','Téléphone en panne'); sp.click('[data-act=manual]'); sp.wait_for_timeout(2500)
    e2=json.loads(dump().get(day2,'[]')); check('pointage manuel signé par le superviseur',any(e['mode']=='manuel' and e['signerId']=='SUP-001' and e['agentId']=='AGT-002' for e in e2),e2)
    # ---------- Central : contrôle, falsification, suppression, exports ----------
    print('5. Contrôle par le central')
    cp.click('[data-act=tab][data-tab=day]'); cp.click('[data-act=reload]'); cp.wait_for_timeout(3000); t=cp.inner_text('body')
    check('journée affichée avec arrivées, distance et état',('Fanta Camara' in t) and ('Présent' in t or 'En poste' in t),t[:300])
    if os.environ.get('SHOTS'): cp.set_viewport_size({'width':1100,'height':800}); cp.wait_for_timeout(300); cp.screenshot(path='/tmp/shot_central.png'); cp.set_viewport_size({'width':420,'height':860})
    check('hors zone validé reconnu','Hors zone validé' in t); check('pointage manuel signalé','Pointage manuel' in t)
    check('aucune signature invalide sur les données saines','Signature invalide' not in t and 'Empreinte modifiée' not in t)
    raw=json.loads(dump()[day]); raw[0]['lat']=raw[0]['lat']+0.01; post('set',{'path':day,'content':json.dumps(raw)})
    cp.click('[data-act=reload]'); cp.wait_for_timeout(2500); check('falsification des coordonnées détectée','Empreinte modifiée' in cp.inner_text('body'))
    raw=json.loads(dump()[day]); post('set',{'path':day,'content':json.dumps(raw[1:])})
    cp.click('[data-act=reload]'); cp.wait_for_timeout(2500); check('suppression d\'un pointage détectée','ont disparu' in cp.inner_text('body') or 'a disparu' in cp.inner_text('body') or 'disparu' in cp.inner_text('body'))
    cp.click('[data-act=tab][data-tab=month]'); cp.wait_for_timeout(300)
    with cp.expect_download() as dl: cp.click('[data-act=json]')
    path=dl.value.path(); ex=json.load(open(path)); check("export JSON pour l'application SPC",ex['format']=='spc-pointages' and len(ex['entrees'])>=2 and ex['entrees'][0]['clientRef']=='CLI-2026-001',list(ex)[:4])
    json.dump(ex,open('/tmp/export-pointages.json','w'))
    # ---------- Pont natif Android (simulé) ----------
    print('6. Pont natif Android (simulé) : le pointage web reconnaît la détection en arrière-plan')
    INIT="""(()=>{window.__nat={calls:[],events:[]};const log=(n,a)=>window.__nat.calls.push([n,a]);
      window.SPCNative={isNative:()=>true,version:()=>'native-test',configure:j=>log('configure',j),setSites:j=>log('setSites',j),noteEvent:j=>log('noteEvent',j),
      recentEvents:()=>JSON.stringify(window.__nat.events),pending:()=>0,syncNow:()=>log('syncNow'),permissions:()=>JSON.stringify({fine:true,background:false,notifications:true,battery:false,geofences:1}),
      requestPermissions:()=>log('requestPermissions'),requestBatteryExemption:()=>log('battery'),openAppSettings:()=>log('settings')};
      const w=navigator.geolocation.watchPosition.bind(navigator.geolocation);window.__watch=0;navigator.geolocation.watchPosition=(...a)=>{window.__watch++;return w(...a)}})()"""
    nc,npg=ctx(geo(*SITE)); nc.add_init_script(INIT); npg.goto(links['Aminata Bah']); npg.wait_for_timeout(2500)
    calls=npg.evaluate("window.__nat.calls.map(c=>[c[0],c[1]])"); names=[c[0] for c in calls]
    conf=[json.loads(c[1]) for c in calls if c[0]=='configure']; sites=[json.loads(c[1]) for c in calls if c[0]=='setSites']
    check("l'application web transmet l'identité, la clé et le dépôt au module natif",bool(conf) and conf[0]['id']=='AGT-002' and conf[0]['key'] and conf[0]['repo']=='spc/data' and conf[0]['auto'] is True,conf[:1])
    check('les lieux, rayons, jours et horaires sont transmis pour la détection',bool(sites) and sites[-1] and sites[-1][0]['lat']==SITE[0] and sites[-1][0]['rayon']==100 and sites[-1][0]['jours']==[1,2,3,4,5,6,7] and sites[-1][0]['debut']=='00:00',sites[-1:])
    check("le suivi web en continu est désactivé (la détection est native)",npg.evaluate("window.__watch")==0)
    sid=sites[-1][0]['siteId']; now=datetime.datetime.now(datetime.timezone.utc)
    npg.evaluate("([sid,t,d])=>{window.__nat.events=[{id:'n1',siteId:sid,type:'IN',t:t,date:d,zone:'in',mode:'auto',synced:false,src:'native'}]}",[sid,now.strftime('%Y-%m-%dT%H:%M:%S.')+'%03dZ'%(now.microsecond//1000),time.strftime('%Y-%m-%d')])
    npg.click('[data-act=tab][data-tab=set]'); npg.wait_for_timeout(300); npg.click('[data-act=tab][data-tab=today]'); npg.wait_for_timeout(400)
    body=npg.inner_text('body'); check("l'arrivée détectée par Android apparaît : « En poste » et bouton « départ »",'En poste' in body and 'Pointer mon départ' in body,body[:200])
    npg.click('[data-act=tab][data-tab=hist]'); npg.wait_for_timeout(300); check("l'historique indique la détection Android",'Android' in npg.inner_text('body'))
    npg.click('[data-act=tab][data-tab=set]'); npg.wait_for_timeout(300); st=npg.inner_text('body'); check("l'écran Réglages montre l'état des autorisations Android",'Détection en arrière-plan' in st and 'lieu(x) surveillé' in st and 'Pas « toujours »' in st)
    npg.click('[data-act=natperm]'); npg.wait_for_timeout(200); npg.click('[data-act=tab][data-tab=today]'); npg.wait_for_timeout(300)
    npg.click('[data-act=punch]'); npg.wait_for_timeout(2500); npg.click('[data-act=close]'); npg.wait_for_timeout(300)
    names=npg.evaluate("window.__nat.calls.map(c=>c[0])"); check("les boutons Android et le pointage manuel appellent le module natif",'requestPermissions' in names and 'noteEvent' in names and 'syncNow' in names,names)
    # ---------- Un pointage natif est vérifié par le central ----------
    print('7. Pointage natif (référence Python = EventFactory.kt) vérifié par le central')
    keys=cp.evaluate("SPC.db('spc-central').get('kv','keys')"); key=keys['AGT-002'][-1]
    path2=day2; cur=json.loads(dump().get(path2,'[]'))
    def put_native(**kw):
        e=native_make('AGT-002',kw.pop('key',key),sid,'IN',kw.pop('t'),9.5786,-13.6331,7,15,'in','auto',kw.pop('reason',''),'GENESIS',kw.pop('drift',None),ev_id=kw.pop('ev_id'))
        if kw.get('tamper'): e['reason']='modifié après coup'
        post('set',{'path':path2,'content':json.dumps(cur+[e])}); return e
    ts=datetime.datetime.now(datetime.timezone.utc); iso=lambda d:d.strftime('%Y-%m-%dT%H:%M:%S.')+'%03dZ'%(d.microsecond//1000)
    ok_ev=put_native(t=iso(ts),ev_id='nat00000001')
    cp.click('[data-act=tab][data-tab=day]'); cp.click('[data-act=reload]'); cp.wait_for_timeout(2500)
    row=[r for r in cp.locator('tbody tr').all_inner_texts() if 'Aminata' in r][0]
    check('pointage natif signé : accepté, signalé « Détection automatique (Android) »','Détection automatique (Android)' in row and 'Signature invalide' not in row and 'Empreinte modifiée' not in row,row)
    put_native(t=iso(ts),ev_id='nat00000002',reason='texte',tamper=True)
    cp.click('[data-act=reload]'); cp.wait_for_timeout(2500)
    row=[r for r in cp.locator('tbody tr').all_inner_texts() if 'Aminata' in r][0]; check('pointage natif modifié après coup : détecté','Empreinte modifiée' in row,row)
    post('set',{'path':path2,'content':json.dumps(cur)}); put_native(t=iso(ts),ev_id='nat00000003',key='A'*43)
    cp.click('[data-act=reload]'); cp.wait_for_timeout(2500)
    row=[r for r in cp.locator('tbody tr').all_inner_texts() if 'Aminata' in r][0]; check('pointage natif signé avec une mauvaise clé : détecté','Signature invalide' in row,row)
    # le central fonctionne aussi sans connexion (données en cache)
    cc.set_offline(True); cp.reload(); cp.wait_for_timeout(1500); check('central consultable hors connexion','Fanta Camara' in cp.inner_text('body') or 'Jour' in cp.inner_text('body'))
    b.close()
finally:
  for pr in procs: pr.terminate()
print('\nERREURS DE SCRIPT :',errs or 'aucune'); ok=sum(1 for _,c in OK if c); print(f'RÉSULTAT : {ok}/{len(OK)} contrôles réussis'); sys.exit(0 if ok==len(OK) and not errs else 1)
