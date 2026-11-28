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

// ---------------- extra map data. Boxes are [x0, x1, y0, y1, z0, z1]; the look of the farm lives in index.html only ----------------
const FLOOR = { x0: -100, x1: 100, y0: -10, y1: 0, z0: -100, z1: 100 };
// ---------------- third map: Farm (built in-house, collision + spawns only; the look lives in index.html) ----------------
const FARM_DATA = {"boxes":[[-11.82,4.18,0,0.3,-32.6,-27.4],[-7.25,8.75,0,0.3,0.4,5.6],[-4.47,11.53,0,0.3,30.4,35.6],[-46.4,-27.6,0,8.2,-41.9,-30.1],[-26.8,-22.2,0,12.9,-44.3,-39.7],[-26.8,-22.2,0,12.9,-37.8,-33.2],[-44.4,-31.6,0,6.8,-0.9,8.9],[-26.4,-17.6,0,5.0,18.1,25.9],[-49.0,-39.0,0,7.2,-16.0,-8.0],[-16.35,-11.65,0,11.2,-54.35,-49.65],[-29.3,-26.7,0,2.9,-15.6,-12.4],[-31.6,-28.4,0,2.6,-7.6,-4.4],[-30.75,-29.25,0,1.2,-26.6,-25.4],[-32.75,-31.25,0,2.4,-24.75,-23.25],[-28.6,-27.4,0,1.2,-28.75,-27.25],[24.5,35.5,0,7.3,-40.5,-31.5],[39.5,48.5,0,7.2,-21.0,-11.0],[25.0,35.0,0,7.2,0.0,8.0],[27.65,32.35,0,11.2,43.65,48.35],[39.1,52.9,0,7.2,-48.9,-39.1],[36.0,40.0,0,11.4,-50.0,-46.0],[21.71,22.29,0,2.61,17.71,18.29],[21.71,22.29,0,2.61,24.71,25.29],[21.71,22.29,0,2.61,31.71,32.29],[21.71,22.29,0,2.61,38.71,39.29],[28.71,29.29,0,2.61,17.71,18.29],[28.71,29.29,0,2.61,24.71,25.29],[28.71,29.29,0,2.61,31.71,32.29],[28.71,29.29,0,2.61,38.71,39.29],[35.71,36.29,0,2.61,17.71,18.29],[35.71,36.29,0,2.61,24.71,25.29],[35.71,36.29,0,2.61,31.71,32.29],[35.71,36.29,0,2.61,38.71,39.29],[42.71,43.29,0,2.61,17.71,18.29],[42.71,43.29,0,2.61,24.71,25.29],[42.71,43.29,0,2.61,31.71,32.29],[42.71,43.29,0,2.61,38.71,39.29],[35.25,36.75,0,2.4,-26.75,-25.25],[37.4,38.6,0,1.2,-24.75,-23.25],[25.25,26.75,0,1.2,13.4,14.6],[22.4,25.6,0,2.9,-19.3,-16.7],[35.2,36.8,0,1.3,-12.8,-11.2],[19.2,20.8,0,1.3,-6.8,-5.2],[34.4,37.6,0,2.6,10.4,13.6],[-13.06,-10.94,0,1.67,-36.06,-33.94],[-10.9,-9.7,0,0.9,-34.85,-33.75],[12.84,15.16,0,1.82,-26.16,-23.84],[15.1,16.3,0,0.9,-24.85,-23.75],[-11.06,-8.94,0,1.67,-3.06,-0.94],[-8.9,-7.7,0,0.9,-1.85,-0.75],[10.83,13.17,0,1.84,6.83,9.17],[13.1,14.3,0,0.9,8.15,9.25],[-15.15,-12.85,0,1.81,31.85,34.15],[-12.9,-11.7,0,0.9,33.15,34.25],[15.09,16.91,0,1.44,32.09,33.91],[17.1,18.3,0,0.9,33.15,34.25],[4.83,6.43,0,1.3,-16.8,-15.2],[-13.17,-11.57,0,1.3,-16.8,-15.2],[11.57,13.17,0,1.3,15.2,16.8],[-6.43,-4.83,0,1.3,15.2,16.8],[7.64,9.24,0,1.3,-48.8,-47.2],[-10.36,-8.76,0,1.3,-48.8,-47.2],[8.76,10.36,0,1.3,47.2,48.8],[-9.24,-7.64,0,1.3,47.2,48.8],[-19.95,-17.66,0,1.8,49.22,51.51],[-17.71,-16.51,0,0.9,50.51,51.61],[-37.85,-36.35,0,2.4,-50.28,-48.78],[47.18,48.68,0,1.2,-27.07,-25.87],[28.52,30.12,0,1.3,-27.25,-25.65],[38.84,40.34,0,1.2,40.48,41.68],[-21.53,-19.93,0,1.3,2.68,4.28],[23.25,24.85,0,1.3,-50.03,-48.43],[18.57,20.07,0,2.4,-41.56,-40.06],[14.63,16.23,0,1.3,-3.67,-2.07],[-35.79,-33.8,0,1.56,19.31,21.3],[-33.69,-32.49,0,0.9,20.45,21.55],[23.44,24.94,0,1.2,-24.81,-23.61],[15.88,18.15,0,1.78,-50.47,-48.21],[18.11,19.31,0,0.9,-49.19,-48.09],[51.03,52.63,0,1.3,20.13,21.73],[10.75,12.25,0,1.2,-9.55,-8.35],[12.13,13.33,0,1.2,-48.22,-46.72],[-43.48,-41.5,0,1.56,18.3,20.28],[-41.39,-40.19,0,0.9,19.44,20.54],[-38.37,-36.87,0,2.4,-22.1,-20.6],[-28.2,-26.18,0,1.59,38.19,40.21],[-26.09,-24.89,0,0.9,39.35,40.45],[45.44,47.04,0,1.3,-8.15,-6.55],[-44.35,-42.22,0,1.67,41.72,43.85],[-42.19,-40.99,0,0.9,42.94,44.04],[-38.26,-36.66,0,1.3,12.18,13.78],[-22.66,-21.06,0,1.3,43.98,45.58],[-13.47,-11.87,0,1.3,22.36,23.96],[30.87,32.47,0,1.3,-7.73,-6.13],[-11.67,-10.07,0,1.3,-42.71,-41.11],[15.78,17.76,0,1.56,-16.75,-14.76],[17.87,19.07,0,0.9,-15.6,-14.5],[-19.13,-17.63,0,1.2,-4.56,-3.36],[37.62,39.12,0,2.4,-3.91,-2.41],[-26.18,-24.98,0,1.2,-23.9,-22.4],[11.43,13.03,0,1.3,42.01,43.61],[-33.61,-32.01,0,1.3,-15.21,-13.61],[-46.72,-44.62,0,1.65,27.99,30.1],[-44.57,-43.37,0,0.9,29.19,30.29],[46.06,47.56,0,2.4,-32.52,-31.02],[13.82,15.42,0,1.3,-33.24,-31.64],[-30.45,-28.95,0,2.4,-50.94,-49.44],[39.97,41.47,0,2.4,51.22,52.72],[-24.11,-22.51,0,1.3,-1.56,0.04],[-13.09,-11.89,0,1.2,27.25,28.75],[15.28,16.78,0,2.4,26.26,27.76],[-39.25,-37.65,0,1.3,-45.94,-44.34],[-49.21,-47.71,0,2.4,3.66,5.16],[46.12,47.32,0,1.2,10.9,12.4],[-51.51,-49.91,0,1.3,7.98,9.58],[-24.71,-23.51,0,1.2,10.27,11.77],[8.8,11.17,0,1.86,-42.41,-40.05],[11.09,12.29,0,0.9,-41.08,-39.98],[28.87,30.47,0,1.3,-14.67,-13.07],[17.75,19.25,0,2.4,10.72,12.22],[-15.02,-13.52,0,2.4,8.98,10.48],[48.4,50.33,0,1.51,3.61,5.53],[50.47,51.67,0,0.9,4.72,5.82],[-19.32,-17.82,0,2.4,-19.03,-17.53],[18.84,20.34,0,1.2,49.72,50.92],[30.11,31.71,0,1.3,-44.69,-43.09],[-52.59,-51.09,0,1.2,17.32,18.52],[-17.68,-16.48,0,1.2,-14.51,-13.01],[21.41,22.91,0,2.4,43.35,44.85],[-51.15,-49.55,0,1.3,31.39,32.99],[7.07,8.67,0,1.3,-22.02,-20.42],[-32.64,-31.04,0,1.3,30.76,32.36],[-7.54,-6.04,0,2.4,8.98,10.48],[-17.22,-15.62,0,1.3,-37.85,-36.25],[17.3,18.9,0,1.3,14.76,16.36],[-45.8,-44.3,0,2.4,-4.88,-3.38],[46.67,48.27,0,1.3,17.9,19.5],[-32.35,-30.75,0,1.3,42.37,43.97],[-9.16,-7.56,0,1.3,28.77,30.37],[-15.61,-14.01,0,1.3,39.73,41.33],[-12.85,-11.25,0,1.3,13.38,14.98],[-10.05,-8.55,0,1.2,37.85,39.05],[7.56,9.16,0,1.3,-26.6,-25.0],[-46.73,-45.23,0,2.4,-22.73,-21.23],[50.89,51.57,0,3.11,37.75,38.43],[-17.64,-16.93,0,3.23,-43.54,-42.83],[-53.99,-53.3,0,3.17,-8.05,-7.36],[24.38,25.04,0,3.04,-12.35,-11.68],[48.58,49.35,0,3.54,42.22,42.99],[16.7,17.48,0,3.57,40.94,41.72],[-19.02,-18.25,0,3.53,-27.35,-26.58],[11.07,11.74,0,3.02,-15.19,-14.53],[-23.22,-22.56,0,3.02,-53.59,-52.93],[-53.64,-52.89,0,3.46,-48.06,-47.31],[-22.5,-21.85,0,2.95,33.87,34.52],[9.41,10.13,0,3.31,-35.42,-34.7],[-45.55,-44.86,0,3.15,13.33,14.02],[-30.18,-29.39,0,3.64,52.42,53.21],[-50.83,-50.16,0,3.06,-41.16,-40.49],[-42.53,-41.74,0,3.59,53.1,53.89],[-53.27,-52.46,0,3.7,-21.49,-20.69],[-52.1,-51.41,0,3.15,-29.64,-28.95],[52.7,53.48,0,3.57,-19.42,-18.64],[50.44,51.18,0,3.35,-1.06,-0.33],[-49.05,-48.35,0,3.19,49.25,49.95],[-49.65,-48.93,0,3.29,42.32,43.04],[53.3,54.04,0,3.38,12.73,13.47],[41.62,42.39,0,3.52,46.76,47.53],[-39.93,-39.12,0,3.71,47.95,48.76],[36.02,36.8,0,3.58,46.54,47.32],[48.46,49.16,0,3.21,48.27,48.97],[41.62,42.4,0,3.56,11.49,12.27],[-39.38,-38.69,0,3.16,35.54,36.23],[-46.73,-46.07,0,3.02,37.39,38.05],[-54.2,-53.52,0,3.13,-13.94,-13.26],[51.32,52.0,0,3.07,-35.24,-34.57],[19.07,19.76,0,3.16,2.11,2.8],[53.56,54.28,0,3.32,30.97,31.7],[53.55,54.38,0,3.79,53.16,53.99],[-14.11,-13.37,0,3.42,3.73,4.48],[-35.3,-34.66,0,2.92,49.08,49.71],[-38.95,-38.24,0,3.24,25.44,26.15],[-43.1,-42.4,0,3.21,-52.44,-51.73],[53.31,53.99,0,3.07,-27.85,-27.18],[30.06,30.85,0,3.62,53.07,53.86],[-51.74,-50.97,0,3.5,-35.23,-34.46],[-46.6,-45.77,0,3.8,-46.48,-45.65],[48.9,49.59,0,3.16,27.85,28.54],[-5.03,-4.29,0,3.36,21.05,21.79],[8.86,9.54,0,3.11,-4.3,-3.62],[39.5,42.5,0,2.9,-38.15,-35.85],[-27.05,-24.95,0,3.3,-20.9,-19.1],[8.95,11.05,0,3.3,-52.9,-51.1],[-30.45,-29.55,0,1.0,-24.45,-23.55],[-28.45,-27.55,0,1.0,-23.45,-22.55],[29.55,30.45,0,1.0,11.55,12.45],[-17.5,-14.5,0,1.3,-10.95,-9.05],[24.5,27.5,0,1.3,27.05,28.95],[-27.5,-24.5,0,1.3,45.05,46.95],[-7.44,-5.76,0,1.32,40.38,42.06],[22.73,24.76,0,1.6,-29.28,-27.24],[-12.44,-10.31,0,1.68,17.54,19.67],[-48.25,-46.53,0,1.35,8.84,10.56],[43.24,45.0,0,1.38,12.28,14.05],[52.97,55.02,0,1.61,-37.03,-34.97],[-41.39,-39.68,0,1.34,-25.9,-24.2],[-44.41,-42.56,0,1.45,38.53,40.38],[-25.8,-22.2,0,3.8,-30.3,-26.7],[-23.75,-20.25,0,2.6,-18.8,-17.2],[-31.75,-28.25,0,2.6,11.2,12.8],[14.25,17.75,0,2.6,-40.8,-39.2],[-20.9,-19.1,0,9,39.1,40.9],[37.3,38.7,0,1.6,-8.8,-7.2],[49.6,54.4,0,1.1,-3.36,-2.64],[51.25,52.75,0,2.9,-30.75,-29.25],[-61,61,0,30,-61,-60],[-61,61,0,30,60,61],[-61,-60,0,30,-61,61],[60,61,0,30,-61,61]],"spawns":[[40.3,2.4],[-54.0,-53.6],[-54.3,54.0],[16.1,-53.8],[7.8,54.1],[-26.0,0.4],[54.2,48.2],[54.3,-53.7],[7.7,-15.8],[-19.8,-47.8],[-54.3,19.7],[10.0,19.9],[-25.6,33.9],[54.0,-24.0],[-43.9,-25.9],[51.9,23.8],[29.8,-24.3],[-51.8,-3.9],[-14.1,-23.7],[-13.7,52.3],[33.8,53.8],[2.3,-38.2],[-33.7,53.6],[-5.9,31.8]]};
export const MAPS = {
  yard: { boxes: buildWorld().boxes, spawns: SPAWNS },
  farm: { boxes: [FLOOR].concat(FARM_DATA.boxes.map(b => ({ x0: b[0], x1: b[1], y0: b[2], y1: b[3], z0: b[4], z1: b[5] }))), spawns: FARM_DATA.spawns },
};
export const mapOfRoom = r => /^(farm-|pf-)/.test(r) ? 'farm' : 'yard';

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
