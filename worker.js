// VELOCITY FFA server (authoritative). One Cloudflare Durable Object per match room.
// Players send only their INPUTS. The server re-runs the same movement/weapon code as the game
// (shared.js), checks every shot against the real map and the other players' hit boxes (with lag
// compensation), and owns health, ammo, kills and respawns. Clients cannot move themselves or
// set their own damage.
import { TICK, WPN, SPAWNS, buildWorld, newState, respawnState, simTick, packState, aimDir, rayBox, rayWorld, playerBoxes, H_STAND } from './shared.js';

export const CFG = {
  MAX_PLAYERS: 12, TICK_HZ: 15, RESPAWN_MS: 3000, HP: 100,
  AFK_MS: 120000, TIMEOUT_MS: 15000,
  BUDGET_CAP: 0.5,      // seconds of simulation a player may "bank"; stops speed hacks
  QUEUE_MAX: 180,       // ticks (3 s) of unprocessed input per player
  INTERP_MS: 120,       // how far in the past other players are drawn on a client
  MAX_REWIND_MS: 400,
};
const WORLD = buildWorld();
export const BOXES = WORLD.boxes;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = v => typeof v === 'number' && isFinite(v);
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;

export class Room {
  constructor(now) {
    this.now = now || (() => Date.now());
    this.players = new Map();
    this.nextId = 1;
    this.lastPing = 0;
  }
  count() { return this.players.size; }

  join(sock, rawName) {
    if (this.players.size >= CFG.MAX_PLAYERS) return null;
    const id = this.nextId++;
    let name = String(rawName || '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 14);
    if (!name) name = 'Player' + id;
    const t = this.now();
    const spawn = this.pickSpawn();
    const S = newState(); respawnState(S, SPAWNS[spawn]);
    const p = { id, name, sock, S, yaw: 0, pitch: 0, hp: CFG.HP, alive: true, kills: 0, deaths: 0, respawnAt: 0,
      lastMsg: t, lastActive: t, queue: [], queued: 0, ack: 0, budget: 0.1, lastTick: t, hist: [], rtt: 100, win: t, winCount: 0 };
    this.players.set(id, p);
    this.send(p, { t: 'w', id, s: spawn, hp: p.hp, players: this.roster() });
    this.broadcast({ t: 'j', id, name }, id);
    this.sendBoard();
    return id;
  }
  leave(id) {
    if (!this.players.delete(id)) return;
    this.broadcast({ t: 'l', id });
    this.sendBoard();
  }
  roster() { return [...this.players.values()].map(p => ({ id: p.id, name: p.name, k: p.kills, d: p.deaths })); }
  send(p, obj) { try { p.sock.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch (e) {} }
  broadcast(obj, exceptId) {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
    for (const p of this.players.values()) if (p.id !== exceptId) this.send(p, s);
  }
  sendBoard() {
    const rows = [...this.players.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).map(p => [p.id, p.name, p.kills, p.deaths]);
    this.broadcast({ t: 'sb', rows });
  }
  pickSpawn() {
    const alive = [...this.players.values()].filter(p => p.alive);
    let best = 0, bestD = -1;
    for (let k = 0; k < 8; k++) {
      const i = (Math.random() * SPAWNS.length) | 0, s = SPAWNS[i];
      let d = 1e9;
      for (const p of alive) d = Math.min(d, Math.hypot(p.S.x - s[0], p.S.z - s[1]));
      if (d > bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ---- incoming ----
  message(id, raw) {
    const p = this.players.get(id);
    if (!p || typeof raw !== 'string' || raw.length > 4096) return;
    const t = this.now();
    if (t - p.win >= 1000) { p.win = t; p.winCount = 0; }
    if (++p.winCount > 40) return;               // flood guard: 40 messages per second
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m) return;
    p.lastMsg = t;
    if (m.t === 'pn') { if (num(m.ts)) p.rtt = clamp(t - m.ts, 0, 1000); return; }
    if (m.t !== 'i' || !Array.isArray(m.c) || !p.alive) return;
    for (const c of m.c.slice(0, 8)) {
      if (!Array.isArray(c) || c.length < 7 || !c.slice(0, 5).every(num)) continue;
      const flags = c[4] | 0, rep = clamp(c[6] | 0, 1, 60);
      if (p.queued + rep > CFG.QUEUE_MAX) { p.ack += rep; continue; }   // flooding: consumed but never simulated
      p.queue.push({ f: clamp(c[0], -100, 100) / 100, r: clamp(c[1], -100, 100) / 100, yaw: clamp(c[2], -1000, 1000), pitch: clamp(c[3], -1.6, 1.6),
        j: !!(flags & 1), s: !!(flags & 2), sp: !!(flags & 4), fire: !!(flags & 8), rl: !!(flags & 16), w: c[5] === 1 ? 1 : 0, rep });
      p.queued += rep;
    }
  }

  // ---- simulation ----
  runQueue(p, t) {
    p.budget = Math.min(CFG.BUDGET_CAP, p.budget + (t - p.lastTick) / 1000); p.lastTick = t;
    while (p.queue.length && p.alive) {
      const c = p.queue[0];
      for (let k = 0; k < c.rep && p.alive; k++) {
        if (p.budget >= TICK) {
          p.budget -= TICK;
          const ev = simTick(p.S, c, BOXES);
          if (c.f || c.r || c.j || c.s || c.fire || Math.abs(c.yaw - p.yaw) > 0.02) p.lastActive = t;
          p.yaw = c.yaw; p.pitch = c.pitch;
          for (const e of ev) if (Array.isArray(e) && e[0] === 'fire') this.shot(p, e, t);
        }                                         // else: out of time budget (speed hack or lag burst): tick is skipped
        p.ack++; p.queued--;
      }
      p.queue.shift();
    }
    if (!p.alive) { p.queue.length = 0; p.queued = 0; }
  }

  posAt(v, at) {
    const h = v.hist;
    if (!h.length || at >= h[h.length - 1].t) return { x: v.S.x, y: v.S.y, z: v.S.z, h: v.S.h };
    if (at <= h[0].t) return h[0];
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= at) {
        const a = h[i - 1], b = h[i], k = (at - a.t) / Math.max(1, b.t - a.t);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, h: b.h };
      }
    }
    return h[0];
  }

  shot(p, ev, t) {
    const w = ev[1], W = WPN[w], yaw = ev[2], pitch = ev[3], ex = ev[4], ey = ev[5], ez = ev[6], hs = ev[7], og = ev[8];
    const fwd = aimDir(yaw, pitch), rgt = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const up = [rgt[1] * fwd[2] - rgt[2] * fwd[1], rgt[2] * fwd[0] - rgt[0] * fwd[2], rgt[0] * fwd[1] - rgt[1] * fwd[0]];
    const at = t - clamp(p.rtt / 2 + CFG.INTERP_MS, 0, CFG.MAX_REWIND_MS);   // lag compensation
    const targets = [];
    for (const v of this.players.values()) {
      if (v === p || !v.alive) continue;
      const pos = this.posAt(v, at);
      targets.push({ v, boxes: playerBoxes(pos.x, pos.y, pos.z, pos.h) });
    }
    const agg = new Map(); let tracerEnd = null;
    const n = w ? W.pellets : 1;
    for (let i = 0; i < n; i++) {
      let ox, oy;
      if (w) { const a = Math.random() * 6.2832, r = Math.sqrt(Math.random()) * 0.055; ox = Math.cos(a) * r; oy = Math.sin(a) * r; }
      else { const s = 0.004 + hs * 0.0009 + (og ? 0 : 0.014); ox = (Math.random() - 0.5) * 2 * s; oy = (Math.random() - 0.5) * 2 * s; }
      let dx = fwd[0] + rgt[0] * ox + up[0] * oy, dy = fwd[1] + rgt[1] * ox + up[1] * oy, dz = fwd[2] + rgt[2] * ox + up[2] * oy;
      const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      let tw = rayWorld(ex, ey, ez, dx, dy, dz, W.range, BOXES); if (tw === Infinity) tw = W.range;
      let best = tw, hit = null;
      for (const tg of targets) for (const b of tg.boxes) {
        const tt = rayBox(ex, ey, ez, dx, dy, dz, b);
        if (tt < best) { best = tt; hit = { v: tg.v, head: b.head }; }
      }
      if (hit) {
        const fall = w ? 1 - clamp((best - 10) / 25, 0, 0.75) : 1;
        const e = agg.get(hit.v) || { dmg: 0, head: false };
        e.dmg += (hit.head ? W.head : W.body) * fall; e.head = e.head || hit.head; agg.set(hit.v, e);
      }
      if (i === 0) tracerEnd = [ex + dx * best, ey + dy * best, ez + dz * best];
    }
    this.broadcast({ t: 'f', i: p.id, w, e: tracerEnd.map(r2) }, p.id);
    agg.forEach((e, v) => this.damage(p, v, Math.round(e.dmg), w, e.head, t));
  }

  damage(shooter, v, dmg, w, head, t) {
    if (!v.alive || dmg <= 0) return;
    v.hp = Math.max(0, v.hp - dmg);
    this.send(shooter, { t: 'h', v: v.id, hp: v.hp, hd: head ? 1 : 0 });
    this.send(v, { t: 'd', hp: v.hp, f: shooter.id });
    if (v.hp > 0) return;
    v.alive = false; v.deaths++; shooter.kills++; v.respawnAt = t + CFG.RESPAWN_MS;
    this.broadcast({ t: 'k', k: shooter.id, v: v.id, w, hd: head ? 1 : 0 });
    this.sendBoard();
  }

  tick() {
    const t = this.now();
    for (const p of [...this.players.values()]) {
      if (t - p.lastMsg > CFG.TIMEOUT_MS) { this.kick(p, 'timeout'); continue; }
      if (t - p.lastActive > CFG.AFK_MS) { this.kick(p, 'afk'); continue; }
      if (!p.alive && t >= p.respawnAt) {
        const s = this.pickSpawn();
        respawnState(p.S, SPAWNS[s]);
        p.alive = true; p.hp = CFG.HP; p.ack = 0; p.queue.length = 0; p.queued = 0; p.budget = 0.1; p.lastTick = t; p.lastActive = t; p.hist.length = 0;
        this.broadcast({ t: 'r', i: p.id, s });
      }
    }
    for (const p of this.players.values()) this.runQueue(p, t);
    for (const p of this.players.values()) {
      p.hist.push({ t, x: p.S.x, y: p.S.y, z: p.S.z, h: p.S.h });
      while (p.hist.length > 2 && t - p.hist[0].t > 1000) p.hist.shift();
    }
    if (!this.players.size) return;
    const all = [];
    for (const p of this.players.values()) {
      const S = p.S, fl = (S.sliding ? 1 : 0) | (S.h < H_STAND ? 2 : 0) | (S.onGround ? 0 : 4);
      all.push([p.id, r2(S.x), r2(S.y), r2(S.z), r3(p.yaw), r2(p.pitch), S.cur, fl, p.alive ? p.hp : 0]);
    }
    for (const p of this.players.values()) {
      this.send(p, { t: 'S', a: p.ack, hp: p.hp, me: packState(p.S), p: all.filter(e => e[0] !== p.id) });
    }
    if (t - this.lastPing > 2000) { this.lastPing = t; this.broadcast({ t: 'pg', ts: t }); }
  }

  kick(p, why) {
    this.send(p, { t: 'kick', why });
    try { p.sock.close(); } catch (e) {}
    this.leave(p.id);
  }
}

// ---------------- Cloudflare glue ----------------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' };
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
const PUBLIC_ROOMS = ['ffa-1', 'ffa-2', 'ffa-3', 'ffa-4', 'ffa-5', 'ffa-6'];

export class GameRoom {
  constructor(state, env) { this.room = new Room(); this.timer = null; }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/count') return json({ n: this.room.count() });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const sock = { send: s => { try { server.send(s); } catch (e) {} }, close: () => { try { server.close(1000, 'bye'); } catch (e) {} } };
    const id = this.room.join(sock, url.searchParams.get('name'));
    if (id === null) {
      server.send(JSON.stringify({ t: 'full' })); server.close(1000, 'full');
      return new Response(null, { status: 101, webSocket: client });
    }
    if (!this.timer) this.timer = setInterval(() => this.room.tick(), 1000 / CFG.TICK_HZ);
    server.addEventListener('message', e => { if (typeof e.data === 'string') this.room.message(id, e.data); });
    const bye = () => {
      this.room.leave(id);
      if (!this.room.count() && this.timer) { clearInterval(this.timer); this.timer = null; }
    };
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/api/rooms') {
      const out = await Promise.all(PUBLIC_ROOMS.map(async r => {
        try {
          const res = await env.ROOMS.get(env.ROOMS.idFromName(r)).fetch('https://room/count');
          return { room: r, n: (await res.json()).n, max: CFG.MAX_PLAYERS };
        } catch (e) { return { room: r, n: 0, max: CFG.MAX_PLAYERS }; }
      }));
      return json(out);
    }
    if (url.pathname === '/ws') {
      const room = (url.searchParams.get('room') || 'ffa-1').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'ffa-1';
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req);
    }
    return new Response('Velocity FFA server is running.', { headers: CORS });
  },
};
