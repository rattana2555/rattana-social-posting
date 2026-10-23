const API = 'https://api.line.me/v2/bot';

async function call(token, path, body) {
  const res = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = (j.details || []).map(d => `${d.property ? d.property + ': ' : ''}${d.message}`).join('; ');
    throw new Error(`${j.message || `HTTP ${res.status}`}${details ? ` — ${details}` : ''}`);
  }
  return { data: j, requestId: res.headers.get('x-line-request-id') };
}

export async function botInfo(token) {
  return (await call(token, '/info')).data;
}

export async function quota(token) {
  const [q, c] = await Promise.all([call(token, '/message/quota'), call(token, '/message/quota/consumption')]);
  return { type: q.data.type, limit: q.data.value ?? null, used: c.data.totalUsage ?? 0 };
}

// One broadcast request holds at most 5 message objects
export function buildMessages(text, media) {
  const msgs = [];
  if (text) msgs.push({ type: 'text', text: text.slice(0, 5000) });
  const video = media.find(m => m.kind === 'video');
  if (video) msgs.push({ type: 'video', originalContentUrl: video.url, previewImageUrl: video.preview });
  const images = media.filter(m => m.kind === 'image');
  if (images.length <= 5 - msgs.length) {
    for (const i of images) msgs.push({ type: 'image', originalContentUrl: i.url, previewImageUrl: i.preview });
  } else {
    // Too many images for separate messages: send them as a swipeable Flex carousel instead
    msgs.push({
      type: 'flex',
      altText: (text || 'รูปภาพใหม่').slice(0, 400),
      contents: {
        type: 'carousel',
        contents: images.slice(0, 12).map(i => ({
          type: 'bubble',
          hero: { type: 'image', url: i.url, size: 'full', aspectMode: 'cover', aspectRatio: '1:1', action: { type: 'uri', uri: i.url } },
        })),
      },
    });
  }
  return msgs;
}

export async function broadcast(token, messages) {
  if (!messages.length) throw new Error('ไม่มีข้อความให้ส่ง');
  const { requestId } = await call(token, '/message/broadcast', { messages });
  return { id: requestId || '', note: 'ส่ง Broadcast แล้ว' };
}
