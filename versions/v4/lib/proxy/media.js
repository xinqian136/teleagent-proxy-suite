'use strict';
/**
 * proxy/media.js — 媒体块预处理
 *
 * 网关只吃 **base64 data URL** 的图片，不认远程 URL（实测 1210 报错）。
 * 但客户端（IDE Agent）通常把上传的图片存到对象存储，传过来的是签名 URL。
 *
 * 所以这里做一件事：把远程 URL 的图片抓下来，转成 base64 再交给网关。
 *
 * 只在**确实需要**时才动手：
 *   - content 是数组且含 image_url 且 url 是 http/https → 下载转 base64
 *   - content 是字符串或纯文本 → 原样，不碰
 */

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;   // 12MB 上限，超过就放弃（别把网关撑爆）
const TIMEOUT_MS = 30000;

function isRemote(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u);
}

function isDataUrl(u) {
  return typeof u === 'string' && u.startsWith('data:');
}

/** 下载并转 base64 data URL */
async function toDataUrl(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: ac.signal,
      headers: { Accept: 'image/*,*/*' },
      redirect: 'follow',
    });
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };

    const ct = resp.headers.get('content-type') || '';
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) return { ok: false, reason: '空响应' };
    if (buf.length > MAX_IMAGE_BYTES) {
      return { ok: false, reason: `太大 ${Math.round(buf.length / 1048576)}MB` };
    }
    // content-type 不像图片就按 png 猜
    const mime = /^image\//i.test(ct) ? ct.split(';')[0].trim() : 'image/png';
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length };
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 处理一个 content 数组：把远程图片换成 base64
 * @param {Array} content
 * @param {function} log
 * @returns {Promise<{changed:boolean, content:Array, notes:string[]}>}
 */
async function processContent(content, log) {
  if (!Array.isArray(content)) return { changed: false, content, notes: [] };

  const notes = [];
  let changed = false;
  const out = [];

  for (const b of content) {
    if (!b || typeof b !== 'object') { out.push(b); continue; }

    // OpenAI 风格：{ type:'image_url', image_url:{url} }
    if (b.type === 'image_url') {
      const u = b.image_url && typeof b.image_url === 'object' ? b.image_url.url : b.image_url;
      if (isRemote(u)) {
        const r = await toDataUrl(u);
        if (r.ok) {
          out.push({ type: 'image_url', image_url: { url: r.dataUrl } });
          changed = true;
          notes.push(`远程图→base64 ${Math.round(r.bytes / 1024)}KB`);
          continue;
        }
        notes.push(`远程图下载失败(${r.reason})，保留原URL`);
      }
      out.push(b);
      continue;
    }

    // Responses 风格：{ type:'input_image', image_url:'...' }
    if (b.type === 'input_image') {
      const u = typeof b.image_url === 'string' ? b.image_url : (b.image_url && b.image_url.url);
      if (isRemote(u)) {
        const r = await toDataUrl(u);
        if (r.ok) {
          out.push({ type: 'image_url', image_url: { url: r.dataUrl } });
          changed = true;
          notes.push(`远程图→base64 ${Math.round(r.bytes / 1024)}KB`);
          continue;
        }
        notes.push(`远程图下载失败(${r.reason})，保留原URL`);
      }
      out.push(b);
      continue;
    }

    // Anthropic 风格：{ type:'image', source:{type:'url', url} }
    if (b.type === 'image' && b.source && b.source.type === 'url' && isRemote(b.source.url)) {
      const r = await toDataUrl(b.source.url);
      if (r.ok) {
        out.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: r.dataUrl.split(',')[1] },
        });
        changed = true;
        notes.push(`远程图→base64 ${Math.round(r.bytes / 1024)}KB`);
        continue;
      }
      notes.push(`远程图下载失败(${r.reason})，保留原URL`);
    }

    out.push(b);
  }

  return { changed, content: changed ? out : content, notes };
}

/**
 * 处理整个请求体：把所有 messages / input 里的远程图片转 base64
 * @param {object} body  OpenAI / Anthropic / Responses 请求体
 * @returns {Promise<{changed:boolean, body:object, notes:string[]}>}
 */
async function processBody(body, log) {
  if (!body || typeof body !== 'object') return { changed: false, body, notes: [] };
  const notes = [];

  // OpenAI / Anthropic：messages[]
  if (Array.isArray(body.messages)) {
    const newMsgs = [];
    let changed = false;
    for (const m of body.messages) {
      if (m && Array.isArray(m.content)) {
        const r = await processContent(m.content, log);
        // ★ notes 两种情况都要传（失败也要记，否则无从排查）
        for (const n of r.notes) notes.push(n);
        if (r.changed) {
          changed = true;
          newMsgs.push({ ...m, content: r.content });
          continue;
        }
      }
      newMsgs.push(m);
    }
    if (changed) {
      body = { ...body, messages: newMsgs };
    }
  }

  // Responses：input[]
  if (Array.isArray(body.input)) {
    const newInput = [];
    let changed = false;
    for (const it of body.input) {
      if (it && Array.isArray(it.content)) {
        const r = await processContent(it.content, log);
        for (const n of r.notes) notes.push(n);
        if (r.changed) {
          changed = true;
          newInput.push({ ...it, content: r.content });
          continue;
        }
      }
      newInput.push(it);
    }
    if (changed) {
      body = { ...body, input: newInput };
    }
  }

  if (notes.length && log) {
    for (const n of notes) log(`[媒体] ${n}`);
  }
  return { changed: notes.some((n) => n.includes('→base64')), body, notes };
}

module.exports = { processBody, processContent, toDataUrl, isRemote, isDataUrl, MAX_IMAGE_BYTES };
