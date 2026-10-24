import fs from 'node:fs';

export const GRAPH_VERSION = 'v23.0';
const G = `https://graph.facebook.com/${GRAPH_VERSION}`;
const GV = `https://graph-video.facebook.com/${GRAPH_VERSION}`;
const SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'business_management'];

const qs = o => new URLSearchParams(o).toString();

async function call(url, init) {
  const res = await fetch(url, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    const e = j.error || {};
    throw new Error(e.message ? `${e.message}${e.code ? ` (code ${e.code})` : ''}` : `HTTP ${res.status}`);
  }
  return j;
}

export function authUrl({ appId, redirectUri, state }) {
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?` +
    qs({ client_id: appId, redirect_uri: redirectUri, state, scope: SCOPES.join(','), response_type: 'code' });
}

export async function exchangeCode({ appId, appSecret, redirectUri, code }) {
  const j = await call(`${G}/oauth/access_token?` + qs({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code }));
  return j.access_token;
}

// Page tokens derived from a long-lived user token do not expire
export async function longLived({ appId, appSecret, token }) {
  const j = await call(`${G}/oauth/access_token?` +
    qs({ grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: token }));
  return j.access_token;
}

export async function listPages(userToken) {
  const pages = [];
  let url = `${G}/me/accounts?` + qs({ fields: 'id,name,access_token,category,picture{url}', limit: '100', access_token: userToken });
  while (url) {
    const j = await call(url);
    pages.push(...(j.data || []));
    url = j.paging?.next || null;
  }
  return pages;
}

async function uploadPhoto({ pageId, token, image, message, extra = {} }) {
  const fd = new FormData();
  fd.append('access_token', token);
  if (message) fd.append('message', message);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append('source', await fs.openAsBlob(image.path, { type: image.mime }), image.name || 'photo.jpg');
  return call(`${G}/${pageId}/photos`, { method: 'POST', body: fd });
}

// Where Page admins see posts that Facebook is holding for a scheduled time
const SCHEDULED_LIST_URL = 'https://business.facebook.com/latest/posts/scheduled_posts';

// With scheduleAt (unix seconds) Facebook stores the post now and publishes it by itself at that time,
// so it goes out even if this PC is off. Facebook accepts 10 minutes to 30 days ahead.
export async function publish({ pageId, token, text, media, scheduleAt }) {
  const video = media.find(m => m.kind === 'video');
  const images = media.filter(m => m.kind === 'image');
  const sched = scheduleAt ? { published: 'false', scheduled_publish_time: String(scheduleAt) } : {};
  const result = (id, liveUrl) => ({ id, deleteId: id, url: scheduleAt ? SCHEDULED_LIST_URL : liveUrl });

  if (video) {
    const fd = new FormData();
    fd.append('access_token', token);
    if (text) fd.append('description', text);
    for (const [k, v] of Object.entries(sched)) fd.append(k, v);
    fd.append('source', await fs.openAsBlob(video.path, { type: video.mime }), video.name || 'video.mp4');
    const j = await call(`${GV}/${pageId}/videos`, { method: 'POST', body: fd });
    return result(j.id, `https://www.facebook.com/${pageId}/videos/${j.id}`);
  }

  if (images.length === 1) {
    const j = await uploadPhoto({ pageId, token, image: images[0], message: text, extra: sched });
    const id = j.post_id || j.id;
    return result(id, `https://www.facebook.com/${id}`);
  }

  // Text-only, or an album: upload photos unpublished, then attach them to one feed post
  // (photos for a scheduled album must be uploaded as temporary)
  const body = new URLSearchParams({ access_token: token, ...sched });
  if (text) body.set('message', text);
  const photoExtra = scheduleAt ? { published: 'false', temporary: 'true' } : { published: 'false' };
  const uploaded = await Promise.all(images.map(image => uploadPhoto({ pageId, token, image, extra: photoExtra })));
  uploaded.forEach((p, i) => body.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: p.id })));
  const j = await call(`${G}/${pageId}/feed`, { method: 'POST', body });
  return result(j.id, `https://www.facebook.com/${j.id}`);
}

// Cancels a post Facebook is still holding for its scheduled time
export async function remove(id, token) {
  return call(`${G}/${id}?` + qs({ access_token: token }), { method: 'DELETE' });
}
