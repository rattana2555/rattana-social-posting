import fs from 'node:fs';
import crypto from 'node:crypto';

const API = 'https://open.tiktokapis.com/v2';
const SCOPES = ['user.info.basic', 'video.publish', 'video.upload'];
const MB = 1024 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// TikTok Login Kit for Desktop (which allows http://localhost redirects) uses PKCE
// with a hex-encoded SHA-256 challenge rather than the usual base64url one
export function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('hex');
  return { verifier, challenge };
}

export function authUrl({ clientKey, redirectUri, state, challenge }) {
  return 'https://www.tiktok.com/v2/auth/authorize/?' + new URLSearchParams({
    client_key: clientKey,
    scope: SCOPES.join(','),
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    disable_auto_auth: '1', // always show the consent screen so another account can be picked
  });
}

async function tokenRequest(params) {
  const res = await fetch(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams(params),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`${j.error || `HTTP ${res.status}`}${j.error_description ? `: ${j.error_description}` : ''}`);
  return j;
}

export const exchangeCode = ({ clientKey, clientSecret, code, redirectUri, verifier }) => tokenRequest({
  client_key: clientKey, client_secret: clientSecret, code, grant_type: 'authorization_code',
  redirect_uri: redirectUri, code_verifier: verifier,
});

export const refresh = ({ clientKey, clientSecret, refreshToken }) => tokenRequest({
  client_key: clientKey, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken,
});

async function api(token, path, body) {
  const res = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json; charset=UTF-8' }) },
    body: body && JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (j.error && j.error.code && j.error.code !== 'ok') throw new Error(`${j.error.code}: ${j.error.message || ''}`.trim());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return j.data || {};
}

export async function userInfo(token) {
  const data = await api(token, '/user/info/?fields=open_id,avatar_url,display_name');
  return data.user || {};
}

// Must be fetched fresh before showing the post form (TikTok Direct Post UX guidelines)
export function creatorInfo(token) {
  return api(token, '/post/publish/creator_info/query/', {});
}

export async function publish(token, { title, video, options = {} }) {
  const size = video.size;
  // Files up to 64MB go in one chunk; larger files use 10MB chunks with the remainder folded into the last one
  const chunkSize = size <= 64 * MB ? size : 10 * MB;
  const chunks = Math.max(1, Math.floor(size / chunkSize));
  const source_info = { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: chunks };

  let init;
  if (options.mode === 'draft') {
    init = await api(token, '/post/publish/inbox/video/init/', { source_info });
  } else {
    const creator = await creatorInfo(token);
    const allowed = creator.privacy_level_options || [];
    const privacy = options.privacy;
    if (!privacy) throw new Error('ยังไม่ได้เลือก "ใครเห็นได้" ของ TikTok');
    if (allowed.length && !allowed.includes(privacy)) {
      throw new Error(`บัญชีนี้เลือกระดับการมองเห็น ${privacy} ไม่ได้ (ใช้ได้: ${allowed.join(', ')})`);
    }
    const maxSec = creator.max_video_post_duration_sec;
    if (video.duration && maxSec && video.duration > maxSec) {
      throw new Error(`วิดีโอยาว ${Math.round(video.duration)} วินาที เกินที่บัญชีนี้โพสต์ได้ (${maxSec} วินาที)`);
    }
    init = await api(token, '/post/publish/video/init/', {
      post_info: {
        title: String(title || '').slice(0, 2200),
        privacy_level: privacy,
        // Interactions the creator turned off in TikTok stay off whatever was chosen here
        disable_comment: !options.allowComment || !!creator.comment_disabled,
        disable_duet: !options.allowDuet || !!creator.duet_disabled,
        disable_stitch: !options.allowStitch || !!creator.stitch_disabled,
        brand_content_toggle: !!options.brandedContent,
        brand_organic_toggle: !!options.brandOrganic,
      },
      source_info,
    });
  }

  const fh = await fs.promises.open(video.path, 'r');
  try {
    for (let i = 0; i < chunks; i++) {
      const start = i * chunkSize;
      const end = i === chunks - 1 ? size - 1 : start + chunkSize - 1;
      const buf = Buffer.alloc(end - start + 1);
      await fh.read(buf, 0, buf.length, start);
      const res = await fetch(init.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': video.mime || 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}` },
        body: buf,
      });
      if (!res.ok) throw new Error(`อัปโหลดวิดีโอไป TikTok ไม่สำเร็จ (chunk ${i + 1}/${chunks}, HTTP ${res.status})`);
    }
  } finally {
    await fh.close();
  }

  // Poll for up to ~2 minutes; long videos may still be processing after that
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const st = await api(token, '/post/publish/status/fetch/', { publish_id: init.publish_id });
    if (st.status === 'FAILED') throw new Error(`TikTok ประมวลผลไม่สำเร็จ: ${st.fail_reason || 'unknown'}`);
    if (st.status === 'SEND_TO_USER_INBOX') return { id: init.publish_id, note: 'ส่งเข้ากล่องแจ้งเตือนในแอป TikTok แล้ว — เปิดแอปเพื่อกดโพสต์' };
    if (st.status === 'PUBLISH_COMPLETE') {
      const postId = st.publicaly_available_post_id?.[0]; // (sic) TikTok's field name
      return { id: postId ? String(postId) : init.publish_id, note: 'โพสต์สำเร็จ' };
    }
  }
  return { id: init.publish_id, note: 'อัปโหลดแล้ว TikTok กำลังประมวลผล' };
}
