"""Vérifie que la fabrication native (référence Python = EventFactory.kt) produit exactement la même chaîne canonique,
la même empreinte et la même signature que le JavaScript de l'application centrale."""
import os, sys, base64, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from native_ref import make, canon
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
random.seed(7)
KEY = base64.urlsafe_b64encode(bytes(random.randrange(256) for _ in range(32))).decode().rstrip('=')
cases = [
 dict(lat=9.5785, lon=-13.633, acc=8.4, dist=12.6, reason='', drift=None),
 dict(lat=0.0, lon=-0.000001, acc=0.4, dist=0.5, reason='', drift=0),
 dict(lat=12.0, lon=100.0, acc=59.5, dist=99.5, reason='Sortie de la zone détectée', drift=-5000),
 dict(lat=9.123456789, lon=-13.9999995, acc=33.3, dist=87.2, reason='guillemet " barre \\ saut\nligne\ttab', drift=1234),
 dict(lat=-33.8688, lon=151.2093, acc=7.5, dist=1.5, reason='Position simulée détectée (GPS fictif) 🚩', drift=250),
 dict(lat=9.57850049999, lon=-13.63300050001, acc=2.5, dist=3.5, reason='\u0001 contrôle', drift=-1),
]
for i in range(40):
    cases.append(dict(lat=round(random.uniform(-80, 80), random.randint(0, 9)), lon=round(random.uniform(-179, 179), random.randint(0, 9)), acc=random.uniform(0, 120), dist=random.uniform(0, 500), reason=random.choice(['', 'é à ç', 'a"b', 'x\\y']), drift=random.choice([None, 0, 999, -12345])))
bad = 0
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(); pg.goto('file://' + ROOT + '/index.html')
    pg.add_script_tag(path=ROOT + '/shared/core.js')
    prev = 'GENESIS'
    for i, c in enumerate(cases):
        e = make('AGT-007', KEY, 'S-1', 'IN' if i % 2 == 0 else 'OUT', '2026-10-12T08:%02d:%02d.%03dZ' % (i % 60, (i * 7) % 60, (i * 13) % 1000), c['lat'], c['lon'], c['acc'], c['dist'], 'in', 'auto', c['reason'], prev, c['drift'], t_gps='2026-10-12T08:00:00.000Z')
        r = pg.evaluate("""async ([e,key])=>{const canon=SPC.canon(e);const hash=await SPC.sha256(canon);const sig=await SPC.hmac(key,hash);return {canon,hash,sig}}""", [e, KEY])
        ok = r['canon'] == canon(e) and r['hash'] == e['hash'] and r['sig'] == e['sig']
        if not ok:
            bad += 1; print('ÉCART cas', i, '\n  js  :', r['canon'], '\n  ref :', canon(e))
        prev = e['hash']
    b.close()
print(f'{len(cases)} événements comparés : ' + ('tous identiques entre la référence native et le JavaScript.' if not bad else f'{bad} écart(s).'))
sys.exit(1 if bad else 0)
