/* ============================================================
 * SiteStats 服务端（ESM）· 模块路径统一前缀 /api/ss/
 * 运行：npm run stats   端口：3881（或环境变量 SS_PORT）
 * 数据：server/data/visits.json   密码：server/data/auth.json
 *   POST /api/ss/report           访客上报（公开，存 IP/城市/UA/系统/浏览器）
 *   POST /api/ss/stay             停留回写（公开）
 *   GET  /api/ss/summary          公开聚合（仅数字，不含 IP/明细）
 *   POST /api/ss/login            密码换令牌（公开）
 *   POST /api/ss/logout           注销（公开）
 *   POST /api/ss/password         修改密码（需令牌）
 *   GET  /api/ss/visits?token=    拉取记录（需令牌）
 *   POST /api/ss/seed?token=      演示数据（需令牌）
 *   POST /api/ss/clear?token=     清空（需令牌）
 * ============================================================ */
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- 配置 ---------------- */
const PORT = process.env.SS_PORT || 3881;
const HOST = '127.0.0.1';
const MAX  = 20000;
const TOKEN_TTL = 12 * 3600 * 1000;
const STORE_IP = true;   // 明细需要 IP；仅登录后台可见，公开接口不暴露。设 false 则不存 IP

/* ---------------- 路径 ---------------- */
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'visits.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------- 密码 / 令牌 ---------------- */
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
function loadAuth(){
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); }
  catch(e){ const init = { passHash: sha256('admin123') }; try { fs.writeFileSync(AUTH_FILE, JSON.stringify(init)); } catch(_){} return init; }
}
function saveAuth(a){ try { fs.writeFileSync(AUTH_FILE, JSON.stringify(a)); } catch(e){ console.error('[auth]', e.message); } }
let auth = loadAuth();

const tokens = new Map();
const newToken = () => { const t = crypto.randomBytes(24).toString('hex'); tokens.set(t, Date.now() + TOKEN_TTL); return t; };
function validToken(t){ if(!t) return false; const exp = tokens.get(t); if(!exp) return false; if(Date.now()>exp){ tokens.delete(t); return false; } return true; }
const cleaner = setInterval(()=>{ const n=Date.now(); for(const [t,exp] of tokens) if(n>exp) tokens.delete(t); }, 3600*1000);
cleaner.unref && cleaner.unref();

/* ---------------- 离线 GeoIP ---------------- */
let geo = null;
try { geo = require('geoip-lite'); } catch(e){ console.warn('[提示] 未安装 geoip-lite，地域显示为"未知"。'); }
const COUNTRIES = { CN:'中国',HK:'中国香港',TW:'中国台湾',MO:'中国澳门',US:'美国',JP:'日本',KR:'韩国',SG:'新加坡',GB:'英国',DE:'德国',FR:'法国',CA:'加拿大',AU:'澳大利亚',NZ:'新西兰',RU:'俄罗斯',IN:'印度',BR:'巴西',NL:'荷兰',ES:'西班牙',IT:'意大利',CH:'瑞士',SE:'瑞典',NO:'挪威',DK:'丹麦',FI:'芬兰',IE:'爱尔兰',PT:'葡萄牙',AT:'奥地利',BE:'比利时',PL:'波兰',CZ:'捷克',HU:'匈牙利',RO:'罗马尼亚',GR:'希腊',UA:'乌克兰',TR:'土耳其',MY:'马来西亚',TH:'泰国',VN:'越南',ID:'印度尼西亚',PH:'菲律宾',AE:'阿联酋',SA:'沙特阿拉伯',IL:'以色列',EG:'埃及',NG:'尼日利亚',KE:'肯尼亚',ZA:'南非',MX:'墨西哥',AR:'阿根廷',CL:'智利',CO:'哥伦比亚',PE:'秘鲁' };
const CN_REGIONS = { SH:'上海',BJ:'北京',TJ:'天津',CQ:'重庆',GD:'广东',ZJ:'浙江',JS:'江苏',SD:'山东',HA:'河南',HE:'河北',SX:'陕西',SC:'四川',HB:'湖北',HN:'湖南',JX:'江西',AH:'安徽',FJ:'福建',LN:'辽宁',JL:'吉林',HL:'黑龙江',GX:'广西',YN:'云南',GZ:'贵州',GS:'甘肃',HI:'海南',NM:'内蒙古',XJ:'新疆',XZ:'西藏',NX:'宁夏',QH:'青海' };
const cname = c => (c ? (COUNTRIES[c] || c) : '未知');
const rname = (co, r) => (!r ? '' : (co === 'CN' ? (CN_REGIONS[r] || r) : r));
function clientIp(req){ const xff = req.headers['x-forwarded-for']; const ip = xff ? String(xff).split(',')[0].trim() : (req.socket.remoteAddress || ''); return ip.replace(/^::ffff:/,''); }
function locate(ip){
  if (!ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return { co:'本地网络', rg:'', city:'' };
  if (!geo) return { co:'未知', rg:'', city:'' };
  const g = geo.lookup(ip);
  return g ? { co: cname(g.country), rg: rname(g.country, g.region), city: (g.city || '') } : { co:'未知', rg:'', city:'' };
}

/* ---------------- UA 解析（系统 / 浏览器） ---------------- */
function parseUA(ua){
  if (!ua) return { os:'', browser:'' };
  let os = '';
  if (/Windows NT 10/i.test(ua)) os = 'Windows 10/11';
  else if (/Windows NT 6\.3/i.test(ua)) os = 'Windows 8.1';
  else if (/Windows NT 6\.1/i.test(ua)) os = 'Windows 7';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/iPad|Macintosh.*Touch/i.test(ua)) os = 'iPadOS';
  else if (/iPhone|iPod/i.test(ua)) os = 'iOS';
  else if (/Android ([\d.]+)/i.test(ua)) os = 'Android ' + (ua.match(/Android ([\d.]+)/i)[1] || '');
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Mac OS X ([\d_]+)/i.test(ua)) os = 'macOS ' + (ua.match(/Mac OS X ([\d_]+)/i)[1] || '').replace(/_/g, '.');
  else if (/Macintosh/i.test(ua)) os = 'macOS';
  else if (/CrOS/i.test(ua)) os = 'ChromeOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  const rules = [
    ['Edge', /Edg\//i], ['Opera', /OPR\/|Opera/i], ['Quark', /Quark/i],
    ['UC', /UCBrowser|UCWEB/i], ['Mi Browser', /MiuiBrowser/i], ['Huawei', /HuaweiBrowser/i],
    ['Samsung', /SamsungBrowser/i], ['WeChat', /MicroMessenger/i], ['QQ', /QQ\//i],
    ['Chrome', /Chrome\//i], ['Safari', /Version\/[\d.]+.*Safari\//i], ['Firefox', /Firefox\//i], ['IE', /MSIE|Trident/i]
  ];
  let br = '';
  for (const [name, re] of rules) { if (re.test(ua)) { br = name; break; } }
  const tokenMap = { Edge:'Edg', Opera:'OPR', Quark:'Quark', UC:'UCBrowser', 'Mi Browser':'MiuiBrowser', Huawei:'HuaweiBrowser', Samsung:'SamsungBrowser', WeChat:'MicroMessenger', QQ:'QQ', Chrome:'Chrome', Safari:'Version', Firefox:'Firefox' };
  const tk = tokenMap[br];
  if (tk) { const m = ua.match(new RegExp(tk + '\\/([\\d.]+)', 'i')); if (m) br = br + ' ' + m[1].split('.').slice(0, 2).join('.'); }
  return { os, browser: br };
}

/* ---------------- 访问数据读写 ---------------- */
let cache = null, timer = null;
function read(){ if (cache) return cache; try { cache = JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch(e){ cache = []; } return cache; }
function write(){ clearTimeout(timer); timer = setTimeout(()=>{ try { if (cache.length>MAX) cache = cache.slice(-MAX); fs.writeFileSync(DATA_FILE, JSON.stringify(cache)); } catch(e){ console.error('[write]', e.message); } }, 300); }
const iso = dt => dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');

/* ---------------- 应用 ---------------- */
const app = express();
app.use(express.json({ limit:'2mb' }));

const authed = (req,res,next) => {
  const token = req.query.token || (req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  return validToken(token) ? next() : res.status(401).json({ err:'unauthorized' });
};

app.post('/api/ss/report', (req,res)=>{
  const b = req.body || {};
  const ip = clientIp(req);
  const { co, rg, city } = locate(ip);
  const ua = String(b.ua || '').slice(0, 400);
  const { os, browser } = parseUA(ua);
  const t = Date.now(), dt = new Date(t); cache = read();
  cache.push({ t, d: iso(dt), h: dt.getHours(),
    p: String(b.p||'/').slice(0,200), uid: String(b.uid||'').slice(0,40)||'anon', sid: String(b.sid||'').slice(0,20),
    dev: ['desktop','mobile','tablet'].includes(b.dev)?b.dev:'desktop',
    st: String(b.st||'direct').slice(0,20), sl: String(b.sl||'').slice(0,60),
    scr: String(b.scr||'').slice(0,20), lang: String(b.lang||'').slice(0,20), tz: String(b.tz||'').slice(0,40),
    co, rg, city, ip: STORE_IP ? ip : '', ua, os, browser, stay: 0 });
  write(); res.json({ ok:1 });
});

app.post('/api/ss/stay', (req,res)=>{
  const { uid, t, stay } = req.body || {}; cache = read();
  for (let i=cache.length-1;i>=0;i--) if (cache[i].uid===uid && cache[i].t===t){ cache[i].stay = Math.min(1800, Math.max(0, +stay||0)); break; }
  write(); res.json({ ok:1 });
});

/* 公开聚合（仅数字，不含 IP / 明细，供首页挂件） */
app.get('/api/ss/summary', (req, res) => {
  const list = read();
  const today = iso(new Date());
  let todayPV = 0, todayUV = {}, recent = 0;
  list.forEach(r => {
    if (r.d === today) { todayPV++; todayUV[r.uid] = 1; }
    if (Date.now() - r.t < 3e5) recent++;
  });
  res.set('Cache-Control', 'no-store').json({ todayPV, todayUV: Object.keys(todayUV).length, totalPV: list.length, online: Math.max(recent, 1) });
});

app.post('/api/ss/login', (req,res)=>{
  const { password } = req.body || {};
  if (typeof password!=='string' || sha256(password)!==auth.passHash) return res.status(401).json({ err:'密码错误' });
  res.json({ ok:1, token: newToken() });
});
app.post('/api/ss/logout', (req,res)=>{ const { token } = req.body||{}; if(token) tokens.delete(token); res.json({ ok:1 }); });
app.post('/api/ss/password', (req,res)=>{
  const { token, oldPassword, newPassword } = req.body || {};
  if (!validToken(token)) return res.status(401).json({ err:'未登录或令牌过期' });
  if (sha256(oldPassword||'')!==auth.passHash) return res.status(403).json({ err:'当前密码不正确' });
  if (typeof newPassword!=='string' || newPassword.length<6) return res.status(400).json({ err:'新密码至少 6 位' });
  auth.passHash = sha256(newPassword); saveAuth(auth); res.json({ ok:1 });
});
app.get('/api/ss/visits', authed, (req,res)=> res.json(read()));
app.post('/api/ss/seed', authed, (req,res)=>{ const arr = Array.isArray(req.body)?req.body:[]; cache = read(); cache.push(...arr.slice(0,8000)); write(); res.json({ ok:1, total: cache.length }); });
app.post('/api/ss/clear', authed, (req,res)=>{ cache = []; write(); res.json({ ok:1 }); });

app.listen(PORT, HOST, ()=> console.log(`SiteStats 运行于 http://${HOST}:${PORT}（/api/ss/* · STORE_IP=${STORE_IP}）`));