"""Test de la récupération des pointages par l'application de gestion (GitHub simulé par interception réseau).
Usage : GESTION=/chemin/spc-gestion-client.html python3 tests/gestion-sync.py   (après tests/e2e.py, qui produit /tmp/published-export.json)"""
import json, os, sys, time
from playwright.sync_api import sync_playwright
GESTION=os.environ.get('GESTION','/mnt/user-data/outputs/spc-gestion-client.html')
pub=json.load(open('/tmp/published-export.json')); MONTH=pub['mois']; OK=[]; hits=[]
def check(l,c,x=''): OK.append(bool(c)); print(('  [OK] ' if c else '  [ÉCHEC] ')+l+(' '+str(x) if x and not c else ''))
state={'mode':'ok'}
def handler(route):
    url=route.request.url; hits.append(url)
    h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'}
    if state['mode']=='abort': return route.abort()
    if state['mode']=='401': return route.fulfill(status=401,headers=h,body='{"message":"Bad credentials"}')
    if state['mode']=='404' or ('pointages-'+MONTH) not in url: return route.fulfill(status=404,headers=h,body='{"message":"Not Found"}')
    assert route.request.headers.get('authorization','').startswith('Bearer github_pat_test'),'jeton absent'
    route.fulfill(status=200,headers=h,body=json.dumps(state.get('body',pub)))
with sync_playwright() as p:
    b=p.chromium.launch(); c=b.new_context(accept_downloads=True,viewport={'width':1280,'height':1000}); pg=c.new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e))); c.route('https://api.github.com/**',handler)
    pg.goto('file://'+GESTION); pg.wait_for_timeout(500); pg.click('button[data-act=demo]'); pg.wait_for_timeout(300)
    info=pg.evaluate("({ref:S.clients[0].ref,cn:S.clients[0].nom,ag:S.agents.map(a=>agentName(a.id))})"); print('démo :',info)
    # client et agents de la démo = ceux du fichier publié
    pg.evaluate("""([ref])=>{S.clients[0].ref=ref;S.agents[0].prenoms='Fanta';S.agents[0].nom='Camara';S.agents[0].codePointage='';
      if(S.agents[1]){S.agents[1].prenoms='Bintou';S.agents[1].nom='Diallo';S.agents[1].codePointage=''} touch('clients');touch('agents')}""",[pub['entrees'][0]['clientRef']])
    pg.click('[data-act=nav][data-v=settings]'); pg.wait_for_timeout(300)
    check('la carte « Pointages » est dans les Réglages avec le dépôt par défaut','Pointages (application SPC Pointage)' in pg.inner_text('body') and pg.input_value('#ghrepo')=='societeplacementconseils-create/spc-pointage-data')
    # sans jeton
    pg.click('[data-act=gh-fetch]'); pg.wait_for_timeout(300); check('sans jeton, un message demande de le renseigner','Renseignez le dépôt et le jeton' in pg.inner_text('body') or len(hits)==0)
    pg.fill('#ghtoken','github_pat_test_lecture'); pg.check('#ghauto'); pg.click('[data-act=gh-save]'); pg.wait_for_timeout(300)
    # 1) récupération : Fanta est reconnue par son nom, Aminata n'a pas d'équivalent
    pg.fill('#ghmonth',MONTH); pg.click('[data-act=gh-fetch]'); pg.wait_for_timeout(1500); t=pg.inner_text('dialog') if pg.locator('dialog').count() else pg.inner_text('body')
    st=pg.evaluate("({n:Object.values(S.logs).flat().filter(e=>e.id&&e.id.startsWith('pt:')).length,code:S.agents[0].codePointage,rows:Object.values(S.logs).flat().filter(e=>e.id&&e.id.startsWith('pt:')).map(e=>[e.date,e.arr,e.dep,e.prest,e.agentId===S.agents[0].id])})")
    nf=[e for e in pub['entrees'] if e['agentNom']=='Fanta Camara' and e['arr']]
    check("les pointages publiés sont importés dans le rapport journalier (agent reconnu par son nom)",st['n']==len(nf) and st['n']>0 and all(r[4] for r in st['rows']),(st,len(nf)))
    check("l'agent est lié automatiquement à son code de pointage",st['code']=='AGT-001',st['code'])
    check('la ligne indique le mode de pointage et le lieu',all('Pointage (' in r[3] and 'Résidence Test' in r[3] for r in st['rows']),st['rows'][:2])
    check("l'agent sans équivalent est signalé dans le compte rendu","Lignes ignorées" in t and 'Aminata Bah' in t,t[:300])
    pg.keyboard.press('Escape')
    # 2) idempotence
    pg.click('[data-act=gh-fetch]'); pg.wait_for_timeout(1200); t=pg.inner_text('dialog'); n2=pg.evaluate("Object.values(S.logs).flat().filter(e=>e.id&&e.id.startsWith('pt:')).length")
    import re; vals=re.findall(r'<b>(\d+)</b>',pg.inner_html('dialog'))
    check('une seconde récupération ne crée pas de doublon (0 ajoutée, 0 mise à jour)',n2==st['n'] and vals[:2]==['0','0'],(n2,vals)); pg.keyboard.press('Escape')
    # 3) un fichier modifié met à jour sans doublon
    body=json.loads(json.dumps(pub)); 
    for e in body['entrees']:
        if e['agentNom']=='Fanta Camara' and e['dep']: e['dep']='18:45'; break
    state['body']=body; pg.click('[data-act=gh-fetch]'); pg.wait_for_timeout(1200); vals=re.findall(r'<b>(\d+)</b>',pg.inner_html('dialog')); check('un pointage corrigé est mis à jour sans doublon',vals[:2]==['0','1'],vals); pg.keyboard.press('Escape'); state.pop('body')
    # 4) récupération automatique à l'ouverture
    hits.clear(); pg.reload(); pg.wait_for_timeout(3500)
    check("à l'ouverture, la récupération automatique interroge GitHub pour le mois en cours",any('pointages-'+MONTH in u for u in hits),hits)
    # 5) erreurs
    pg.click('[data-act=nav][data-v=settings]'); pg.wait_for_timeout(300)
    state['mode']='404'; pg.click('[data-act=gh-fetch]'); pg.wait_for_timeout(1000); check("fichier absent : message qui renvoie vers le central","Pas de fichier pour ce mois" in pg.inner_text('dialog')); pg.keyboard.press('Escape')
    state['mode']='401'; pg.click('[data-act=gh-fetch]'); pg.wait_for_timeout(1000); check("jeton refusé : message clair","Jeton refusé" in pg.inner_text('dialog')); pg.keyboard.press('Escape')
    state['mode']='abort'; pg.click('[data-act=gh-fetch]'); pg.wait_for_timeout(1000); mt=pg.inner_text('dialog'); check("pas de réseau ou page publiée dans Claude : message explicatif avec la solution","Connexion à GitHub impossible" in mt and 'Importer un fichier' in mt); pg.keyboard.press('Escape'); state['mode']='ok'
    # 6) jeton jamais dans les sauvegardes
    with pg.expect_download() as dl: pg.click('[data-act=export]')
    txt=open(dl.value.path(),encoding='utf8').read(); check("le jeton n'est jamais inclus dans la sauvegarde exportée",'github_pat_test' not in txt and 'ghtoken' not in txt)
    # 7) import d'un fichier (secours)
    pg.evaluate("S.logs={};S.meta.months=[];touch('meta')"); pg.set_input_files('#ptimp','/tmp/published-export.json'); pg.wait_for_timeout(800)
    check("l'import d'un fichier reste possible (secours)",pg.evaluate("Object.values(S.logs).flat().filter(e=>e.id&&e.id.startsWith('pt:')).length")==st['n'])
    print('erreurs de script :',errs or 'aucune'); b.close()
ok=sum(OK); print(f'RÉSULTAT : {ok}/{len(OK)} contrôles réussis'); sys.exit(0 if ok==len(OK) and not errs else 1)
