import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { db, save, newId, ROOT, UPLOAD_DIR } from './lib/db.js';
import { VERSION, PORT, MEDIA_PORT, BASE_URL } from './lib/config.js';
import * as fb from './lib/facebook.js';
import * as tt from './lib/tiktok.js';
import * as line from './lib/line.js';
import * as tunnel from './lib/tunnel.js';
import { hasFfmpeg, probeDuration } from './lib/media.js';
import { runPost, isRunning, recoverOnStartup, duePosts, deleteMediaFiles, tiktokToken, mediaPath } from './lib/publisher.js';

const REDIRECT = {
  facebook: `${BASE_URL}/auth/facebook/callback`,
  tiktok: `${BASE_URL}/auth/tiktok/callback`,
};
const MB = 1024 * 1024;

class UserError extends Error {}
const fail = msg => { throw new UserError(msg); };

const app = express();

// Only answer requests addressed to this machine (blocks DNS-rebinding from other sites)
app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return res.status(403).send('Forbidden');
  next();
});
// A custom header forces a CORS preflight, so other websites cannot trigger posts from the browser
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('x-app') !== 'rattana') return res.status(403).json({ error: 'forbidden' });
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, { dotfiles: 'deny', index: false }));

/* ---------- helpers ---------- */

const publicAccount = a => ({
  id: a.id, platform: a.platform, name: a.name, externalId: a.externalId, picture: a.picture || '',
  enabled: a.enabled !== false, addedAt: a.addedAt, meta: a.meta || {},
  expiresAt: a.platform === 'tiktok' ? a.refreshExpiresAt || null : null,
});

const publicPost = p => ({ ...p, media: p.media.map(({ file, name, mime, size, kind }) => ({ file, name, mime, size, kind })) });

function upsertAccount(platform, externalId, fields) {
  let a = db.accounts.find(x => x.platform === platform && x.externalId === externalId);
  if (a) Object.assign(a, fields);
  else {
    a = { id: newId(), platform, externalId, enabled: true, addedAt: new Date().toISOString(), ...fields };
    db.accounts.push(a);
  }
  return a;
}

async function importFacebookPages(userToken) {
  if (!userToken) fail('กรุณาใส่ User Access Token');
  const s = db.settings;
  let token = userToken;
  if (s.fbAppId && s.fbAppSecret) {
    token = await fb.longLived({ appId: s.fbAppId, appSecret: s.fbAppSecret, token }).catch(e => {
      throw new UserError(`แลก Long-lived token ไม่สำเร็จ: ${e.message}`);
    });
  }
  const pages = await fb.listPages(token);
  if (!pages.length) fail('ไม่พบเพจที่บัญชีนี้ดูแล — ตรวจสอบว่าเลือกเพจตอนล็อกอิน และได้สิทธิ์ pages_show_list');
  for (const p of pages) {
    upsertAccount('facebook', p.id, { name: p.name, token: p.access_token, picture: p.picture?.data?.url || '', meta: { category: p.category } });
  }
  save();
  return pages.length;
}

const oauthStates = new Map();
function newState(data) {
  const s = newId(16);
  oauthStates.set(s, { ...data, at: Date.now() });
  return s;
}
function takeState(s) {
  const d = oauthStates.get(s);
  oauthStates.delete(s);
  return d && Date.now() - d.at < 15 * 60e3 ? d : null;
}
const backToApp = (res, q) => res.redirect('/?' + new URLSearchParams(q));

/* ---------- status & settings ---------- */

app.get('/api/status', async (req, res) => {
  res.json({ version: VERSION, ffmpeg: await hasFfmpeg(), tunnel: tunnel.status(), publicBase: tunnel.getPublicBase() || null, mediaReady: tunnel.canServeMedia() });
});

app.post('/api/tunnel/start', async (req, res) => {
  res.json({ url: await tunnel.startTunnel(), tunnel: tunnel.status() });
});

app.get('/api/settings', (req, res) => {
  const s = db.settings;
  res.json({
    fbAppId: s.fbAppId || '', fbAppSecretSet: !!s.fbAppSecret,
    ttClientKey: s.ttClientKey || '', ttClientSecretSet: !!s.ttClientSecret,
    publicBaseUrl: s.publicBaseUrl || '', redirect: REDIRECT,
  });
});

app.post('/api/settings', (req, res) => {
  const b = req.body || {};
  if (b.publicBaseUrl && !/^https:\/\//i.test(String(b.publicBaseUrl).trim())) fail('Public Media URL ต้องขึ้นต้นด้วย https://');
  for (const k of ['fbAppId', 'ttClientKey', 'publicBaseUrl']) if (k in b) db.settings[k] = String(b[k] || '').trim();
  // Blank secret fields mean "keep the saved one"
  for (const k of ['fbAppSecret', 'ttClientSecret']) if (b[k]) db.settings[k] = String(b[k]).trim();
  save();
  res.json({ ok: true });
});

/* ---------- accounts ---------- */

app.get('/api/accounts', (req, res) => res.json(db.accounts.map(publicAccount)));

app.patch('/api/accounts/:id', (req, res) => {
  const a = db.accounts.find(x => x.id === req.params.id) || fail('ไม่พบบัญชี');
  if (typeof req.body.name === 'string' && req.body.name.trim()) a.name = req.body.name.trim();
  if (typeof req.body.enabled === 'boolean') a.enabled = req.body.enabled;
  save();
  res.json(publicAccount(a));
});

app.delete('/api/accounts/:id', (req, res) => {
  db.accounts = db.accounts.filter(x => x.id !== req.params.id);
  save();
  res.json({ ok: true });
});

app.post('/api/accounts/line', async (req, res) => {
  const token = String(req.body.token || '').trim() || fail('กรุณาใส่ Channel Access Token');
  const info = await line.botInfo(token).catch(e => { throw new UserError(`ตรวจสอบ Token ไม่ผ่าน: ${e.message}`); });
  const a = upsertAccount('line', info.userId, {
    name: String(req.body.name || '').trim() || info.displayName,
    token, picture: info.pictureUrl || '', meta: { basicId: info.basicId },
  });
  save();
  res.json(publicAccount(a));
});

app.get('/api/accounts/:id/quota', async (req, res) => {
  const a = db.accounts.find(x => x.id === req.params.id && x.platform === 'line') || fail('ไม่พบบัญชี LINE');
  res.json(await line.quota(a.token));
});

app.get('/api/accounts/:id/tiktok-creator', async (req, res) => {
  const a = db.accounts.find(x => x.id === req.params.id && x.platform === 'tiktok') || fail('ไม่พบบัญชี TikTok');
  const c = await tt.creatorInfo(await tiktokToken(a)).catch(e => { throw new UserError(e.message); });
  res.json({
    nickname: c.creator_nickname || a.name,
    username: c.creator_username || '',
    avatar: c.creator_avatar_url || a.picture || '',
    privacyOptions: c.privacy_level_options || [],
    commentDisabled: !!c.comment_disabled,
    duetDisabled: !!c.duet_disabled,
    stitchDisabled: !!c.stitch_disabled,
    maxDurationSec: c.max_video_post_duration_sec || null,
  });
});

app.post('/api/accounts/facebook/token', async (req, res) => {
  res.json({ count: await importFacebookPages(String(req.body.token || '').trim()) });
});

/* ---------- OAuth ---------- */

app.get('/auth/facebook/start', (req, res) => {
  const s = db.settings;
  if (!s.fbAppId || !s.fbAppSecret) return backToApp(res, { error: 'กรุณาใส่ Facebook App ID และ App Secret ในแท็บตั้งค่าก่อน', tab: 'settings' });
  res.redirect(fb.authUrl({ appId: s.fbAppId, redirectUri: REDIRECT.facebook, state: newState({ p: 'facebook' }) }));
});

app.get('/auth/facebook/callback', async (req, res) => {
  try {
    if (req.query.error) fail(req.query.error_description || req.query.error);
    if (!takeState(req.query.state)) fail('ลิงก์ล็อกอินหมดอายุ ลองใหม่อีกครั้ง');
    const s = db.settings;
    const token = await fb.exchangeCode({ appId: s.fbAppId, appSecret: s.fbAppSecret, redirectUri: REDIRECT.facebook, code: req.query.code });
    const count = await importFacebookPages(token);
    backToApp(res, { connected: 'facebook', count, tab: 'accounts' });
  } catch (e) {
    backToApp(res, { error: `Facebook: ${e.message}`, tab: 'accounts' });
  }
});

app.get('/auth/tiktok/start', (req, res) => {
  const s = db.settings;
  if (!s.ttClientKey || !s.ttClientSecret) return backToApp(res, { error: 'กรุณาใส่ TikTok Client Key และ Client Secret ในแท็บตั้งค่าก่อน', tab: 'settings' });
  const { verifier, challenge } = tt.pkce();
  res.redirect(tt.authUrl({ clientKey: s.ttClientKey, redirectUri: REDIRECT.tiktok, state: newState({ p: 'tiktok', verifier }), challenge }));
});

app.get('/auth/tiktok/callback', async (req, res) => {
  try {
    if (req.query.error) fail(req.query.error_description || req.query.error);
    const st = takeState(req.query.state) || fail('ลิงก์ล็อกอินหมดอายุ ลองใหม่อีกครั้ง');
    const s = db.settings;
    const t = await tt.exchangeCode({ clientKey: s.ttClientKey, clientSecret: s.ttClientSecret, code: req.query.code, redirectUri: REDIRECT.tiktok, verifier: st.verifier });
    const user = await tt.userInfo(t.access_token).catch(() => ({}));
    upsertAccount('tiktok', t.open_id, {
      name: user.display_name || `TikTok ${t.open_id.slice(0, 6)}`,
      picture: user.avatar_url || '',
      token: t.access_token,
      refreshToken: t.refresh_token,
      expiresAt: Date.now() + t.expires_in * 1000,
      refreshExpiresAt: Date.now() + t.refresh_expires_in * 1000,
      meta: { scope: t.scope },
    });
    save();
    backToApp(res, { connected: 'tiktok', count: 1, tab: 'accounts' });
  } catch (e) {
    backToApp(res, { error: `TikTok: ${e.message}`, tab: 'accounts' });
  }
});

/* ---------- posts ---------- */

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    // Random names: the media server is reachable from the internet through the tunnel
    filename: (req, file, cb) => cb(null, newId(16) + path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')),
  }),
  limits: { fileSize: 4 * 1024 * MB, files: 10 },
});

const parseJson = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

app.get('/api/posts', (req, res) => res.json(db.posts.map(publicPost)));

app.post('/api/posts', upload.array('files', 10), async (req, res) => {
  const files = req.files || [];
  try {
    const b = req.body;
    const caption = String(b.caption || '').trim();
    const captions = parseJson(b.captions, {});
    const targets = [...new Set(parseJson(b.targets, []))].filter(id => db.accounts.some(a => a.id === id));
    const accs = targets.map(id => db.accounts.find(a => a.id === id));
    const has = p => accs.some(a => a.platform === p);
    const media = files.map(f => ({
      file: f.filename,
      // multer hands back UTF-8 file names decoded as latin1
      name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
      mime: f.mimetype, size: f.size,
      kind: f.mimetype.startsWith('video/') ? 'video' : 'image',
    }));
    const videos = media.filter(m => m.kind === 'video');

    if (!targets.length) fail('กรุณาเลือกบัญชีปลายทางอย่างน้อย 1 บัญชี');
    if (media.some(m => !/^(image|video)\//.test(m.mime))) fail('รองรับเฉพาะไฟล์รูปภาพและวิดีโอ');
    if (videos.length > 1 || (videos.length && media.length > 1)) fail('แนบได้ รูปภาพสูงสุด 10 รูป หรือ วิดีโอ 1 ไฟล์ (ห้ามผสมกัน)');
    if (!caption && !media.length && !Object.values(captions).some(v => String(v).trim())) fail('กรุณาใส่ข้อความหรือแนบรูป/วิดีโอ');
    if (has('tiktok') && !videos.length) fail('TikTok ต้องแนบวิดีโอ 1 ไฟล์');
    if (has('line') && media.length && !tunnel.canServeMedia()) fail('การส่งรูป/วิดีโอทาง LINE ต้องมี URL สาธารณะ — ติดตั้ง cloudflared หรือใส่ Public Media URL ในแท็บตั้งค่า');

    let scheduledAt = null;
    if (b.scheduledAt) {
      const t = Date.parse(b.scheduledAt);
      if (Number.isNaN(t)) fail('รูปแบบวันเวลาไม่ถูกต้อง');
      if (t < Date.now() - 60e3) fail('เวลาที่ตั้งต้องเป็นเวลาในอนาคต');
      scheduledAt = new Date(t).toISOString();
    }

    // TikTok settings are chosen per account: each creator has its own privacy options and interaction switches
    const t = parseJson(b.tiktok, {});
    const tiktokAccs = accs.filter(a => a.platform === 'tiktok');
    const tiktok = {
      mode: t.mode === 'draft' ? 'draft' : 'direct',
      disclose: !!t.disclose,
      brandOrganic: !!t.disclose && !!t.brandOrganic,
      brandedContent: !!t.disclose && !!t.brandedContent,
      accounts: Object.fromEntries(tiktokAccs.map(a => {
        const o = t.accounts?.[a.id] || {};
        return [a.id, { privacy: String(o.privacy || ''), allowComment: !!o.allowComment, allowDuet: !!o.allowDuet, allowStitch: !!o.allowStitch }];
      })),
    };
    if (tiktokAccs.length && tiktok.mode === 'direct') {
      for (const a of tiktokAccs) {
        const { privacy } = tiktok.accounts[a.id];
        if (!privacy) fail(`TikTok: กรุณาเลือก "ใครเห็นได้" ให้บัญชี ${a.name}`);
        if (tiktok.brandedContent && privacy === 'SELF_ONLY') fail(`TikTok: Branded content ตั้งเป็น "เฉพาะฉัน" ไม่ได้ (บัญชี ${a.name})`);
      }
      if (tiktok.disclose && !tiktok.brandOrganic && !tiktok.brandedContent) fail('TikTok: เปิดการเปิดเผยเนื้อหาเชิงพาณิชย์แล้ว ต้องเลือกอย่างน้อย 1 แบบ');
    }

    for (const m of videos) m.duration = await probeDuration(mediaPath(m.file)).catch(() => null);

    const post = {
      id: newId(),
      createdAt: new Date().toISOString(),
      scheduledAt,
      status: scheduledAt ? 'scheduled' : 'queued',
      caption,
      captions: { facebook: String(captions.facebook || ''), tiktok: String(captions.tiktok || ''), line: String(captions.line || '') },
      media,
      targets,
      tiktok,
      results: Object.fromEntries(targets.map(id => [id, { status: 'pending' }])),
    };
    db.posts.push(post);
    save();
    if (!scheduledAt) runPost(post);
    res.json(publicPost(post));
  } catch (e) {
    for (const f of files) fs.rmSync(f.path, { force: true });
    throw e;
  }
});

function findPost(id) {
  return db.posts.find(p => p.id === id) || fail('ไม่พบโพสต์');
}

// Only posts still waiting to go out can be edited
app.patch('/api/posts/:id', (req, res) => {
  const post = findPost(req.params.id);
  if (!['scheduled', 'missed'].includes(post.status) || isRunning(post.id)) fail('แก้ได้เฉพาะโพสต์ที่ยังรอโพสต์อยู่');
  const t = req.body.tiktok;
  if (t) {
    const cur = post.tiktok || {};
    if (t.mode === 'draft') {
      post.tiktok = { ...cur, mode: 'draft' };
    } else {
      // Applies one privacy level to every TikTok account of the post, keeping their other settings
      const privacy = String(t.privacy || '') || fail('กรุณาเลือกระดับการมองเห็นของ TikTok');
      if (cur.brandedContent && privacy === 'SELF_ONLY') fail('Branded content ตั้งเป็น "เฉพาะฉัน" ไม่ได้');
      const ids = post.targets.filter(id => db.accounts.find(a => a.id === id)?.platform === 'tiktok');
      const accounts = Object.fromEntries(ids.map(id => [id, { ...(cur.accounts?.[id] || {}), privacy }]));
      post.tiktok = { ...cur, mode: 'direct', privacy, accounts };
    }
  }
  save();
  res.json(publicPost(post));
});

app.post('/api/posts/:id/retry', (req, res) => {
  const post = findPost(req.params.id);
  if (isRunning(post.id)) fail('โพสต์นี้กำลังทำงานอยู่');
  runPost(post, { onlyFailed: true });
  res.json({ ok: true });
});

app.post('/api/posts/:id/run-now', (req, res) => {
  const post = findPost(req.params.id);
  if (!['scheduled', 'missed'].includes(post.status)) fail('โพสต์นี้ไม่ได้อยู่ในสถานะรอโพสต์');
  runPost(post);
  res.json({ ok: true });
});

app.delete('/api/posts/:id', (req, res) => {
  const post = findPost(req.params.id);
  if (isRunning(post.id)) fail('โพสต์นี้กำลังทำงานอยู่ ลบไม่ได้');
  deleteMediaFiles(post);
  db.posts = db.posts.filter(p => p.id !== post.id);
  save();
  res.json({ ok: true });
});

/* ---------- errors ---------- */

app.use((err, req, res, next) => {
  const isUser = err instanceof UserError || err instanceof multer.MulterError;
  if (!isUser) console.error(err);
  res.status(isUser ? 400 : 500).json({ error: err.message || 'เกิดข้อผิดพลาด' });
});

/* ---------- media server (the only thing exposed through the tunnel) ---------- */

const mediaApp = express();
mediaApp.get('/health', (req, res) => res.send('ok'));
mediaApp.use('/m', express.static(UPLOAD_DIR, { dotfiles: 'deny', index: false }));
mediaApp.use((req, res) => res.status(404).send('Not found'));

/* ---------- boot ---------- */

recoverOnStartup();

const onListenError = port => err => {
  console.error(err.code === 'EADDRINUSE'
    ? `\n  ✖ Port ${port} ถูกใช้อยู่ — แอปอาจเปิดอยู่แล้วในหน้าต่างอื่น (เปิด ${BASE_URL} ได้เลย)\n`
    : err);
  process.exit(1);
};
mediaApp.listen(MEDIA_PORT, '127.0.0.1').on('error', onListenError(MEDIA_PORT));
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Rattana Social Posting v${VERSION}`);
  console.log(`  เปิดใช้งานที่  ${BASE_URL}\n`);
}).on('error', onListenError(PORT));

if (!db.settings.publicBaseUrl) {
  tunnel.startTunnel().then(u => console.log(u
    ? `  LINE media tunnel: ${u}`
    : '  ⚠ ไม่ได้เปิด tunnel (ไม่พบ cloudflared) — LINE จะส่งได้เฉพาะข้อความ'));
}

setInterval(() => duePosts().forEach(p => runPost(p)), 15000);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { tunnel.stopTunnel(); process.exit(0); });
