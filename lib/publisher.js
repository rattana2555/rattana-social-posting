import fs from 'node:fs';
import path from 'node:path';
import { db, save, UPLOAD_DIR } from './db.js';
import * as fb from './facebook.js';
import * as tt from './tiktok.js';
import * as line from './line.js';
import * as tunnel from './tunnel.js';
import { hasFfmpeg, thumbnail, toJpeg, remuxMp4 } from './media.js';

const MB = 1024 * 1024;
const running = new Set();
const now = () => new Date().toISOString();

export const isRunning = id => running.has(id);
export const mediaPath = file => path.join(UPLOAD_DIR, file);
const textFor = (post, platform) => String(post.captions?.[platform] || '').trim() || post.caption || '';

export function summarize(post) {
  const st = post.targets.map(id => post.results[id]?.status);
  if (st.every(s => s === 'success')) return 'done';
  if (st.some(s => s === 'success')) return 'partial';
  return 'failed';
}

async function tiktokToken(acc) {
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
    const media = post.media.map(m => ({ ...m, path: mediaPath(m.file) }));
    let out;
    switch (acc.platform) {
      case 'facebook':
        out = await fb.publish({ pageId: acc.externalId, token: acc.token, text, media });
        break;
      case 'tiktok': {
        const video = media.find(m => m.kind === 'video');
        if (!video) throw new Error('TikTok ต้องมีวิดีโอ');
        out = await tt.publish(await tiktokToken(acc), { title: text, video, options: post.tiktok });
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
    Object.assign(r, { status: 'failed', message: e.message });
  }
  r.at = now();
  save();
}

export async function runPost(post, { onlyFailed = false } = {}) {
  if (running.has(post.id)) return;
  running.add(post.id);
  post.status = 'running';
  post.startedAt = now();
  save();
  try {
    const ids = post.targets.filter(id => !onlyFailed || post.results[id]?.status !== 'success');
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
    if (p.status === 'scheduled' && t - Date.parse(p.scheduledAt) > 60 * 60e3) p.status = 'missed';
  }
  save();
}

export function duePosts() {
  const t = Date.now();
  return db.posts.filter(p => p.status === 'scheduled' && Date.parse(p.scheduledAt) <= t);
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
