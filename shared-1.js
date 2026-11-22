// VELOCITY shared game logic. The game (browser) and the server (Cloudflare) both run exactly this code,
// so the server can re-simulate every player's movement and judge every shot. Pure logic only: no DOM, no three.js.

export const PHYS = { gravity: 25, jump: 9.2, walk: 6.5, sprint: 10, slideBoost: 3.5, slideDecel: 5, airAccel: 14, maxSpeed: 24, airCap: 4.5, maxSlide: 17 };
export const R = 0.35, H_STAND = 1.8, H_CROUCH = 1.0, STEP = 0.55, DT = 1 / 120, TICK = 1 / 60;
export const WPN = [
  { name: 'RIFLE', mag: 24, rate: 1 / 9, reload: 1.2, range: 150, body: 16, head: 40 },
  { name: 'SHOTGUN', mag: 6, rate: 0.6, reload: 1.5, range: 45, body: 11, head: 22, pellets: 8 },
  { name: 'SNIPER', mag: 5, rate: 1.35, reload: 2.6, range: 300, body: 75, head: 120 },
  { name: 'JUICE', mag: 2, rate: 1.0, reload: 0, range: 0, body: 0, head: 0 },   // throwable heal zone (never reloads)
];
export const getAmmo = (S, w) => (w === 3 ? S.m3 : w === 2 ? S.m2 : w === 1 ? S.m1 : S.m0);
function setAmmo(S, w, v) { if (w === 3) S.m3 = v; else if (w === 2) S.m2 = v; else if (w === 1) S.m1 = v; else S.m0 = v; }
// juice box: thrown, lands, and leaves a ring that heals everyone standing in it
export const JUICE = { speed: 13, lob: 3.5, grav: 22, radius: 3.2, dur: 3, hps: 20, rest: 0.12 };
function boxAt(boxes, x, y, z, R) {
  for (let i = 0; i < boxes.length; i++) { const b = boxes[i]; if (x > b.x0 - R && x < b.x1 + R && y > b.y0 - R && y < b.y1 + R && z > b.z0 - R && z < b.z1 + R) return b; }
  return null;
}
export function throwInit(yaw, pitch, ex, ey, ez, vx, vz, boxes) {
  const d = aimDir(yaw, pitch);
  let x = ex + d[0] * 0.5, y = ey + d[1] * 0.5 - 0.1, z = ez + d[2] * 0.5;
  if (boxAt(boxes, x, y, z, JUICE.rest)) { x = ex; y = ey; z = ez; }          // hugging a wall: start from the eye
  return { x, y, z, vx: d[0] * JUICE.speed + vx * 0.7, vy: d[1] * JUICE.speed + JUICE.lob, vz: d[2] * JUICE.speed + vz * 0.7, age: 0 };
}
export function projStep(g, dt, boxes) {   // returns true once it has landed
  const R = JUICE.rest;
  g.age += dt; g.vy -= JUICE.grav * dt;
  const nx = g.x + g.vx * dt; if (boxAt(boxes, nx, g.y, g.z, R)) { g.vx *= -0.3; g.vz *= 0.7; } else g.x = nx;
  const nz = g.z + g.vz * dt; if (boxAt(boxes, g.x, g.y, nz, R)) { g.vz *= -0.3; g.vx *= 0.7; } else g.z = nz;
  const ny = g.y + g.vy * dt;
  if (ny <= R) { g.y = R; return true; }
  const b = boxAt(boxes, g.x, ny, g.z, R);
  if (b) { if (g.vy < 0) { g.y = b.y1 + R; return true; } g.vy *= -0.3; } else g.y = ny;
  return g.age > 5;
}
// shot spread (radians-ish) for single-bullet weapons; shared so the client's tracer matches the server's judgement
export function spreadOf(w, speed, onGround) {
  if (w === 2) return onGround ? 0.0004 + speed * 0.0022 : 0.05;   // sniper: only accurate when nearly still
  return 0.004 + speed * 0.0009 + (onGround ? 0 : 0.014);
}
export const BLAST = { power: 17, range: 6 };
export const WORLD_SEED = 20261120;
export const SPAWNS = [[-56,-56],[56,56],[-56,56],[56,-56],[0,-8],[0,52],[-56,0],[56,0],[-6,-56],[-30,28],[-32,-28],[24,24],[32,-28],[24,-56],[52,28],[28,54],[-28,0],[-28,56],[-2,20],[-56,26],[6,-34],[-32,-54],[30,-4],[56,-30]];

/* ---------------- map ---------------- */

export function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// Builds random container piles. Every box is guaranteed climbable: each rise is <= 1.2m (jump apex ~1.7m),
// via yellow step crates, and no walled-in pockets are left on the ground.
export function genPiles(rand, base, half, want) {
  const CW = 2.5, CL = 6, CH = 2.4, SH = 1.2;
  const rr = (a, b) => a + rand() * (b - a);
  const mk = (x, z, w, d, h, y0, t) => ({ x, z, w, d, h, y0, t, x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2, y1: y0 + h });
  const ov = (a, b, m) => a.x0 < b.x1 + m && a.x1 > b.x0 - m && a.z0 < b.z1 + m && a.z1 > b.z0 - m;
  const free = (c, list, m) => !list.some(p => ov(p, c, m));
  const gap = (a, b) => Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.z0 - b.z1, b.z0 - a.z1));
  const rects = base.slice();
  const out = [];

  function enclosed(cand) {
    const g = cand.filter(n => n.y0 === 0);
    let X0 = 1e9, X1 = -1e9, Z0 = 1e9, Z1 = -1e9;
    g.forEach(n => { X0 = Math.min(X0, n.x0); X1 = Math.max(X1, n.x1); Z0 = Math.min(Z0, n.z0); Z1 = Math.max(Z1, n.z1); });
    X0 -= 9; X1 += 9; Z0 -= 9; Z1 += 9;
    const all = rects.concat(g).filter(r => r.x1 > X0 && r.x0 < X1 && r.z1 > Z0 && r.z0 < Z1);
    const cs = 0.6, nx = Math.ceil((X1 - X0) / cs), nz = Math.ceil((Z1 - Z0) / cs);
    const blk = new Uint8Array(nx * nz);
    for (const r of all) {
      const i0 = Math.max(0, Math.floor((r.x0 - 0.4 - X0) / cs)), i1 = Math.min(nx - 1, Math.floor((r.x1 + 0.4 - X0) / cs));
      const j0 = Math.max(0, Math.floor((r.z0 - 0.4 - Z0) / cs)), j1 = Math.min(nz - 1, Math.floor((r.z1 + 0.4 - Z0) / cs));
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const cx = X0 + (i + 0.5) * cs, cz = Z0 + (j + 0.5) * cs;
        if (cx > r.x0 - 0.4 && cx < r.x1 + 0.4 && cz > r.z0 - 0.4 && cz < r.z1 + 0.4) blk[i * nz + j] = 1;
      }
    }
    const seen = new Uint8Array(nx * nz), st = [];
    const push = (i, j) => { const k = i * nz + j; if (!blk[k] && !seen[k]) { seen[k] = 1; st.push(k); } };
    for (let i = 0; i < nx; i++) { push(i, 0); push(i, nz - 1); }
    for (let j = 0; j < nz; j++) { push(0, j); push(nx - 1, j); }
    while (st.length) {
      const k = st.pop(), i = (k / nz) | 0, j = k - i * nz;
      if (i > 0) push(i - 1, j); if (i < nx - 1) push(i + 1, j); if (j > 0) push(i, j - 1); if (j < nz - 1) push(i, j + 1);
    }
    for (let k = 0; k < blk.length; k++) if (!blk[k] && !seen[k]) return true;
    return false;
  }

  function tryPile(cx, cz) {
    const parts = [];
    const o0 = rand() < 0.5;
    parts.push(mk(cx, cz, o0 ? CL : CW, o0 ? CW : CL, CH, 0, 'c'));
    const n = 2 + ((rand() * 3) | 0);
    for (let k = 1; k < n; k++) for (let t = 0; t < 12; t++) {
      const b = parts[(rand() * parts.length) | 0], o = rand() < 0.5;
      const w = o ? CL : CW, d = o ? CW : CL, gp = rand() < 0.3 ? rr(3.5, 5) : 0, side = (rand() * 4) | 0;
      let x, z;
      if (side < 2) { const sg = side ? 1 : -1; x = b.x + sg * (b.w / 2 + w / 2 + gp); z = b.z + rr(-1, 1) * ((b.d + d) / 2 - 1.2); }
      else { const sg = side === 3 ? 1 : -1; z = b.z + sg * (b.d / 2 + d / 2 + gp); x = b.x + rr(-1, 1) * ((b.w + w) / 2 - 1.2); }
      const c = mk(x, z, w, d, CH, 0, 'c');
      if (!free(c, parts, -0.01)) continue;
      parts.push(c); break;
    }
    const ground = parts.slice();
    // second tier: short container on a lower one + a step crate on the lower roof
    const ups = [], upsOf = new Map();
    for (const p of ground) {
      if (rand() > 0.6) continue;
      const lx = p.w > p.d, L = lx ? p.w : p.d, len = rr(2.0, 2.4), off = rand() < 0.5 ? 1 : -1;
      const sh = off * (L - len) / 2, cs = 2.0, csh = off * ((L - len) / 2 - len / 2 - cs / 2);
      const pair = lx ? [mk(p.x + sh, p.z, len, p.d, CH, CH, 'c'), mk(p.x + csh, p.z, cs, cs, SH, CH, 's')]
                      : [mk(p.x, p.z + sh, p.w, len, CH, CH, 'c'), mk(p.x, p.z + csh, cs, cs, SH, CH, 's')];
      upsOf.set(p, pair); pair.forEach(u => ups.push(u));
    }
    // ground-level step crates (2.0 wide x 2.2 deep x 1.2 high); never where they would land you against the tier-2 pieces
    for (const p of ground) {
      if (rand() > 0.9) continue;
      for (let t = 0; t < 10; t++) {
        const side = (rand() * 4) | 0;
        let x, z, w, d;
        if (side < 2) { const sg = side ? 1 : -1; w = 2.2; d = 2.0; x = p.x + sg * (p.w / 2 + w / 2); z = p.z + rr(-1, 1) * Math.max(0, (p.d - d) / 2); }
        else { const sg = side === 3 ? 1 : -1; w = 2.0; d = 2.2; z = p.z + sg * (p.d / 2 + d / 2); x = p.x + rr(-1, 1) * Math.max(0, (p.w - w) / 2); }
        const c = mk(x, z, w, d, SH, 0, 's');
        if (!free(c, parts, -0.01) || !free(c, rects, 0.5)) continue;
        const land = { x0: Math.max(p.x0, c.x0 - 1.2), x1: Math.min(p.x1, c.x1 + 1.2), z0: Math.max(p.z0, c.z0 - 1.2), z1: Math.min(p.z1, c.z1 + 1.2) };
        if ((upsOf.get(p) || []).some(u => ov(u, land, 0.3))) continue;
        parts.push(c); break;
      }
    }
    let nodes = parts.concat(ups);
    // keep only what can be reached from the ground with rises <= 1.3m, and anything left unsupported goes too
    for (let it = 0; it < 8; it++) {
      const reach = new Set(), q = [];
      nodes.forEach(n => { if (n.y0 === 0 && n.y1 <= 1.3) { reach.add(n); q.push(n); } });
      while (q.length) {
        const a = q.pop();
        for (const b of nodes) { if (reach.has(b) || b.y1 - a.y1 > 1.3 || gap(a, b) > 0.5) continue; reach.add(b); q.push(b); }
      }
      const keep = nodes.filter(n => reach.has(n) && (n.y0 === 0 || nodes.some(sp => sp !== n && Math.abs(sp.y1 - n.y0) < 1e-6 && ov(sp, n, -0.01))));
      if (keep.length === nodes.length) break;
      nodes = keep;
    }
    if (nodes.filter(n => n.t === 'c' && n.y0 === 0).length < 2) return null;
    const gnd = nodes.filter(n => n.y0 === 0);
    if (gnd.some(n => !free(n, rects, 1.5))) return null;
    if (enclosed(nodes)) return null;
    gnd.forEach(n => rects.push(n));
    return nodes;
  }

  for (let a = 0; a < 600 && out.length < want; a++) {
    const r = tryPile(rr(-half, half), rr(-half, half));
    if (r) out.push(r);
  }
  return out;
}

const CPAL = [0xc0392b, 0x2563eb, 0x16a34a, 0xd97706, 0x7c3aed, 0x0e7490, 0x9ca3af, 0xdb2777];

// Returns drawable specs (for the browser) and collision boxes (for everyone). Deterministic.
export function buildWorld() {
  const specs = [], ground = [];
  const add = (cx, cz, w, d, h, y0, color, edge, ribbed) => {
    specs.push({ cx, cz, w, d, h, y0, color, edge, ribbed: !!ribbed });
    ground.push({ x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2 });
  };
  add(0, -60.5, 122, 1, 16, 0, 0x1a2147, 0.15);
  add(0, 60.5, 122, 1, 16, 0, 0x1a2147, 0.15);
  add(-60.5, 0, 1, 122, 16, 0, 0x1a2147, 0.15);
  add(60.5, 0, 1, 122, 16, 0, 0x1a2147, 0.15);
  add(0, 0, 10, 10, 2, 0, 0x2b3a8f);
  add(0, 0, 4, 4, 3.2, 0, 0x3b4fd0);
  add(6.5, 0, 3, 6, 1, 0, 0x3552d9);
  add(-6.5, 0, 3, 6, 1, 0, 0x3552d9);
  add(-6.5, -20, 1, 8, 1.8, 0, 0x6b3a1c);
  add(6.5, -20, 1, 8, 1.8, 0, 0x6b3a1c);
  add(0, -20, 12, 8, 0.6, 1.2, 0xff7a29, 0.6);
  [-22, -15, -6.5, 3.5, 15].forEach(x => add(x, 20, 4, 4, 1, 0, 0x14b8a6, 0.5));
  add(14, -8, 3, 3, 1.2, 0, 0x7c3aed);
  add(-14, -10, 2.5, 2.5, 0.5, 0, 0xe11d48);
  add(-10, 10, 3, 3, 2, 0, 0x0ea5e9);
  add(22, -14, 4, 4, 2, 0, 0xf59e0b);
  add(-22, -6, 3, 3, 1, 0, 0x10b981);
  add(24, 6, 3, 3, 1, 0, 0xe11d48);
  add(10, 14, 2, 2, 0.6, 0, 0x7c3aed);
  const rand = mulberry32(WORLD_SEED);
  genPiles(rand, ground.concat([{ x0: -9, x1: 9, z0: 3, z1: 21 }]), 53, 26).forEach(pile => pile.forEach(n => {
    if (n.t === 'c') add(n.x, n.z, n.w, n.d, n.h, n.y0, CPAL[(rand() * CPAL.length) | 0], 0, true);
    else add(n.x, n.z, n.w, n.d, n.h, n.y0, 0xfacc15, 0.55);
  }));
  const boxes = [{ x0: -100, x1: 100, y0: -10, y1: 0, z0: -100, z1: 100 }];
  specs.forEach(s => boxes.push({ x0: s.cx - s.w / 2, x1: s.cx + s.w / 2, y0: s.y0, y1: s.y0 + s.h, z0: s.cz - s.d / 2, z1: s.cz + s.d / 2 }));
  return { specs, boxes };
}

/* ---------------- rays ---------------- */
export function aimDir(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
// distance along the ray to the box, or Infinity (a ray that starts inside a box misses it)
export function rayBox(ox, oy, oz, dx, dy, dz, b) {
  let tmin = -Infinity, tmax = Infinity;
  if (Math.abs(dx) < 1e-9) { if (ox < b.x0 || ox > b.x1) return Infinity; }
  else { let t1 = (b.x0 - ox) / dx, t2 = (b.x1 - ox) / dx; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; }
  if (Math.abs(dy) < 1e-9) { if (oy < b.y0 || oy > b.y1) return Infinity; }
  else { let t1 = (b.y0 - oy) / dy, t2 = (b.y1 - oy) / dy; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; }
  if (Math.abs(dz) < 1e-9) { if (oz < b.z0 || oz > b.z1) return Infinity; }
  else { let t1 = (b.z0 - oz) / dz, t2 = (b.z1 - oz) / dz; if (t1 > t2) { const t = t1; t1 = t2; t2 = t; } if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; }
  if (tmax < tmin || tmax < 0 || tmin < 0) return Infinity;
  return tmin;
}
export function rayWorld(ox, oy, oz, dx, dy, dz, maxT, boxes) {
  let best = Infinity;
  for (let i = 0; i < boxes.length; i++) { const t = rayBox(ox, oy, oz, dx, dy, dz, boxes[i]); if (t < best) best = t; }
  return best <= maxT ? best : Infinity;
}
// a player's two hit boxes: body and head
export function playerBoxes(x, y, z, h) {
  const hh = 0.5;
  return [
    { x0: x - 0.3, x1: x + 0.3, y0: y, y1: y + h - hh, z0: z - 0.3, z1: z + 0.3, head: false },
    { x0: x - 0.25, x1: x + 0.25, y0: y + h - hh, y1: y + h, z0: z - 0.25, z1: z + 0.25, head: true },
  ];
}
export const eyeOf = S => [S.x, S.y + S.h - 0.15, S.z];

/* ---------------- player simulation ---------------- */
export function newState() {
  return { x: 0, y: 0.01, z: 0, vx: 0, vy: 0, vz: 0, h: H_STAND, onGround: false, sliding: false, tg: 0, slideCool: 0,
    cur: 0, m0: WPN[0].mag, m1: WPN[1].mag, m2: WPN[2].mag, m3: WPN[3].mag, cool: 0, reloading: false, rt: 0 };
}
export function respawnState(S, sp) {
  S.x = sp[0]; S.z = sp[1]; S.y = 0.01; S.vx = S.vy = S.vz = 0; S.h = H_STAND; S.onGround = false; S.sliding = false; S.tg = 0; S.slideCool = 0;
  S.cur = 0; S.m0 = WPN[0].mag; S.m1 = WPN[1].mag; S.m2 = WPN[2].mag; S.m3 = WPN[3].mag; S.cool = 0; S.reloading = false; S.rt = 0;
}
export const SIM_KEYS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'h', 'onGround', 'sliding', 'tg', 'slideCool', 'cur', 'm0', 'm1', 'cool', 'reloading', 'rt', 'm2', 'm3'];
export function packState(S) {
  const q = v => Math.round(v * 100000) / 100000;
  return [q(S.x), q(S.y), q(S.z), q(S.vx), q(S.vy), q(S.vz), S.h, S.onGround ? 1 : 0, S.sliding ? 1 : 0, q(S.tg), q(S.slideCool), S.cur, S.m0, S.m1, q(S.cool), S.reloading ? 1 : 0, q(S.rt), S.m2, S.m3];
}
export function unpackState(a, S) {
  S = S || newState();
  S.x = a[0]; S.y = a[1]; S.z = a[2]; S.vx = a[3]; S.vy = a[4]; S.vz = a[5]; S.h = a[6]; S.onGround = !!a[7]; S.sliding = !!a[8]; S.tg = a[9]; S.slideCool = a[10];
  S.cur = a[11]; S.m0 = a[12]; S.m1 = a[13]; S.cool = a[14]; S.reloading = !!a[15]; S.rt = a[16]; S.m2 = a[17] === undefined ? WPN[2].mag : a[17]; S.m3 = a[18] === undefined ? WPN[3].mag : a[18];
  return S;
}

function hitBox(S, b) {
  return S.x + R > b.x0 && S.x - R < b.x1 && S.y + S.h > b.y0 && S.y < b.y1 && S.z + R > b.z0 && S.z - R < b.z1;
}
function anyHit(S, boxes) { for (let i = 0; i < boxes.length; i++) if (hitBox(S, boxes[i])) return true; return false; }
function headroom(S, boxes) { const h = S.h; S.h = H_STAND; const r = anyHit(S, boxes); S.h = h; return !r; }
function resolve(S, boxes, axis, d, wasG) {
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (!hitBox(S, b)) continue;
    if (axis === 1) {
      if (d <= 0) { S.y = b.y1; S.onGround = true; } else { S.y = b.y0 - S.h - 1e-3; }
      S.vy = 0;
    } else {
      if (wasG && b.y1 - S.y <= STEP && b.y1 > S.y) { // step up small ledges
        const oy = S.y; S.y = b.y1 + 1e-3;
        if (!anyHit(S, boxes)) continue;
        S.y = oy;
      }
      if (axis === 0) { S.x = d > 0 ? b.x0 - R - 1e-3 : b.x1 + R + 1e-3; S.vx = 0; }
      else { S.z = d > 0 ? b.z0 - R - 1e-3 : b.z1 + R + 1e-3; S.vz = 0; }
    }
  }
}
function accel(S, dx, dz, wishSpeed, a, dt, cap) {
  const cur = S.vx * dx + S.vz * dz;
  const add = (cap === undefined ? wishSpeed : cap) - cur;
  if (add <= 0) return;
  const k = Math.min(a * wishSpeed * dt, add);
  S.vx += k * dx; S.vz += k * dz;
}

function moveSub(S, cmd, boxes, dt, ev) {
  const P = PHYS;
  let fwd = cmd.f, rgt = cmd.r;
  const mag = Math.hypot(fwd, rgt);
  if (mag > 1) { fwd /= mag; rgt /= mag; }
  const sy = Math.sin(cmd.yaw), cy = Math.cos(cmd.yaw);
  const wx = -sy * fwd + cy * rgt, wz = -cy * fwd - sy * rgt;
  const wl = Math.hypot(wx, wz);
  const dx = wl > 1e-4 ? wx / wl : 0, dz = wl > 1e-4 ? wz / wl : 0;
  const inMag = Math.min(1, wl);
  const sprint = cmd.sp && fwd > 0.3;
  const sH = cmd.s;

  S.slideCool = Math.max(0, S.slideCool - dt);
  S.tg = S.onGround ? 0 : S.tg + dt;

  // jump (before friction, so bunny-hopping keeps speed)
  if (cmd.j && (S.onGround || S.tg < 0.1)) {
    S.vy = P.jump; S.onGround = false; S.tg = 1; S.sliding = false; ev.push('jump');
  }
  // slide start
  let hs = Math.hypot(S.vx, S.vz);
  if (sH && !S.sliding && S.onGround && S.slideCool <= 0 && hs > 5.5) {
    S.sliding = true; S.slideCool = 0.8;
    const ns = Math.min(hs + P.slideBoost, Math.max(hs, P.maxSlide));
    S.vx *= ns / hs; S.vz *= ns / hs; ev.push('slide');
  }
  if (S.onGround) {
    if (S.sliding) {
      const hs0 = Math.hypot(S.vx, S.vz);
      if (inMag > 0 && hs0 > 0.1) { // gentle steering
        S.vx += dx * 9 * dt; S.vz += dz * 9 * dt;
        const k = hs0 / Math.hypot(S.vx, S.vz); S.vx *= k; S.vz *= k;
      }
      const hs1 = Math.max(0, hs0 - P.slideDecel * dt);
      const k2 = hs0 > 0 ? hs1 / hs0 : 0; S.vx *= k2; S.vz *= k2;
      if (hs1 < 3.2 || !sH) S.sliding = false;
    } else {
      const hs0 = Math.hypot(S.vx, S.vz);
      if (hs0 > 0.01) { // ground friction
        const ns = Math.max(hs0 - Math.max(hs0, 3) * 6 * dt, 0) / hs0;
        S.vx *= ns; S.vz *= ns;
      }
      if (inMag > 0) accel(S, dx, dz, (sH ? 3.5 : (sprint ? P.sprint : P.walk)) * inMag, 10, dt);
    }
  } else {
    S.sliding = false;
    if (inMag > 0) accel(S, dx, dz, P.sprint * inMag, P.airAccel, dt, P.airCap);
  }
  hs = Math.hypot(S.vx, S.vz);
  if (hs > P.maxSpeed) { S.vx *= P.maxSpeed / hs; S.vz *= P.maxSpeed / hs; }
  S.vy = Math.max(-50, S.vy - P.gravity * dt);

  // stance
  if (sH || S.sliding) S.h = H_CROUCH; else if (S.h !== H_STAND && headroom(S, boxes)) S.h = H_STAND;

  // move + collide, one axis at a time
  const wasG = S.onGround, vy0 = S.vy; S.onGround = false;
  S.x += S.vx * dt; resolve(S, boxes, 0, S.vx, wasG);
  S.z += S.vz * dt; resolve(S, boxes, 2, S.vz, wasG);
  S.y += S.vy * dt; resolve(S, boxes, 1, vy0, wasG);
  if (S.onGround && !wasG && vy0 < -4) ev.push(['land', -vy0]);
}

function startReload(S) {
  if (S.cur === 3) return false;
  const w = WPN[S.cur];
  if (!S.reloading && getAmmo(S, S.cur) < w.mag) { S.reloading = true; S.rt = w.reload; return true; }
  return false;
}
function weaponTick(S, cmd, boxes, ev) {
  S.cool = Math.max(0, S.cool - TICK);
  if ((cmd.w === 0 || cmd.w === 1 || cmd.w === 2 || cmd.w === 3) && cmd.w !== S.cur) { S.cur = cmd.w; S.reloading = false; S.cool = Math.max(S.cool, 0.3); ev.push(['swap', S.cur]); }
  if (S.reloading) { S.rt -= TICK; if (S.rt <= 0) { S.reloading = false; setAmmo(S, S.cur, WPN[S.cur].mag); } }
  else if (cmd.rl && startReload(S)) ev.push('reload');
  if (cmd.fire && !S.reloading && S.cool <= 0 && S.cur === 3) {
    if (S.m3 > 0) { S.m3--; S.cool = WPN[3].rate; const e = eyeOf(S); ev.push(['throw', cmd.yaw, cmd.pitch, e[0], e[1], e[2], S.vx, S.vz]); }
  } else if (cmd.fire && !S.reloading && S.cool <= 0) {
    const ammo = getAmmo(S, S.cur);
    if (ammo > 0) {
      setAmmo(S, S.cur, ammo - 1);
      S.cool = WPN[S.cur].rate;
      const e = eyeOf(S), d = aimDir(cmd.yaw, cmd.pitch);
      ev.push(['fire', S.cur, cmd.yaw, cmd.pitch, e[0], e[1], e[2], Math.hypot(S.vx, S.vz), S.onGround]);
      if (S.cur === 1) { // shotgun recoil-jump: pushes you away from a close surface
        const t = rayWorld(e[0], e[1], e[2], d[0], d[1], d[2], BLAST.range, boxes);
        if (t !== Infinity) {
          const imp = BLAST.power * (1 - t / BLAST.range);
          S.vx -= d[0] * imp * 0.8; S.vz -= d[2] * imp * 0.8;
          S.vy = Math.min(16, S.vy - d[1] * imp);
          if (S.vy > 1) { S.onGround = false; S.tg = 1; }
        }
      }
      if (getAmmo(S, S.cur) <= 0) startReload(S);
    } else if (startReload(S)) ev.push('reload');
  }
}

// One 1/60 s step. cmd = { f, r (-1..1), yaw, pitch, j, s, sp, fire, rl, w }. Returns a list of events.
export function simTick(S, cmd, boxes) {
  const ev = [];
  weaponTick(S, cmd, boxes, ev);
  moveSub(S, cmd, boxes, DT, ev);
  moveSub(S, cmd, boxes, DT, ev);
  return ev;
}
