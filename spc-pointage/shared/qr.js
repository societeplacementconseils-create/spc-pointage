/* Générateur de codes QR (mode octets, correction d'erreur M, versions 1 à 10).
   Sans dépendance, fonctionne hors connexion. Produit une matrice de modules ou une image SVG. */
(function (g) {
  'use strict';
  const ECC_PER_BLOCK_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  const NUM_BLOCKS_M = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const MAX_VERSION = 10;

  function rawDataModules(ver) {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const n = Math.floor(ver / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  const dataCodewords = ver => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * NUM_BLOCKS_M[ver];

  function alignPositions(ver) {
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const res = [6];
    for (let pos = size - 7; res.length < n; pos -= step) res.splice(1, 0, pos);
    return res;
  }

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
    return z;
  }
  function rsDivisor(degree) {
    const res = new Array(degree).fill(0); res[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < res.length; j++) { res[j] = gfMul(res[j], root); if (j + 1 < res.length) res[j] ^= res[j + 1]; }
      root = gfMul(root, 0x02);
    }
    return res;
  }
  function rsRemainder(data, div) {
    const res = div.map(() => 0);
    for (const b of data) {
      const factor = b ^ res.shift(); res.push(0);
      div.forEach((coef, i) => { res[i] ^= gfMul(coef, factor); });
    }
    return res;
  }
  function addEcc(data, ver) {
    const nb = NUM_BLOCKS_M[ver], eccLen = ECC_PER_BLOCK_M[ver], raw = Math.floor(rawDataModules(ver) / 8);
    const nShort = nb - raw % nb, shortLen = Math.floor(raw / nb), blocks = [], div = rsDivisor(eccLen);
    for (let i = 0, k = 0; i < nb; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1)); k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < nShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const out = [];
    for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) out.push(b[i]); });
    return out;
  }

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    let ver = 1;
    for (; ver <= MAX_VERSION; ver++) {
      const ccBits = ver <= 9 ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
    }
    if (ver > MAX_VERSION) throw new Error('Texte trop long pour le code QR');
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0x4, 4); put(bytes.length, ver <= 9 ? 8 : 16); bytes.forEach(b => put(b, 8));
    const cap = dataCodewords(ver) * 8;
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; data.push(b); }
    const all = addEcc(data, ver);

    const size = ver * 4 + 17;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (x, y, v) => { mod[y][x] = v; fn[y][x] = true; };
    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const ap = alignPositions(ver);
    ap.forEach((ax, i) => ap.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const bit = (x, i) => ((x >>> i) & 1) !== 0;
    const formatBits = mask => {
      const d = (0 << 3) | mask; // niveau M = 0
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits15 = ((d << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) setFn(8, i, bit(bits15, i));
      setFn(8, 7, bit(bits15, 6)); setFn(8, 8, bit(bits15, 7)); setFn(7, 8, bit(bits15, 8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bits15, i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bits15, i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bits15, i));
      setFn(8, size - 8, true);
    };
    formatBits(0);
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const bits18 = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) { const c = bit(bits18, i), a = size - 11 + i % 3, b = Math.floor(i / 3); setFn(a, b, c); setFn(b, a, c); }
    }
    // placement des données en zigzag
    let k = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && k < all.length * 8) { mod[y][x] = bit(all[k >>> 3], 7 - (k & 7)); k++; }
      }
    }
    const applyMask = m => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        let inv;
        switch (m) {
          case 0: inv = (x + y) % 2 === 0; break; case 1: inv = y % 2 === 0; break; case 2: inv = x % 3 === 0; break; case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break; case 5: inv = x * y % 2 + x * y % 3 === 0; break;
          case 6: inv = (x * y % 2 + x * y % 3) % 2 === 0; break; default: inv = ((x + y) % 2 + x * y % 3) % 2 === 0;
        }
        if (!fn[y][x] && inv) mod[y][x] = !mod[y][x];
      }
    };
    const penalty = () => {
      let p = 0;
      for (let t = 0; t < 2; t++) for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          const cur = t ? mod[b][a] : mod[a][b], prev = t ? mod[b - 1][a] : mod[a][b - 1];
          if (cur === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
        }
      }
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3; }
      const pat = [true, false, true, true, true, false, true];
      for (let t = 0; t < 2; t++) for (let a = 0; a < size; a++) for (let b = 0; b <= size - 7; b++) {
        let ok = true; for (let i = 0; i < 7; i++) if ((t ? mod[b + i][a] : mod[a][b + i]) !== pat[i]) { ok = false; break; }
        if (ok) p += 40;
      }
      let dark = 0; mod.forEach(r => r.forEach(c => { if (c) dark++; }));
      p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
      return p;
    };
    let best = 0, bestP = Infinity;
    for (let m = 0; m < 8; m++) { applyMask(m); formatBits(m); const p = penalty(); if (p < bestP) { bestP = p; best = m; } applyMask(m); }
    applyMask(best); formatBits(best);
    return mod;
  }

  /** Image SVG (modules noirs sur fond blanc, marge de 4 modules). */
  function svg(text, px) {
    const m = encode(text), n = m.length, q = 4, tot = n + 2 * q;
    let d = '';
    for (let y = 0; y < n; y++) { let x = 0; while (x < n) { if (m[y][x]) { let w = 1; while (x + w < n && m[y][x + w]) w++; d += 'M' + (x + q) + ' ' + (y + q) + 'h' + w + 'v1h-' + w + 'z'; x += w; } else x++; } }
    const s = px ? ' width="' + px + '" height="' + px + '"' : '';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + tot + ' ' + tot + '"' + s + ' shape-rendering="crispEdges" role="img" aria-label="Code QR"><rect width="' + tot + '" height="' + tot + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }

  g.SPCQR = { encode, svg };
})(typeof window !== 'undefined' ? window : globalThis);
