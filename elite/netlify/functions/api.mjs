import { neon } from '@netlify/neon';
import crypto from 'node:crypto';

const sql = neon();
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const hash = (p, s) => crypto.pbkdf2Sync(p, s, 150000, 32, 'sha256').toString('base64');
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const num = v => (v === null || v === undefined ? null : Number(v));
const N = x => Math.max(0, Number.isFinite(+x) ? +x : 0);

let ready;
const init = () => ready || (ready = (async () => {
  await sql`CREATE TABLE IF NOT EXISTS users(u text PRIMARY KEY, e text, salt text, h text, banned boolean DEFAULT false, fav jsonb DEFAULT '[]', f int DEFAULT 0, lk bigint DEFAULT 0)`;
  await sql`CREATE TABLE IF NOT EXISTS sessions(tok text PRIMARY KEY, u text, exp bigint)`;
  await sql`CREATE TABLE IF NOT EXISTS items(id text PRIMARY KEY, kind text, cat text, name text, contains text, price numeric, orig numeric, stock int, exp bigint)`;
  await sql`CREATE TABLE IF NOT EXISTS orders(id serial PRIMARY KEY, u text, items jsonb, total numeric, t bigint, st int DEFAULT 0)`;
  await sql`CREATE TABLE IF NOT EXISTS reviews(id serial PRIMARY KEY, u text, r int, t text)`;
  await sql`CREATE TABLE IF NOT EXISTS tickets(id serial PRIMARY KEY, u text, s text, m text, st text DEFAULT 'Open')`;
  await sql`CREATE TABLE IF NOT EXISTS settings(k text PRIMARY KEY, v jsonb)`;
  if (!(await sql`SELECT 1 FROM items LIMIT 1`).length) {
    const seed = [
      ['n1', 'p', 'Discord Nitro', 'Nitro Basic', '', 3, 0, 50, null],
      ['n2', 'p', 'Discord Nitro', 'Nitro Monthly', '', 10, 0, 40, null],
      ['r1', 'p', 'Robux', '400 Robux', '', 5, 0, 100, null],
      ['r2', 'p', 'Robux', '800 Robux', '', 9, 0, 100, null],
      ['r3', 'p', 'Robux', '1700 Robux', '', 15, 0, 80, null],
      ['r4', 'p', 'Robux', '4500 Robux', '', 38, 0, 40, null],
      ['b1', 'b', '', 'Starter Pack', 'Nitro Basic + 400 Robux', 7, 9, null, null],
      ['b2', 'b', '', 'Gamer Pack', 'Nitro Monthly + 1700 Robux', 21, 25, null, null],
      ['l1', 'l', '', 'Limited Winter Pack', 'Nitro Monthly + 800 Robux', 13, 20, 25, Date.now() + 7 * 864e5],
    ];
    for (const r of seed) await sql`INSERT INTO items(id,kind,cat,name,contains,price,orig,stock,exp) VALUES(${r[0]},${r[1]},${r[2]},${r[3]},${r[4]},${r[5]},${r[6]},${r[7]},${r[8]}) ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO settings(k,v) VALUES('friday','{"on":true,"force":false,"pct":27}') ON CONFLICT DO NOTHING`;
  }
})());

async function friday() {
  const f = (await sql`SELECT v FROM settings WHERE k='friday'`)[0]?.v || { on: true, force: false, pct: 27 };
  const wd = new Date().toLocaleString('en-US', { timeZone: 'Asia/Beirut', weekday: 'short' });
  return { f, fri: !!(f.on && (f.force || wd === 'Fri')) };
}
const mkOrder = o => ({ id: 'ES' + (1000 + o.id), u: o.u, items: o.items, total: Number(o.total), t: Number(o.t), st: o.st });

export default async (req) => {
  if (req.method !== 'POST') return J({ err: 'Not found' }, 404);
  await init();
  let d; try { d = await req.json(); } catch { return J({ err: 'Bad request' }, 400); }
  const now = Date.now();
  const tok = req.headers.get('x-tok'), adm = req.headers.get('x-adm');
  let me = tok ? (await sql`SELECT u.u,u.e,u.fav,u.banned FROM sessions s JOIN users u ON u.u=s.u WHERE s.tok=${tok} AND s.exp>${now}`)[0] : null;
  if (me && me.banned) me = null;
  const isAdm = !!(adm && (await sql`SELECT 1 FROM sessions WHERE tok=${adm} AND u='*admin*' AND exp>${now}`).length);
  const mk = async (u, rm) => { const t = crypto.randomBytes(24).toString('hex'); await sql`DELETE FROM sessions WHERE exp<${now}`; await sql`INSERT INTO sessions(tok,u,exp) VALUES(${t},${u},${now + (rm ? 30 * 864e5 : 864e5)})`; return t; };
  const need = () => (me ? null : J({ err: 'Please log in first.' }, 401));
  const adminOnly = () => (isAdm ? null : J({ err: 'Admin only.' }, 403));

  switch (d.a) {
    case 'state': {
      const { f, fri } = await friday();
      const items = (await sql`SELECT * FROM items ORDER BY id`).map(i => ({ id: i.id, kind: i.kind, cat: i.cat, name: i.name, contains: i.contains, price: Number(i.price), orig: Number(i.orig), stock: num(i.stock), exp: num(i.exp) }));
      const reviews = (await sql`SELECT u,r,t FROM reviews ORDER BY id DESC LIMIT 50`);
      const out = { items, friday: f, fri, reviews, me: me ? { u: me.u, e: me.e, fav: me.fav } : null };
      if (isAdm) {
        out.users = await sql`SELECT u,e,banned FROM users ORDER BY u`;
        out.orders = (await sql`SELECT * FROM orders ORDER BY id`).map(mkOrder);
        out.tickets = await sql`SELECT id,u,s,m,st FROM tickets ORDER BY id`;
      } else if (me) {
        out.orders = (await sql`SELECT * FROM orders WHERE u=${me.u} ORDER BY id`).map(mkOrder);
        out.tickets = await sql`SELECT id,u,s,m,st FROM tickets WHERE u=${me.u} ORDER BY id`;
      }
      return J(out);
    }
    case 'register': {
      const u = String(d.u || '').trim(), e = String(d.e || '').trim(), p = String(d.p || '');
      if (!/^[\w.-]{3,20}$/.test(u)) return J({ err: 'Username: 3–20 letters, numbers, . _ -' });
      if (!/^\S+@\S+\.\S+$/.test(e)) return J({ err: 'Enter a valid email.' });
      if (p.length < 8) return J({ err: 'Use at least 8 characters.' });
      const salt = crypto.randomBytes(16).toString('base64');
      const r = await sql`INSERT INTO users(u,e,salt,h) SELECT ${u},${e},${salt},${hash(p, salt)} WHERE NOT EXISTS(SELECT 1 FROM users WHERE lower(u)=lower(${u})) RETURNING u`;
      if (!r.length) return J({ err: 'That username is taken.' });
      return J({ tok: await mk(u, d.rm) });
    }
    case 'login': {
      const u = String(d.u || '').trim(), p = String(d.p || '');
      const x = (await sql`SELECT * FROM users WHERE lower(u)=lower(${u})`)[0];
      if (x && Number(x.lk) > now) return J({ err: 'Too many attempts. Try again in a few minutes.' });
      if (!x || !same(hash(p, x.salt), x.h)) {
        if (x) { const n = x.f + 1; await sql`UPDATE users SET f=${n >= 5 ? 0 : n}, lk=${n >= 5 ? now + 3e5 : 0} WHERE u=${x.u}`; }
        return J({ err: 'Wrong username or password.' });
      }
      if (x.banned) return J({ err: 'This account is banned.' });
      await sql`UPDATE users SET f=0 WHERE u=${x.u}`;
      return J({ tok: await mk(x.u, d.rm) });
    }
    case 'logout': if (tok) await sql`DELETE FROM sessions WHERE tok=${tok}`; if (adm) await sql`DELETE FROM sessions WHERE tok=${adm}`; return J({ ok: 1 });
    case 'adminLogin': {
      const pw = process.env.ADMIN_PASSWORD;
      if (!pw) return J({ err: 'Admin password is not set on the server.' });
      const fl = (await sql`SELECT v FROM settings WHERE k='adminfail'`)[0]?.v || { n: 0, until: 0 };
      if (fl.until > now) return J({ err: 'Too many attempts. Try again in a few minutes.' });
      const dg = s => crypto.createHash('sha256').update(String(s)).digest('hex');
      if (!same(dg(d.p), dg(pw))) {
        fl.n++; if (fl.n >= 5) { fl.n = 0; fl.until = now + 3e5; }
        await sql`INSERT INTO settings(k,v) VALUES('adminfail',${JSON.stringify(fl)}::jsonb) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`;
        return J({ err: 'Wrong password.' });
      }
      const t = crypto.randomBytes(24).toString('hex');
      await sql`INSERT INTO sessions(tok,u,exp) VALUES(${t},'*admin*',${now + 18e5})`;
      return J({ tok: t });
    }
    case 'fav': {
      const b = need(); if (b) return b;
      const a = Array.isArray(me.fav) ? me.fav : []; const i = a.indexOf(d.id);
      i < 0 ? a.push(String(d.id)) : a.splice(i, 1);
      await sql`UPDATE users SET fav=${JSON.stringify(a)}::jsonb WHERE u=${me.u}`; return J({ ok: 1 });
    }
    case 'review': {
      const b = need(); if (b) return b;
      const t = String(d.t || '').trim().slice(0, 500), r = Math.min(5, Math.max(1, Math.floor(+d.r || 5)));
      if (!t) return J({ err: 'Write a review first.' });
      await sql`INSERT INTO reviews(u,r,t) VALUES(${me.u},${r},${t})`; return J({ ok: 1 });
    }
    case 'ticket': {
      const b = need(); if (b) return b;
      const s = String(d.s || '').trim().slice(0, 100), m = String(d.m || '').trim().slice(0, 1000);
      if (!s || !m) return J({ err: 'Add a subject and message.' });
      await sql`INSERT INTO tickets(u,s,m) VALUES(${me.u},${s},${m})`; return J({ ok: 1 });
    }
    case 'order': {
      const b = need(); if (b) return b;
      const cart = Array.isArray(d.cart) ? d.cart.slice(0, 20) : [];
      if (!cart.length) return J({ err: 'Your cart is empty.' });
      const { f, fri } = await friday();
      const lines = [], taken = []; let total = 0;
      const undo = async () => { for (const t of taken) await sql`UPDATE items SET stock=stock+${t.q} WHERE id=${t.id}`; };
      for (const c of cart) {
        const q = Math.floor(+c.q), id = String(c.k || '').split(':')[1];
        if (!(q >= 1 && q <= 20)) { await undo(); return J({ err: 'Bad quantity.' }); }
        const it = (await sql`SELECT * FROM items WHERE id=${id}`)[0];
        if (!it || (it.kind === 'l' && Number(it.exp) < now)) { await undo(); return J({ err: 'An item in your cart is no longer available.' }); }
        if (it.stock !== null) {
          const r = await sql`UPDATE items SET stock=stock-${q} WHERE id=${id} AND stock>=${q} RETURNING id`;
          if (!r.length) { await undo(); return J({ err: 'Not enough stock for ' + it.name }); }
          taken.push({ id, q });
        }
        const p = it.kind === 'p' && fri ? Math.round(Number(it.price) * (100 - f.pct)) / 100 : Number(it.price);
        lines.push({ n: it.name, q, p }); total += p * q;
      }
      total = Math.round(total * 100) / 100;
      const o = (await sql`INSERT INTO orders(u,items,total,t) VALUES(${me.u},${JSON.stringify(lines)}::jsonb,${total},${now}) RETURNING *`)[0];
      return J({ order: mkOrder(o) });
    }
    case 'itemSave': {
      const a = adminOnly(); if (a) return a;
      const i = d.item || {}; if (!['p', 'b', 'l'].includes(i.kind)) return J({ err: 'Bad item.' });
      const id = /^[\w-]{1,30}$/.test(i.id || '') ? i.id : i.kind + Date.now().toString(36);
      const stock = i.kind === 'b' || i.stock == null ? null : Math.floor(N(i.stock));
      await sql`INSERT INTO items(id,kind,cat,name,contains,price,orig,stock,exp) VALUES(${id},${i.kind},${String(i.cat || '').slice(0, 40)},${String(i.name || '').slice(0, 80)},${String(i.contains || '').slice(0, 120)},${N(i.price)},${N(i.orig)},${stock},${i.kind === 'l' ? N(i.exp) : null})
        ON CONFLICT(id) DO UPDATE SET cat=EXCLUDED.cat,name=EXCLUDED.name,contains=EXCLUDED.contains,price=EXCLUDED.price,orig=EXCLUDED.orig,stock=EXCLUDED.stock,exp=COALESCE(EXCLUDED.exp,items.exp)`;
      return J({ ok: 1 });
    }
    case 'itemDel': { const a = adminOnly(); if (a) return a; await sql`DELETE FROM items WHERE id=${String(d.id)}`; return J({ ok: 1 }); }
    case 'friday': {
      const a = adminOnly(); if (a) return a;
      const { f } = await friday();
      if (d.k === 'pct') f.pct = Math.min(90, Math.max(1, Math.floor(+d.v) || 1)); else if (d.k === 'on' || d.k === 'force') f[d.k] = !!d.v; else return J({ err: 'Bad setting.' });
      await sql`UPDATE settings SET v=${JSON.stringify(f)}::jsonb WHERE k='friday'`; return J({ ok: 1 });
    }
    case 'ban': { const a = adminOnly(); if (a) return a; await sql`UPDATE users SET banned=NOT banned WHERE u=${String(d.u)}`; await sql`DELETE FROM sessions WHERE u=${String(d.u)}`; return J({ ok: 1 }); }
    case 'orderSt': { const a = adminOnly(); if (a) return a; const id = parseInt(String(d.id).slice(2)) - 1000; await sql`UPDATE orders SET st=${Math.min(3, Math.max(0, Math.floor(+d.st) || 0))} WHERE id=${id}`; return J({ ok: 1 }); }
    case 'ticketSt': { const a = adminOnly(); if (a) return a; await sql`UPDATE tickets SET st=CASE WHEN st='Open' THEN 'Closed' ELSE 'Open' END WHERE id=${Math.floor(+d.id)}`; return J({ ok: 1 }); }
    default: return J({ err: 'Unknown action.' }, 400);
  }
};

export const config = { path: '/api' };
