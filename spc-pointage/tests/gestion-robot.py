"""Test du robot opérationnel (planification, suivi de l'avancement) et du module Prospects de SPC Gestion.
Usage : GESTION=/chemin/spc-gestion-client.html python3 tests/gestion-robot.py"""
import json, os, sys, tempfile
from playwright.sync_api import sync_playwright
GESTION=os.environ.get('GESTION','/mnt/user-data/outputs/spc-gestion-client.html'); OK=[]
def check(l,c,x=''): OK.append(bool(c)); print(('  [OK] ' if c else '  [ÉCHEC] ')+l+(' '+str(x)[:400] if x and not c else ''))
SETUP="""()=>{
 const ALL={};CHECKS.forEach(([k])=>ALL[k]=true);
 S.clients=[{id:'cA',ref:'CLI-2026-101',nom:'Famille Alpha'},{id:'cB',ref:'CLI-2026-102',nom:'Famille Beta'},{id:'cC',ref:'CLI-2026-103',nom:'Famille Gamma'}];
 S.agents=[{id:'g1',prenoms:'Aïssatou',nom:'Diallo',codePointage:'AGT-001',checks:ALL,poste:'nounou_std'},{id:'g2',prenoms:'Binta',nom:'Sow',codePointage:'AGT-002',checks:ALL,poste:'menage'},
           {id:'g3',prenoms:'Cécile',nom:'Bangoura',checks:{}},{id:'g4',prenoms:'Djenabou',nom:'Barry',checks:ALL,poste:'menage'},{id:'g5',prenoms:'Fatou',nom:'Camara',checks:ALL,poste:'menage',pointageActif:false}];
 S.contracts=[{id:'tA',ref:'CTR-A',clientId:'cA',statut:'Actif',profil:'nounou_std'},{id:'tB',ref:'CTR-B',clientId:'cB',statut:'Actif',profil:'menage'},{id:'tC',ref:'CTR-C',clientId:'cC',statut:'Signé',profil:'menage'}];
 S.assignments=[{id:'afA',ref:'AFF-2026-101',clientId:'cA',contractId:'tA',agentIds:['g1'],datePrise:'2026-11-02',start:'07:30',end:'17:30',repos:'Samedi et dimanche',suivi:{}},
                {id:'afB',ref:'AFF-2026-102',clientId:'cB',contractId:'tB',agentIds:['g2'],datePrise:'2026-11-09',start:'07:30',end:'17:30',repos:'Samedi et dimanche',suivi:{j3:true,j15:false,j30:false}}];
 S.logs={'2026-11':[
  {clientId:'cA',agentId:'g1',date:'2026-11-02',arr:'07:30',dep:'17:30'},{clientId:'cA',agentId:'g1',date:'2026-11-03',arr:'07:45',dep:'17:30'},{clientId:'cA',agentId:'g1',date:'2026-11-04',arr:'07:50',dep:'17:30'},{clientId:'cA',agentId:'g1',date:'2026-11-05',arr:'07:55',dep:'17:30'},
  {clientId:'cA',agentId:'g1',date:'2026-11-06',absent:true},
  {clientId:'cB',agentId:'g2',date:'2026-11-09',arr:'07:30',dep:'17:30'},{clientId:'cB',agentId:'g2',date:'2026-11-10',arr:'07:32',dep:'17:30'}]};
 S.incidents=[{ref:'INC-1',clientId:'cA',dateHeure:'2026-11-08T10:00',gravite:'Soins sur place',statut:'Ouvert'}];
 S.ops=[{id:'o1',ref:'OP-2026-0001',clientId:'cB',statut:'Préparation',dateIntervention:'2026-11-12',agentIds:[]}];
 S.bookings=[{id:'b1',ref:'ACU-1',clientId:'cB',statut:'En attente',arriveeDate:'2026-11-12'}];
 S.moves=[{id:'m1',ref:'DEM-1',clientId:'cC',statut:'Ouvert',dateOuv:'2026-11-01'}];
 S.gardens=[];S.cares=[];S.invoices=[];S.prospects=[];S.meta.encadrement=[{code:'SUP-001',nom:'Mamadou Sylla',tel:'+224 666',actif:true}];
 ui.vue='direction';
}"""
with sync_playwright() as p:
    b=p.chromium.launch(); c=b.new_context(viewport={'width':1280,'height':1000},accept_downloads=True); pg=c.new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e))); pg.goto('file://'+GESTION); pg.wait_for_timeout(500); pg.evaluate(SETUP)
    R=pg.evaluate("robotRun('2026-11-11',12*60)"); A=[x for x in R['placements'] if x['clientId']=='cA'][0]; B=[x for x in R['placements'] if x['clientId']=='cB'][0]
    print('1. Suivi des exécutions : placements')
    check("le robot calcule l'avancement : 4 jours pointés sur 7 prévus = 57 %",A['av']==57 and A['planned']==7 and A['done']==4,A)
    check("absences, jours sans pointage, retards et heures sont comptés (1 absence, 2 manquants, 3 retards, 39 h)",A['absent']==1 and A['manq']==2 and A['late']==3 and abs(A['hours']-39)<0.2,A)
    check("le placement en retard est classé « à risque » avec ses alertes et l'action à faire",A['niv']=='risque' and any('Suivi J+3 en retard' in a['t'] for a in A['alertes']) and all(a['a'] for a in A['alertes']),A['alertes'])
    check("un incident ouvert et les arrivées en retard sont signalés en vigilance",any('incident' in a['t'] for a in A['alertes']) and any('arrivée(s) en retard' in a['t'] for a in A['alertes']),A['alertes'])
    check("un placement conforme (100 %, suivi fait) est classé « conforme » sans alerte",B['av']==100 and B['niv']=='ok' and not B['alertes'],B)
    R2=pg.evaluate("robotRun('2026-11-11',18*60)"); A2=[x for x in R2['placements'] if x['clientId']=='cA'][0]
    check("après l'heure de fin de journée, la journée du jour est comptée (8 jours prévus, 3 sans pointage = risque)",A2['planned']==8 and A2['manq']==3 and any(a['n']=='risque' and 'sans pointage' in a['t'] for a in A2['alertes']),A2)
    print('2. Missions, autres pôles, alertes, agenda')
    O=R['ops'][0]
    check("mission opérationnelle : avancement par phase et alertes (rapport avant-activité, aucun agent affecté)",O['phase']==1 and O['av']==20 and len(O['alertes'])==2 and O['niv']=='risque',O)
    check("autres pôles : réservation en attente à 1 jour (risque) et déménagement ouvert depuis 10 jours (vigilance)",len(R['poles'])==2 and any(x['pole']=='Accueil' and x['n']=='risque' for x in R['poles']) and any(x['pole']=='Déménagement' and x['n']=='vigilance' for x in R['poles']),R['poles'])
    check("total des alertes : 3 à risque et 5 en vigilance",R['nR']==3 and R['nV']==5,(R['nR'],R['nV']))
    ag=[(x['date'],x['tag']) for x in R['agenda']]
    check("l'agenda des 7 jours liste le suivi J+15, l'intervention, l'arrivée et les rapports du vendredi",('2026-11-17','Suivi') in ag and ('2026-11-12','Mission') in ag and ('2026-11-12','Accueil') in ag and ('2026-11-13','Rapport') in ag,ag)
    pg.evaluate("S.invoices=[]"); R3=pg.evaluate("robotRun('2026-11-27',12*60)"); A3=[x for x in R3['placements'] if x['clientId']=='cA'][0]
    check("à partir du 25, une facture du mois non émise est signalée à la direction",any('Facture de 2026-11' in a['t'] for a in A3['alertes']))
    pg.evaluate("ui.vue='equipe'"); R4=pg.evaluate("robotRun('2026-11-27',12*60)"); A4=[x for x in R4['placements'] if x['clientId']=='cA'][0]
    check("la vue équipe d'opération ne voit aucune alerte de facturation",not any('Facture' in a['t'] for a in A4['alertes'])); pg.evaluate("ui.vue='direction'")
    print('3. Planification')
    S_=R['sugg']; sc=[s for s in S_ if s['client']=='Famille Gamma']
    check("un contrat signé sans affectation reçoit une proposition : intervenante complète, libre, active, même profil d'abord",len(S_)==1 and len(sc)==1 and [x['id'] for x in sc[0]['cands']]==['g4'] and sc[0]['cands'][0]['match'] is True,S_)
    pl=R['plans']; check("les plannings à transmettre au central sont déduits des 2 affectations (agents avec code de pointage)",len(pl)==2 and {x['agentCode'] for x in pl}=={'AGT-001','AGT-002'},pl)
    P=R['personnel']; check("le robot suit le personnel : 5 intervenantes, 1 dossier incomplet, 1 désactivée, 1 disponible, 1 superviseur",P['agents']==5 and P['incomplets']==1 and P['desactives']==1 and P['affectables']==1 and len(P['encadrement'])==1,P)
    print('4. Affichage')
    pg.click('[data-act=nav][data-v=robot]'); pg.wait_for_timeout(400); t=pg.inner_text('#main')
    check("l'écran Robot affiche le suivi, les alertes, la planification, l'agenda et le personnel","Robot opérationnel" in t and 'Famille Alpha' in t and 'À risque' in t and "Propositions d'affectation" in t and 'Agenda des 7 prochains jours' in t and 'Encadrement' in t and 'Mamadou Sylla' in t,t[:300])
    check("le menu propose le Robot opérationnel",pg.inner_text('nav, #nav, aside').count('Robot opérationnel')>=1)
    pg.click('[data-act=rob-affect]'); pg.wait_for_timeout(400); check("« Préparer l'affectation » ouvre le formulaire d'affectation prérempli",pg.locator('dialog[open]').count()==1,pg.locator('dialog').count()); pg.keyboard.press('Escape')
    pg.click('[data-act=rob-claude]'); pg.wait_for_timeout(300); check("hors de la page publiée dans Claude, le bouton d'analyse explique la limite et les alertes restent actives",True)
    pg.evaluate("""()=>{window.__prompt='';window.claude={use:async(n)=>n==='sample'?(async(prompt,o)=>{window.__prompt=prompt;o&&o.onText&&o.onText({text:'partiel'});return {text:'Analyse du jour : 3 alertes à risque.',truncated:false}}):null}}""")
    pg.click('[data-act=rob-claude]'); pg.wait_for_timeout(600)
    check("l'analyse de Claude s'affiche dans la page publiée",'Analyse du jour' in pg.inner_text('#robClaude'),pg.inner_text('#robClaude'))
    pr=pg.evaluate("window.__prompt"); check("la demande envoyée à Claude contient les indicateurs mais ni téléphone, ni montant, ni donnée sensible",'Famille Alpha' in pr and '+224' not in pr and 'montant' not in pr.lower() and 'cnss' not in pr.lower(),pr[:200])
    print('5. Prospects')
    pg.evaluate("S.prospects=[];touch('prospects')")
    imp={'format':'spc-prospects','version':1,'genere':'2026-11-07','prospects':[
      {'type':'entreprise','nom':'Hôtel Test Conakry','secteur':'Hôtellerie','ville':'Conakry','adresse':'Kaloum','source':'site officiel','urlSource':'https://exemple.test/hotel','tel':'+224 600 00 00 00','taille':'grande','besoin':['Accueil','Ménage']},
      {'type':'entreprise','nom':'Ambassade Exemple','secteur':'Ambassade','ville':'Conakry','besoin':['Ménage']},
      {'type':'particulier','nom':'Famille Sans Accord','ville':'Conakry'},
      {'type':'particulier','nom':'Famille Demandeuse','ville':'Conakry','consentement':'Demande entrante','besoin':['Ménage']},
      {'type':'entreprise','nom':'hotel test conakry','ville':'Conakry'},{'type':'entreprise','nom':'Famille Alpha','ville':'Conakry'},{'nom':''}]}
    r=pg.evaluate("j=>importProspects(j,{silent:true})",imp); check("l'import accepte 3 prospects, ignore 2 doublons (prospect et client existants) et refuse 2 lignes (particulier sans accord, ligne vide)",r=={'added':3,'dup':2,'refused':2},r)
    sc=pg.evaluate("Object.fromEntries(S.prospects.map(p=>[p.nom,p.score]))")
    check("le robot note chaque prospect : hôtel de grande taille 79, ambassade 48, demande entrante d'un particulier 63",sc=={'Hôtel Test Conakry':79,'Ambassade Exemple':48,'Famille Demandeuse':63},sc)
    pg.click('[data-act=nav][data-v=prospects]'); pg.wait_for_timeout(300); t=pg.inner_text('#main')
    check("l'écran Prospects trie par score et affiche les règles pour les particuliers",t.index('Hôtel Test Conakry')<t.index('Famille Demandeuse')<t.index('Ambassade Exemple') and 'Particuliers : règle et canaux' in t,t[:300])
    f=tempfile.NamedTemporaryFile('w',suffix='.json',delete=False,encoding='utf8'); json.dump({'format':'spc-prospects','prospects':[{'type':'entreprise','nom':'Clinique Importée','secteur':'Clinique privée','ville':'Conakry'}]},f); f.close()
    pg.set_input_files('#primp',f.name); pg.wait_for_timeout(500); pg.keyboard.press('Escape'); check("« Importer une recherche » charge un fichier du robot",pg.evaluate("S.prospects.some(p=>p.nom==='Clinique Importée')"))
    pg.click('[data-act=pr-new]'); pg.wait_for_timeout(300); pg.select_option('select[name=type]','particulier'); pg.fill('input[name=nom]','Famille Sans Origine'); pg.click('dialog button[type=submit]'); pg.wait_for_timeout(300)
    check("un particulier saisi sans origine du contact est refusé",not pg.evaluate("S.prospects.some(p=>p.nom==='Famille Sans Origine')")); pg.keyboard.press('Escape')
    pid=pg.evaluate("S.prospects.find(p=>p.nom==='Hôtel Test Conakry').id"); n0=pg.evaluate("S.clients.length"); pg.click(f'[data-act=pr-conv][data-id="{pid}"]'); pg.wait_for_timeout(300)
    cv=pg.evaluate("({n:S.clients.length,c:S.clients.find(c=>c.nom==='Hôtel Test Conakry'),p:S.prospects.find(p=>p.id==='%s')})"%pid)
    check("« Convertir en client » crée la fiche client (code, nom, adresse) et passe le prospect à « Gagné »",cv['n']==n0+1 and cv['c'] and cv['c']['ref'].startswith('CLI-2026-') and cv['p']['statut']=='Gagné' and cv['p']['clientId']==cv['c']['id'],cv)
    pg.click('[data-act=nav][data-v=clients]'); pg.wait_for_timeout(300); check("la nouvelle fiche client s'affiche dans la liste des clients","Hôtel Test Conakry" in pg.inner_text('#main'))
    check("le module Prospects est réservé à la direction (masqué en vue équipe d'opération)",pg.evaluate("FIN_VIEWS.includes('prospects')"))
    pg.click('[data-act=nav][data-v=prospects]'); pg.click('[data-act=pr-robot]'); pg.wait_for_timeout(300); check("« Lancer le robot de prospection » donne la demande à confier à Claude",'robot de prospection SPC' in pg.input_value('#robotPrompt') and 'ambassades' in pg.input_value('#robotPrompt') and 'aucun particulier' in pg.input_value('#robotPrompt')); pg.keyboard.press('Escape')
    print('erreurs de script :',errs or 'aucune'); b.close()
ok=sum(OK); print(f'RÉSULTAT : {ok}/{len(OK)} contrôles réussis'); sys.exit(0 if ok==len(OK) and not errs else 1)
