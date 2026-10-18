"""Référence en Python de la fabrication d'un pointage natif.
Chaque fonction reproduit pas à pas EventFactory.kt (application Android) : si ce test passe contre le JavaScript
de l'application centrale, les pointages natifs sont vérifiables par le central."""
import hashlib, hmac as _hmac, base64, json
from decimal import Decimal, ROUND_HALF_UP

def num(d):                      # EventFactory.num : BigDecimal(d).setScale(6, HALF_UP).stripTrailingZeros().toPlainString()
    q = Decimal(d).quantize(Decimal('0.000001'), rounding=ROUND_HALF_UP)
    return format(q.normalize(), 'f') if q != 0 else '0'

def js_str(s):                   # EventFactory.jsStr
    out = ['"']
    for c in s:
        if c == '"': out.append('\\"')
        elif c == '\\': out.append('\\\\')
        elif c == '\n': out.append('\\n')
        elif c == '\r': out.append('\\r')
        elif c == '\t': out.append('\\t')
        elif c == '\b': out.append('\\b')
        elif c == '\f': out.append('\\f')
        elif ord(c) < 0x20: out.append('\\u%04x' % ord(c))
        else: out.append(c)
    out.append('"'); return ''.join(out)

def canon(e):                    # EventFactory.canon
    p = [js_str(e['id']), js_str(e['agentId']), js_str(e['siteId']), js_str(e['type']), js_str(e['t']), js_str(e['tGps']),
         num(e['lat']), num(e['lon']), str(int(e['acc'])), str(int(e['dist'])), js_str(e['zone']), js_str(e['mode']), js_str(e['reason']),
         js_str(e['signerId']), js_str(e['prev']), '""' if e.get('drift') is None else str(int(e['drift']))]
    if e.get('src'): p.append(js_str(e['src']))
    return '[' + ','.join(p) + ']'

def sha256(s): return hashlib.sha256(s.encode('utf-8')).hexdigest()
def hmac_hex(key_b64u, msg):     # EventFactory.hmac : clé décodée en base64 URL sans remplissage
    key = base64.urlsafe_b64decode(key_b64u + '=' * (-len(key_b64u) % 4))
    return _hmac.new(key, msg.encode('utf-8'), hashlib.sha256).hexdigest()

def make(cfg_id, key, site_id, typ, t_iso, lat, lon, acc, dist, zone, mode, reason, prev, drift, t_gps='', date=None, ev_id='abc123def456'):
    e = {'id': ev_id, 'agentId': cfg_id, 'siteId': site_id, 'type': typ, 't': t_iso, 'tGps': t_gps,
         'lat': float(num(lat)), 'lon': float(num(lon)), 'acc': round(acc), 'dist': round(dist), 'zone': zone, 'mode': mode,
         'reason': reason, 'signerId': cfg_id, 'prev': prev, 'drift': drift, 'date': date or t_iso[:10], 'app': 'native-1.0.0', 'src': 'native'}
    e['hash'] = sha256(canon(e)); e['sig'] = hmac_hex(key, e['hash']); return e
