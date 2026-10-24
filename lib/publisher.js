import fs from 'node:fs';
import path from 'node:path';
import { db, save, UPLOAD_DIR } from './db.js';
import * as fb from './facebook.js';
import * as tt from './tiktok.js';
import * as line from './line.js';
import * as tunnel from './tunnel.js';
import { hasFfmpeg, thumbnail, toJpeg, remuxMp4 } from './media.js';

const MB = 1024 * 1024;
// A scheduled post that is this late (PC off/asleep) is not posted at a random hour — the user decides
const LATE_LIMIT = 60 * 60e3;
const running = new Set();
const now = () => new Date().toISOString();

export const isRunning = id => running.has(id);
export const mediaPath = file => path.join(UPLOAD_DIR, file);
const withPaths = media => media.map(m => ({ ...m, path: mediaPath(m.file) }));
const textFor = (post, platform) => String(post.captions?.[platform] || '').trim() || post.caption || '';
// "scheduled" = the platform itself holds the post and publishes it at the set time
const handled = s => s === 'success' || s === 'scheduled';

export function summarize(post) {
  const st = post.targets.map(id => post.results[id]?.status);
  if (st.every(handled)) return 'done';
  if (st.some(handled)) return 'partial';
  return 'failed';
}

// Once the time has passed, a post Facebook was holding has been published by Facebook
function settleScheduled(post) {
  if (Date.parse(post.scheduledAt) > Date.now()) return;
  for (const id of post.targets) {
    const r = post.results[id];
    if (r?.status === 'scheduled') Object.assign(r, { status: 'success', note: 'Facebook โพสต์ให้ตามเวลาที่ตั้งไว้' });
  }
}

// Facebook accepts scheduled_publish_time 10 minutes to 30 days ahead (kept a little inside both limits)
const FB_MIN_LEAD = 11 * 60e3;
const FB_MAX_LEAD = 29 * 24 * 3600e3;

// Hands Facebook targets of a scheduled post to Facebook right away, so they go out even if this PC is off.
// TikTok and LINE have no scheduling API, so those still wait for this app at the set time.
export async function scheduleOnPlatforms(post) {
  const at = Date.parse(post.scheduledAt);
  const lead = at - Date.now();
  if (!(lead > FB_MIN_LEAD && lead < FB_MAX_LEAD)) return;
  const fbIds = post.targets.filter(id => db.accounts.find(a => a.id === id)?.platform === 'facebook');
  if (!fbIds.length) return;
  running.add(post.id);
  try {
    await Promise.all(fbIds.map(async id => {
      const acc = db.accounts.find(a => a.id === id);
      const r = post.results[id] = { status: 'running', at: now(), note: 'กำลังอัปโหลดไปตั้งเวลาบน Facebook…' };
      save();
      try {
        const out = await fb.publish({
          pageId: acc.externalId, token: acc.token, text: textFor(post, 'facebook'),
          media: withPaths(post.media), scheduleAt: Math.floor(at / 1000),
        });
        Object.assign(r, { status: 'scheduled', message: '', note: 'ตั้งเวลาไว้บน Facebook แล้ว — Facebook จะโพสต์เองตามเวลา ปิดคอมได้', ...out });
      } catch (e) {
        // Fall back to this app posting it when due
        Object.assign(r, { status: 'pending', message: '', note: `ตั้งเวลาบน Facebook ไม่สำเร็จ (${e.message}) — แอปจะโพสต์เองเมื่อถึงเวลา ต้องเปิดคอมไว้` });
      }
      r.at = now();
      save();
    }));
  } finally {
    running.delete(post.id);
  }
}

// Takes back posts Facebook is still holding (before deleting the post, or to post it right now instead).
// After the time has passed Facebook has already published them, so they are left alone.
export async function cancelOnPlatforms(post) {
  if (Date.parse(post.scheduledAt) <= Date.now() + 60e3) return;
  for (const id of post.targets) {
    const r = post.results[id];
    if (r?.status !== 'scheduled') continue;
    const acc = db.accounts.find(a => a.id === id);
    if (!acc) throw new Error('ไม่พบเพจ Facebook ของโพสต์นี้ในแอปแล้ว — ลบโพสต์ที่ตั้งเวลาไว้ใน Meta Business Suite เอง');
    await fb.remove(r.deleteId || r.id, acc.token);
    post.results[id] = { status: 'pending', at: now() };
    save();
  }
}

function tiktokOptions(post, accId) {
  const t = post.tiktok || {};
  const a = t.accounts?.[accId];
  return {
    mode: t.mode,
    privacy: a?.privacy || t.privacy,
    // Posts created before per-account settings existed only had a comment switch
    allowComment: a?.allowComment ?? !t.disableComment,
    allowDuet: a?.allowDuet ?? true,
    allowStitch: a?.allowStitch ?? true,
    brandOrganic: !!t.brandOrganic,
    brandedContent: !!t.brandedContent,
  };
}

export async function tiktokToken(acc) {
  if (acc.expiresAt && acc.expiresAt - Date.now() > 5 * 60e3) return acc.token;
  const s = db.settings;
  if (!acc.refreshToken) throw new Error('Token TikTok หมดอายุ กรุณาเชื่อมต่อบัญชีใหม่');
  const t = await tt.refresh({ clientKey: s.ttClientKey, clientSecret: s.ttClientSecret, refreshToken: acc.refreshToken });
  Object.assign(acc, {
    token: t.access_token,
    refreshToken: t.refresh_token || acc.refreshToken,
    expiresAt: Date.now() + t.expires_in * 1000,
    refreshExpiresAt: t.refresh_expires_in ? Date.now() + t.refresh_expires_in * 1000 : acc.refreshExpiresAt,
  });
  save();
  return acc.token;
}

// Builds public URLs (plus previews) that LINE's servers fetch; derived files sit next to the original
async function prepareLineMedia(media) {
  if (!media.length) return [];
  const base = await tunnel.ensurePublicBase();
  if (!base) throw new Error('ไม่มี URL สาธารณะสำหรับส่งรูป/วิดีโอให้ LINE — ติดตั้ง cloudflared หรือใส่ Public Media URL ในแท็บตั้งค่า');
  const ff = await hasFfmpeg();
  const url = f => `${base}/m/${encodeURIComponent(f)}`;
  const out = [];
  for (const m of media) {
    const stem = path.parse(m.file).name;
    if (m.kind === 'video') {
      if (m.size > 200 * MB) throw new Error('วิดีโอใหญ่เกิน 200MB (ข้อจำกัดของ LINE)');
      if (!ff) throw new Error('ต้องติดตั้ง ffmpeg เพื่อสร้างภาพตัวอย่างวิดีโอสำหรับ LINE');
      let file = m.file;
      if (m.mime !== 'video/mp4') {
        file = `${stem}__line.mp4`;
        await remuxMp4(mediaPath(m.file), mediaPath(file));
      }
      const prev = `${stem}__prev.jpg`;
      await thumbnail(mediaPath(m.file), mediaPath(prev), { video: true });
      out.push({ kind: 'video', url: url(file), preview: url(prev) });
    } else {
      let file = m.file;
      if (!/^image\/(jpeg|png)$/.test(m.mime) || m.size > 10 * MB) {
        if (!ff) throw new Error(`รูป ${m.name} ต้องเป็น JPG/PNG ไม่เกิน 10MB (หรือติดตั้ง ffmpeg ให้แปลงอัตโนมัติ)`);
        file = `${stem}__line.jpg`;
        await toJpeg(mediaPath(m.file), mediaPath(file));
      }
      let prev = file;
      if (ff) {
        prev = `${stem}__prev.jpg`;
        await thumbnail(mediaPath(file), mediaPath(prev));
      }
      out.push({ kind: 'image', url: url(file), preview: url(prev) });
    }
  }
  return out;
}

async function runTarget(post, id, getLineMedia) {
  const r = post.results[id] = { status: 'running', at: now() };
  save();
  try {
    const acc = db.accounts.find(a => a.id === id);
    if (!acc) throw new Error('ไม่พบบัญชีนี้ (อาจถูกลบไปแล้ว)');
    if (acc.enabled === false) throw new Error('บัญชีนี้ถูกปิดใช้งาน');
    const text = textFor(post, acc.platform);
    const media = withPaths(post.media);
    let out;
    switch (acc.platform) {
      case 'facebook':
        out = await fb.publish({ pageId: acc.externalId, token: acc.token, text, media });
        break;
      case 'tiktok': {
        const video = media.find(m => m.kind === 'video');
        if (!video) throw new Error('TikTok ต้องมีวิดีโอ');
        out = await tt.publish(await tiktokToken(acc), { title: text, video, options: tiktokOptions(post, acc.id) });
        break;
      }
      case 'line':
        out = await line.broadcast(acc.token, line.buildMessages(text, await getLineMedia()));
        break;
      default:
        throw new Error(`ไม่รองรับแพลตฟอร์ม ${acc.platform}`);
    }
    Object.assign(r, { status: 'success', message: '', ...out });
  } catch (e) {
    const offline = /fetch failed|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED/.test(`${e.message} ${e.cause?.code || ''}`);
    Object.assign(r, { status: 'failed', message: offline ? 'เชื่อมต่ออินเทอร์เน็ตไม่ได้ตอนโพสต์ — เช็กเน็ตแล้วกดลองใหม่' : e.message });
  }
  r.at = now();
  save();
}

// Posts every target not already done (also used by "retry", which then only re-runs the failed ones)
export async function runPost(post) {
  if (running.has(post.id)) return;
  running.add(post.id);
  post.status = 'running';
  post.startedAt = now();
  settleScheduled(post);
  save();
  try {
    const ids = post.targets.filter(id => !handled(post.results[id]?.status));
    let lineMedia;
    // Shared by every LINE target of this post so files are prepared once
    const getLineMedia = () => (lineMedia ??= prepareLineMedia(post.media));
    await Promise.all(ids.map(id => runTarget(post, id, getLineMedia)));
  } finally {
    post.status = summarize(post);
    post.finishedAt = now();
    running.delete(post.id);
    save();
  }
}

// Called once at boot: anything mid-flight when the app stopped must not be re-posted blindly
export function recoverOnStartup() {
  const t = Date.now();
  for (const p of db.posts) {
    if (p.status === 'running' || p.status === 'queued') {
      for (const id of p.targets) {
        const r = p.results[id] ||= { status: 'pending' };
        if (r.status === 'running') Object.assign(r, { status: 'failed', message: 'แอปถูกปิดระหว่างโพสต์ — ตรวจสอบที่แพลตฟอร์มก่อนกดลองใหม่' });
        if (r.status === 'pending') Object.assign(r, { status: 'failed', message: 'ยังไม่ได้โพสต์ (แอปถูกปิดก่อน)' });
      }
      p.status = summarize(p);
    }
    if (p.status === 'scheduled') {
      for (const id of p.targets) {
        const r = p.results[id];
        if (r?.status === 'running') Object.assign(r, { status: 'failed', note: '', message: 'แอปถูกปิดระหว่างอัปโหลดไปตั้งเวลาบน Facebook — เช็กใน Meta Business Suite ว่ามีโพสต์ค้างไหม' });
      }
    }
  }
  markMissed();
  save();
}

function markMissed() {
  const t = Date.now();
  let changed = false;
  for (const p of db.posts) {
    if (p.status === 'scheduled' && t - Date.parse(p.scheduledAt) > LATE_LIMIT) {
      settleScheduled(p);
      // Only targets this app still had to post count as missed; Facebook-scheduled ones went out on their own
      p.status = p.targets.every(id => handled(p.results[id]?.status)) ? summarize(p) : 'missed';
      changed = true;
    }
  }
  return changed;
}

// Also runs after the PC wakes up, so a post due hours ago becomes "missed" instead of going out at midnight
export function duePosts() {
  if (markMissed()) save();
  const t = Date.now();
  return db.posts.filter(p => p.status === 'scheduled' && Date.parse(p.scheduledAt) <= t);
}

// Only posts this app still has to send itself count; Facebook-scheduled targets don't need the PC
export function hasPostWithin(ms) {
  const t = Date.now();
  return db.posts.some(p => p.status === 'scheduled' && Date.parse(p.scheduledAt) - t <= ms
    && p.targets.some(id => !handled(p.results[id]?.status)));
}

// After waking from sleep Wi-Fi takes a few seconds to come back; posting before that fails with "fetch failed"
export async function online() {
  for (const url of ['https://graph.facebook.com/', 'https://open.tiktokapis.com/', 'https://api.line.me/']) {
    try {
      await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      return true;
    } catch {}
  }
  return false;
}

export function deleteMediaFiles(post) {
  const stillUsed = new Set(db.posts.filter(p => p.id !== post.id).flatMap(p => p.media.map(m => m.file)));
  for (const m of post.media) {
    if (stillUsed.has(m.file)) continue;
    const stem = path.parse(m.file).name;
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      if (f === m.file || f.startsWith(`${stem}__`)) fs.rmSync(mediaPath(f), { force: true });
    }
  }
}
