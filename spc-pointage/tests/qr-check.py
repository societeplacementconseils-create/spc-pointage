"""Vérifie que les codes QR produits par shared/qr.js sont lisibles (décodage par OpenCV) pour des textes variés."""
import json, subprocess, sys, os
import numpy as np, cv2
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
texts = ['A', 'SPC1|S-1a2b3c4d|ABCD-EFGH-JKMN-PQRS', 'SPC1|S-ff00aa11|7K2M-9QXA-4F8D-VR3T', 'Résidence Côte d\'Ivoire é à ç',
         'x' * 14, 'x' * 15, 'x' * 40, 'y' * 62, 'z' * 100, 'SPC1|' + 'w' * 130, 'a' * 213, '0123456789' * 20 + 'ab']
js = "require('" + ROOT + "/shared/qr.js'); const t=JSON.parse(process.argv[1]); console.log(JSON.stringify(t.map(s=>globalThis.SPCQR.encode(s).map(r=>r.map(c=>c?1:0)))))"
out = subprocess.run(['node', '-e', js, json.dumps(texts)], capture_output=True, text=True)
if out.returncode: print(out.stderr); sys.exit(1)
mats = json.loads(out.stdout); det = cv2.QRCodeDetector(); bad = 0
for s, m in zip(texts, mats):
    a = 255 - (np.array(m, dtype=np.uint8) * 255); a = np.pad(a, 4, constant_values=255)
    img = cv2.resize(a, None, fx=10, fy=10, interpolation=cv2.INTER_NEAREST)
    val, pts, _ = det.detectAndDecode(img)
    ok = val == s; bad += not ok
    print(('OK  ' if ok else 'ÉCHEC'), 'version', (len(m) - 17) // 4, 'taille', len(s.encode()), 'octets', '' if ok else repr(val[:30]))
print('Tous les codes QR sont lisibles.' if not bad else f'{bad} échec(s).'); sys.exit(1 if bad else 0)
