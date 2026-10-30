// TH3 BUNNY M. — payment link backend (Cloudflare Worker + KV)
// Secret (Dashboard > Worker > Settings > Variables and Secrets): FAM_API_KEY
const FAM = 'https://famgateway.in';
const API_KEY = 'fam_664f30ca534c34acdba8d070bcf74abf17d703ca'; // GitHub repo PRIVATE rakhna!
const keyOf = env => env.FAM_API_KEY || API_KEY;
const te = new TextEncoder();
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const rid = () => { const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', a = new Uint32Array(8); crypto.getRandomValues(a); return [...a].map(n => c[n % c.length]).join(''); };
const safeEq = (x, y) => { const a = te.encode(x), b = te.encode(y); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0; };
async function hmacHex(key, data) {
  const k = await crypto.subtle.importKey('raw', te.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, data))].map(b => b.toString(16).padStart(2, '0')).join('');
}
const getL = async (env, id) => { const v = await env.LINKS.get('link:' + id); return v ? JSON.parse(v) : null; };
const putL = (env, l) => env.LINKS.put('link:' + l.id, JSON.stringify(l));

async function createOrder(env, l, origin) {
  const r = await fetch(FAM + '/api/create-order', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Api-Key': keyOf(env) },
    body: JSON.stringify({ amount: Number(l.amount), customer_name: l.merchant, webhook_url: origin + '/api/webhook' })
  });
  const j = await r.json().catch(() => ({}));
  if (j.status !== 'success' || !j.data) throw new Error(j.message || 'order failed');
  const d = j.data;
  return { id: d.order_id, qr: d.qr_url, intent: d.upi_intent, pay: d.payable_amount || d.amount, at: Date.now() };
}
async function markPaid(env, l, j) {
  l.paid = true; l.utr = j.utr || ''; l.sender = j.sender_name || ''; l.paidAt = Date.now();
  l.txn = j.transaction_id || ''; l.payable = j.payable_amount || j.amount || l.amount;
  l.payTime = j.payment_time || j.payment_time_ist || ''; l.orderId = j.order_id || (l.order && l.order.id) || '';
  await putL(env, l);
}

async function payInfo(id, env, origin) {
  const l = await getL(env, id);
  if (!l) return json({ error: 'not_found' }, 404);
  const base = { id: l.id, amount: l.amount, merchant: l.merchant, expires: l.expires };
  if (l.paid) return json({ ...base, state: 'paid', utr: l.utr });
  if (Date.now() >= l.expires) return json({ ...base, state: 'expired' });
  if (!l.order || Date.now() - l.order.at > 270000) {   // gateway sessions last ~5 min
    l.order = await createOrder(env, l, origin);
    await putL(env, l);
    await env.LINKS.put('order:' + l.order.id, l.id, { expirationTtl: 172800 });
  }
  return json({ ...base, state: 'pending', order: l.order });
}
const paidRes = l => json({ state: 'paid', amount: l.amount, merchant: l.merchant, utr: l.utr });
async function status(id, env) {
  const l = await getL(env, id);
  if (!l) return json({ state: 'gone' });
  if (l.paid) return paidRes(l);
  if (Date.now() >= l.expires) return json({ state: 'expired' });
  if (!l.order) return json({ state: 'renew' });
  const r = await fetch(FAM + '/api/checkout-status.php?order_id=' + encodeURIComponent(l.order.id));
  const j = await r.json().catch(() => ({}));
  if (j.status === 'success') { await markPaid(env, l, j); return paidRes(l); }
  if (j.status === 'expired') { l.order = null; await putL(env, l); return json({ state: 'renew' }); }
  return json({ state: 'pending' });
}
async function webhook(req, env) {
  const raw = await req.arrayBuffer();
  const sig = (req.headers.get('x-famgateway-signature') || '').toLowerCase();
  if (!safeEq(await hmacHex(keyOf(env), raw), sig)) return json({ error: 'bad signature' }, 401);
  const e = JSON.parse(new TextDecoder().decode(raw));
  if (e.event === 'payment.success' || e.status === 'success') {
    const id = await env.LINKS.get('order:' + e.order_id);
    const l = id && await getL(env, id);
    if (l && !l.paid) await markPaid(env, l, e);
  }
  return json({ status: 'ok' });
}
async function admin(req, env, p) {
  const m = p.match(/^\/api\/admin\/links(?:\/([A-Za-z0-9]{8}))?$/);
  if (!m) return json({ error: 'not_found' }, 404);
  const id = m[1];
  if (!id && req.method === 'GET') {
    const ks = await env.LINKS.list({ prefix: 'link:' });
    const ls = (await Promise.all(ks.keys.map(k => env.LINKS.get(k.name)))).filter(Boolean).map(v => JSON.parse(v));
    ls.sort((a, b) => b.created - a.created);
    return json(ls.map(({ order, ...r }) => r));
  }
  if (!id && req.method === 'POST') {
    const b = await req.json();
    const amount = parseFloat(b.amount), merchant = String(b.merchant || '').trim().slice(0, 40), expires = Number(b.expires);
    if (!(amount >= 1) || !merchant || !(expires > Date.now())) return json({ error: 'Invalid input' }, 400);
    const l = { id: rid(), amount: amount.toFixed(2), merchant, expires, created: Date.now(), paid: false };
    await putL(env, l);
    return json(l);
  }
  const l = id && await getL(env, id);
  if (!l) return json({ error: 'not_found' }, 404);
  if (req.method === 'PATCH') {
    const e = Number((await req.json()).expires);
    if (!(e > 0)) return json({ error: 'Invalid expiry' }, 400);
    l.expires = e; await putL(env, l); return json(l);
  }
  if (req.method === 'DELETE') { await env.LINKS.delete('link:' + id); return json({ ok: true }); }
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (p === '/api/webhook' && req.method === 'POST') return await webhook(req, env);
      const m = p.match(/^\/api\/pay\/([A-Za-z0-9]{8})(\/status)?$/);
      if (m) return m[2] ? await status(m[1], env) : await payInfo(m[1], env, url.origin);
      if (p.startsWith('/api/admin/')) {
        return await admin(req, env, p);
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      return json({ error: 'gateway_error' }, 502);
    }
  }
};
