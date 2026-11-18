"""Test de la récupération des pointages par l'application de gestion (GitHub simulé par interception réseau).
Usage : GESTION=/chemin/spc-gestion-client.html python3 tests/gestion-sync.py   (après tests/e2e.py, qui produit /tmp/published-export.json)"""
import json, os, sys, time
from playwright.sync_api import sync_playwright
GESTION=os.environ.get('GESTION','/mnt/user-data/outputs/spc-gestion-client.html')
pub=json.load(open('/tmp/published-export.json')); MONTH=pub['mois']; OK=[]; hits=[]
def check(l,c,x=''): OK.append(bool(c)); print(('  [OK] ' if c else '  [ÉCHEC] ')+l+(' '+str(x) if x and not c else ''))
state={'mode':'ok','emp':None,'put':'ok','puts':[],'sha':None,'plans':[],'psha':None}
def handler(route):
    req=route.request; url=req.url; hits.append(url)
    h={'Access-Control-Allow-Origin':'*','Content-Type':'application/json'}
    if 'echange/clients.json' in url:
        if req.method=='PUT':
            if state['put']=='403': return route.fulfill(status=403,headers=h,body='{"message":"Resource not accessible"}')
            body=json.loads(req.post_data); state['puts'].append(body); state['sha']='sha%d'%len(state['puts'])
            return route.fulfill(status=201,headers=h,body=json.dumps({'content':{'sha':state['sha']}}))
        if state['sha'] is None: return route.fulfill(status=404,headers=h,body='{"message":"Not Found"}')
        return route.fulfill(status=200,headers=h,body=json.dumps({'sha':state['sha']}))
    if 'echange/plannings.json' in url:
        if req.method=='PUT':
            body=json.loads(req.post_data); state['plans'].append(body); state['psha']='psha%d'%len(state['plans'])
            return route.fulfill(status=201,headers=h,body=json.dumps({'content':{'sha':state['psha']}}))
        if state['psha'] is None: return route.fulfill(status=404,headers=h,body='{"message":"Not Found"}')
        return route.fulfill(status=200,headers=h,body=json.dumps({'sha':state['psha']}))
    if 'exports/employes.json' in url:
        if state['emp'] is None: return route.fulfill(status=404,headers=h,body='{"message":"Not Found"}')
        return route.fulfill(status=200,headers=h,body=json.dumps(state['emp']))
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
    # 8) personnel : le central est la source (fiche complète, fichier chiffré)
    import base64, re as _re, os as _os
    XKEY=base64.urlsafe_b64encode(_os.urandom(32)).decode().rstrip('=')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(200); pg.click('[data-act=nav][data-v=settings]'); pg.wait_for_timeout(300)
    pg.evaluate("""()=>{S.agents.length=0;S.agents.push({id:'a-fanta',prenoms:'Fanta',nom:'Camara',tel:'+224 600 00 00 00',cnss:'123456',codePointage:'',checks:{},garants:[{},{}],pieces:[]});touch('agents')}""")
    plain={'genere':'2026-11-07T08:00:00Z','employes':[
      {'code':'AGT-001','role':'agent','nom':'Fanta Camara','prenoms':'Fanta','nomFamille':'Camara','naissance':'1994-05-02','tel':'+224 622 11 22 33','adresse':'Kipé, Ratoma','piece':'CNI 111222333','cnss':'CNSS-111','poste':'nounou_std','garants':[{'nom':'Oumar Camara','tel':'+224 600 11 11 11','lien':'Frère'},{'nom':'','tel':'','lien':''}],'notes':'','actif':True,'creeLe':''},
      {'code':'AGT-002','role':'agent','nom':'Aminata Bah','prenoms':'Aminata','nomFamille':'Bah','naissance':'1990-01-15','tel':'+224 655 00 00 01','adresse':'Lambanyi','piece':'Passeport P987','cnss':'','poste':'menage','garants':[],'notes':'Parle anglais','actif':True,'creeLe':''},
      {'code':'AGT-003','role':'agent','nom':'Mariama Binta Soumah','prenoms':'Mariama Binta','nomFamille':'Soumah','naissance':'','tel':'','adresse':'','piece':'','cnss':'','poste':'','garants':[],'notes':'','actif':False,'creeLe':''},
      {'code':'SUP-001','role':'superviseur','nom':'Mamadou Sylla','prenoms':'Mamadou','nomFamille':'Sylla','naissance':'','tel':'+224 666 00 00 00','adresse':'','piece':'','cnss':'','poste':'','garants':[],'notes':'','actif':True,'creeLe':''}]}
    env=pg.evaluate("([k,o])=>xEnc(k,o)",[XKEY,plain]); state['emp']=dict({'format':'spc-employes','version':2,'source':'central'},**env)
    check("le fichier du personnel publié par le central est chiffré : aucune donnée personnelle lisible",not any(x in json.dumps(state['emp']) for x in ['Fanta','CNSS-111','CNI 111222333','Kipé']))
    pg.fill('#ghxkey',''); pg.click('[data-act=gh-emp]'); pg.wait_for_timeout(1000); check("sans clé d'échange, un message explique où la copier","Clé d'échange manquante" in pg.inner_text('dialog')); pg.keyboard.press('Escape')
    pg.fill('#ghxkey',XKEY[:-4]+'AAAA'); pg.click('[data-act=gh-emp]'); pg.wait_for_timeout(1000); check("avec une mauvaise clé, un message l'indique","Clé d'échange incorrecte" in pg.inner_text('dialog')); pg.keyboard.press('Escape')
    pg.fill('#ghxkey',XKEY); pg.click('[data-act=gh-save]'); pg.wait_for_timeout(300)
    pg.click('[data-act=gh-emp]'); pg.wait_for_timeout(1500); vals=_re.findall(r'<b>(\d+)</b>',pg.inner_html('dialog')); pg.keyboard.press('Escape')
    ag=pg.evaluate("S.agents.map(a=>({c:a.codePointage,p:a.prenoms,n:a.nom,t:a.tel,cnss:a.cnss,naiss:a.naissance,adr:a.adresse,piece:a.piece,poste:a.poste,g:a.garants,o:a.origine,act:a.pointageActif,notes:a.notes,checks:Object.keys(a.checks||{}).length}))")
    by={a['c']:a for a in ag}; enc=pg.evaluate("S.meta.encadrement")
    check("l'import crée 2 nouvelles fiches, met à jour 1, et range le superviseur dans l'encadrement",vals[:4]==['4','3','1','0'] and len(ag)==3 and len(enc)==1 and enc[0]['code']=='SUP-001',(vals,len(ag),enc))
    check("la fiche existante reçoit toutes les informations saisies au central : naissance, adresse, pièce, CNSS, poste, garants",by['AGT-001']['naiss']=='1994-05-02' and by['AGT-001']['adr']=='Kipé, Ratoma' and by['AGT-001']['piece']=='CNI 111222333' and by['AGT-001']['cnss']=='CNSS-111' and by['AGT-001']['poste']=='nounou_std' and by['AGT-001']['g'][0]['nom']=='Oumar Camara' and by['AGT-001']['t']=='+224 622 11 22 33',by.get('AGT-001'))
    check("une nouvelle intervenante est créée avec toute sa fiche et un dossier à compléter (aucun contrôle validé)",by['AGT-002']['o']=='central' and by['AGT-002']['piece']=='Passeport P987' and by['AGT-002']['poste']=='menage' and by['AGT-002']['notes']=='Parle anglais' and by['AGT-002']['checks']==0,by.get('AGT-002'))
    check("un employé désactivé au central est marqué ; le prénom composé est conservé",by['AGT-003']['act'] is False and by['AGT-003']['p']=='Mariama Binta' and by['AGT-003']['n']=='Soumah',by.get('AGT-003'))
    pg.click('[data-act=gh-emp]'); pg.wait_for_timeout(1000); vals=_re.findall(r'<b>(\d+)</b>',pg.inner_html('dialog')); pg.keyboard.press('Escape'); check('une seconde récupération ne change rien (aucune création, aucune mise à jour)',vals[1:3]==['0','0'],vals)
    plain['employes'][0]['tel']='+224 699 99 99 99'; plain['employes'][0]['adresse']='Dixinn, Conakry'
    state['emp']=dict({'format':'spc-employes','version':2,'source':'central'},**pg.evaluate("([k,o])=>xEnc(k,o)",[XKEY,plain])); pg.click('[data-act=gh-emp]'); pg.wait_for_timeout(1200); pg.keyboard.press('Escape')
    check("une modification saisie au central (téléphone, adresse) est reprise dans la fiche sans doublon",pg.evaluate("S.agents.filter(a=>a.codePointage==='AGT-001').map(a=>a.tel+'|'+a.adresse)")==['+224 699 99 99 99|Dixinn, Conakry'] and pg.evaluate("S.agents.length")==3)
    # 9) clients : SPC Gestion est la source (fichier chiffré)
    pg.evaluate("""()=>{S.clients.push({id:'c-test',ref:'CLI-2026-050',nom:'Famille Test',adresse:'Kipé, Ratoma',tel:'+224 600 11 11 11',email:'a@b.c',contact:'Mme Test',poles:['Placement RH'],horaires:'7h30 à 17h30',notes:'diabète',sante:'confidentiel',montant:1800000})}""")
    pg.fill('#ghxkey',''); pg.click('[data-act=gh-push]'); pg.wait_for_timeout(800); check("sans clé d'échange, l'envoi des clients est refusé avec un message clair","Clé d'échange manquante" in pg.inner_text('dialog') and len(state['puts'])==0); pg.keyboard.press('Escape')
    pg.fill('#ghxkey',XKEY); pg.click('[data-act=gh-push]'); pg.wait_for_timeout(1500); check("« Envoyer les clients » confirme l'envoi",'Clients envoyés au central' in pg.inner_text('dialog'),pg.inner_text('dialog')[:120]); pg.keyboard.press('Escape')
    rawput=base64.b64decode(state['puts'][-1]['content']).decode('utf8'); filej=json.loads(rawput)
    check("le fichier des clients est chiffré dans le dépôt (aucun nom, adresse ni code lisible)",filej.get('chiffre') is True and not any(x in rawput for x in ['Famille Test','CLI-2026-050','Kipé']),list(filej))
    sent=pg.evaluate("([k,e])=>xDec(k,e)",[XKEY,filej]); cl=sent['clients']
    check("une fois déchiffré, le fichier contient seulement code, nom, adresse, pôles et horaires des vrais clients (la démo est exclue)",[c['ref'] for c in cl]==['CLI-2026-050'] and set(cl[0])=={'ref','nom','adresse','poles','horaires'},sent)
    raw=json.dumps(sent); check("aucune donnée sensible n'est envoyée (téléphone, e-mail, contact, santé, notes, montants)",not any(x in raw for x in ['+224 600','a@b.c','Mme Test','diabète','confidentiel','1800000']))
    check("le jeton et la clé d'échange ne sont pas dans le contenu envoyé",'github_pat_test' not in rawput and XKEY not in rawput)
    n=len(state['puts']); r=pg.evaluate("pushClients({silent:true})"); check("sans changement, l'envoi automatique est ignoré",r.get('same') is True and len(state['puts'])==n,r)
    pg.evaluate("()=>{S.clients.find(c=>c.ref==='CLI-2026-050').adresse='Lambanyi, Ratoma';touch('clients')}"); pg.wait_for_timeout(5500)
    sent=pg.evaluate("([k,e])=>xDec(k,e)",[XKEY,json.loads(base64.b64decode(state['puts'][-1]['content']).decode('utf8'))])
    check("une modification d'un client est envoyée automatiquement (chiffrée), avec l'empreinte du fichier précédent",len(state['puts'])==n+1 and sent['clients'][0]['adresse']=='Lambanyi, Ratoma' and state['puts'][-1].get('sha')=='sha%d'%n,(len(state['puts']),n))
    r=pg.evaluate("()=>{const s=S.clients.slice();S.clients.length=0;const p=pushClients({silent:true});return p.then(x=>{S.clients.push(...s);return x})}"); check("une liste de clients vide n'est jamais envoyée automatiquement (elle effacerait celle du central)",r.get('empty') is True and len(state['puts'])==n+1,r)
    state['put']='403'; pg.evaluate("S.clients.find(c=>c.ref==='CLI-2026-050').nom='Famille Test 2'"); pg.click('[data-act=gh-push]'); pg.wait_for_timeout(1200); check("un jeton en lecture seule reçoit un message clair pour l'envoi des clients","ne peut pas écrire" in pg.inner_text('dialog') and 'Read and write' in pg.inner_text('dialog')); pg.keyboard.press('Escape'); state['put']='ok'
    # 10) plannings : déduits des affectations, envoyés chiffrés au central
    pg.evaluate("""()=>{const ag=S.agents.find(a=>a.codePointage==='AGT-001');S.contracts.push({id:'ct-1',ref:'SPC-CTR-2026-OPT1-00001',clientId:'c-test',statut:'Actif',option:1,profil:'nounou_std'});
      S.assignments.push({id:'af-1',ref:'AFF-2026-001',clientId:'c-test',contractId:'ct-1',agentIds:[ag.id],datePrise:'2026-11-02',start:'07:30',end:'17:30',repos:'Samedi et dimanche'});
      S.assignments.push({id:'af-2',ref:'AFF-2026-002',clientId:'c-test',contractId:'ct-1',agentIds:['inconnu'],datePrise:'2026-11-02',start:'08:00',end:'16:00',repos:'Dimanche'})}""")
    pl=pg.evaluate("buildPlannings()"); check("les plannings sont déduits des affectations : jours (repos samedi et dimanche), horaires, prise de poste ; une agente sans code de pointage est ignorée",len(pl)==1 and pl[0]['agentCode']=='AGT-001' and pl[0]['clientRef']=='CLI-2026-050' and pl[0]['jours']==[1,2,3,4,5] and pl[0]['debut']=='07:30' and pl[0]['fin']=='17:30' and pl[0]['du']=='2026-11-02' and pl[0]['ref']=='AFF-2026-001',pl)
    pg.click('[data-act=gh-plan]'); pg.wait_for_timeout(1500); check("« Envoyer les plannings au central » confirme l'envoi","Plannings envoyés au central" in pg.inner_text('dialog'),pg.inner_text('dialog')[:100]); pg.keyboard.press('Escape')
    pf=json.loads(base64.b64decode(state['plans'][-1]['content']).decode('utf8')); dpl=pg.evaluate("([k,e])=>xDec(k,e)",[XKEY,pf])
    check("le fichier des plannings est chiffré et se déchiffre avec la clé d'échange",pf.get('chiffre') is True and 'Fanta' not in json.dumps(pf) and dpl['plannings'][0]['agentCode']=='AGT-001' and pf['format']=='spc-plannings',list(pf))
    print('erreurs de script :',errs or 'aucune'); b.close()
ok=sum(OK); print(f'RÉSULTAT : {ok}/{len(OK)} contrôles réussis'); sys.exit(0 if ok==len(OK) and not errs else 1)
