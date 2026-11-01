// Study 01 — the human heart as a mechanism.
//
// One degree of freedom: position in the cardiac cycle. A Wiggers-style set of
// pressure/volume traces is the whole state; everything visible derives from it.
// Ventricular volume drives a warp field over the myocardium (radial squeeze,
// base-to-apex shortening, apical twist). Atrial contraction squeezes the atria.
// The four valves have no motor at all: each opens when the pressure behind it
// overtakes the pressure in front, which is exactly how the model drives them.
import * as THREE from 'three';
import {
  applyWarp, capMaterial, clamp01, curve, deformable, fbm, ghostMaterial, lerp, loft, paint,
  periodicCurve, pulse, ramp, remap, roughen, sheet, smoothMax, solid, tag, tissue, tube,
} from './toolkit';
import { arrow, font } from './draw';
import type { Anchor, Ink, Rig, Study } from './types';

const deg = (d: number) => (d * Math.PI) / 180;
const gauss = (x: number, s: number) => Math.exp(-(x * x) / (s * s));
const angDiff = (a: number, b: number) => {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/* ── geometry constants (heart-local frame: +Y runs apex → base) ─────── */

const YB = 0.5;     // valve plane
const YA = -2.0;    // epicardial apex
const YC = -1.62;   // left-ventricular cavity apex
const YR = -1.2;    // right-ventricular cavity apex
const LCX = 0.32, LCZ = -0.08; // left-ventricular long axis
const TH1 = deg(52), TH2 = deg(228); // angular extent of the right ventricle

const MITRAL = new THREE.Vector3(0.46, YB + 0.02, -0.2);
const TRICUSPID = new THREE.Vector3(-0.59, YB + 0.02, 0.08);
const AORTIC = new THREE.Vector3(0.095, YB + 0.03, 0.19);
const PULMONIC = new THREE.Vector3(0.25, 1.05, 0.75);

/** Left-ventricular endocardium: a bullet, widened toward the aortic outflow. */
function lvCav(theta: number, y: number) {
  const u = clamp01((y - YC) / (YB - YC));
  let r = 0.5 * Math.sqrt(Math.max(0, 1 - Math.pow(1 - u, 2.2))) * (1 - 0.1 * ramp(u, 0.75, 1));
  r += 0.12 * ramp(y, -0.4, YB) * gauss(angDiff(theta, deg(128)), deg(40));
  return r;
}

/** Right-ventricular cavity depth: a crescent wrapped round the septum. */
function rvDepth(theta: number, y: number) {
  if (y <= YR) return 0;
  const s = (((theta - TH1) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (TH2 - TH1);
  if (s <= 0 || s >= 1) return 0;
  const w = clamp01((y - YR) / (YB - YR));
  return 0.64 * Math.pow(Math.max(0, 1 - (1 - w) ** 2), 0.55) * Math.pow(Math.sin(Math.PI * s), 0.7);
}

function outerR(theta: number, y: number) {
  const v = clamp01((y - YA) / (YB - YA));
  const lv = 0.9 * Math.pow(Math.max(0, 1 - (1 - v) ** 3), 0.46);
  const d = rvDepth(theta, y);
  // The right-ventricular bulge rises out of the left-ventricular cone; where
  // it emerges the union leaves a crease — the interventricular sulcus.
  // Where there is no right ventricle the bulge term sinks below the cone, so
  // the apex closes on the left ventricle alone.
  let r = smoothMax(lv, lvCav(theta, y) + 0.32 + d - 0.35 * (1 - ramp(d, 0, 0.12)), 0.1);
  const sulcus = gauss(angDiff(theta, TH1 + 0.06), 0.11) + gauss(angDiff(theta, TH2 - 0.06), 0.11);
  r -= 0.04 * sulcus * ramp(v, 0.15, 0.4);
  return Math.max(r, 0);
}

/** Linings and lumens: x-ray drops them so only outer silhouettes ghost. */
const inner = <T extends THREE.Object3D>(o: T) => { o.traverse(c => { c.userData.inner = true; }); return o; };

const polar = (theta: number, r: number, y: number, out = new THREE.Vector3()) =>
  out.set(LCX + r * Math.cos(theta), y, LCZ + r * Math.sin(theta));

/* ── haemodynamics: the single degree of freedom ─────────────────────── */

const REST = [0, 0.14, 0.2, 0.5, 0.6, 0.78, 1];
const EXERCISE = [0, 0.12, 0.16, 0.58, 0.66, 0.92, 1];
const PHASE_NAMES = ['Atrial kick', 'Isovolumetric contraction', 'Ejection', 'Isovolumetric relaxation', 'Rapid filling', 'Diastasis'];
const PHASE_SHORT = ['ATRIAL KICK', 'VALVES SHUT', 'EJECTION', 'RELAXATION', 'RAPID FILLING', 'DIASTASIS'];

const volume = periodicCurve([[0, 108], [0.14, 120], [0.2, 120], [0.3, 86], [0.4, 62], [0.5, 50], [0.6, 50], [0.68, 80], [0.78, 97], [0.92, 105]]);
const lvPressure = periodicCurve([[0, 6], [0.07, 9], [0.14, 11], [0.17, 45], [0.2, 80], [0.27, 112], [0.33, 121], [0.42, 113], [0.5, 98], [0.55, 40], [0.6, 6], [0.66, 3], [0.8, 5], [0.93, 6]]);
const aoPressure = periodicCurve([[0, 85], [0.14, 80], [0.2, 79.5], [0.27, 111], [0.33, 120], [0.42, 112], [0.5, 100], [0.515, 94], [0.54, 98], [0.7, 91], [0.86, 86]]);
const laPressure = periodicCurve([[0, 8], [0.07, 12], [0.14, 7], [0.2, 4], [0.45, 11], [0.58, 15], [0.66, 6], [0.85, 7]]);

export function hemo(t: number, seq: string) {
  const ex = seq === 'exercise';
  const tau = ex ? remap(t, EXERCISE, REST) : t - Math.floor(t);
  const scaleP = (p: number) => (ex && p > 80 ? 80 + (p - 80) * 2 : p);
  const v = volume(tau);
  const V = ex ? 40 + (v - 50) * (90 / 70) : v;
  const mitral = tau < 0.35 ? 1 - ramp(tau, 0.124, 0.14) : ramp(tau, 0.6, 0.622);
  const tricuspid = tau < 0.35 ? 1 - ramp(tau, 0.128, 0.145) : ramp(tau, 0.596, 0.616);
  const aortic = ramp(tau, 0.2, 0.218) * (1 - ramp(tau, 0.482, 0.5));
  const pulmonary = ramp(tau, 0.196, 0.214) * (1 - ramp(tau, 0.488, 0.506));
  let phase = 0;
  for (let i = 0; i < 6; i++) if (tau >= REST[i]) phase = i;
  const ecg =
    0.12 * gauss(tau - 0.07, 0.025) - 0.1 * gauss(tau - 0.133, 0.006) + 1.0 * gauss(tau - 0.148, 0.008)
    - 0.24 * gauss(tau - 0.162, 0.008) + 0.28 * gauss(tau - 0.42, 0.045);
  return {
    tau, phase, V, ecg,
    P: scaleP(lvPressure(tau)), Pao: scaleP(aoPressure(tau)), Pla: laPressure(tau),
    c: clamp01((120 - v) / 70) * (ex ? 1.12 : 1),
    atrial: pulse(tau, 0.015, 0.15),
    mitral, tricuspid, aortic, pulmonary,
  };
}

/* ── valves ───────────────────────────────────────────────────────────── */

type ValveSpec = {
  origin: THREE.Vector3; up: THREE.Vector3; ref: THREE.Vector3;
  R: number; aspect: number; commissures: number[]; kind: 'av' | 'sl';
  meet?: (i: number, u: number) => [number, number];
};

class Valve {
  A = new THREE.Vector3(); B = new THREE.Vector3(); U = new THREE.Vector3();
  origin = new THREE.Vector3();
  leaflets: { mesh: THREE.Mesh; update: (f: (u: number, v: number, o: THREE.Vector3) => void) => void }[] = [];
  ring: THREE.Mesh;
  open = 0;
  constructor(public spec: ValveSpec, material: THREE.Material, ringMaterial: THREE.MeshPhysicalMaterial) {
    this.U.copy(spec.up).normalize();
    this.A.copy(spec.ref).addScaledVector(this.U, -spec.ref.dot(this.U)).normalize();
    this.B.crossVectors(this.U, this.A);
    this.origin.copy(spec.origin);
    for (let i = 0; i < spec.commissures.length; i++) {
      const s = sheet((u, v, o) => this.point(i, u, v, 0, o), 18, 9);
      const mesh = new THREE.Mesh(s.geometry, material);
      mesh.frustumCulled = false;
      this.leaflets.push({ mesh, update: s.update });
    }
    const ringCurve = new THREE.CatmullRomCurve3(Array.from({ length: 48 }, (_, k) => {
      const psi = (k / 48) * Math.PI * 2;
      return this.local(spec.R * Math.cos(psi), spec.R * spec.aspect * Math.sin(psi), this.hinge(psi), new THREE.Vector3());
    }), true);
    this.ring = new THREE.Mesh(new THREE.TubeGeometry(ringCurve, 96, 0.036, 10, true), ringMaterial);
  }
  private local(a: number, b: number, h: number, out: THREE.Vector3) {
    return out.copy(this.origin).addScaledVector(this.A, a).addScaledVector(this.B, b).addScaledVector(this.U, h);
  }
  /** Semilunar cusps hang from a crown: the hinge rises at each commissure. */
  private hinge(psi: number) {
    if (this.spec.kind === 'av') return 0;
    const n = this.spec.commissures.length, c = this.spec.commissures;
    let best = Infinity;
    for (let i = 0; i < n; i++) best = Math.min(best, Math.abs(angDiff(psi, c[i])));
    return 0.38 * this.spec.R * (1 - Math.sin(Math.min(1, best / (Math.PI / n)) * Math.PI / 2));
  }
  private corner(i: number): [number, number] {
    const psi = this.spec.commissures[i % this.spec.commissures.length];
    return [this.spec.R * Math.cos(psi), this.spec.R * this.spec.aspect * Math.sin(psi)];
  }
  point(i: number, u: number, v: number, open: number, out: THREE.Vector3) {
    const { commissures: c, R, aspect, kind } = this.spec;
    const n = c.length;
    let p0 = c[i], p1 = c[(i + 1) % n];
    while (p1 <= p0) p1 += Math.PI * 2;
    const psi = lerp(p0, p1, u);
    const ha = R * Math.cos(psi), hb = R * aspect * Math.sin(psi), hh = this.hinge(psi);
    let qa: number, qb: number;
    if (this.spec.meet) [qa, qb] = this.spec.meet(i, u);
    else {
      const c0 = this.corner(i), c1 = this.corner(i + 1);
      if (u < 0.5) { qa = lerp(c0[0], 0, u * 2); qb = lerp(c0[1], 0, u * 2); }
      else { qa = lerp(0, c1[0], u * 2 - 1); qb = lerp(0, c1[1], u * 2 - 1); }
    }
    const L = Math.hypot(qa - ha, qb - hb);
    const belly = Math.sin(Math.PI * v) * Math.pow(Math.sin(Math.PI * u), 0.8);
    let ca: number, cb: number, ch: number, oa: number, ob: number, oh: number;
    if (kind === 'av') {
      // Closed: the leaflets meet along the coaptation line and billow up toward
      // the atrium. Open: they hang into the ventricle like a funnel.
      ca = lerp(ha, qa, v); cb = lerp(hb, qb, v);
      ch = -0.06 * v + 0.05 * belly;
      oa = ha + (qa - ha) * 0.22 * v; ob = hb + (qb - hb) * 0.22 * v;
      oh = -L * 1.02 * v * (1 - 0.1 * v);
    } else {
      // Closed: three pockets sag toward the ventricle and meet at the centre.
      // Open: pressed back against the wall of the root.
      const top = 0.3 * R;
      ca = lerp(ha, qa, v); cb = lerp(hb, qb, v);
      ch = lerp(hh, top, v) - 0.3 * R * belly;
      oa = ha + (qa - ha) * 0.1 * v; ob = hb + (qb - hb) * 0.1 * v;
      oh = hh + Math.max(L, 0.4 * R) * 0.95 * v;
    }
    const e = open * open * (3 - 2 * open);
    return this.local(lerp(ca, oa, e), lerp(cb, ob, e), lerp(ch, oh, e), out);
  }
  set(open: number, drop: number) {
    this.open = open;
    this.origin.copy(this.spec.origin);
    this.origin.y += drop;
    this.ring.position.set(0, drop, 0);
    for (let i = 0; i < this.leaflets.length; i++) this.leaflets[i].update((u, v, o) => this.point(i, u, v, open, o));
  }
}

/* ── coronary tree ────────────────────────────────────────────────────── */

/**
 * Grow the fine coronary branches as a texture in the epicardium's own UV
 * space (u = angle round the long axis, v = loft level). Trunks are 3D tubes;
 * the twigs that make a real heart look veined are painted here, with a
 * matching bump map so they stand slightly proud of the muscle.
 */
function coronaryTree(levels: number, body: number, sh: number) {
  if (typeof document === 'undefined') return null;
  const W = 2048, H = 1024;
  const map = document.createElement('canvas'), bump = document.createElement('canvas');
  map.width = bump.width = W; map.height = bump.height = H;
  const m = map.getContext('2d')!, b = bump.getContext('2d')!;
  m.fillStyle = '#ffffff'; m.fillRect(0, 0, W, H);
  b.fillStyle = '#000000'; b.fillRect(0, 0, W, H);
  const random = (() => { let a = 1234567; return () => ((a = (a * 1103515245 + 12345) >>> 0) / 4294967296); })();
  // (theta, y) → canvas pixel, inverting the loft's level spacing.
  // Angles are NOT wrapped per point: a branch crossing the seam would draw a
  // line across the whole canvas. `stroke` draws each branch at ±W instead.
  const toPx = (th: number, y: number): [number, number] => {
    const t = th / (Math.PI * 2);
    let l: number;
    if (y <= YB) l = body * Math.pow(clamp01((y - YA) / (YB - YA)), 1 / 1.5);
    else l = body + ((levels - body) * Math.asin(clamp01((y - YB) / sh))) / (Math.PI / 2);
    return [t * W, (1 - l / levels) * H];
  };
  // Muscle grain: faint oblique strokes, mostly in the bump.
  for (let i = 0; i < 900; i++) {
    const x = random() * W, y = random() * H, len = 30 + random() * 70, a = -0.7 + random() * 0.3;
    b.strokeStyle = `rgba(255,255,255,${0.03 + random() * 0.04})`; b.lineWidth = 2 + random() * 3;
    b.beginPath(); b.moveTo(x, y); b.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); b.stroke();
  }
  const stroke = (pts: [number, number][], w: number) => {
    if (pts.length < 2) return;
    const shift = -Math.floor(pts[0][0] / (Math.PI * 2)) * W;
    for (const dx of [shift - W, shift, shift + W]) {
      for (const [ctx, color, k] of [[m, `rgba(${52 + 26 * random()},10,${18 + 10 * random()},0.86)`, 1.7], [b, 'rgba(255,255,255,0.7)', 2.4]] as const) {
        ctx.strokeStyle = color; ctx.lineWidth = Math.max(0.8, w * k); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        pts.forEach(([th, y], i) => { const [x, py] = toPx(th, y); if (i === 0) ctx.moveTo(x + dx, py); else ctx.lineTo(x + dx, py); });
        ctx.stroke();
      }
    }
  };
  // Recursive branching walk on the surface: arc steps converted to angle by
  // the local radius; each branch bends, tapers and spawns smaller ones.
  const grow = (th: number, y: number, dir: number, width: number, depth: number) => {
    const pts: [number, number][] = [[th, y]];
    const steps = 6 + Math.floor(random() * 8) + depth * 5;
    for (let i = 0; i < steps; i++) {
      const r = Math.max(0.25, outerR(th, Math.min(y, YB)));
      // Wander, but keep heading down toward the apex as real branches do.
      dir += (random() - 0.5) * 0.45 + (-Math.PI / 2 - dir) * 0.06;
      const ds = 0.04 + 0.025 * random();
      th += (ds * Math.cos(dir)) / r; y += ds * Math.sin(dir);
      if (y < YA + 0.15 || y > YB + sh * 0.6) break;
      pts.push([th, y]);
      if (depth > 0 && i > 1 && random() < 0.16) grow(th, y, dir + (random() < 0.5 ? -1 : 1) * (0.45 + random() * 0.5), width * 0.62, depth - 1);
    }
    // Taper: draw the branch in three overlapping spans of falling width.
    const n = pts.length;
    for (let k = 0; k < 3; k++) stroke(pts.slice(Math.floor((k * n) / 3), Math.min(n, Math.floor(((k + 1) * n) / 3) + 1)), width * (1 - k * 0.25));
  };
  const trunks: [number, number, number, number][] = [];
  for (let k = 0; k < 9; k++) { const y = lerp(YB - 0.25, YA + 0.5, k / 8); trunks.push([TH1 + 0.06, y, -Math.PI / 2 + (k % 2 ? 0.85 : -0.85), 4.5]); }
  for (let k = 0; k < 6; k++) trunks.push([TH1 - 0.2 - (k / 5) * deg(140), YB - 0.14, -Math.PI / 2 + (random() - 0.5) * 0.5, 4.2]);
  for (let k = 0; k < 6; k++) trunks.push([deg(125) + (k / 5) * (TH2 - deg(130)), YB - 0.14, -Math.PI / 2 + (random() - 0.5) * 0.5, 4.2]);
  for (let k = 0; k < 5; k++) { const y = lerp(YB - 0.25, YA + 0.7, k / 4); trunks.push([TH2 - 0.06, y, -Math.PI / 2 + (k % 2 ? 0.8 : -0.8), 3.6]); }
  for (const [th, y, dir, w] of trunks) grow(th, y, dir, w, 2);
  const tex = (c: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { map: tex(map, true), bump: tex(bump, false) };
}

/* ── build ────────────────────────────────────────────────────────────── */

function buildHeart(): Rig {
  const root = new THREE.Group();
  const heart = new THREE.Group();
  heart.rotation.set(-0.3, -0.35, 0.4, 'YXZ');
  heart.position.set(0, 0.1, 0);
  root.add(heart);

  const ventricles = new THREE.Group(), atria = new THREE.Group(), arteries = new THREE.Group(), plane = new THREE.Group();
  heart.add(ventricles, atria, arteries, plane);

  const myo = tissue('#ffffff', { vertexColors: true, roughness: 0.52, clearcoat: 0.7, clearcoatRoughness: 0.32, sheen: 0.25, sheenColor: new THREE.Color('#c0473f'), envMapIntensity: 0.75 });
  const endo = tissue('#c66d66', { roughness: 0.48, clearcoat: 0.8, clearcoatRoughness: 0.22 });
  const atrialWall = tissue('#ffffff', { vertexColors: true, roughness: 0.52, clearcoat: 0.6 });
  const cut = capMaterial('#7f2725');
  const cutPale = capMaterial('#b98f7e');
  const artery = tissue('#a32b27', { roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.36, sheen: 0.25, sheenColor: new THREE.Color('#c85048'), envMapIntensity: 0.8 });
  const lumen = tissue('#7c2221', { roughness: 0.4, clearcoat: 0.8 });
  const vein = tissue('#962f31', { roughness: 0.4, clearcoat: 0.8, sheen: 0.25 });
  const veinLumen = tissue('#6e2224', { roughness: 0.4 });
  const coronaryMat = tissue('#8a2321', { roughness: 0.4, clearcoat: 0.7, clearcoatRoughness: 0.3, sheenColor: new THREE.Color('#a8403a') });
  const cardiacVein = tissue('#9c98b2', { roughness: 0.42, clearcoat: 0.9, clearcoatRoughness: 0.25, sheen: 0.2, sheenColor: new THREE.Color('#e8e4f2') });
  const leafletMat = new THREE.MeshPhysicalMaterial({
    color: '#f2e4cc', roughness: 0.45, sheen: 0.8, sheenColor: new THREE.Color('#fff3e0'), sheenRoughness: 0.4,
    clearcoat: 0.6, clearcoatRoughness: 0.3, side: THREE.DoubleSide, transmission: 0.12, thickness: 0.05,
  });
  const ringMat = new THREE.MeshPhysicalMaterial({ color: '#ead8b6', roughness: 0.6, sheen: 0.5, emissive: '#000000' });
  const fibrous = new THREE.MeshPhysicalMaterial({ color: '#e7d2ab', roughness: 0.7, sheen: 0.5, sheenColor: new THREE.Color('#fff2d8'), clearcoat: 0.3 });
  const chordMat = new THREE.MeshStandardMaterial({ color: '#f6eedd', roughness: 0.5 });
  const papMat = tissue('#a84640', { roughness: 0.5 });

  const myoA = new THREE.Color('#541113'), myoB = new THREE.Color('#982a26'), fat = new THREE.Color('#d9a77c'), fatB = new THREE.Color('#c08263');

  /* ventricular myocardium: outer surface */
  // Above the valve plane the wall rolls inward in a rounded shoulder, so the
  // fibrous skeleton stays inside; the atrioventricular groove fat closes it.
  const SH = 0.2, BODY = 84, LEVELS = 98;
  const shoulder = (th: number, s: number) => outerR(th, YB) - SH + SH * Math.sqrt(Math.max(0, 1 - s * s));
  const outerGeo = loft((v, out) => {
    const l = v * LEVELS;
    if (l <= BODY) {
      const y = lerp(YA, YB, 0.0004 + 0.9996 * Math.pow(l / BODY, 1.5));
      out.forEach((p, i) => { const th = (i / out.length) * Math.PI * 2; polar(th, outerR(th, y), y, p); });
    } else {
      const s = Math.sin(((l - BODY) / (LEVELS - BODY)) * Math.PI / 2);
      const y = YB + SH * s;
      out.forEach((p, i) => { const th = (i / out.length) * Math.PI * 2; polar(th, shoulder(th, s), y, p); });
    }
  }, { levels: LEVELS, segments: 128, capStart: true });
  roughen(outerGeo, 0.007, 2.6, 4);
  const myoPaint = (p: THREE.Vector3, c: THREE.Color) => {
    const th = Math.atan2(p.z - LCZ, p.x - LCX);
    const n = fbm(p.x * 3, p.y * 3, p.z * 3, 3, 9);
    // Broad light/dark modelling, then darker in the sulci where vessels run.
    const groove = Math.max(gauss(angDiff(th, TH1 + 0.06), 0.1), gauss(angDiff(th, TH2 - 0.06), 0.1));
    c.copy(myoA).lerp(myoB, clamp01(0.62 + 0.55 * fbm(p.x * 2.2, p.y * 2.2, p.z * 2.2, 3, 3) + 0.15 * n));
    c.lerp(myoA, 0.35 * groove + 0.25 * ramp(p.y, YB - 0.2, YB + 0.1));
  };
  paint(outerGeo, myoPaint);
  const tree = coronaryTree(LEVELS, BODY, SH);
  if (tree) { myo.map = tree.map; myo.bumpMap = tree.bump; myo.bumpScale = 1.1; }
  const outer = solid(outerGeo, myo, cut);
  tag(outer, 'ventricles');
  ventricles.add(outer);

  /* left-ventricular cavity: trabeculated endocardium */
  const lvGeo = loft((v, out) => {
    const y = lerp(YC, YB - 0.01, 0.01 + 0.99 * v);
    out.forEach((p, i) => { const th = (i / out.length) * Math.PI * 2; polar(th, lvCav(th, y), y, p); });
  }, { levels: 56, segments: 96, capStart: true, inward: true });
  roughen(lvGeo, 0.018, 7, 21);
  const lv = inner(solid(lvGeo, endo, cut));
  tag(lv, 'lv');
  ventricles.add(lv);

  /* right-ventricular cavity: crescent */
  const N = 44;
  const rvGeo = loft((v, out) => {
    const y = lerp(YR, YB - 0.01, 0.01 + 0.99 * v);
    for (let i = 0; i < N; i++) {
      const s = 0.02 + 0.96 * (i / (N - 1));
      const th = TH1 + s * (TH2 - TH1);
      const rin = lvCav(th, y) + 0.22;
      polar(th, rin + rvDepth(th, y), y, out[i]);
      const s2 = 0.02 + 0.96 * (1 - i / (N - 1));
      const th2 = TH1 + s2 * (TH2 - TH1);
      polar(th2, lvCav(th2, y) + 0.22 + 0.002, y, out[N + i]);
    }
  }, { levels: 44, segments: N * 2, capStart: true, inward: true });
  roughen(rvGeo, 0.014, 7, 22);
  const rv = inner(solid(rvGeo, endo, cut));
  tag(rv, 'rv');
  ventricles.add(rv);

  /* papillary muscles, rising from the cavity walls toward the valves */
  const papTips: THREE.Vector3[] = [];
  const papillary = new THREE.Group();
  const addPap = (theta: number, rBase: (y: number) => number, yBase: number, tip: THREE.Vector3, width: number) => {
    const base = polar(theta, rBase(yBase) * 1.02, yBase);
    const mid = base.clone().lerp(tip, 0.55);
    mid.x += (LCX - mid.x) * 0.08; mid.z += (LCZ - mid.z) * 0.08;
    const g = tube(new THREE.CatmullRomCurve3([base, mid, tip]), t => width * Math.sqrt(Math.max(0, 1 - Math.pow(t, 4))) * (1 - 0.35 * t), 24, 12);
    roughen(g, 0.008, 9, 31 + papTips.length);
    const m = deformable(new THREE.Mesh(g, papMat));
    papillary.add(m);
    papTips.push(tip.clone());
  };

  /* valves */
  const toAortic = AORTIC.clone().sub(MITRAL).setY(0).normalize();
  const mitral = new Valve({
    origin: MITRAL, up: new THREE.Vector3(0, 1, 0), ref: toAortic, R: 0.28, aspect: 0.86, kind: 'av',
    commissures: [deg(-62), deg(62)],
    // The coaptation line is a smile bowed toward the posterior annulus: the
    // anterior leaflet is tall and narrow, the posterior short and wide.
    meet: (i, u) => {
      const s = i === 0 ? u : 1 - u;
      const R = 0.28, ca = R * Math.cos(deg(62)), cb = R * 0.86 * Math.sin(deg(62));
      return [ca - 0.95 * R * Math.sin(Math.PI * s), lerp(-cb, cb, s)];
    },
  }, leafletMat, ringMat.clone());
  const tricuspid = new Valve({
    origin: TRICUSPID, up: new THREE.Vector3(0, 1, 0), ref: new THREE.Vector3(1, 0, 0.25), R: 0.27, aspect: 0.9, kind: 'av',
    commissures: [deg(-40), deg(85), deg(205)],
  }, leafletMat, ringMat.clone());

  const aortaPts: [number, number, number][] = [
    [AORTIC.x, YB - 0.02, AORTIC.z], [0.05, 0.9, 0.3], [-0.1, 1.42, 0.22], [-0.04, 1.86, -0.05], [0.24, 2.02, -0.42],
    [0.6, 1.8, -0.95], [0.74, 1.2, -1.28], [0.75, 0.3, -1.34], [0.75, -0.3, -1.33],
  ];
  const aortaCurve = curve(aortaPts);
  const aorticUp = aortaCurve.getTangentAt(0.01);
  const aortic = new Valve({
    origin: AORTIC, up: aorticUp, ref: new THREE.Vector3(1, 0, 0), R: 0.185, aspect: 1, kind: 'sl',
    commissures: [deg(90), deg(210), deg(330)],
  }, leafletMat, ringMat.clone());
  const trunkPts: [number, number, number][] = [[0.22, 0.95, 0.78], [0.25, 1.05, 0.75], [0.33, 1.4, 0.62], [0.42, 1.68, 0.32], [0.46, 1.76, 0.08]];
  const trunkCurve = curve(trunkPts);
  const pulmonic = new Valve({
    origin: PULMONIC, up: trunkCurve.getTangentAt(0.2), ref: new THREE.Vector3(1, 0, 0), R: 0.18, aspect: 1, kind: 'sl',
    commissures: [deg(30), deg(150), deg(270)],
  }, leafletMat, ringMat.clone());

  const valves = { mitral, tricuspid, aortic, pulmonic };
  for (const [id, v] of Object.entries(valves)) {
    const g = new THREE.Group();
    v.leaflets.forEach(l => g.add(l.mesh));
    g.add(v.ring);
    tag(g, id === 'pulmonic' ? 'pulmonary-valve' : id === 'aortic' ? 'aortic-valve' : id, 'mechanism');
    plane.add(g);
  }

  // Papillary muscles sit beneath the commissures, so each muscle's chordae
  // fan out to the two leaflets that meet above it.
  const commissurePoint = (v: Valve, i: number) => v.point(i, 0.001, 0, 1, new THREE.Vector3());
  for (const i of [0, 1]) {
    const c = commissurePoint(mitral, i);
    const th = Math.atan2(c.z - LCZ, c.x - LCX);
    const tip = c.clone().lerp(new THREE.Vector3(LCX, c.y, LCZ), 0.12); tip.y = -0.22;
    addPap(th, y => lvCav(th, y), -0.98, tip, 0.11);
  }
  for (let i = 0; i < 3; i++) {
    const c = commissurePoint(tricuspid, i);
    const th = Math.atan2(c.z - LCZ, c.x - LCX);
    const tip = c.clone(); tip.y = -0.08;
    const tipR = Math.hypot(tip.x - LCX, tip.z - LCZ);
    const yb = -0.62;
    const rIn = lvCav(th, yb) + 0.22, rOut = rIn + rvDepth(th, yb);
    // Keep the tip inside the crescent at its own level.
    const want = lerp(rIn, rOut, 0.55);
    const scale = want / Math.max(tipR, 1e-3);
    tip.x = LCX + (tip.x - LCX) * lerp(1, scale, 0.6); tip.z = LCZ + (tip.z - LCZ) * lerp(1, scale, 0.6);
    addPap(th, y => lvCav(th, y) + 0.22 + rvDepth(th, y) * 0.96, yb, tip, 0.075);
  }
  tag(papillary, 'papillary', 'mechanism');
  ventricles.add(papillary);

  type Chord = { tip: number; valve: Valve; leaflet: number; u: number; v: number };
  const chords: Chord[] = [];
  for (const u of [0.1, 0.22, 0.34, 0.46]) {
    chords.push({ tip: 0, valve: mitral, leaflet: 0, u, v: 1 }, { tip: 1, valve: mitral, leaflet: 0, u: 1 - u, v: 1 });
    chords.push({ tip: 1, valve: mitral, leaflet: 1, u, v: 1 }, { tip: 0, valve: mitral, leaflet: 1, u: 1 - u, v: 1 });
  }
  for (const u of [0.25, 0.75]) chords.push({ tip: 0, valve: mitral, leaflet: 0, u: u * 0.6, v: 0.7 }, { tip: 1, valve: mitral, leaflet: 0, u: 1 - u * 0.6, v: 0.7 });
  for (let i = 0; i < 3; i++) for (const u of [0.12, 0.28, 0.42]) {
    chords.push({ tip: 2 + i, valve: tricuspid, leaflet: i, u, v: 1 });
    chords.push({ tip: 2 + ((i + 1) % 3), valve: tricuspid, leaflet: i, u: 1 - u, v: 1 });
  }
  const chordGeo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);
  const chordae = new THREE.InstancedMesh(chordGeo, chordMat, chords.length);
  chordae.frustumCulled = false;
  tag(chordae, 'papillary', 'mechanism');
  heart.add(chordae);

  /* fibrous skeleton: the valve plane, cut from the ventricular outline */
  const outline = new THREE.Shape();
  const ringN = 128;
  for (let i = 0; i <= ringN; i++) {
    const th = (i / ringN) * Math.PI * 2;
    const p = polar(th, outerR(th, YB) * 0.955, YB);
    if (i === 0) outline.moveTo(p.x, -p.z); else outline.lineTo(p.x, -p.z);
  }
  const hole = (cx: number, cz: number, rx: number, rz: number, rot = 0) => {
    const h = new THREE.Path();
    for (let i = 0; i <= 48; i++) {
      const a = -(i / 48) * Math.PI * 2;
      const x = rx * Math.cos(a), z = rz * Math.sin(a);
      const px = cx + x * Math.cos(rot) - z * Math.sin(rot), pz = cz + x * Math.sin(rot) + z * Math.cos(rot);
      if (i === 0) h.moveTo(px, -pz); else h.lineTo(px, -pz);
    }
    outline.holes.push(h);
  };
  const mRot = Math.atan2(toAortic.z, toAortic.x);
  hole(MITRAL.x, MITRAL.z, 0.28, 0.28 * 0.86, mRot);
  hole(TRICUSPID.x, TRICUSPID.z, 0.27, 0.27 * 0.9, Math.atan2(0.25, 1));
  hole(AORTIC.x, AORTIC.z, 0.2, 0.2);
  hole(0.149, 0.89, 0.22, 0.22);
  const plateGeo = new THREE.ExtrudeGeometry(outline, { depth: 0.07, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2, curveSegments: 4 });
  plateGeo.rotateX(-Math.PI / 2);
  plateGeo.translate(0, YB - 0.03, 0);
  const baseMuscle = tissue('#7a2826', { roughness: 0.6, clearcoat: 0.5 });
  const plateMesh = solid(plateGeo, baseMuscle, cut);
  plateMesh.children[0].userData.zone = 'upper';
  tag(plateMesh, 'ventricles');
  ventricles.add(plateMesh);

  // Fibrous trigones knit the mitral, aortic and tricuspid rings together.
  const trigone = (a: THREE.Vector3, b: THREE.Vector3, w: number) => {
    const g = tube(new THREE.CatmullRomCurve3([a, a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, 0.025, 0)), b]), t => w * (0.6 + 0.4 * Math.sin(Math.PI * t)), 16, 10);
    const m = deformable(new THREE.Mesh(roughen(g, 0.006, 8, 101), fibrous));
    m.userData.zone = 'upper';
    return m;
  };
  const skeleton = new THREE.Group();
  const at = (v: THREE.Vector3, toward: THREE.Vector3, r: number) => v.clone().add(toward.clone().sub(v).setY(0).normalize().multiplyScalar(r)).setY(YB + 0.03);
  skeleton.add(trigone(at(AORTIC, MITRAL, 0.19), at(MITRAL, AORTIC, 0.25), 0.05));
  skeleton.add(trigone(at(AORTIC, TRICUSPID, 0.19), at(TRICUSPID, AORTIC, 0.26), 0.055));
  skeleton.add(trigone(at(MITRAL, TRICUSPID, 0.24), at(TRICUSPID, MITRAL, 0.26), 0.045));
  tag(skeleton, 'skeleton');
  plane.add(skeleton);

  /* conus arteriosus — the right-ventricular outflow — carrying the pulmonary valve */
  const conusCurve = curve([[0.12, YB - 0.3, 0.86], [0.16, 0.66, 0.86], [0.22, 0.95, 0.79], [0.25, 1.06, 0.75]]);
  const conus = new THREE.Group();
  // Painted like the ventricle it grows from, so the flare blends into the wall.
  const conusWall = tissue('#ffffff', { vertexColors: true, roughness: 0.52, clearcoat: 0.7, clearcoatRoughness: 0.32, sheen: 0.25, sheenColor: new THREE.Color('#c0473f'), envMapIntensity: 0.75 });
  conus.add(solid(paint(roughen(tube(conusCurve, t => 0.23 + 0.3 * Math.pow(1 - t, 2.2), 24, 32), 0.008, 3, 41), myoPaint), conusWall, cut));
  conus.add(inner(solid(tube(conusCurve, t => 0.2 - 0.03 * t, 24, 28, true), endo, cut)));
  tag(conus, 'rv');
  ventricles.add(conus);

  /* atria: lofted from the annulus up to a dome, with wall and lumen */
  type AtriumSpec = { ann: THREE.Vector3; r: number; aspect: number; rot: number; body: THREE.Vector3; rx: number; rz: number; top: number; seed: number };
  const atriumRing = (s: AtriumSpec, inset: number) => (v: number, out: THREE.Vector3[]) => {
    const vv = 0.985 * v;
    const y = lerp(YB + 0.02, s.top, vv);
    const e = ramp(vv, 0, 0.6);
    const cx = lerp(s.ann.x, s.body.x, e), cz = lerp(s.ann.z, s.body.z, e);
    const grow = Math.sin(Math.min(1, vv / 0.5) * Math.PI / 2);
    const dome = vv > 0.5 ? Math.sqrt(Math.max(0, 1 - ((vv - 0.5) / 0.5) ** 2)) : 1;
    for (let i = 0; i < out.length; i++) {
      const phi = (i / out.length) * Math.PI * 2;
      const ar = s.r * Math.cos(phi), br = s.r * s.aspect * Math.sin(phi);
      const annx = ar * Math.cos(s.rot) - br * Math.sin(s.rot), annz = ar * Math.sin(s.rot) + br * Math.cos(s.rot);
      const bodyx = s.rx * Math.cos(phi), bodyz = s.rz * Math.sin(phi);
      const n = 1 + 0.09 * fbm(Math.cos(phi) * 1.4, y * 1.8, Math.sin(phi) * 1.4, 3, s.seed) * ramp(vv, 0.05, 0.3);
      const x = lerp(annx, bodyx, grow) * dome * n, z = lerp(annz, bodyz, grow) * dome * n;
      const len = Math.hypot(x, z) || 1;
      const k = Math.max(0, len - inset) / len;
      out[i].set(cx + x * k, y, cz + z * k);
    }
  };
  // Auricles read pale and thin-walled against the ventricles: beige-pink
  // flushing to red where they meet the groove.
  const atrialColors = (base: string, seed: number) => (p: THREE.Vector3, c: THREE.Color) => {
    c.set(base).lerp(new THREE.Color('#a8463f'), clamp01(0.25 + 0.6 * fbm(p.x * 3, p.y * 3, p.z * 3, 3, seed)));
    c.lerp(myoA, 0.6 * ramp(p.y, YB + 0.35, YB + 0.05));
  };
  const makeAtrium = (id: string, s: AtriumSpec, color: string) => {
    const g = new THREE.Group();
    const og = paint(roughen(loft(atriumRing(s, 0), { levels: 40, segments: 80, capEnd: true }), 0.018, 3.5, s.seed), atrialColors(color, s.seed));
    const ig = loft(atriumRing(s, 0.055), { levels: 40, segments: 80, capEnd: true, inward: true });
    g.add(solid(og, atrialWall, cut), inner(solid(ig, endo, cut)));
    const center = new THREE.Vector3(s.body.x, lerp(YB, s.top, 0.45), s.body.z);
    g.traverse(o => { if (o.userData.rest) o.userData.squeeze = center; });
    tag(g, id);
    return g;
  };
  const ra = makeAtrium('ra', { ann: TRICUSPID, r: 0.29, aspect: 0.9, rot: Math.atan2(0.25, 1), body: new THREE.Vector3(-0.9, 0, -0.05), rx: 0.62, rz: 0.56, top: 1.58, seed: 51 }, '#d8a088');
  const la = makeAtrium('la', { ann: MITRAL, r: 0.3, aspect: 0.86, rot: mRot, body: new THREE.Vector3(0.38, 0, -0.66), rx: 0.64, rz: 0.46, top: 1.4, seed: 61 }, '#bd7f68');
  atria.add(ra, la);

  const capGeo = loft((v, out) => {
    for (let i = 0; i < out.length; i++) {
      const th = (i / out.length) * Math.PI * 2;
      const k = 1 - v;
      const r = shoulder(th, 1) * k;
      polar(th, r, YB + SH + 0.1 * Math.sin(v * Math.PI / 2) + 0.02 * fbm(Math.cos(th) * 2, v * 3, Math.sin(th) * 2, 2, 91), out[i]);
    }
  }, { levels: 14, segments: 128 });
  paint(capGeo, (p, c) => {
    const n = fbm(p.x * 5, p.y * 5, p.z * 5, 3, 93);
    c.copy(myoA).lerp(myoB, clamp01(0.35 + 0.6 * n));
  });
  const groove = solid(capGeo, atrialWall, cutPale);
  groove.children[0].userData.zone = 'upper';
  tag(groove, 'groove');
  atria.add(groove);

  /* auricles: crinkled appendages curling round the great arteries */
  const auricle = (pts: [number, number, number][], w: number, seed: number, id: string, center: THREE.Vector3, color: string, flat: [number, number, number]) => {
    const g = tube(curve(pts), t => w * Math.pow(Math.max(0, 1 - t), 0.55) * (0.6 + 0.4 * Math.sin(Math.PI * Math.min(1, t * 1.5))), 48, 20);
    g.computeBoundingBox();
    const mid = g.boundingBox!.getCenter(new THREE.Vector3());
    g.translate(-mid.x, -mid.y, -mid.z); g.scale(...flat); g.translate(mid.x, mid.y, mid.z);
    roughen(g, 0.012, 5, seed);
    paint(g, atrialColors(color, seed));
    const m = deformable(new THREE.Mesh(g, atrialWall));
    m.userData.squeeze = center;
    tag(m, id);
    atria.add(m);
  };
  auricle([[0.7, 1.08, -0.4], [0.98, 1.1, -0.1], [0.96, 1.02, 0.24], [0.74, 0.92, 0.46]], 0.2, 71, 'la', new THREE.Vector3(0.36, 0.95, -0.62), '#c18468', [1, 1.15, 0.8]);
  auricle([[-0.82, 1.42, 0.12], [-0.7, 1.22, 0.46], [-0.42, 1.02, 0.62], [-0.08, 0.9, 0.62]], 0.36, 72, 'ra', new THREE.Vector3(-0.8, 0.95, -0.02), '#cf8f74', [1.08, 1.25, 0.46]);

  /* coronary circulation on the epicardium, in the fat of the grooves */
  const surface = (th: number, y: number, lift: number) => polar(th, outerR(th, y) + lift, y);
  const coronary = new THREE.Group();
  const vessel = (path: [number, number][], r0: number, r1: number, mat: THREE.Material, lift = 0.012) => {
    const pts = path.map(([th, y]) => surface(th, y, lift + r0 * 0.6));
    const g = tube(new THREE.CatmullRomCurve3(pts), t => lerp(r0, r1, t), Math.max(24, path.length * 10), 8);
    coronary.add(deformable(new THREE.Mesh(g, mat)));
  };
  const lad: [number, number][] = [];
  for (let k = 0; k <= 12; k++) { const y = lerp(YB - 0.12, YA + 0.12, k / 12); lad.push([TH1 + 0.06 + 0.05 * Math.sin(k * 1.3) - 0.25 * ramp(k, 10, 12), y]); }
  vessel(lad, 0.03, 0.011, coronaryMat);
  vessel(lad.map(([th, y]) => [th + 0.065, y] as [number, number]).slice(0, 11), 0.026, 0.01, cardiacVein);
  vessel([[TH1 + 0.04, -0.15], [TH1 - 0.25, -0.55], [TH1 - 0.5, -1.0], [TH1 - 0.62, -1.3]], 0.022, 0.01, coronaryMat);
  vessel([[TH1 + 0.04, -0.75], [TH1 - 0.3, -1.1], [TH1 - 0.45, -1.45]], 0.018, 0.009, coronaryMat);
  const cx: [number, number][] = [];
  for (let k = 0; k <= 10; k++) cx.push([TH1 + 0.02 - (k / 10) * deg(150), YB - 0.13 - 0.03 * Math.sin(k)]);
  vessel(cx, 0.03, 0.017, coronaryMat);
  vessel([[deg(-20), YB - 0.15], [deg(-28), -0.4], [deg(-35), -0.9], [deg(-38), -1.3]], 0.02, 0.009, coronaryMat);
  const rca: [number, number][] = [];
  for (let k = 0; k <= 10; k++) rca.push([deg(118) + (k / 10) * (TH2 - deg(118) - 0.06), YB - 0.13]);
  for (let k = 1; k <= 7; k++) rca.push([TH2 - 0.06 - 0.03 * Math.sin(k), lerp(YB - 0.13, YA + 0.5, k / 7)]);
  vessel(rca, 0.032, 0.013, coronaryMat);
  vessel([[deg(185), YB - 0.15], [deg(188), -0.4], [deg(192), -0.85], [deg(196), -1.15]], 0.02, 0.009, coronaryMat);
  // Left main: from the left aortic sinus behind the pulmonary trunk to the groove.
  const lm = tube(new THREE.CatmullRomCurve3([AORTIC.clone().add(new THREE.Vector3(0.14, 0.04, -0.02)), surface(TH1 + 0.25, YB - 0.04, 0.03), surface(TH1 + 0.06, YB - 0.12, 0.03)]), 0.036, 16, 8);
  coronary.add(deformable(new THREE.Mesh(lm, coronaryMat)));
  tag(coronary, 'coronary');
  ventricles.add(coronary);

  /* great arteries — hollow, so the section shows wall and lumen */
  const hollow = (c: THREE.Curve<THREE.Vector3>, r: (t: number) => number, outerMat: THREE.Material, innerMat: THREE.Material, deform: boolean, segs = 64) => {
    const g = new THREE.Group();
    g.add(solid(tube(c, r, segs, 28), outerMat, cut, deform));
    g.add(inner(solid(tube(c, t => r(t) * 0.86, segs, 28, true), innerMat, cut, deform)));
    return g;
  };
  const sinus = (t: number) => 1 + 0.2 * Math.sin(Math.PI * clamp01(t / 0.07));
  // The ascending aorta and arch carry the faint circumferential ridging of
  // their elastic lamellae.
  const ridges = (t: number) => 1 + 0.07 * ramp(t, 0.07, 0.12) * (1 - ramp(t, 0.55, 0.65)) * Math.pow(Math.abs(Math.cos(t * Math.PI * 46)), 3);
  const aorta = hollow(aortaCurve, t => (0.19 - 0.035 * ramp(t, 0.3, 0.7)) * sinus(t) * ridges(t), artery, lumen, true, 300);
  const branch = (pts: [number, number, number][], r: number, fork: [number, number, number][] = []) => {
    const g = hollow(curve(pts), t => r * (1 - 0.12 * t), artery, lumen, false, 24);
    const end = new THREE.Vector3(...pts[pts.length - 1]), prev = new THREE.Vector3(...pts[pts.length - 2]);
    const start = end.clone().lerp(prev, 0.08);
    for (const f of fork) {
      const tip = end.clone().add(new THREE.Vector3(...f));
      g.add(hollow(new THREE.CatmullRomCurve3([start, end.clone().lerp(tip, 0.45).add(end.clone().sub(prev).normalize().multiplyScalar(0.04)), tip]), t => r * 0.72 * (1 - 0.15 * t), artery, lumen, false, 16));
    }
    return g;
  };
  aorta.add(branch([[-0.04, 1.84, -0.04], [-0.2, 2.22, 0.0], [-0.32, 2.52, 0.02]], 0.088, [[-0.26, 0.2, 0.02], [0.02, 0.3, 0.02]]));
  aorta.add(branch([[0.12, 1.98, -0.24], [0.15, 2.38, -0.26], [0.16, 2.76, -0.24]], 0.06));
  aorta.add(branch([[0.34, 1.98, -0.55], [0.5, 2.3, -0.62], [0.6, 2.52, -0.64]], 0.066, [[0.26, 0.12, -0.02], [0.04, 0.26, 0.0]]));
  aorta.traverse(o => { if (o.userData.rest) o.userData.zone = 'upper'; });
  tag(aorta, 'aorta');
  arteries.add(aorta);

  const pulm = new THREE.Group();
  pulm.add(hollow(trunkCurve, t => 0.215 - 0.01 * t, artery, lumen, true, 40));
  pulm.add(hollow(curve([[0.44, 1.75, 0.1], [0.8, 1.73, -0.14], [1.18, 1.6, -0.36]]), t => 0.145 - 0.02 * t, artery, lumen, false, 30));
  pulm.add(hollow(curve([[0.42, 1.74, 0.06], [0.04, 1.63, -0.22], [-0.56, 1.56, -0.36], [-1.0, 1.5, -0.38]]), t => 0.135 - 0.02 * t, artery, lumen, false, 40));
  // Ligamentum arteriosum: the closed fetal shunt, tying the trunk to the arch.
  pulm.add(new THREE.Mesh(tube(curve([[0.5, 1.8, 0.0], [0.42, 1.9, -0.25], [0.36, 1.95, -0.42]]), 0.022, 12, 6), fibrous));
  tag(pulm, 'pulmonary');
  arteries.add(pulm);

  const veins = new THREE.Group();
  const svc = hollow(curve([[-0.66, 1.2, 0.0], [-0.64, 1.75, 0.02], [-0.62, 2.35, 0.03]]), () => 0.15, vein, veinLumen, true, 24);
  const ivc = hollow(curve([[-0.82, -0.4, -0.88], [-0.82, 0.42, -0.6], [-0.82, 0.82, -0.28]]), () => 0.16, vein, veinLumen, true, 24);
  ivc.traverse(o => { if (o.userData.rest) o.userData.zone = 'upper'; });
  veins.add(svc, ivc);
  for (const [a, b] of [
    [[0.72, 1.06, -0.72], [1.36, 1.24, -0.78]], [[0.74, 0.84, -0.76], [1.36, 0.78, -0.88]],
    [[0.02, 1.04, -0.8], [-0.56, 1.14, -0.98]], [[0.02, 0.84, -0.82], [-0.56, 0.74, -1.02]],
  ] as [number, number, number][][]) {
    const mid: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 - 0.05];
    veins.add(hollow(curve([a, mid, b]), () => 0.1, vein, veinLumen, true, 16));
  }
  veins.traverse(o => { if (o.userData.rest && !o.userData.zone) o.userData.zone = 'upper'; });
  tag(veins, 'veins');
  atria.add(veins);

  // Mesh roles: inside surfaces (cavities, lumens) carry the cut colour too.
  heart.traverse(o => { if ((o as THREE.Mesh).isMesh && o.userData.role === 'cap') o.castShadow = false; });

  /* thorax: the fuselage this mechanism is mounted in */
  const context = buildThorax();

  // Vessels well above the valve plane never move; skip them in the warp.
  heart.traverse(o => {
    const rest = o.userData.rest as Float32Array | undefined;
    if (!rest || o.userData.squeeze) return;
    let minY = Infinity;
    for (let i = 1; i < rest.length; i += 3) minY = Math.min(minY, rest[i]);
    if (minY > YB + 0.9) delete o.userData.rest;
  });

  /* single degree of freedom → every moving part */
  let c = 0, atrial = 0, drop = 0;
  const upperFactor = (y: number) => 1 - ramp(y, YB, YB + 0.9);
  const warp = (p: THREE.Vector3, out: THREE.Vector3, mesh: THREE.Mesh) => {
    if (p.y > YB || mesh.userData.zone === 'upper') {
      out.set(p.x, p.y + drop * upperFactor(p.y), p.z);
    } else {
      const rx = p.x - LCX, rz = p.z - LCZ;
      const r = Math.hypot(rx, rz), th = Math.atan2(rz, rx);
      const nearBase = ramp(p.y, YB - 0.6, YB);
      const k = c * lerp(0.16, 0.04, clamp01((r - 0.3) / 0.7)) * (1 - 0.75 * nearBase);
      const r2 = Math.max(0, r - k * ramp(r, 0, 0.25));
      const hv = (p.y - YA) / (YB - YA);
      const th2 = th + c * 0.11 * (1 - hv);
      out.set(LCX + r2 * Math.cos(th2), YA + (p.y - YA) * (1 - 0.09 * c), LCZ + r2 * Math.sin(th2));
    }
    const sq = mesh.userData.squeeze as THREE.Vector3 | undefined;
    if (sq && atrial > 0) {
      const w = ramp(p.y, YB + 0.02, YB + 0.3) * 0.085 * atrial;
      const cy = sq.y + drop * upperFactor(sq.y);
      out.x += (sq.x - out.x) * w; out.y += (cy - out.y) * w; out.z += (sq.z - out.z) * w;
    }
  };

  const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), dir = new THREE.Vector3(), mid = new THREE.Vector3(), sc = new THREE.Vector3();
  const tipNow = papTips.map(() => new THREE.Vector3());
  const ringColor = new THREE.Color('#e0662b');

  const set = (t: number, seq: string) => {
    const s = hemo(t, seq);
    c = Math.min(1.15, s.c); atrial = s.atrial;
    drop = -0.09 * c * (YB - YA);
    applyWarp(heart, warp);
    const dummy = new THREE.Mesh();
    papTips.forEach((tip, i) => { warp(tip, tipNow[i], dummy); tipNow[i].add(ventricles.position); });
    mitral.set(s.mitral, drop);
    tricuspid.set(s.tricuspid, drop);
    aortic.set(s.aortic, drop);
    pulmonic.set(s.pulmonary, drop * upperFactor(PULMONIC.y));
    for (const v of [mitral, tricuspid, aortic, pulmonic]) {
      // The studio may swap in its own copy (or a ghost) — light the base copy.
      const m = (v.ring.userData.base ?? v.ring.material) as THREE.MeshPhysicalMaterial;
      if (m.emissive) { m.emissive.copy(ringColor); m.emissiveIntensity = 0.9 * v.open; }
    }
    chords.forEach((ch, i) => {
      a.copy(tipNow[ch.tip]);
      ch.valve.point(ch.leaflet, ch.u, ch.v, ch.valve.open, b).add(plane.position);
      dir.subVectors(b, a);
      const len = dir.length();
      mid.addVectors(a, b).multiplyScalar(0.5);
      q.setFromUnitVectors(yAxis, dir.divideScalar(len || 1));
      matrix.compose(mid, q, sc.set(0.0075, len, 0.0075));
      chordae.setMatrixAt(i, matrix);
    });
    chordae.instanceMatrix.needsUpdate = true;
  };
  set(0, 'rest');

  /* labels */
  const anchors: Anchor[] = [
    { label: 'Aorta', object: arteries, at: [0.12, 2.04, -0.32], side: [-1, -0.6] },
    { label: 'Pulmonary trunk', object: arteries, at: [0.36, 1.45, 0.66], side: [1, -0.7] },
    { label: 'Superior vena cava', object: atria, at: [-0.63, 2.0, 0.05], side: [-1, -0.4] },
    { label: 'Right atrium', object: atria, at: [-1.1, 0.95, 0.12], side: [-1, 0.1] },
    { label: 'Left auricle', object: atria, at: [0.98, 1.1, 0.05], side: [1, -0.2] },
    { label: 'Right ventricle', object: ventricles, at: [-0.5, -0.2, 0.95], side: [-1, 0.6] },
    { label: 'Left ventricle', object: ventricles, at: [1.0, -0.9, 0.05], side: [1, 0.5] },
    { label: 'Anterior descending a.', object: ventricles, at: [0.62, -0.7, 0.62], side: [1, 0.15] },
    { label: 'Mitral valve', object: plane, at: [MITRAL.x, YB - 0.1, MITRAL.z], side: [1, -0.3], inside: true },
    { label: 'Tricuspid valve', object: plane, at: [TRICUSPID.x, YB - 0.1, TRICUSPID.z], side: [-1, -0.3], inside: true },
    { label: 'Aortic valve', object: plane, at: [AORTIC.x, YB + 0.1, AORTIC.z], side: [-1, -0.8], inside: true },
    { label: 'Chordae tendineae', object: ventricles, at: [0.45, -0.05, -0.1], side: [1, 0.4], inside: true },
    { label: 'Papillary muscle', object: ventricles, at: [0.35, -0.6, -0.25], side: [1, 1.7], inside: true },
    { label: 'Interventricular septum', object: ventricles, at: [-0.2, -0.6, 0.35], side: [-1, 0.7], inside: true },
  ];

  // Four-chamber plane: contains the long axis and both atrioventricular valves.
  const across = MITRAL.clone().sub(TRICUSPID).setY(0).normalize();
  const n = new THREE.Vector3().crossVectors(across, new THREE.Vector3(0, 1, 0)).negate().normalize();
  const sectionLocal = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(0.46, 0, -0.14));
  heart.updateMatrix();
  const section = sectionLocal.clone().applyMatrix4(heart.matrix);

  return {
    root, context,
    explode: [
      { object: arteries, offset: new THREE.Vector3(0, 2.0, 0.2) },
      { object: atria, offset: new THREE.Vector3(0, 1.1, -0.25) },
      { object: plane, offset: new THREE.Vector3(0, 0.3, 0) },
      { object: ventricles, offset: new THREE.Vector3(0, -0.75, 0) },
    ],
    anchors, section, set,
    groups: { atria, arteries, ventricles, plane },
    viewDirs: {
      'four-chamber': section.normal.clone().negate().add(new THREE.Vector3(0, 0.25, 0)).normalize(),
      'valve-plane': new THREE.Vector3(0, 1, 0).applyQuaternion(heart.quaternion).add(new THREE.Vector3(0, 0, -0.3)).normalize(),
    },
  };
}

/** Ghosted thorax: ribs, sternum, spine, diaphragm, lungs. */
function buildThorax() {
  const g = new THREE.Group();
  const ghost = ghostMaterial('#2a2724', 0.6);
  ghost.userData.ghost = true;
  const faint = ghostMaterial('#2a2724', 0.32);
  faint.userData.ghost = true;
  const mid = -0.35;
  for (let k = 0; k < 10; k++) {
    const y = 2.9 - k * 0.6;
    const w = 0.55 + 0.45 * Math.sin(Math.min(1, (k + 1) / 7) * Math.PI / 2);
    const fall = 0.55 + 0.05 * k;
    for (const side of [-1, 1]) {
      const pts: [number, number, number][] = [
        [mid + side * 0.3, y, -2.1], [mid + side * 1.5 * w, y - 0.1, -2.15], [mid + side * 2.8 * w, y - fall * 0.6, -0.8],
        [mid + side * 2.4 * w, y - fall, 0.75], [mid + side * (k < 7 ? 0.5 : 1.2), y - fall * (k < 7 ? 1.05 : 1.6), k < 7 ? 1.58 : 1.2],
      ];
      g.add(new THREE.Mesh(tube(curve(pts), 0.055, 40, 8), ghost));
    }
  }
  const sternum = tube(curve([[mid, 2.55, 1.6], [mid, 0.8, 1.72], [mid, -0.95, 1.7]]), t => 0.2 - 0.06 * t, 20, 14);
  sternum.scale(1.5, 1, 0.45);
  g.add(new THREE.Mesh(sternum, ghost));
  for (let y = 3.0; y > -3.1; y -= 0.56) {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.36, 24), faint);
    body.position.set(mid, y, -2.42);
    g.add(body);
  }
  const dia = sheet((u, v, o) => {
    const a = u * Math.PI * 2, r = v * 2.75;
    const x = mid + r * Math.cos(a), z = -0.3 + r * 0.85 * Math.sin(a);
    o.set(x, -2.05 - 0.55 * v * v + 0.32 * gauss(x - (mid + 1.3), 1.1) + 0.42 * gauss(x - (mid - 1.3), 1.1) - 0.3 * v ** 4, z);
  }, 48, 16);
  g.add(new THREE.Mesh(dia.geometry, faint));
  for (const [x, rx, seed] of [[mid - 1.75, 1.0, 81], [mid + 1.9, 0.95, 82]]) {
    const lung = new THREE.IcosahedronGeometry(1, 14);
    const p = lung.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
      const k = 1 + 0.06 * fbm(vx * 2, vy * 2, vz * 2, 3, seed);
      const taper = 0.65 + 0.35 * (1 - (vy + 1) / 2);
      p.setXYZ(i, vx * rx * k * taper, vy * 2.05 * k, vz * 1.3 * k);
    }
    lung.computeVertexNormals();
    const m = new THREE.Mesh(lung, faint);
    m.position.set(x, 0.55, -0.5);
    g.add(m);
  }
  tag(g, 'thorax', 'context');
  return g;
}

/* ── panels ───────────────────────────────────────────────────────────── */

function schematic(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, seq: string, ink: Ink) {
  const s = hemo(t, seq);
  const k = Math.min(w / 300, h / 160);
  ctx.save();
  ctx.translate((w - 300 * k) / 2, (h - 160 * k) / 2);
  ctx.scale(k, k);
  ctx.lineWidth = 1.1; ctx.strokeStyle = ink.ink; ctx.fillStyle = ink.paper;
  const inset = Math.min(1, s.c) * 13;
  const squeeze = s.atrial * 4;
  // atrium
  ctx.beginPath(); ctx.roundRect(24 + squeeze, 14 + squeeze, 96 - squeeze * 2, 44 - squeeze, 9); ctx.fill(); ctx.stroke();
  // ventricle
  ctx.beginPath();
  ctx.moveTo(30, 58);
  ctx.bezierCurveTo(30 + inset, 100, 60 + inset, 146 - inset * 0.4, 112, 148 - inset * 0.8);
  ctx.bezierCurveTo(164 - inset, 146 - inset * 0.4, 196 - inset, 100, 196, 58);
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(94, 58); ctx.lineTo(152, 58); ctx.stroke();
  // aorta
  ctx.beginPath(); ctx.moveTo(152, 58); ctx.lineTo(152, 30); ctx.quadraticCurveTo(152, 18, 166, 18); ctx.lineTo(286, 18);
  ctx.moveTo(196, 58); ctx.lineTo(196, 50); ctx.quadraticCurveTo(196, 42, 206, 42); ctx.lineTo(286, 42); ctx.stroke();
  // valves: accent while open
  const leaf = (x: number, y: number, len: number, closedAngle: number, openAngle: number, o: number) => {
    const e = o * o * (3 - 2 * o);
    const ang = lerp(closedAngle, openAngle, e);
    ctx.strokeStyle = o > 0.5 ? ink.accent : ink.ink; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len * Math.cos(ang), y + len * Math.sin(ang)); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();
  };
  leaf(36, 58, 26, deg(8), deg(78), s.mitral);
  leaf(94, 58, 22, deg(172), deg(102), s.mitral);
  leaf(152, 58, 21, deg(-6), deg(-82), s.aortic);
  leaf(196, 58, 21, deg(186), deg(262), s.aortic);
  // flow
  ctx.lineWidth = 1.2; ctx.strokeStyle = ink.accent; ctx.fillStyle = ink.accent;
  if (s.mitral > 0.6) arrow(ctx, 66, 30, 66, 96);
  if (s.aortic > 0.6) { arrow(ctx, 174, 120, 174, 36); arrow(ctx, 230, 30, 278, 30); }
  // labels
  font(ctx, 7.2, 500); ctx.fillStyle = ink.faint;
  ctx.fillText('ATRIUM', 30, 10);
  ctx.fillText('MITRAL', 40, 76 + (s.mitral > 0.5 ? 18 : 0));
  ctx.fillText('VENTRICLE', 84, 124);
  ctx.fillText('AORTIC', 204, 70);
  ctx.fillText('AORTA', 248, 12);
  font(ctx, 7.2, 600); ctx.fillStyle = ink.soft;
  ctx.fillText(`LV ${Math.round(s.P)}`, 220, 108);
  ctx.fillText(`AO ${Math.round(s.Pao)}`, 220, 120);
  ctx.fillText(`LA ${Math.round(s.Pla)}`, 220, 132);
  ctx.fillStyle = ink.faint; font(ctx, 6.5, 500); ctx.fillText('MMHG', 220, 144);
  ctx.restore();
}

/** Pressure–volume loop: the cycle drawn as a single closed path. */
function plot(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, seq: string, ink: Ink) {
  const x = (V: number) => 14 + ((V - 30) / 115) * (w - 28);
  const y = (P: number) => h - 14 - (P / 175) * (h - 22);
  ctx.strokeStyle = ink.ink; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(10, h - 14); ctx.lineTo(w - 10, h - 14); ctx.stroke();
  ctx.setLineDash([3, 3]); ctx.strokeStyle = ink.accent; ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let i = 0; i <= 240; i++) {
    const s = hemo(i / 240, seq);
    if (i === 0) ctx.moveTo(x(s.V), y(s.P)); else ctx.lineTo(x(s.V), y(s.P));
  }
  ctx.stroke(); ctx.setLineDash([]);
  const s = hemo(t, seq), s2 = hemo(t + 0.004, seq);
  const px = x(s.V), py = y(s.P);
  let ang = Math.atan2(y(s2.P) - py, x(s2.V) - px);
  if (Math.hypot(y(s2.P) - py, x(s2.V) - px) < 0.05) ang = -Math.PI / 2;
  ctx.fillStyle = ink.accent;
  ctx.save(); ctx.translate(px, py); ctx.rotate(ang);
  ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-6, -5); ctx.lineTo(-3, 0); ctx.lineTo(-6, 5); ctx.closePath(); ctx.fill();
  ctx.restore();
  font(ctx, 7, 500); ctx.fillStyle = ink.faint;
  ctx.fillText('PRESSURE', 12, 10);
  ctx.textAlign = 'right'; ctx.fillText('VOLUME →', w - 12, h - 3); ctx.textAlign = 'left';
}

function ecgStrip(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, seq: string, ink: Ink) {
  ctx.strokeStyle = ink.soft; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 160; i++) {
    const s = hemo(i / 160, seq);
    const yy = h * 0.68 - s.ecg * h * 0.55;
    if (i === 0) ctx.moveTo(0, yy); else ctx.lineTo((i / 160) * w, yy);
  }
  ctx.stroke();
  const s = hemo(t, seq);
  const cx = (t - Math.floor(t)) * w;
  ctx.fillStyle = ink.accent;
  ctx.beginPath(); ctx.arc(cx, h * 0.68 - s.ecg * h * 0.55, 2.6, 0, Math.PI * 2); ctx.fill();
}

/* ── the study ────────────────────────────────────────────────────────── */

export const heartStudy: Study = {
  id: 'heart',
  code: '01',
  mark: 'HRT',
  eyebrow: 'Cardiovascular',
  title: 'Human heart',
  short: 'Heart',
  subtitle: 'Cardiac cycle / valve mechanism',
  tagline: 'Four chambers · two pumps in series',
  figure: '72',
  figureUnit: seq => (seq === 'exercise' ? '150' : '72'),
  motto: ['Fill', 'Squeeze', 'Eject'],
  stateTitle: 'Cycle state',
  dynamicsTitle: 'Haemodynamics',
  operationTitle: 'Cardiac cycle',
  overview: {
    heading: 'Valves and chambers',
    text: 'Four valves and no motor to open any of them. A valve swings only when the pressure behind it overtakes the pressure in front. The muscle squeezes; the valves obey.',
    stats: [['4', 'Valves'], ['2', 'Pumps'], ['70 mL', 'Stroke']],
  },
  sequenceTitle: 'Sequence',
  sequences: [{ id: 'rest', label: 'Rest' }, { id: 'exercise', label: 'Exercise' }],
  views: [
    { id: 'hero', label: 'Hero', dir: [0.62, 0.28, 1] },
    { id: 'anterior', label: 'Anterior', dir: [0.02, 0.06, 1] },
    { id: 'four-chamber', label: '4-Chamber', dir: [0, 0, 1] },
    { id: 'valve-plane', label: 'Valve plane', dir: [0, 1, 0.3], zoom: 1.05, hide: ['atria', 'arteries'], focus: 'plane', note: 'Atria and great arteries removed\nAnterior at top' },
    { id: 'posterior', label: 'Posterior', dir: [-0.2, 0.12, -1] },
  ],
  contextLabel: 'Thorax',
  footer: ['Mechanism study', 'Driven by one number: ventricular volume'],
  caption: 'Left heart drives the loop.\nRight heart shown (typical).',
  readouts: [
    { label: 'LV pressure', unit: 'mmHg', max: 175 },
    { label: 'LV volume', unit: 'mL', max: 140 },
    { label: 'Aortic', unit: 'mmHg', max: 175 },
  ],
  parts: [
    { id: 'ventricles', name: 'Ventricular myocardium', role: 'The working muscle. It thickens as it shortens, twisting apex against base to wring blood out.' },
    { id: 'lv', name: 'Left ventricle', role: 'The high-pressure pump: ~120 mmHg into the aorta, about 70 mL per beat at rest.' },
    { id: 'rv', name: 'Right ventricle', role: 'A thin-walled bellows wrapped round the septum, pushing the same volume into the lungs at a fifth of the pressure.' },
    { id: 'la', name: 'Left atrium', role: 'Receives blood from the lungs and tops up the ventricle with a final atrial kick.' },
    { id: 'ra', name: 'Right atrium', role: 'Collects venous return from both venae cavae.' },
    { id: 'mitral', name: 'Mitral valve', role: 'Two leaflets, tethered by chordae so that ventricular pressure seals rather than inverts them.' },
    { id: 'tricuspid', name: 'Tricuspid valve', role: 'Three leaflets guarding the right ventricular inflow.' },
    { id: 'aortic-valve', name: 'Aortic valve', role: 'Three semilunar cusps. They open when LV pressure exceeds aortic pressure and slap shut on the reversal.' },
    { id: 'pulmonary-valve', name: 'Pulmonary valve', role: 'The semilunar valve at the top of the right ventricular outflow.' },
    { id: 'papillary', name: 'Papillary muscles & chordae', role: 'They contract with the ventricle to keep the leaflet edges from blowing back into the atrium. They never pull a valve open.' },
    { id: 'skeleton', name: 'Fibrous skeleton', role: 'The rigid plane that holds three valve rings and insulates atria from ventricles electrically.' },
    { id: 'coronary', name: 'Coronary arteries', role: 'The heart’s own supply, running in fat along the grooves between chambers.' },
    { id: 'aorta', name: 'Aorta', role: 'Its elastic wall stores part of each stroke and releases it in diastole.' },
    { id: 'pulmonary', name: 'Pulmonary trunk', role: 'Carries the right heart’s output to both lungs.' },
    { id: 'veins', name: 'Great veins', role: 'Venae cavae into the right atrium; four pulmonary veins into the left.' },
    { id: 'groove', name: 'Atrioventricular groove', role: 'The fat-filled sulcus between atria and ventricles, carrying the right coronary artery and circumflex branch.' },
    { id: 'thorax', name: 'Thorax', role: 'Context only.' },
  ],
  playback: seq => (seq === 'exercise' ? 2.9 : 6),
  phases: seq => (seq === 'exercise' ? EXERCISE : REST).slice(0, 6).map((at, i) => ({ at, label: PHASE_SHORT[i] })),
  frame: (t, seq) => {
    const s = hemo(t, seq);
    const period = seq === 'exercise' ? 0.4 : 60 / 72;
    const systole = s.tau >= 0.14 && s.tau < 0.5;
    const open = [s.mitral > 0.5 && 'Mitral open', s.aortic > 0.5 && 'Aortic open'].filter(Boolean);
    return {
      status: PHASE_NAMES[s.phase],
      detail: `${systole ? 'Systole' : 'Diastole'} · ${open.length ? open.join(' · ') : 'All valves shut'}`,
      values: [s.P, s.V, s.Pao],
      clock: `${((t - Math.floor(t)) * period).toFixed(2)} / ${period.toFixed(2)} s`,
    };
  },
  schematic,
  plot,
  strip: { label: 'ECG', draw: ecgStrip },
  build: buildHeart,
};
