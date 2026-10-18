/* Faux serveur GitHub (sous-ensemble de l'API "contents" et "git/trees") pour tester sans réseau.
   Usage : node tests/mock-github.js 4010   (jeton accepté : test-token) */
const http = require('http'), crypto = require('crypto');
const PORT = +process.argv[2] || 4010, TOKEN = 'test-token';
const files = new Map(); // chemin -> { content (utf8), sha }
const sha = s => crypto.createHash('sha1').update(s).digest('hex');
const commits = [];
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag, X-RateLimit-Remaining' }); res.end(JSON.stringify(obj)); };
const b64 = s => Buffer.from(s, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-GitHub-Api-Version', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS' }); return res.end(); }
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    if (u.pathname.startsWith('/__admin/')) {
      const j = body ? JSON.parse(body) : {};
      if (u.pathname === '/__admin/dump') return send(res, 200, Object.fromEntries([...files].map(([k, v]) => [k, v.content])));
      if (u.pathname === '/__admin/set') { files.set(j.path, { content: j.content, sha: sha(j.content) }); return send(res, 200, { ok: 1 }); }
      if (u.pathname === '/__admin/delete') { files.delete(j.path); return send(res, 200, { ok: 1 }); }
      if (u.pathname === '/__admin/reset') { files.clear(); return send(res, 200, { ok: 1 }); }
    }
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(res, 401, { message: 'Bad credentials' });
    let m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^/]+)$/);
    if (m) return send(res, 200, { sha: 'tree', truncated: false, tree: [...files].map(([p, v]) => ({ path: p, type: 'blob', sha: v.sha })) });
    m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (!m) return send(res, 404, { message: 'Not Found' });
    const path = decodeURIComponent(m[3]).replace(/\/$/, '');
    if (req.method === 'GET') {
      if (files.has(path)) { const f = files.get(path); return send(res, 200, { type: 'file', name: path.split('/').pop(), path, sha: f.sha, size: f.content.length, encoding: 'base64', content: b64(f.content) }); }
      const pre = path + '/', kids = new Map();
      for (const [p, v] of files) if (p.startsWith(pre)) { const rest = p.slice(pre.length), n = rest.split('/')[0]; kids.set(n, rest.includes('/') ? { name: n, path: pre + n, sha: 'dir' + n, type: 'dir' } : { name: n, path: p, sha: v.sha, type: 'file' }); }
      if (kids.size) return send(res, 200, [...kids.values()]);
      return send(res, 404, { message: 'Not Found' });
    }
    if (req.method === 'PUT') {
      const j = JSON.parse(body), content = Buffer.from(j.content, 'base64').toString('utf8'), ex = files.get(path);
      if (ex && !j.sha) return send(res, 422, { message: "Invalid request. \"sha\" wasn't supplied." });
      if (ex && j.sha !== ex.sha) return send(res, 409, { message: path + ' does not match ' + j.sha });
      if (!ex && j.sha) return send(res, 422, { message: 'sha supplied for a new file' });
      const s = sha(content); files.set(path, { content, sha: s }); const date = new Date().toISOString(); commits.push({ path, date });
      return send(res, ex ? 200 : 201, { content: { path, sha: s }, commit: { sha: sha(path + date), committer: { date }, author: { date }, message: j.message } });
    }
    send(res, 405, { message: 'Method not allowed' });
  });
}).listen(PORT, () => console.log('faux GitHub sur le port ' + PORT));
