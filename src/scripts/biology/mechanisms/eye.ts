// Study 02 — the human eye as a mechanism.
//
// One degree of freedom: time through a change of gaze, far → near → far.
// Demand (how near the target is) and response (how far the lens rounds) are
// the whole state; everything visible derives from them. The ciliary muscle is
// the only motor and it works against intuition: contracting narrows its ring,
// the zonular fibres slacken, and the lens rounds itself by its own elasticity.
// At 55 the muscle still contracts, but the stiffened lens no longer follows.
import * as THREE from 'three';
import {
  capMaterial, clamp01, curve, fbm, ghostMaterial, lerp, loft, profileFace, ramp, Revolved, rng, solid, tag, tissue, tube,
} from './toolkit';
import { arrow, font } from './draw';
import type { Anchor, Ink, Rig, Study } from './types';

const MM = 0.2; // scene units per millimetre: the globe comes out the heart's size
const TAU = Math.PI * 2;
const deg = (d: number) => (d * Math.PI) / 180;
const ACCENT = '#e0662b';

/* ── geometry (mm; optical axis +Z, cornea forward) ──────────────────── */

const APEX = 12.5;
const R_CORNEA = 7.8, R_CORNEA_IN = 7.2, CORNEA_T = 0.55;
const R_SCLERA = 11.5, R_SCLERA_IN = 10.9;
const R_CHOROID = 10.88, R_RETINA = 10.62, R_INNER = 10.38;
const TH_CHOROID = deg(111.5), TH_RETINA = deg(110); // forward edges, at the ora serrata
const corneaZ = (r: number) => APEX - R_CORNEA + Math.sqrt(R_CORNEA ** 2 - r * r);
const corneaInZ = (r: number) => APEX - CORNEA_T - R_CORNEA_IN + Math.sqrt(R_CORNEA_IN ** 2 - r * r);
const LIMBUS: [number, number] = [5.8, corneaZ(5.8)];
const CORNEA_EDGE: [number, number] = [5.5, corneaInZ(5.5)];
/** (r, z) at polar angle θ from the posterior pole on a sphere about the centre. */
const onSphere = (R: number, th: number): [number, number] => [R * Math.sin(th), -R * Math.cos(th)];
const polarAngle = (r: number, z: number) => Math.atan2(r, -z);
const sph = (R: number, th: number, phi: number) => {
  const [r, z] = onSphere(R, th);
  return new THREE.Vector3(r * Math.cos(phi), r * Math.sin(phi), z);
};
const SPUR: [number, number] = [5.55, 9.3];      // scleral spur: the ciliary muscle's fixed anchor
const IRIS_ROOT: [number, number] = [5.45, 9.02];
const R_PLANA = 10.57, R_CIL_OUT = 10.86;
const TH_ORA = deg(112), TH_PLICATA = deg(128);
const DISC_TH = deg(15);                          // optic disc, nasal (−x) of the posterior pole
const Z_RET = -R_INNER;
const Z_PP = 11.0;                                // principal plane of the eye's optics
const V0 = 1336 / (Z_PP - Z_RET);                 // image vergence that lands on the retina (D)
const DEFOCUS_DRAWN = 6;                          // defocus is drawn six times larger than life

/* ── the lens and its ages ───────────────────────────────────────────── */

type Lens = { Req: number; tA: number; tP: number; pA: number; pP: number; zeq: number };
type Age = { amp: number; rest: Lens; full: Lens; pupil: [number, number]; tint: string; cut: string };
// `full` is the shape at FULL_D dioptres of accommodation. The anterior face
// steepens most (radius ~10 → ~6 mm); the equator draws in, the poles move apart.
const AGES: Record<string, Age> = {
  young: {
    amp: 10, pupil: [4.6, 3.2], tint: '#f4eed8', cut: '#ead9a4',
    rest: { Req: 4.6, tA: 1.5, tP: 2.1, pA: 0.705, pP: 0.84, zeq: 7.6 },
    full: { Req: 4.35, tA: 1.85, tP: 2.25, pA: 0.85, pP: 0.76, zeq: 7.6 },
  },
  presbyopic: {
    amp: 1.5, pupil: [3.7, 2.7], tint: '#efd99a', cut: '#dcbd6e',
    rest: { Req: 4.75, tA: 1.75, tP: 2.45, pA: 0.75, pP: 0.85, zeq: 7.45 },
    full: { Req: 4.5, tA: 2.1, tP: 2.6, pA: 0.9, pP: 0.77, zeq: 7.45 },
  },
};
const FULL_D = 8;
const NEAR_D = 4; // a page at 25 cm
const CYCLE = 6;  // seconds; accommodation takes about a second each way
const PHASES = [0, 0.14, 0.2, 0.42, 0.66, 0.72];
const PHASE_LABELS: Record<string, string[]> = {
  young: ['Far focus', 'Near target', 'Focusing', 'Near focus', 'Far target', 'Relaxing'],
  presbyopic: ['Far focus', 'Near target', 'Straining', 'Near blur', 'Far target', 'Relaxing'],
};

const mixLens = (a: Lens, b: Lens, k: number): Lens => ({
  Req: lerp(a.Req, b.Req, k), tA: lerp(a.tA, b.tA, k), tP: lerp(a.tP, b.tP, k),
  pA: lerp(a.pA, b.pA, k), pP: lerp(a.pP, b.pP, k), zeq: lerp(a.zeq, b.zeq, k),
});
// Each face is (1 − u²)^p: p sets the curvature at the pole, and easing p to ½
// toward the equator rounds the rim the way the capsule does.
const face = (r: number, Req: number, p: number) => {
  const u = Math.min(1, r / Req);
  return Math.pow(Math.max(0, 1 - u * u), lerp(p, 0.5, u ** 4));
};
const lensFront = (L: Lens, r: number) => L.zeq + L.tA * face(r, L.Req, L.pA);
const lensBack = (L: Lens, r: number) => L.zeq - L.tP * face(r, L.Req, L.pP);

/** The whole state at one instant of the change of gaze. */
export function optics(t: number, seq: string) {
  const age = AGES[seq] ?? AGES.young;
  const tau = t - Math.floor(t);
  const demand = tau >= PHASES[1] && tau < PHASES[4] ? NEAR_D : 0;
  // ~0.35 s latency after each switch, then a smooth approach.
  const env = ramp(tau, PHASES[2], PHASES[3]) * (1 - ramp(tau, PHASES[5], 0.97));
  const response = Math.min(age.amp, NEAR_D) * env;
  // The brain drives the muscle as hard as the blur demands: a stiff lens gets full effort.
  const muscle = env * Math.min(1, NEAR_D / (age.amp * 0.8));
  const lens = mixLens(age.rest, age.full, response / FULL_D);
  const pupil = lerp(age.pupil[0], age.pupil[1], env);
  const error = response - demand; // negative: the image falls behind the retina
  let phase = 0;
  for (let k = 0; k < PHASES.length; k++) if (tau >= PHASES[k]) phase = k;
  return { tau, demand, response, muscle, lens, pupil, error, phase, age };
}

/* ── profiles: each walked clockwise in (r, z) and closed ─────────────── */

function lensProfile(L: Lens) {
  const n = 24, pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) { const r = L.Req * Math.sin((i / n) * Math.PI / 2); pts.push([r, lensFront(L, r)]); }
  for (let i = n - 1; i >= 0; i--) { const r = L.Req * Math.sin((i / n) * Math.PI / 2); pts.push([r, lensBack(L, r)]); }
  pts.push(pts[0]);
  return pts;
}

function corneaProfile() {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 24; i++) { const r = LIMBUS[0] * Math.sin((i / 24) * Math.PI / 2); pts.push([r, corneaZ(r)]); }
  pts.push(LIMBUS, CORNEA_EDGE);
  for (let i = 24; i >= 0; i--) { const r = CORNEA_EDGE[0] * Math.sin((i / 24) * Math.PI / 2); pts.push([r, corneaInZ(r)]); }
  pts.push(pts[0]);
  return pts;
}

/** A spherical shell from the posterior pole forward to `th`. */
function shellProfile(rOut: number, rIn: number, th: number, n: number) {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) pts.push(onSphere(rOut, lerp(th, 0, i / n)));
  for (let i = 0; i <= n; i++) pts.push(onSphere(rIn, lerp(0, th, i / n)));
  pts.push(pts[0]);
  return pts;
}

function scleraProfile() {
  const pts: [number, number][] = [CORNEA_EDGE, LIMBUS];
  const thL = polarAngle(...LIMBUS), thE = polarAngle(...CORNEA_EDGE);
  for (let i = 0; i <= 48; i++) pts.push(onSphere(R_SCLERA, lerp(thL, 0, i / 48)));
  for (let i = 0; i <= 48; i++) pts.push(onSphere(R_SCLERA_IN, lerp(0, thE, i / 48)));
  pts.push(pts[0]);
  return pts;
}

const bezier = (a: [number, number], b: [number, number], c: [number, number], t: number): [number, number] => [
  (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * b[0] + t * t * c[0],
  (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * b[1] + t * t * c[1],
];
/** Ciliary crown and the start of the pars plicata, moving inward and forward as the muscle contracts. */
function ciliaryKeys(c: number) {
  const p0 = onSphere(R_PLANA, TH_PLICATA);
  const P: [number, number] = [p0[0] - 0.12 * c, p0[1] + 0.1 * c];
  const C: [number, number] = [5.3 - 0.3 * c, 7.95 + 0.25 * c];
  return { P, C };
}
/** Inner face of the pars plicata, u = 0 at its back edge to 1 at the crown. */
function plicata(c: number, u: number) {
  const { P, C } = ciliaryKeys(c);
  return bezier(P, [lerp(P[0], C[0], 0.5) - 0.35 - 0.1 * c, lerp(P[1], C[1], 0.5) - 0.15], C, u);
}
/** Anterior face, crown (v = 0) to scleral spur (v = 1). */
function ciliaryFace(c: number, v: number) {
  const { C } = ciliaryKeys(c);
  return bezier(C, [lerp(C[0], SPUR[0], 0.5) + 0.25, lerp(C[1], SPUR[1], 0.5) - 0.05], SPUR, v);
}
const CIL_PLICATA = 17, CIL_FACE = 32; // profile indices where those faces begin
function ciliaryProfile(c: number) {
  const pts: [number, number][] = [SPUR];
  const th0 = polarAngle(...SPUR);
  for (let i = 1; i <= 10; i++) pts.push(onSphere(R_CIL_OUT, lerp(th0, TH_ORA, i / 10)));
  for (let i = 0; i <= 5; i++) pts.push(onSphere(R_PLANA, lerp(TH_ORA, TH_PLICATA, i / 6)));
  for (let i = 0; i <= 14; i++) pts.push(plicata(c, i / 14));
  for (let i = 1; i <= 8; i++) pts.push(ciliaryFace(c, i / 8));
  return pts;
}

const IRIS_N = 18;
function irisProfile(rp: number, L: Lens) {
  // The pupil margin rides on the anterior lens surface.
  const zm = lensFront(L, Math.min(rp, L.Req - 0.2)) + 0.07;
  const mid = (s: number): [number, number] => [lerp(rp, IRIS_ROOT[0], s), lerp(zm, IRIS_ROOT[1], s) + 0.22 * Math.sin(Math.PI * s) * (1 - 0.4 * s)];
  const thick = (s: number) => 0.18 + 0.3 * Math.exp(-(((s - 0.28) / 0.2) ** 2)) + 0.12 * (1 - s);
  const pts: [number, number][] = [];
  for (let i = 0; i <= IRIS_N; i++) { const s = i / IRIS_N, [r, z] = mid(s); pts.push([r, z + thick(s) / 2]); }
  pts.push(pts[pts.length - 1]);
  for (let i = IRIS_N; i >= 0; i--) { const s = i / IRIS_N, [r, z] = mid(s); pts.push([r, z - thick(s) / 2]); }
  pts.push(pts[pts.length - 1], pts[0]);
  return pts;
}

/* ── the fundus, painted once ─────────────────────────────────────────── */

function fundus() {
  if (typeof document === 'undefined') return null;
  const W = 2048, C = W / 2;
  const PX = C / (TH_RETINA * R_INNER); // pixels per millimetre of retina
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = W;
  const g = canvas.getContext('2d')!;
  const random = rng(77);
  const bg = g.createRadialGradient(C, C, 0, C, C, C);
  bg.addColorStop(0, '#8e2e20'); bg.addColorStop(0.18, '#b4442b'); bg.addColorStop(0.55, '#c85a31'); bg.addColorStop(1, '#d27040');
  g.fillStyle = bg; g.fillRect(0, 0, W, W);
  // Choroidal mottling seen through the pigment epithelium.
  for (let i = 0; i < 2600; i++) {
    const x = random() * W, y = random() * W, r = 6 + random() * 26;
    g.fillStyle = random() < 0.5 ? `rgba(70,18,10,${0.04 + random() * 0.05})` : `rgba(240,140,90,${0.03 + random() * 0.04})`;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  const mac = g.createRadialGradient(C, C, 0, C, C, 2.8 * PX);
  mac.addColorStop(0, 'rgba(55,12,8,0.6)'); mac.addColorStop(0.35, 'rgba(70,18,10,0.35)'); mac.addColorStop(1, 'rgba(70,18,10,0)');
  g.fillStyle = mac; g.beginPath(); g.arc(C, C, 2.8 * PX, 0, TAU); g.fill();

  const VEIN = '#6d1d1c', ARTERY = '#b8382c';
  const disc = { x: C - (DISC_TH / TH_RETINA) * C, y: C };
  const stroke = (pts: [number, number][], w0: number, color: string) => {
    g.strokeStyle = color; g.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      g.lineWidth = lerp(w0, Math.max(1.2, w0 * 0.35), i / (pts.length - 1));
      g.beginPath(); g.moveTo(...pts[i - 1]); g.lineTo(...pts[i]); g.stroke();
    }
    if (color === ARTERY && w0 >= 5) {
      // The light reflex down the middle of an artery.
      g.strokeStyle = 'rgba(255,190,160,0.32)'; g.lineWidth = 1.3;
      g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
    }
  };
  const grow = (x: number, y: number, dir: number, turn: number, w: number, steps: number, color: string, depth: number) => {
    const pts: [number, number][] = [[x, y]];
    for (let i = 0; i < steps; i++) {
      dir += turn + (random() - 0.5) * 0.1;
      turn *= 0.985;
      // Vessels skirt the fovea: the centre of the macula stays avascular.
      const d = Math.hypot(x - C, y - C);
      if (d < 3.2 * PX) {
        const away = Math.atan2(y - C, x - C);
        dir += Math.atan2(Math.sin(away - dir), Math.cos(away - dir)) * 0.06 * (1 - d / (3.2 * PX));
      }
      x += Math.cos(dir) * 5; y += Math.sin(dir) * 5;
      if (Math.hypot(x - C, y - C) > C * 0.99) break;
      pts.push([x, y]);
      if (depth > 0 && i > 6 && random() < 0.05) {
        grow(x, y, dir + (random() < 0.5 ? -1 : 1) * (0.5 + random() * 0.6), (random() - 0.5) * 0.01, w * 0.62, steps * 0.55, color, depth - 1);
      }
    }
    stroke(pts, w, color);
  };
  // Four arcades leave the disc; the temporal pair arch round the macula.
  for (const [color, w, off] of [[VEIN, 10, 0], [ARTERY, 7, 0.16]] as const) {
    for (const s of [-1, 1]) {
      grow(disc.x + 4, disc.y + s * 6, s * (Math.PI / 2 - 0.12 - off), -s * (0.022 - off * 0.04), w, 230, color, 3);
      grow(disc.x - 4, disc.y + s * 6, s * (Math.PI / 2 + 0.35 + off), s * 0.008, w * 0.72, 170, color, 3);
    }
    for (const s of [-1, 1]) grow(disc.x + 20, disc.y + s * 10, s * 0.3, 0, w * 0.35, 40, color, 1);
  }
  const rD = 0.9 * PX;
  const dg = g.createRadialGradient(disc.x + 4, disc.y, 0, disc.x, disc.y, rD);
  dg.addColorStop(0, '#fbeccc'); dg.addColorStop(0.35, '#f2cf9e'); dg.addColorStop(0.8, '#e6a072'); dg.addColorStop(1, 'rgba(214,120,80,0.9)');
  g.fillStyle = dg; g.beginPath(); g.arc(disc.x, disc.y, rD, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(90,35,15,0.35)'; g.lineWidth = 4; g.beginPath(); g.arc(disc.x, disc.y, rD + 2, 0, TAU); g.stroke();
  for (const [s, color, w] of [[-1, VEIN, 9], [1, VEIN, 9], [-1, ARTERY, 6], [1, ARTERY, 6]] as const) {
    g.strokeStyle = color; g.lineWidth = w; g.lineCap = 'round';
    g.beginPath(); g.moveTo(disc.x + 3, disc.y + s * 3); g.quadraticCurveTo(disc.x + 8, disc.y + s * rD * 0.5, disc.x + 5, disc.y + s * (rD + 6)); g.stroke();
  }
  g.fillStyle = 'rgba(255,225,190,0.55)'; g.beginPath(); g.arc(C, C, 4, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(255,210,170,0.12)'; g.lineWidth = 3; g.beginPath(); g.arc(C, C, 0.75 * PX, 0, TAU); g.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Map the retina so the fundus painting is centred on the posterior pole. */
function fundusUV(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const rho = (0.5 * polarAngle(Math.hypot(x, y), z)) / TH_RETINA, phi = Math.atan2(y, x);
    uv.setXY(i, 0.5 + rho * Math.cos(phi), 0.5 + rho * Math.sin(phi));
  }
}

/* ── build ────────────────────────────────────────────────────────────── */

const inner = <T extends THREE.Object3D>(o: T) => { o.traverse(c => { c.userData.inner = true; }); return o; };

function buildEye(): Rig {
  const root = new THREE.Group();
  const eye = new THREE.Group();
  eye.scale.setScalar(MM);
  root.add(eye);
  const wall = new THREE.Group(), cornea = new THREE.Group(), iris = new THREE.Group(), apparatus = new THREE.Group(), light = new THREE.Group();
  eye.add(wall, cornea, iris, apparatus, light);

  // Cut faces are drawn from the profiles themselves, so transparent parts
  // section as cleanly as opaque ones. Each sits a hair behind the plane.
  const cut = (profile: [number, number][], depth: number, color: string, id: string) => {
    const m = new THREE.Mesh(profileFace(profile, depth), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    m.userData.role = 'cap';
    return tag(m, id, 'cap');
  };
  const swap = (m: THREE.Mesh, g: THREE.BufferGeometry) => { m.geometry.dispose(); m.geometry = g; };
  const live = <M extends THREE.Material>(m: THREE.Mesh) => (m.userData.base ?? m.material) as M;

  /* sclera, with episcleral vessels near the limbus */
  const scleraProf = scleraProfile();
  const scleraRev = new Revolved(scleraProf.length, 128).update(scleraProf);
  const ivory = new THREE.Color('#eee7da'), cream = new THREE.Color('#e0cfb9'), limbal = new THREE.Color('#b9bfc6'), flush = new THREE.Color('#efcfc0');
  scleraRev.paint((l, phi, c) => {
    const th = polarAngle(...scleraProf[l]);
    c.copy(ivory).lerp(cream, clamp01(0.35 + 0.6 * fbm(Math.cos(phi) * 2.2, Math.sin(phi) * 2.2, th * 1.6, 3, 31)));
    c.lerp(flush, 0.45 * ramp(th, deg(122), deg(142)) * clamp01(0.5 + fbm(Math.cos(phi) * 5, Math.sin(phi) * 5, th * 4, 2, 32)));
    c.lerp(limbal, 0.7 * ramp(th, deg(144), deg(149.5)));
  });
  const scleraMesh = new THREE.Mesh(scleraRev.geometry, tissue('#ffffff', { vertexColors: true, roughness: 0.36, clearcoat: 0.75, clearcoatRoughness: 0.22, sheen: 0.15, sheenColor: new THREE.Color('#ffffff') }));
  wall.add(tag(scleraMesh, 'sclera'), cut(scleraProf, 0.06, '#efe8dc', 'sclera'));
  const vesselMat = tissue('#b5463d', { roughness: 0.42, clearcoat: 0.6 });
  const rand = rng(202);
  for (let k = 0; k < 11; k++) {
    const phi0 = (k / 11) * TAU + rand() * 0.4;
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= 8; i++) {
      const p = sph(R_SCLERA + 0.05, lerp(deg(116), deg(146), i / 8), phi0 + 0.06 * Math.sin(i * 1.7 + k) + 0.012 * i);
      pts.push([p.x, p.y, p.z]);
    }
    wall.add(tag(new THREE.Mesh(tube(curve(pts), t => lerp(0.075, 0.025, t), 40, 6), vesselMat), 'sclera'));
  }

  /* choroid and retina: the linings, seen only once the globe is opened */
  const choroidProf = shellProfile(R_CHOROID, R_RETINA, TH_CHOROID, 48);
  const choroid = new THREE.Mesh(new Revolved(choroidProf.length, 128).update(choroidProf).geometry, tissue('#4a1c14', { roughness: 0.6, clearcoat: 0.2 }));
  wall.add(inner(tag(choroid, 'choroid')), cut(choroidProf, 0.07, '#3e1913', 'choroid'));
  const retinaProf = shellProfile(R_RETINA - 0.005, R_INNER, TH_RETINA, 64);
  const retinaRev = new Revolved(retinaProf.length, 160).update(retinaProf);
  fundusUV(retinaRev.geometry);
  const fundusMap = fundus();
  const retina = new THREE.Mesh(retinaRev.geometry, tissue(fundusMap ? '#ffffff' : '#c4532f', {
    map: fundusMap, roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.3, sheen: 0.2, sheenColor: new THREE.Color('#ffb090'),
  }));
  wall.add(inner(tag(retina, 'retina')), cut(retinaProf, 0.08, '#d48a73', 'retina'));

  /* optic nerve, leaving nasally toward the orbital apex */
  const out = new THREE.Vector3(-Math.sin(DISC_TH), 0, -Math.cos(DISC_TH));
  const along = (d: number, x = 0, y = 0, z = 0) => out.clone().multiplyScalar(d).add(new THREE.Vector3(x, y, z));
  const nerveCurve = new THREE.CatmullRomCurve3([along(10.9), along(13.5), along(17, -1.2, 0.2, 0.4), along(21, -3.2, 0.5, 0.9), along(25, -5.5, 0.8, 1.2)]);
  const nerve = solid(tube(nerveCurve, t => 1.75 - 0.15 * t, 40, 28), tissue('#e8dccb', { roughness: 0.55, sheen: 0.4 }), capMaterial('#e3d3b0'), false);
  const end = new THREE.Mesh(new THREE.CircleGeometry(1.6, 32), tissue('#ead9b4', { roughness: 0.7 }));
  end.position.copy(nerveCurve.getPointAt(1));
  end.lookAt(end.position.clone().add(nerveCurve.getTangentAt(1)));
  nerve.add(end);
  wall.add(tag(nerve, 'nerve'));

  /* cornea */
  const corneaProf = corneaProfile();
  const corneaMesh = new THREE.Mesh(new Revolved(corneaProf.length, 96).update(corneaProf).geometry, new THREE.MeshPhysicalMaterial({
    color: '#ffffff', transparent: true, opacity: 0.14, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, depthWrite: false, envMapIntensity: 1.4,
  }));
  cornea.add(tag(corneaMesh, 'cornea'), cut(corneaProf, 0.06, '#d4e0e3', 'cornea'));

  /* iris: radial striae and crypts in the stroma, black pigment behind */
  const IRIS_SEG = 288;
  const irisRev = new Revolved(2 * IRIS_N + 5, IRIS_SEG);
  const striae = (phi: number, s: number) => 0.5 + 0.5 * Math.sin(phi * 54 + 2.2 * fbm(Math.cos(phi) * 3, Math.sin(phi) * 3, s * 2, 2, 41));
  const relief = new Float32Array((IRIS_N + 1) * IRIS_SEG);
  for (let l = 0; l <= IRIS_N; l++) for (let k = 0; k < IRIS_SEG; k++) {
    const s = l / IRIS_N, phi = (k / IRIS_SEG) * TAU, st = striae(phi, s);
    const crypt = Math.max(0, fbm(Math.cos(phi) * 7, Math.sin(phi) * 7, s * 5, 2, 43) - 0.25);
    relief[l * IRIS_SEG + k] = (0.05 * st - 0.18 * crypt) * ramp(s, 0.32, 0.45) * (1 - ramp(s, 0.92, 1)) + 0.03 * st * (1 - ramp(s, 0.1, 0.3));
  }
  const pupillary = new THREE.Color('#7b4824'), ciliaryZone = new THREE.Color('#5b3a22'), collarette = new THREE.Color('#b07c45'), rim = new THREE.Color('#33221a');
  irisRev.paint((l, phi, c) => {
    if (l > IRIS_N) { c.set('#1c100b'); return; }
    const s = l / IRIS_N;
    c.copy(pupillary).lerp(ciliaryZone, ramp(s, 0.25, 0.42));
    c.lerp(collarette, 0.75 * Math.exp(-(((s - 0.3) / 0.07) ** 2)));
    c.lerp(rim, 0.8 * ramp(s, 0.82, 1));
    c.multiplyScalar(0.78 + 0.4 * striae(phi, s));
    if (s < 0.06) c.set('#2a160e'); // pupillary ruff
  });
  const irisBend = (l: number, phi: number, p: THREE.Vector3) => {
    if (l <= IRIS_N) p.z += relief[l * IRIS_SEG + (Math.round((phi / TAU) * IRIS_SEG) % IRIS_SEG)];
  };
  const irisMesh = tag(new THREE.Mesh(irisRev.geometry, tissue('#ffffff', {
    vertexColors: true, roughness: 0.62, clearcoat: 0.35, clearcoatRoughness: 0.4, sheen: 0.25, sheenColor: new THREE.Color('#d8a070'),
  })), 'iris', 'mechanism');
  const irisCut = cut([[0, 0], [1, 0], [1, 1], [0, 0]], 0.1, '#5a3622', 'iris');
  iris.add(irisMesh, irisCut);

  /* lens */
  const lensRev = new Revolved(50, 96);
  const lensMesh = tag(new THREE.Mesh(lensRev.geometry, new THREE.MeshPhysicalMaterial({
    color: '#f4eed8', transparent: true, opacity: 0.42, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.05, depthWrite: false,
    sheen: 0.3, sheenColor: new THREE.Color('#fff6dd'),
  })), 'lens', 'mechanism');
  const lensCut = cut([[0, 0], [1, 0], [1, 1], [0, 0]], 0.06, '#ead9a4', 'lens');
  apparatus.add(lensMesh, lensCut);

  /* ciliary body: a ring of muscle with ~70 folded processes on its crown */
  const PROCESSES = 72, CIL_SEG = PROCESSES * 6;
  const cilProf0 = ciliaryProfile(0);
  const cilRev = new Revolved(cilProf0.length, CIL_SEG);
  const cilW = new Float32Array(cilProf0.length);
  for (let l = CIL_PLICATA; l < CIL_FACE; l++) cilW[l] = ramp((l - CIL_PLICATA) / 14, 0.1, 0.55);
  for (let l = CIL_FACE; l < cilProf0.length; l++) cilW[l] = 1 - ramp((l - CIL_FACE + 1) / 8, 0, 0.4);
  const ridge = (phi: number) => Math.pow(0.5 + 0.5 * Math.cos(phi * PROCESSES), 3);
  const pigment = new THREE.Color('#2e1a13'), process = new THREE.Color('#7a4634');
  cilRev.paint((l, phi, c) => {
    if (l <= 11) { c.set('#3a2119'); return; }
    c.copy(pigment).lerp(process, 0.9 * ridge(phi) * cilW[l]);
  });
  const cilBend = (l: number, phi: number, p: THREE.Vector3) => {
    const w = cilW[l];
    if (!w) return;
    const r = Math.hypot(p.x, p.y), k = (r - 0.3 * w * ridge(phi)) / r;
    p.x *= k; p.y *= k;
  };
  const cilMesh = tag(new THREE.Mesh(cilRev.geometry, tissue('#ffffff', {
    vertexColors: true, roughness: 0.55, clearcoat: 0.35, sheen: 0.3, sheenColor: new THREE.Color('#7a4a38'), emissive: new THREE.Color(ACCENT), emissiveIntensity: 0,
  })), 'ciliary', 'mechanism');
  const cilCut = cut(cilProf0, 0.09, '#8e3d30', 'ciliary');
  apparatus.add(cilMesh, cilCut);

  /* zonular fibres: three bands from the valleys between processes to the capsule */
  const BANDS = [
    // Fibres from the pars plana run forward to the anterior capsule, crossing
    // those from the crown that run back to the posterior capsule.
    { u: 0.3, bow: 1, insert: (L: Lens): [number, number] => { const r = L.Req - 0.75; return [r, lensFront(L, r)]; } },
    { u: 0.68, bow: -1, insert: (L: Lens): [number, number] => [L.Req, L.zeq] },
    { u: 0.92, bow: -1, insert: (L: Lens): [number, number] => { const r = L.Req - 0.6; return [r, lensBack(L, r)]; } },
  ];
  const ZSEG = 6, FIBRES = PROCESSES * BANDS.length;
  const zonules = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 5, 1, true), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5 }), FIBRES * ZSEG);
  zonules.frustumCulled = false;
  const jitter = Array.from({ length: FIBRES }, () => rand());
  apparatus.add(tag(zonules, 'zonules', 'mechanism'));

  /* the light path: a fan of rays in the cut plane, and the image on the retina */
  const RAYS = 7, RSEG = 4;
  const rays = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6, 1, true), new THREE.MeshBasicMaterial({
    color: ACCENT, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
  }), RAYS * RSEG);
  rays.frustumCulled = false;
  const spot = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshBasicMaterial({ color: '#ffa267', transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
  spot.position.set(0, 0, Z_RET + 0.05);
  light.add(tag(rays, 'rays', 'fluid'), tag(spot, 'rays', 'fluid'));

  // Framing marker for the close-up view: the upper lens edge and its fibres.
  const detail = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 2.2, 4.6), new THREE.Vector3(0, 7.8, 11.2)]), new THREE.PointsMaterial({ visible: false }));
  eye.add(detail);

  const Y = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), m4 = new THREE.Matrix4();
  const dir = new THREE.Vector3(), mid = new THREE.Vector3(), sc = new THREE.Vector3();
  const place = (mesh: THREE.InstancedMesh, i: number, a: THREE.Vector3, b: THREE.Vector3, radius: number) => {
    dir.subVectors(b, a);
    const len = dir.length();
    mid.addVectors(a, b).multiplyScalar(0.5);
    q.setFromUnitVectors(Y, len > 1e-6 ? dir.divideScalar(len) : Y);
    mesh.setMatrixAt(i, m4.compose(mid, q, sc.set(radius, len, radius)));
  };
  const hide = (mesh: THREE.InstancedMesh, i: number) => mesh.setMatrixAt(i, m4.makeScale(0, 0, 0));
  const taut = new THREE.Color('#f7f1e4'), slack = new THREE.Color('#8f8474'), tone = new THREE.Color();
  const muscleCut = new THREE.Color('#8e3d30'), accent = new THREE.Color(ACCENT);
  const pts = Array.from({ length: ZSEG + 1 }, () => new THREE.Vector3());
  const rayPts = Array.from({ length: RSEG + 1 }, () => new THREE.Vector3());

  const set = (t: number, seq: string) => {
    const s = optics(t, seq), L = s.lens;

    const lp = lensProfile(L);
    lensRev.update(lp);
    swap(lensCut, profileFace(lp, 0.06));
    live<THREE.MeshPhysicalMaterial>(lensMesh).color.set(s.age.tint);
    live<THREE.MeshBasicMaterial>(lensCut).color.set(s.age.cut);

    const ip = irisProfile(s.pupil / 2, L);
    irisRev.update(ip, irisBend);
    swap(irisCut, profileFace(ip, 0.1));

    const cp = ciliaryProfile(s.muscle);
    cilRev.update(cp, cilBend);
    swap(cilCut, profileFace(cp, 0.09));
    live<THREE.MeshPhysicalMaterial>(cilMesh).emissiveIntensity = 0.22 * s.muscle;
    live<THREE.MeshBasicMaterial>(cilCut).color.copy(muscleCut).lerp(accent, 0.55 * s.muscle);

    // A fibre's taut length is its span with the muscle relaxed and the lens
    // flat. Narrowing the ring shortens the span; what the lens does not take
    // up hangs as slack.
    let i = 0;
    for (let k = 0; k < PROCESSES; k++) {
      const phi = ((k + 0.5) / PROCESSES) * TAU;
      BANDS.forEach((band, bi) => {
        const f = k * BANDS.length + bi;
        const O = plicata(s.muscle, band.u), I = band.insert(L);
        const O0 = plicata(0, band.u), I0 = band.insert(s.age.rest);
        const d = Math.hypot(I[0] - O[0], I[1] - O[1]);
        const slackMM = Math.max(0, Math.hypot(I0[0] - O0[0], I0[1] - O0[1]) - d);
        const h = Math.min(0.5, Math.sqrt((3 * d * slackMM) / 8)) * (0.8 + 0.4 * jitter[f]);
        let pr = -(I[1] - O[1]) / d, pz = (I[0] - O[0]) / d;
        if (pz * band.bow < 0) { pr = -pr; pz = -pz; }
        const twist = (jitter[f] - 0.5) * 0.04;
        for (let j = 0; j <= ZSEG; j++) {
          const u = j / ZSEG, bow = h * 4 * u * (1 - u);
          const r = lerp(O[0], I[0], u) + pr * bow, z = lerp(O[1], I[1], u) + pz * bow, a = phi + twist * u;
          pts[j].set(r * Math.cos(a), r * Math.sin(a), z);
        }
        const tension = clamp01(1 - slackMM / 0.1) * (1 - 0.55 * s.muscle);
        tone.copy(slack).lerp(taut, tension);
        for (let j = 0; j < ZSEG; j++, i++) { place(zonules, i, pts[j], pts[j + 1], 0.04); zonules.setColorAt(i, tone); }
      });
    }
    zonules.instanceMatrix.needsUpdate = true;
    if (zonules.instanceColor) zonules.instanceColor.needsUpdate = true;

    // Rays from the target, bent at the cornea and lens toward the image point.
    const zImg = Z_PP - 1336 / (V0 + s.error);
    const F = new THREE.Vector3(0, 0, Z_RET + DEFOCUS_DRAWN * (zImg - Z_RET));
    const rp = s.pupil / 2, zStart = APEX + 8, zObj = APEX + 1000 / Math.max(s.demand, 1e-3);
    let blur = 0;
    for (let k = 0; k < RAYS; k++) {
      const h = rp * 0.85 * ((k - (RAYS - 1) / 2) / ((RAYS - 1) / 2));
      const hc = h * 1.07, zc = corneaZ(Math.abs(hc)), h3 = h * 0.93;
      const y0 = s.demand > 0 ? (hc * (zObj - zStart)) / (zObj - zc) : hc;
      rayPts[0].set(0, y0, zStart);
      rayPts[1].set(0, hc, zc);
      rayPts[2].set(0, h, lensFront(L, Math.abs(h)));
      rayPts[3].set(0, h3, lensBack(L, Math.abs(h3)));
      // Where the line toward the image point meets the retina.
      const P3 = rayPts[3], dv = F.clone().sub(P3);
      const a = dv.dot(dv), b = P3.dot(dv), c = P3.dot(P3) - R_INNER * R_INNER;
      const lam = (-b + Math.sqrt(Math.max(0, b * b - a * c))) / a;
      rayPts[4].copy(P3).addScaledVector(dv, lam);
      blur = Math.max(blur, Math.abs(rayPts[4].y));
      for (let j = 0; j < RSEG; j++) place(rays, k * RSEG + j, rayPts[j], rayPts[j + 1], 0.05);
    }
    rays.instanceMatrix.needsUpdate = true;
    spot.scale.setScalar(Math.max(0.12, blur));
  };
  for (let k = 0; k < FIBRES * ZSEG; k++) zonules.setColorAt(k, taut);
  for (let k = 0; k < RAYS * RSEG; k++) hide(rays, k);
  set(0, 'young');

  const anchors: Anchor[] = [
    { label: 'Cornea', object: cornea, at: [-1.2, 1.2, corneaZ(1.7)], side: [-1, 0.1] },
    { label: 'Iris', object: iris, at: [-0.3, 3.6, 9.3], side: [-1, -0.5] },
    { label: 'Sclera', object: wall, at: sph(R_SCLERA, deg(120), deg(105)).toArray() as [number, number, number], side: [-1, -1] },
    { label: 'Optic nerve', object: wall, at: along(15, -1.6, 0.3, 0.5).toArray() as [number, number, number], side: [1, -0.6] },
    { label: 'Lens', object: apparatus, at: [0, -1.2, 7.6], side: [-1, 0.7], inside: true },
    { label: 'Ciliary muscle', object: apparatus, at: [0, -6.4, 8.1], side: [-1, 0.9], inside: true },
    { label: 'Zonular fibres', object: apparatus, at: [0, 4.95, 7.6], side: [-1, -1], inside: true },
    { label: 'Choroid', object: wall, at: [0, -9.31, -5.38], side: [1, 0.8], inside: true },
    { label: 'Retina', object: wall, at: sph(R_INNER, deg(55), deg(140)).toArray() as [number, number, number], side: [1, -1.4], inside: true },
    { label: 'Fovea', object: wall, at: [0, 0, Z_RET], side: [1, 0.2], inside: true },
    { label: 'Optic disc', object: wall, at: sph(R_INNER, DISC_TH, Math.PI).toArray() as [number, number, number], side: [1, 0.9], inside: true },
  ];

  return {
    root,
    context: buildOrbit(),
    explode: [
      { object: cornea, offset: new THREE.Vector3(0, 0, 7) },
      { object: iris, offset: new THREE.Vector3(0, 0, 4) },
      { object: apparatus, offset: new THREE.Vector3(0, 0, 1.2) },
      { object: wall, offset: new THREE.Vector3(0, 0, -4) },
    ],
    anchors,
    // Sagittal: the plane through the optical axis, keeping the half at −x.
    section: new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
    set,
    groups: { wall, cornea, iris, apparatus, detail },
  };
}

/** Ghosted orbit: the bony cone and the four recti. */
function buildOrbit() {
  const g = new THREE.Group();
  g.scale.setScalar(MM);
  const ghost = ghostMaterial('#2a2724', 0.55);
  ghost.userData.ghost = true;
  const faint = ghostMaterial('#2a2724', 0.3);
  faint.userData.ghost = true;
  // The orbit's axis turns ~23° nasally from the line of sight.
  const apex = new THREE.Vector3(-11, 0.5, -30), rimC = new THREE.Vector3(2, 1, 12);
  const sq = (x: number) => Math.sign(x) * Math.pow(Math.abs(x), 0.6);
  g.add(new THREE.Mesh(loft((v, out) => {
    const c = apex.clone().lerp(rimC, v), w = lerp(3, 20, Math.pow(v, 0.8)), h = lerp(3, 17.5, Math.pow(v, 0.8));
    out.forEach((p, i) => { const a = (i / out.length) * TAU; p.set(c.x + w * sq(Math.cos(a)), c.y + h * sq(Math.sin(a)), c.z); });
  }, { levels: 24, segments: 64 }), faint));
  // Superior, inferior, medial, lateral: insertion distances behind the limbus (mm).
  const thL = polarAngle(...LIMBUS);
  for (const [phi, dist] of [[Math.PI / 2, 7.7], [-Math.PI / 2, 6.5], [Math.PI, 5.5], [0, 6.9]]) {
    const th = thL - dist / R_SCLERA;
    const ins = sph(R_SCLERA + 0.4, th, phi), wrap = sph(R_SCLERA + 1.0, th - 0.55, phi);
    const ring = apex.clone().add(new THREE.Vector3(Math.cos(phi) * 2.2, Math.sin(phi) * 2.2, 2));
    g.add(new THREE.Mesh(tube(new THREE.CatmullRomCurve3([ins, wrap, wrap.clone().lerp(ring, 0.45), ring]), t => lerp(2.4, 1.2, t), 40, 12), ghost));
  }
  tag(g, 'orbit', 'context');
  return g;
}

/* ── panels ───────────────────────────────────────────────────────────── */

/** A ray diagram of the instant: target, cornea, lens, and where the image lands. */
function schematic(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, seq: string, ink: Ink) {
  const s = optics(t, seq);
  const k = Math.min(w / 300, h / 160);
  ctx.save();
  ctx.translate((w - 300 * k) / 2, (h - 160 * k) / 2);
  ctx.scale(k, k);
  const cy = 78, ex = 196, er = 56, xR = ex + er - 2;
  ctx.lineWidth = 1.1; ctx.strokeStyle = ink.ink;
  ctx.beginPath(); ctx.arc(ex, cy, er, deg(-148), deg(148)); ctx.stroke();
  ctx.beginPath(); ctx.arc(ex - 30, cy, 36, deg(124), deg(236)); ctx.stroke();
  ctx.lineWidth = 2.4; ctx.strokeStyle = ink.soft;
  ctx.beginPath(); ctx.arc(ex, cy, er - 2, deg(-58), deg(58)); ctx.stroke();
  // lens: thickness drawn with its change exaggerated
  const L = s.lens, lx = 156, rx = 4.5 + (L.tA + L.tP - 3.4) * 5, ry = L.Req * 5.2;
  ctx.lineWidth = 1.1; ctx.strokeStyle = ink.ink; ctx.fillStyle = ink.paper;
  ctx.beginPath(); ctx.ellipse(lx, cy, rx, ry, 0, 0, TAU); ctx.fill(); ctx.stroke();
  // iris and pupil
  const pp = s.pupil * 4.2;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(lx - rx - 1, cy - 30); ctx.lineTo(lx - rx - 1, cy - pp); ctx.moveTo(lx - rx - 1, cy + pp); ctx.lineTo(lx - rx - 1, cy + 30); ctx.stroke();
  // ciliary ring and zonules: the ring closes in as the muscle contracts
  for (const sgn of [-1, 1]) {
    const tipY = cy + sgn * (ry + 9 - 5 * s.muscle);
    ctx.fillStyle = s.muscle > 0.05 ? ink.accent : ink.soft;
    ctx.beginPath(); ctx.moveTo(lx - 6, cy + sgn * 40); ctx.lineTo(lx + 10, cy + sgn * 40); ctx.lineTo(lx + 2, tipY); ctx.closePath(); ctx.fill();
    const sag = Math.max(0, 5 * s.muscle - (L.Req - s.age.rest.Req) * -20) * 0.8;
    ctx.strokeStyle = ink.faint; ctx.lineWidth = 0.9;
    for (const dx of [-3, 0, 3]) {
      ctx.beginPath(); ctx.moveTo(lx + 2 + dx, tipY); ctx.quadraticCurveTo(lx + dx + 2 + sag, (tipY + cy + sgn * ry) / 2, lx + dx * 0.6, cy + sgn * (ry - 1)); ctx.stroke();
    }
  }
  // rays
  const err = s.error, xF = xR - err * 14;
  ctx.strokeStyle = ink.accent; ctx.fillStyle = ink.accent; ctx.lineWidth = 1.1;
  let blur = 0;
  for (const f of [-1, -0.5, 0.5, 1]) {
    const hp = f * pp * 0.8, hc = hp * 1.15, x0 = s.demand > 0 ? 34 : 18;
    ctx.beginPath();
    ctx.moveTo(x0, s.demand > 0 ? cy : cy + hc);
    ctx.lineTo(132, cy + hc); ctx.lineTo(lx - rx, cy + hp); ctx.lineTo(lx + rx, cy + hp * 0.93);
    const yAt = (x: number) => cy + hp * 0.93 * ((xF - x) / (xF - (lx + rx)));
    ctx.lineTo(xR, yAt(xR)); ctx.stroke();
    blur = Math.max(blur, Math.abs(yAt(xR) - cy));
    if (xF > xR + 1) {
      ctx.setLineDash([2, 3]); ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(xR, yAt(xR)); ctx.lineTo(xF, cy); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
  }
  ctx.lineWidth = 3;
  if (blur > 1.2) { ctx.beginPath(); ctx.moveTo(xR + 2, cy - blur); ctx.lineTo(xR + 2, cy + blur); ctx.stroke(); }
  else { ctx.beginPath(); ctx.arc(xR, cy, 2.6, 0, TAU); ctx.fill(); }
  // target
  ctx.lineWidth = 1.2; ctx.strokeStyle = ink.ink; ctx.fillStyle = ink.ink;
  font(ctx, 7.2, 600);
  if (s.demand > 0) { arrow(ctx, 34, cy + 9, 34, cy - 11, 4); ctx.fillText('25 CM', 22, cy + 22); }
  else ctx.fillText('∞', 8, cy + 3);
  font(ctx, 7.2, 500); ctx.fillStyle = ink.faint;
  ctx.fillText('CORNEA', 112, 26);
  ctx.fillText('LENS', 146, 150);
  ctx.fillText('RETINA', 236, 14);
  font(ctx, 7.2, 600); ctx.fillStyle = Math.abs(err) < 0.25 ? ink.soft : ink.accent;
  ctx.fillText(Math.abs(err) < 0.25 ? 'IN FOCUS' : `BLUR ${Math.abs(err).toFixed(1)} D`, 214, 150);
  ctx.restore();
}

/** Demand and response through the cycle; the gap between them is blur. */
function plot(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, seq: string, ink: Ink) {
  const x = (u: number) => 14 + u * (w - 28);
  const y = (D: number) => h - 14 - (D / 5) * (h - 26);
  const N = 240;
  ctx.strokeStyle = ink.ink; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(10, h - 14); ctx.lineTo(w - 10, h - 14); ctx.stroke();
  ctx.fillStyle = ink.accent; ctx.globalAlpha = 0.13;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) { const s = optics(i / N, seq); if (i === 0) ctx.moveTo(x(0), y(s.demand)); else ctx.lineTo(x(i / N), y(s.demand)); }
  for (let i = N; i >= 0; i--) ctx.lineTo(x(i / N), y(optics(i / N, seq).response));
  ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
  ctx.setLineDash([3, 3]); ctx.strokeStyle = ink.soft;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) { const s = optics(i / N, seq); if (i === 0) ctx.moveTo(x(0), y(s.demand)); else ctx.lineTo(x(i / N), y(s.demand)); }
  ctx.stroke(); ctx.setLineDash([]);
  ctx.strokeStyle = ink.accent; ctx.lineWidth = 1.4;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) { const s = optics(i / N, seq); if (i === 0) ctx.moveTo(x(0), y(s.response)); else ctx.lineTo(x(i / N), y(s.response)); }
  ctx.stroke();
  const s = optics(t, seq);
  ctx.strokeStyle = ink.faint; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x(s.tau), 10); ctx.lineTo(x(s.tau), h - 14); ctx.stroke();
  ctx.fillStyle = ink.accent; ctx.beginPath(); ctx.arc(x(s.tau), y(s.response), 3, 0, TAU); ctx.fill();
  font(ctx, 7, 500); ctx.fillStyle = ink.faint;
  ctx.fillText('DIOPTRES', 12, 10);
  ctx.textAlign = 'right';
  ctx.fillText('- - DEMAND   — RESPONSE', w - 12, 10);
  ctx.fillText('TIME →', w - 12, h - 3);
  ctx.textAlign = 'left';
}

function ciliaryStrip(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, seq: string, ink: Ink) {
  ctx.strokeStyle = ink.soft; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 160; i++) {
    const yy = h * 0.8 - optics(i / 160, seq).muscle * h * 0.62;
    if (i === 0) ctx.moveTo(0, yy); else ctx.lineTo((i / 160) * w, yy);
  }
  ctx.stroke();
  const s = optics(t, seq);
  ctx.fillStyle = ink.accent;
  ctx.beginPath(); ctx.arc(s.tau * w, h * 0.8 - s.muscle * h * 0.62, 2.6, 0, TAU); ctx.fill();
}

/* ── the study ────────────────────────────────────────────────────────── */

export const eyeStudy: Study = {
  id: 'eye',
  code: '02',
  mark: 'EYE',
  eyebrow: 'Sensory · vision',
  title: 'Human eye',
  short: 'Eye',
  subtitle: 'Accommodation',
  tagline: 'Muscle · fibres · lens',
  figure: '10',
  figureUnit: seq => (seq === 'presbyopic' ? '1.5' : '10'),
  motto: ['Contract', 'Slacken', 'Round'],
  stateTitle: 'Focus state',
  dynamicsTitle: 'Accommodation',
  operationTitle: 'Change of gaze',
  overview: {
    heading: 'Focus by letting go',
    text: 'Nothing pulls the lens round. At rest the zonular fibres hold it stretched thin, focused far. To focus near, the ciliary muscle contracts, its ring narrows, the fibres go slack, and the elastic lens rounds itself. At 55 the muscle still contracts; the stiffened lens no longer answers.',
    stats: [['10 D', 'Range at 20'], ['1.5 D', 'Range at 55'], ['4 D', 'Page at 25 cm']],
  },
  sequenceTitle: 'Age',
  sequences: [{ id: 'young', label: 'Age 20' }, { id: 'presbyopic', label: 'Age 55' }],
  defaultDisplay: ['labels', 'section'],
  views: [
    { id: 'hero', label: 'Hero', dir: [1, 0.34, 0.36] },
    { id: 'sagittal', label: 'Sagittal', dir: [1, 0.04, 0.02] },
    { id: 'zonules', label: 'Zonules', dir: [1, 0.1, 0.16], focus: 'detail', note: 'Upper lens edge\nCut through the optical axis' },
    { id: 'anterior', label: 'Anterior', dir: [0.12, 0.1, 1] },
  ],
  contextLabel: 'Orbit',
  footer: ['Mechanism study', 'Driven by one number: ciliary contraction'],
  caption: 'Cut through the optical axis.\nDefocus drawn six times life size.',
  readouts: [
    { label: 'Added power', unit: 'D', max: 5, digits: 1 },
    { label: 'Lens thickness', unit: 'mm', max: 5, digits: 2 },
    { label: 'Pupil', unit: 'mm', max: 6, digits: 1 },
  ],
  parts: [
    { id: 'cornea', name: 'Cornea', role: 'Two-thirds of the eye’s focusing power, about 43 D, and fixed: it cannot change shape.' },
    { id: 'iris', name: 'Iris', role: 'Narrows the pupil for near work. The smaller aperture deepens the focus.' },
    { id: 'lens', name: 'Lens', role: 'About 20 D at rest. Its elastic capsule pulls it round; zonular tension holds it flat.' },
    { id: 'ciliary', name: 'Ciliary muscle', role: 'A ring of smooth muscle. Contracting draws it inward and forward, which slackens the zonules.' },
    { id: 'zonules', name: 'Zonular fibres', role: 'Fine fibres from the ciliary body to the lens capsule. They can only pull, never push.' },
    { id: 'sclera', name: 'Sclera', role: 'The tough outer coat. It holds the optics at a fixed distance from the retina.' },
    { id: 'choroid', name: 'Choroid', role: 'Vascular, pigmented layer that feeds the outer retina and absorbs stray light.' },
    { id: 'retina', name: 'Retina', role: 'The light-sensitive layer, about 0.25 mm thick. Sharp vision happens only at the fovea.' },
    { id: 'nerve', name: 'Optic nerve', role: 'About a million axons leave through the optic disc, which has no photoreceptors: the blind spot.' },
    { id: 'rays', name: 'Light path', role: 'Rays from the target, bent by cornea and lens. Defocus is drawn six times life size.' },
    { id: 'orbit', name: 'Orbit', role: 'Context only.' },
  ],
  playback: () => CYCLE,
  phases: seq => PHASES.map((at, i) => ({ at, label: (PHASE_LABELS[seq] ?? PHASE_LABELS.young)[i] })),
  frame: (t, seq) => {
    const s = optics(t, seq);
    const focus = Math.abs(s.error) < 0.25 ? 'In focus' : s.error < 0 ? `${(-s.error).toFixed(1)} D short` : `${s.error.toFixed(1)} D over`;
    return {
      status: (PHASE_LABELS[seq] ?? PHASE_LABELS.young)[s.phase],
      detail: `${s.muscle > 0.04 ? 'Ciliary contracted' : 'Ciliary relaxed'} · ${focus}`,
      values: [s.response, s.lens.tA + s.lens.tP, s.pupil],
      clock: `${(s.tau * CYCLE).toFixed(2)} / ${CYCLE.toFixed(2)} s`,
    };
  },
  schematic,
  plot,
  strip: { label: 'Ciliary', draw: ciliaryStrip },
  build: buildEye,
};
