// VELOCITY FFA server (authoritative). One Cloudflare Durable Object per match room.
// Players send only their INPUTS. The server re-runs the same movement/weapon code as the game
// (shared.js), checks every shot against the real map and the other players' hit boxes (with lag
// compensation), and owns health, ammo, kills and respawns. Clients cannot move themselves or
// set their own damage.
import { TICK, WPN, JUICE, throwInit, projStep, spreadOf, SPAWNS, buildWorld, MAPS, mapOfRoom, newState, respawnState, simTick, packState, aimDir, rayBox, rayWorld, playerBoxes, H_STAND } from './shared.js';

export const CFG = {
  MAX_PLAYERS: 12, TICK_HZ: 15, RESPAWN_MS: 3000, HP: 100,
  AFK_MS: 120000, TIMEOUT_MS: 15000,
  BUDGET_CAP: 0.5,      // seconds of simulation a player may "bank"; stops speed hacks
  QUEUE_MAX: 180,       // ticks (3 s) of unprocessed input per player
  INTERP_MS: 120,       // how far in the past other players are drawn on a client
  MAX_REWIND_MS: 400,
  MATCH_MS: 300000,     // public rooms run endless 5-minute free-for-all matches
  RESULTS_MS: 12000,    // podium screen between matches
};
const MATCH_MAPS = ['yard', 'farm'];   // matches alternate between these two maps
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
    this.nextId = 1; this.boxes = BOXES; this.spawns = SPAWNS;
    this.lastPing = 0; this.projs = []; this.zones = []; this.lastJuice = null;
    this.timed = false; this.phase = 'play'; this.phaseEnd = 0; this.matchNo = 0; this.mapOffset = 0; this.mapId = 'yard'; this.lastRows = [];
  }
  count() { return this.players.size; }
  setMap(id) { const m = MAPS[id] || MAPS.yard; this.mapId = MAPS[id] ? id : 'yard'; this.boxes = m.boxes; this.spawns = m.spawns; }

  join(sock, rawName, uid) {
    if (this.players.size >= CFG.MAX_PLAYERS) return null;
    if (this.timed && this.players.size === 0) this.beginMatchState(this.now());   // first player in an empty public room starts a fresh match
    const id = this.nextId++;
    let name = String(rawName || '').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 14);
    if (!name) name = 'Player' + id;
    const t = this.now();
    const spawn = this.pickSpawn();
    const S = newState(); respawnState(S, this.spawns[spawn]);
    const p = { id, name, uid: uid || '', sock, S, yaw: 0, pitch: 0, hp: CFG.HP, alive: true, kills: 0, deaths: 0, respawnAt: 0,
      lastMsg: t, lastActive: t, queue: [], queued: 0, ack: 0, budget: 0.1, lastTick: t, hist: [], rtt: 100, win: t, winCount: 0 };
    this.players.set(id, p);
    const wel = { t: 'w', id, s: spawn, hp: p.hp, players: this.roster(), map: this.mapId };
    if (this.timed) { wel.ph = this.phase; wel.ml = Math.max(0, this.phaseEnd - t); wel.no = this.matchNo; }
    this.send(p, wel);
    this.broadcast({ t: 'j', id, name }, id);
    this.sendBoard();
    if (this.timed && this.phase === 'results') this.send(p, { t: 'res', rows: this.lastRows, next: this.nextMapId(), ml: Math.max(0, this.phaseEnd - t), no: this.matchNo });
    return id;
  }
  voiceRelay(p, raw, t) {   // voice chat: hand a phone-to-phone connection setup message to one other player in this room
    if (t - (p.vwin || 0) >= 10000) { p.vwin = t; p.vcount = 0; }
    if (++p.vcount > 400) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const to = m && typeof m.to === 'number' ? this.players.get(m.to) : null;
    if (!to || to === p || !m.d || typeof m.d !== 'object') return;
    this.send(to, { t: 'vs', f: p.id, d: m.d });
  }
  guestName() {   // server-made guest names: "lazyguy" + 5 digits, never reused by someone already in the room
    for (let k = 0; k < 30; k++) {
      const n = 'lazyguy' + (10000 + Math.floor(Math.random() * 90000));
      if (![...this.players.values()].some(p => p.name === n)) return n;
    }
    return 'lazyguy' + Date.now() % 100000;
  }
  byUid(uid) { for (const p of this.players.values()) if (p.uid && p.uid === uid) return p; return null; }
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
      const i = (Math.random() * this.spawns.length) | 0, s = this.spawns[i];
      let d = 1e9;
      for (const p of alive) d = Math.min(d, Math.hypot(p.S.x - s[0], p.S.z - s[1]));
      if (d > bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // ---- timed matches (public rooms) ----
  nextMapId() { return MATCH_MAPS[(this.matchNo + this.mapOffset) % MATCH_MAPS.length]; }
  beginMatchState(t) {
    this.matchNo++; this.phase = 'play'; this.phaseEnd = t + CFG.MATCH_MS;
    this.setMap(MATCH_MAPS[(this.matchNo - 1 + this.mapOffset) % MATCH_MAPS.length]);
  }
  matchTick(t) {
    if (this.phase === 'play' && t >= this.phaseEnd) this.endMatch(t);
    else if (this.phase === 'results' && t >= this.phaseEnd) this.startMatch(t);
  }
  endMatch(t) {   // time is up: freeze the room and show the podium
    this.phase = 'results'; this.phaseEnd = t + CFG.RESULTS_MS;
    this.lastRows = [...this.players.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).map(p => [p.id, p.name, p.kills, p.deaths]);
    for (const p of this.players.values()) { p.queue.length = 0; p.queued = 0; }
    this.broadcast({ t: 'res', rows: this.lastRows, next: this.nextMapId(), ml: CFG.RESULTS_MS, no: this.matchNo });
  }
  startMatch(t) {   // next match: other map, everyone back to zero and onto fresh spawns
    this.beginMatchState(t);
    this.projs.length = 0; this.zones.length = 0; this.lastJuice = null;
    const ps = [...this.players.values()];
    ps.forEach(p => { p.alive = false; });         // so each spawn is picked away from the people already placed
    for (const p of ps) {
      p.kills = 0; p.deaths = 0; p.hp = CFG.HP;
      const s = this.pickSpawn(); respawnState(p.S, this.spawns[s]);
      p.alive = true; p.ack = 0; p.queue.length = 0; p.queued = 0; p.budget = 0.1; p.lastTick = t; p.lastActive = t; p.hist.length = 0; p.healAcc = 0;
      this.send(p, { t: 'nm', map: this.mapId, s, no: this.matchNo, ml: CFG.MATCH_MS });
    }
    this.sendBoard();
  }

  // ---- incoming ----
  message(id, raw) {
    const p = this.players.get(id);
    if (!p || typeof raw !== 'string' || raw.length > 4096) return;
    const t = this.now();
    if (raw.startsWith('{"t":"vs"')) return this.voiceRelay(p, raw, t);   // voice chat setup messages have their own allowance
    if (t - p.win >= 1000) { p.win = t; p.winCount = 0; }
    if (++p.winCount > 40) return;               // flood guard: 40 messages per second
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m) return;
    p.lastMsg = t;
    if (m.t === 'pn') { if (num(m.ts)) p.rtt = clamp(t - m.ts, 0, 1000); return; }
    if (m.t !== 'i' || !Array.isArray(m.c) || !p.alive || (this.timed && this.phase === 'results')) return;
    for (const c of m.c.slice(0, 8)) {
      if (!Array.isArray(c) || c.length < 7 || !c.slice(0, 5).every(num)) continue;
      const flags = c[4] | 0, rep = clamp(c[6] | 0, 1, 60);
      if (p.queued + rep > CFG.QUEUE_MAX) { p.ack += rep; continue; }   // flooding: consumed but never simulated
      p.queue.push({ f: clamp(c[0], -100, 100) / 100, r: clamp(c[1], -100, 100) / 100, yaw: clamp(c[2], -1000, 1000), pitch: clamp(c[3], -1.6, 1.6),
        j: !!(flags & 1), s: !!(flags & 2), sp: !!(flags & 4), fire: !!(flags & 8), rl: !!(flags & 16), w: c[5] === 1 ? 1 : c[5] === 2 ? 2 : c[5] === 3 ? 3 : 0, rep });
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
          const ev = simTick(p.S, c, this.boxes);
          if (c.f || c.r || c.j || c.s || c.fire || Math.abs(c.yaw - p.yaw) > 0.02) p.lastActive = t;
          p.yaw = c.yaw; p.pitch = c.pitch;
          for (const e of ev) if (Array.isArray(e)) { if (e[0] === 'fire') this.shot(p, e, t); else if (e[0] === 'throw') this.throwJuice(p, e); }
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

  throwJuice(p, e) {
    if (this.projs.length >= 24) return;
    const g = throwInit(e[1], e[2], e[3], e[4], e[5], e[6], e[7], this.boxes);
    this.projs.push({ g, o: p.id });
    this.broadcast({ t: 'th', i: p.id, p: [g.x, g.y, g.z].map(r2), v: [g.vx, g.vy, g.vz].map(r2) }, p.id);
  }
  // thrown juice boxes fly, land, and become heal rings
  stepJuice(t) {
    const dt = this.lastJuice === null ? 0 : clamp((t - this.lastJuice) / 1000, 0, 0.2); this.lastJuice = t;
    const n = Math.ceil(dt * 60);
    for (let i = this.projs.length - 1; i >= 0; i--) {
      const pr = this.projs[i]; let landed = false;
      for (let k = 0; k < n && !landed; k++) landed = projStep(pr.g, 1 / 60, this.boxes);
      if (landed) {
        this.projs.splice(i, 1);
        const z = { x: pr.g.x, y: pr.g.y - JUICE.rest, z: pr.g.z, t1: t + JUICE.dur * 1000, o: pr.o };
        this.zones.push(z); if (this.zones.length > 16) this.zones.shift();
        this.broadcast({ t: 'z', x: r2(z.x), y: r2(z.y), z: r2(z.z), r: JUICE.radius, d: JUICE.dur * 1000 });
      }
    }
    this.zones = this.zones.filter(z => z.t1 > t);
    for (const p of this.players.values()) {
      let inside = false;
      if (p.alive) for (const z of this.zones) {
        if (Math.hypot(p.S.x - z.x, p.S.z - z.z) <= JUICE.radius && p.S.y >= z.y - 0.6 && p.S.y <= z.y + 2.2) { inside = true; break; }
      }
      if (!inside) { p.healAcc = 0; continue; }
      p.healAcc = (p.healAcc || 0) + JUICE.hps * dt;
      const whole = Math.floor(p.healAcc);
      if (whole > 0) { p.healAcc -= whole; p.hp = Math.min(CFG.HP, p.hp + whole); }
    }
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
    const n = w === 1 ? W.pellets : 1;
    for (let i = 0; i < n; i++) {
      let ox, oy;
      if (w === 1) { const a = Math.random() * 6.2832, r = Math.sqrt(Math.random()) * 0.055; ox = Math.cos(a) * r; oy = Math.sin(a) * r; }
      else { const s = spreadOf(w, hs, og); ox = (Math.random() - 0.5) * 2 * s; oy = (Math.random() - 0.5) * 2 * s; }
      let dx = fwd[0] + rgt[0] * ox + up[0] * oy, dy = fwd[1] + rgt[1] * ox + up[1] * oy, dz = fwd[2] + rgt[2] * ox + up[2] * oy;
      const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      let tw = rayWorld(ex, ey, ez, dx, dy, dz, W.range, this.boxes); if (tw === Infinity) tw = W.range;
      let best = tw, hit = null;
      for (const tg of targets) for (const b of tg.boxes) {
        const tt = rayBox(ex, ey, ez, dx, dy, dz, b);
        if (tt < best) { best = tt; hit = { v: tg.v, head: b.head }; }
      }
      if (hit) {
        const fall = w === 1 ? 1 - clamp((best - 10) / 25, 0, 0.75) : 1;
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
    if (this.timed) this.matchTick(t);
    const frozen = this.timed && this.phase === 'results';
    for (const p of [...this.players.values()]) {
      if (t - p.lastMsg > CFG.TIMEOUT_MS) { this.kick(p, 'timeout'); continue; }
      if (t - p.lastActive > CFG.AFK_MS) { this.kick(p, 'afk'); continue; }
      if (!p.alive && t >= p.respawnAt && !frozen) {
        const s = this.pickSpawn();
        respawnState(p.S, this.spawns[s]);
        p.alive = true; p.hp = CFG.HP; p.ack = 0; p.queue.length = 0; p.queued = 0; p.budget = 0.1; p.lastTick = t; p.lastActive = t; p.hist.length = 0;
        this.broadcast({ t: 'r', i: p.id, s });
      }
    }
    if (!frozen) for (const p of this.players.values()) this.runQueue(p, t);
    this.stepJuice(t);
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
      this.send(p, { t: 'S', a: p.ack, hp: p.hp, r: Math.round(p.rtt), me: packState(p.S), p: all.filter(e => e[0] !== p.id), ml: this.timed ? Math.max(0, this.phaseEnd - t) : undefined });
    }
    if (t - this.lastPing > 2000) { this.lastPing = t; this.broadcast({ t: 'pg', ts: t }); }
  }

  kick(p, why) {
    this.send(p, { t: 'kick', why });
    try { p.sock.close(); } catch (e) {}
    this.leave(p.id);
  }
}

// ---------------- account check (Firebase) ----------------
// The browser sends its Firebase sign-in token. We ask Firestore for that user's claimed username using the token itself:
// Firestore only answers if the token is genuine and belongs to that user, so nobody can fake a name or an identity.
async function verifyUser(token, env) {
  const pid = env.FIREBASE_PROJECT_ID;
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || token.length > 4000) return null;
    let b = parts[1].replace(/-/g, '+').replace(/_/g, '/'); b += '='.repeat((4 - b.length % 4) % 4);
    const pay = JSON.parse(atob(b));
    if (pay.aud !== pid || typeof pay.sub !== 'string' || !/^[A-Za-z0-9]{6,128}$/.test(pay.sub) || !(pay.exp * 1000 > Date.now())) return null;
    const res = await fetch('https://firestore.googleapis.com/v1/projects/' + pid + '/databases/(default)/documents/users/' + pay.sub, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return null;
    const doc = await res.json();
    const name = doc && doc.fields && doc.fields.username && doc.fields.username.stringValue;
    return name && /^[A-Za-z0-9_-]{3,14}$/.test(name) ? { uid: pay.sub, name } : null;
  } catch (e) { return null; }
}

// ---------------- Cloudflare glue ----------------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' };
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json', ...CORS } });
const PUBLIC_ROOMS = ['ffa-1', 'ffa-2', 'ffa-3', 'ffa-4', 'ffa-5', 'ffa-6'];

export class GameRoom {
  constructor(state, env) { this.room = new Room(); this.timer = null; this.env = env || {}; }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/count') return json({ n: this.room.count() });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const sock = { send: s => { try { server.send(s); } catch (e) {} }, close: () => { try { server.close(1000, 'bye'); } catch (e) {} } };
    if (!this.mapSet) {
      this.mapSet = true;
      const rn = (url.searchParams.get('room') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16);
      // every room (public or private) runs endless 5-minute matches that rotate through the maps; nobody picks a map
      this.room.timed = true;
      this.room.mapOffset = /^ffa-/.test(rn) ? (parseInt(rn.slice(4), 10) || 0) % MATCH_MAPS.length : 0;
    }
    let who = null, guest = null;
    if (this.env.FIREBASE_PROJECT_ID) {          // accounts are on: signed-in players use their claimed username, guests get a random one
      const token = url.searchParams.get('token');
      if (token) {
        who = await verifyUser(token, this.env);
        if (who) { const old = this.room.byUid(who.uid); if (old) this.room.kick(old, 'replaced'); }   // same account joining twice: the new connection wins
      } else if (url.searchParams.get('guest') === '1') guest = this.room.guestName();
      if (!who && guest === null) { server.send(JSON.stringify({ t: 'autherr' })); server.close(1000, 'auth'); return new Response(null, { status: 101, webSocket: client }); }
    }
    const id = this.room.join(sock, who ? who.name : guest !== null ? guest : url.searchParams.get('name'), who ? who.uid : '');
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
