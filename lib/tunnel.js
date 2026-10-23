import { spawn } from 'node:child_process';
import { db } from './db.js';
import { MEDIA_PORT } from './config.js';

// LINE only accepts media from public HTTPS URLs. When no fixed URL is configured we open a
// free Cloudflare quick tunnel to the media-only server (never to the main app).
let proc = null;
let url = null;
let available = null; // null = not tried yet, false = cloudflared not installed
let starting = null;
let verified = false;
let lastError = '';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fixedBase = () => String(db.settings.publicBaseUrl || '').trim().replace(/\/+$/, '');

export const status = () => ({ available, url, running: !!proc, error: lastError });
export const getPublicBase = () => fixedBase() || url;
export const canServeMedia = () => !!fixedBase() || available !== false;

export function startTunnel() {
  if (url) return Promise.resolve(url);
  if (starting) return starting;
  starting = new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    lastError = '';
    try {
      proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${MEDIA_PORT}`], { windowsHide: true });
    } catch (e) {
      available = false; lastError = e.message; proc = null; starting = null;
      return finish(null);
    }
    const onData = buf => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !url) { url = m[0]; available = true; verified = false; finish(url); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', e => {
      proc = null; starting = null;
      if (e.code === 'ENOENT') available = false;
      lastError = e.code === 'ENOENT' ? 'ไม่พบ cloudflared ในเครื่อง' : e.message;
      finish(null);
    });
    proc.on('exit', () => {
      proc = null; url = null; starting = null; verified = false;
      finish(null);
    });
    setTimeout(() => { if (!url) { lastError = 'cloudflared ไม่ตอบกลับภายใน 30 วินาที'; finish(null); } }, 30000);
  });
  return starting;
}

export function stopTunnel() {
  proc?.kill();
}

// Returns a public base URL that LINE servers can reach, waiting for a fresh tunnel's DNS to come up
export async function ensurePublicBase() {
  const fixed = fixedBase();
  if (fixed) return fixed;
  const u = url || await startTunnel();
  if (!u) return null;
  for (let i = 0; !verified && i < 15; i++) {
    try {
      const r = await fetch(`${u}/health`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) verified = true;
    } catch { /* DNS for a new quick tunnel can take a few seconds */ }
    if (!verified) await sleep(2000);
  }
  return u;
}
