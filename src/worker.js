// Tbilisi Stays — API, photo storage and Airbnb calendar sync.
// Static files in /public are served by the assets layer; everything else lands here.

const APTS = ['mel', 'nik', 'bar'];
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);
      if (url.pathname.startsWith('/photos/')) return await servePhoto(env, url.pathname.slice(8));
      const ical = url.pathname.match(/^\/ical\/(\w+)\.ics$/);
      if (ical && APTS.includes(ical[1])) return await serveIcal(env, ical[1]);
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: err.message || 'Server error' }, err.status || 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAirbnb(env));
  },
};

// ===== STORAGE =====
async function getJson(env, key, fallback) {
  return (await env.DATA.get(key, 'json')) ?? fallback;
}
function putJson(env, key, value) {
  return env.DATA.put(key, JSON.stringify(value));
}
const getSettings = env => getJson(env, 'settings', { prices: {}, descs: {}, about: {}, rules: null, icalUrls: {} });

// ===== API =====
async function handleApi(request, env, url) {
  const path = url.pathname.slice(5);
  const method = request.method;

  if (path === 'public' && method === 'GET') return json(await publicState(env), 200, { 'Cache-Control': 'no-store' });

  if (path === 'subscribe' && method === 'POST') {
    const { email } = await body(request);
    if (typeof email !== 'string' || email.length > 254 || !/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(email)) throw httpError(400, 'Invalid email');
    const subs = await getJson(env, 'subscribers', []);
    if (!subs.includes(email)) {
      subs.push(email);
      await putJson(env, 'subscribers', subs);
    }
    return json({ ok: true });
  }

  if (path === 'login' && method === 'POST') {
    const { password } = await body(request);
    if (!(await passwordOk(env, password))) {
      await new Promise(r => setTimeout(r, 800));
      throw httpError(401, 'Incorrect password');
    }
    return json({ ok: true });
  }

  if (!path.startsWith('admin')) throw httpError(404, 'Not found');
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!(await passwordOk(env, token))) throw httpError(401, 'Unauthorized');
  return handleAdmin(request, env, path.slice(5), method);
}

async function handleAdmin(request, env, path, method) {
  if (path === '' && method === 'GET') {
    const [settings, bookings, revenue, subscribers] = await Promise.all([
      getSettings(env), getJson(env, 'bookings', []), getJson(env, 'revenue', {}), getJson(env, 'subscribers', []),
    ]);
    const blocked = {}, airbnb = {}, photos = {};
    await Promise.all(APTS.map(async id => {
      blocked[id] = await getJson(env, 'blocked:' + id, []);
      airbnb[id] = await getJson(env, 'airbnb:' + id, { dates: [], syncedAt: null, error: null });
      photos[id] = (await getJson(env, 'photos:' + id, [])).map(photoUrl);
    }));
    return json({ settings, bookings, revenue, subscribers, blocked, airbnb, photos });
  }

  // Partial update of prices / descs / about / rules / icalUrls
  if (path === '/settings' && method === 'PUT') {
    const patch = await body(request);
    const settings = await getSettings(env);
    for (const key of ['prices', 'descs', 'about', 'icalUrls']) {
      if (patch[key]) settings[key] = { ...settings[key], ...patch[key] };
    }
    if ('rules' in patch) settings.rules = patch.rules;
    await putJson(env, 'settings', settings);
    return json({ ok: true, settings });
  }

  if (path === '/block' && method === 'POST') {
    const { apt, dates, action } = await body(request);
    checkApt(apt);
    if (!Array.isArray(dates) || !dates.every(isDate)) throw httpError(400, 'Invalid dates');
    let list = await getJson(env, 'blocked:' + apt, []);
    list = action === 'unblock'
      ? list.filter(d => !dates.includes(d))
      : [...new Set([...list, ...dates])].sort();
    await putJson(env, 'blocked:' + apt, list);
    return json({ ok: true, blocked: list });
  }

  if (path === '/bookings' && method === 'PUT') {
    await putJson(env, 'bookings', await body(request));
    return json({ ok: true });
  }
  if (path === '/revenue' && method === 'PUT') {
    await putJson(env, 'revenue', await body(request));
    return json({ ok: true });
  }
  if (path === '/subscribers' && method === 'DELETE') {
    await putJson(env, 'subscribers', []);
    return json({ ok: true });
  }

  if (path === '/sync' && method === 'POST') {
    return json({ ok: true, airbnb: await syncAirbnb(env) });
  }

  const photoMatch = path.match(/^\/photos\/(\w+)(?:\/([\w-]+))?$/);
  if (photoMatch) {
    const [, apt, pid] = photoMatch;
    checkApt(apt);
    let ids = await getJson(env, 'photos:' + apt, []);
    if (method === 'POST' && !pid) {
      const type = request.headers.get('Content-Type') || '';
      if (!type.startsWith('image/')) throw httpError(400, 'Not an image');
      const data = await request.arrayBuffer();
      if (data.byteLength > MAX_PHOTO_BYTES) throw httpError(413, 'Photo too large');
      const id = crypto.randomUUID();
      await env.DATA.put('photo:' + id, data, { metadata: { type } });
      ids.push(id);
    } else if (method === 'DELETE' && pid) {
      ids = ids.filter(x => x !== pid);
      await env.DATA.delete('photo:' + pid);
    } else if (method === 'DELETE') {
      await Promise.all(ids.map(x => env.DATA.delete('photo:' + x)));
      ids = [];
    } else if (method === 'PUT' && !pid) {
      // Reorder: body is the full list of existing ids in the new order
      const order = await body(request);
      if (Array.isArray(order) && order.length === ids.length && order.every(x => ids.includes(x))) ids = order;
    } else {
      throw httpError(405, 'Method not allowed');
    }
    await putJson(env, 'photos:' + apt, ids);
    return json({ ok: true, photos: ids.map(photoUrl) });
  }

  throw httpError(404, 'Not found');
}

async function publicState(env) {
  const settings = await getSettings(env);
  const apts = {};
  await Promise.all(APTS.map(async id => {
    const [manual, airbnb, photos] = await Promise.all([
      getJson(env, 'blocked:' + id, []),
      getJson(env, 'airbnb:' + id, { dates: [] }),
      getJson(env, 'photos:' + id, []),
    ]);
    apts[id] = {
      price: settings.prices[id] || null,
      desc: settings.descs[id] || null,
      photos: photos.map(photoUrl),
      blocked: [...new Set([...manual, ...airbnb.dates])].sort(),
    };
  }));
  return { apts, about: settings.about, rules: settings.rules };
}

// ===== PHOTOS =====
const photoUrl = id => ({ id, url: '/photos/' + id });

async function servePhoto(env, id) {
  if (!/^[\w-]+$/.test(id)) throw httpError(404, 'Not found');
  const { value, metadata } = await env.DATA.getWithMetadata('photo:' + id, 'arrayBuffer');
  if (!value) throw httpError(404, 'Not found');
  return new Response(value, {
    headers: { 'Content-Type': metadata?.type || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
}

// ===== AIRBNB SYNC =====
// Import: Airbnb's export feed -> airbnb:<id> (cron + "Sync now").
// Export: /ical/<id>.ics lists only dates blocked on this site, so Airbnb's own
// reservations never echo back to Airbnb.
async function syncAirbnb(env) {
  const { icalUrls } = await getSettings(env);
  const result = {};
  await Promise.all(APTS.map(async id => {
    const key = 'airbnb:' + id;
    const prev = await getJson(env, key, { dates: [], syncedAt: null, error: null });
    if (!icalUrls[id]) {
      result[id] = prev;
      return;
    }
    let next;
    try {
      const res = await fetch(icalUrls[id], { headers: { 'User-Agent': 'TbilisiStays/1.0' } });
      if (!res.ok) throw new Error('Airbnb returned ' + res.status);
      const text = await res.text();
      if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Not a calendar feed');
      next = { dates: parseIcalDates(text), syncedAt: new Date().toISOString(), error: null };
    } catch (err) {
      // Keep the last good dates so a failed fetch never unblocks anything
      next = { ...prev, error: err.message, failedAt: new Date().toISOString() };
    }
    await putJson(env, key, next);
    result[id] = next;
  }));
  return result;
}

function parseIcalDates(text) {
  const dates = new Set();
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  for (const ev of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const start = (ev.match(/DTSTART[^:]*:(\d{8})/) || [])[1];
    const end = (ev.match(/DTEND[^:]*:(\d{8})/) || [])[1];
    if (!start) continue;
    const d = toDate(start);
    const stop = end ? toDate(end) : new Date(d.getTime() + 86400000);
    for (; d < stop; d.setUTCDate(d.getUTCDate() + 1)) dates.add(d.toISOString().slice(0, 10));
  }
  const today = new Date().toISOString().slice(0, 10);
  return [...dates].filter(x => x >= today).sort();
}
const toDate = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));

async function serveIcal(env, id) {
  const dates = await getJson(env, 'blocked:' + id, []);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tbilisi Stays//Direct bookings//EN', 'CALSCALE:GREGORIAN'];
  for (const [start, end] of toRanges(dates)) {
    lines.push('BEGIN:VEVENT', `UID:${id}-${start}@tbilisi-stays`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${end.replace(/-/g, '')}`,
      'SUMMARY:Blocked (Tbilisi Stays)', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// Consecutive dates -> [start, endExclusive] ranges
function toRanges(dates) {
  const ranges = [];
  for (const d of [...dates].sort()) {
    const next = new Date(d + 'T00:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    const nextStr = next.toISOString().slice(0, 10);
    const last = ranges[ranges.length - 1];
    if (last && last[1] === d) last[1] = nextStr;
    else ranges.push([d, nextStr]);
  }
  return ranges;
}

// ===== HELPERS =====
async function passwordOk(env, given) {
  if (!env.ADMIN_PASSWORD || typeof given !== 'string' || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(env.ADMIN_PASSWORD)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
function checkApt(apt) {
  if (!APTS.includes(apt)) throw httpError(400, 'Unknown apartment');
}
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
async function body(request) {
  try { return await request.json(); } catch { throw httpError(400, 'Invalid JSON'); }
}
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}
