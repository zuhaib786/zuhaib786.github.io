// Study 03 — a secretory cell as a mechanism.
//
// One degree of freedom: time since a cohort of cargo protein was made. The
// cohort is followed molecule by molecule through the secretory pathway:
// translated into the rough ER, folded there, exported in COPII vesicles,
// carried cis → trans through the Golgi stack, sorted at the trans-Golgi
// network and shipped along microtubules to the apical membrane. In the
// constitutive pathway each vesicle fuses as it arrives; in the regulated
// pathway the granules dock and wait for a calcium signal, then fuse together.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { capMaterial, clamp01, curve, fbm, ghostMaterial, lerp, ramp, Revolved, rng, roughen, solid, tag, tissue, tube } from './toolkit';
import { arrow, font } from './draw';
import type { Anchor, Ink, Rig, Study } from './types';

const TAU = Math.PI * 2;
const deg = (d: number) => (d * Math.PI) / 180;
const ACCENT = '#e0662b';

/* ── layout (1 unit ≈ 3.5 µm; organelles and vesicles drawn larger than life) ── */

const CELL = { a: 1.65, b: 2.15, c: 1.4, n: 3 };
const apicalY = (x: number, z: number) =>
  CELL.b * Math.pow(Math.max(0, 1 - Math.abs(x / CELL.a) ** CELL.n - Math.abs(z / CELL.c) ** CELL.n), 1 / CELL.n);
const NUC = new THREE.Vector3(0.1, -0.9, -0.05);
const NUC_R = new THREE.Vector3(0.86, 0.76, 0.8);
const ER_R = [1.08, 1.18, 1.28, 1.38];
const ER_T = 0.03;
const ER_TH: [number, number] = [deg(62), deg(132)];
const ER_PHI = deg(150);
/** A point on ER sheet j: (u, v) across the sheet, h through its lumen. The band
 *  wraps the nucleus with its gap toward +z, the half the section removes. */
function erPoint(j: number, u: number, v: number, h: number, out: THREE.Vector3) {
  const R = ER_R[j] + h, th = lerp(ER_TH[1], ER_TH[0], (v + 1) / 2), phi = -Math.PI / 2 + u * ER_PHI;
  return out.set(NUC.x + 0.94 * R * Math.sin(th) * Math.cos(phi), NUC.y + 0.92 * R * Math.cos(th), NUC.z + 0.82 * R * Math.sin(th) * Math.sin(phi));
}
const GOLGI = { x: 0.05, y: 0.32, z: -0.15, step: 0.11, kappa: 0.2 };
const CISTERNAE = 6;
const cisternaY = (k: number, x: number, z: number) => GOLGI.y + k * GOLGI.step + GOLGI.kappa * ((x - GOLGI.x) ** 2 + 0.6 * (z - GOLGI.z) ** 2);
const cisternaSize = (k: number): [number, number] => [lerp(0.95, 0.76, k / (CISTERNAE - 1)), lerp(0.62, 0.5, k / (CISTERNAE - 1))];
const TGN_Y = GOLGI.y + CISTERNAE * GOLGI.step + 0.06;
const CENTROSOME = new THREE.Vector3(1.2, 0.36, -0.25);
// Mitochondria: [x, y, z, tilt about x, tilt about z]; the first lies in the cut, split lengthwise.
const MITO: [number, number, number, number, number][] = [
  [-1.25, 0.2, -0.02, 0, Math.PI / 2], [-1.42, -0.8, -0.3, 0.15, 0.1], [-1.25, 0.6, -0.6, 0.3, 0.9], [1.2, 0.15, -0.8, -0.3, 0.6],
  [-0.35, 1.25, -0.8, 1.5, 0.1], [0.1, -1.95, -0.35, 0, Math.PI / 2], [0.7, 1.35, 0.5, 1.4, 0.3], [-1.35, -0.2, 0.45, 0.3, 0.2],
];
/** True where a microtubule would run through an organelle. */
function blocked(p: THREE.Vector3) {
  if (((p.x - NUC.x) / 1.45) ** 2 + ((p.y - NUC.y) / 1.4) ** 2 + ((p.z - NUC.z) / 1.2) ** 2 < 1) return true;
  const bowl = GOLGI.kappa * ((p.x - GOLGI.x) ** 2 + 0.6 * (p.z - GOLGI.z) ** 2);
  if (Math.abs(p.x - GOLGI.x) < 1.02 && Math.abs(p.z - GOLGI.z) < 0.7 && p.y > GOLGI.y + bowl - 0.1 && p.y < TGN_Y + bowl + 0.12) return true;
  return MITO.some(([x, y, z]) => (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2 < 0.36 ** 2);
}

/* ── the cohort ───────────────────────────────────────────────────────── */

const GROUPS = 12, PER = 6, N = GROUPS * PER, POOL = 24, BACKGROUND = 10;
const STIMULUS = 0.84;
type Sched = { er: number; exit: number; golgi: number; tgn: number; go: number; dock: number };
const SCHED: Record<string, Sched> = {
  constitutive: { er: 0.05, exit: 0.25, golgi: 0.32, tgn: 0.59, go: 0.65, dock: 0.82 },
  regulated: { er: 0.05, exit: 0.25, golgi: 0.32, tgn: 0.57, go: 0.62, dock: 0.7 },
};
const random = rng(303);
/** Squircle coordinates stay inside the rounded sheets. */
const inside = (u: number, v: number): [number, number] => {
  const k = Math.abs(u) ** 3.3 + Math.abs(v) ** 3.3;
  return k <= 0.9 ? [u, v] : [u * Math.pow(0.9 / k, 1 / 3.3), v * Math.pow(0.9 / k, 1 / 3.3)];
};
// Every event happens in the half the section keeps (z < 0), so it can be watched.
// ER sheet coordinate u for an angle φ round the nucleus (0 = +x, −90° = −z).
const uAt = (phiDeg: number) => (phiDeg + 90) / 150;
const GROUP = Array.from({ length: GROUPS }, (_, g) => {
  const side = g % 2 ? 1 : -1, k = Math.floor(g / 2) / (GROUPS / 2 - 1);
  const fx = lerp(-1.05, 1.05, ((g * 5 + 3) % GROUPS) / (GROUPS - 1)), fz = lerp(-0.75, -0.18, random());
  return {
    lag: (g / GROUPS) * 0.1,
    sheet: g % ER_R.length,
    side,
    // Exit sites, like the cargo, sit just behind the cut so they can be watched.
    exit: inside(uAt(side > 0 ? lerp(-4, -10, k) : lerp(-176, -170, k)), 0.86),
    gx: side * lerp(0.12, 0.5, k), gz: lerp(-0.42, -0.12, random()),
    fx, fz, fuse: STIMULUS + 0.004 + random() * 0.02,
  };
});
const PARTICLE = Array.from({ length: N }, (_, i) => ({
  start: inside(uAt(GROUP[Math.floor(i / PER)].side > 0 ? -2 - 8 * random() : -178 + 8 * random()), lerp(-0.8, 0.5, random())),
  jitter: random() * 0.03,
  off: new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize().multiplyScalar(0.02 + 0.03 * random()),
  dx: (random() - 0.5) * 0.25, dz: (random() - 0.5) * 0.2,
  drift: new THREE.Vector3(random() - 0.5, random() * 0.6, random() - 0.5),
}));

const enum Stage { Pre, Synth, ER, COPII, Golgi, TGN, Transport, Docked, Fusing, Out }
type Where = { stage: Stage; k: number; cisterna: number };
/** Where molecule i is at time t: its stage and progress through it. */
function where(i: number, t: number, seq: string): Where {
  const S = SCHED[seq] ?? SCHED.constitutive, G = GROUP[Math.floor(i / PER)], P = PARTICLE[i];
  const tau = t - Math.floor(t), x = tau - G.lag, xs = x - P.jitter;
  const at = (stage: Stage, a: number, b: number, v = x, cisterna = 0): Where => ({ stage, k: clamp01((v - a) / (b - a)), cisterna });
  if (xs < 0) return at(Stage.Pre, 0, 1);
  if (xs < S.er) return at(Stage.Synth, 0, S.er, xs);
  if (x < S.exit) return at(Stage.ER, S.er + P.jitter, S.exit);
  if (x < S.golgi) return at(Stage.COPII, S.exit, S.golgi);
  if (x < S.tgn) {
    const c = ((x - S.golgi) / (S.tgn - S.golgi)) * CISTERNAE, k = Math.min(CISTERNAE - 1, Math.floor(c));
    return { stage: Stage.Golgi, k: c - k, cisterna: k };
  }
  if (x < S.go) return at(Stage.TGN, S.tgn, S.go);
  if (x < S.dock) return at(Stage.Transport, S.go, S.dock);
  if (seq !== 'regulated') {
    if (x < S.dock + 0.03) return at(Stage.Fusing, S.dock, S.dock + 0.03);
    return at(Stage.Out, S.dock + 0.03, S.dock + 0.1);
  }
  // Regulated release is triggered, not scheduled: docked granules wait for Ca²⁺.
  if (tau < G.fuse) return at(Stage.Docked, S.dock, G.fuse);
  if (tau < G.fuse + 0.03) return at(Stage.Fusing, G.fuse, G.fuse + 0.03, tau);
  return at(Stage.Out, G.fuse + 0.03, 1, tau);
}

/** The compartment chain drawn in the panel, and the lumenal pH of each. */
const BOXES = ['ER', 'ERGIC', 'CIS', 'MED', 'TRANS', 'TGN', 'VES', 'OUT'];
const PH = (seq: string) => [7.2, 7.0, 6.7, 6.4, 6.2, 6.0, seq === 'regulated' ? 5.5 : 5.8, 7.4];
function box(w: Where) {
  switch (w.stage) {
    case Stage.Pre: return -1;
    case Stage.Synth: case Stage.ER: return 0;
    case Stage.COPII: return 1;
    case Stage.Golgi: return 2 + Math.min(2, Math.floor(w.cisterna / 2));
    case Stage.TGN: return 5;
    case Stage.Out: return 7;
    default: return 6;
  }
}

export function cohort(t: number, seq: string) {
  const counts = new Array(BOXES.length).fill(0);
  const cisternae = new Array(CISTERNAE).fill(0);
  let made = 0, ph = 0;
  const pH = PH(seq);
  for (let i = 0; i < N; i++) {
    const w = where(i, t, seq), b = box(w);
    if (b < 0) continue;
    counts[b]++; made++; ph += pH[b];
    if (w.stage === Stage.Golgi) cisternae[w.cisterna]++;
  }
  const tau = t - Math.floor(t);
  const ca = seq === 'regulated' ? 0.1 + 0.9 * ramp(tau, STIMULUS - 0.004, STIMULUS + 0.006) * Math.exp(-Math.max(0, tau - STIMULUS - 0.006) / 0.05) : 0.1;
  return { counts, cisternae, made, ph: made ? ph / made : pH[0], secreted: counts[7] / N, ca, tau };
}

const PHASES: Record<string, [number, string][]> = {
  constitutive: [[0, 'Translation'], [0.1, 'Folding in ER'], [0.29, 'ER export'], [0.37, 'Golgi transit'], [0.64, 'Sorting'], [0.7, 'Transport'], [0.87, 'Exocytosis']],
  regulated: [[0, 'Translation'], [0.1, 'Folding in ER'], [0.29, 'ER export'], [0.37, 'Golgi transit'], [0.62, 'Granule forms'], [0.74, 'Docked'], [STIMULUS, 'Ca²⁺ release']],
};
const phaseAt = (t: number, seq: string) => {
  const list = PHASES[seq] ?? PHASES.constitutive, tau = t - Math.floor(t);
  let k = 0;
  for (let i = 0; i < list.length; i++) if (tau >= list[i][0]) k = i;
  return k;
};

/* ── geometry helpers ─────────────────────────────────────────────────── */

/** Smooth closed blob: an icosphere pushed out to `radius(dir)`. */
function blob(detail: number, radius: (d: THREE.Vector3) => number) {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g);
  const pos = g.getAttribute('position') as THREE.BufferAttribute, d = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    pos.setXYZ(i, d.x * radius(d), d.y * radius(d), d.z * radius(d));
  }
  g.computeVertexNormals();
  return g;
}

/**
 * A flattened membrane sac — an ER sheet, a cisterna — laid on a surface.
 * `at(u, v, h, out)` maps squircle coordinates and a lumenal height to space;
 * `w(r)` shapes the lumen from centre (0) to rim (1).
 */
function sac(at: (u: number, v: number, h: number, out: THREE.Vector3) => void, thickness: number, w: (r: number) => number, rings = 12, segments = 72) {
  const prof: [number, number][] = [];
  for (let i = 0; i <= rings; i++) { const r = Math.sin((i / rings) * Math.PI / 2); prof.push([r, thickness * w(r)]); }
  for (let i = rings - 1; i >= 0; i--) { const r = Math.sin((i / rings) * Math.PI / 2); prof.push([r, -thickness * w(r)]); }
  prof.push(prof[0]);
  return new Revolved(prof.length, segments).update(prof, (_l, phi, p) => {
    const r = Math.hypot(p.x, p.y), c = Math.cos(phi), s = Math.sin(phi);
    at(r * Math.sign(c) * Math.abs(c) ** 0.6, r * Math.sign(s) * Math.abs(s) ** 0.6, p.z, p);
  }).geometry;
}
const erLumen = (r: number) => Math.sqrt(Math.max(0, 1 - r ** 6));
// Golgi cisternae are thin in the middle and swollen at the rims, where vesicles bud.
const cisternaLumen = (r: number) => Math.sqrt(Math.max(0, 1 - r ** 8)) * (1 + 0.65 * Math.exp(-(((r - 0.9) / 0.06) ** 2)));

/* ── build ────────────────────────────────────────────────────────────── */

const innerOnly = <T extends THREE.Object3D>(o: T) => { o.traverse(c => { c.userData.inner = true; }); return o; };

function buildCell(): Rig {
  const root = new THREE.Group();
  const membrane = new THREE.Group(), nucleus = new THREE.Group(), er = new THREE.Group(), golgi = new THREE.Group();
  const cytoskeleton = new THREE.Group(), mito = new THREE.Group(), traffic = new THREE.Group();
  root.add(membrane, nucleus, er, golgi, cytoskeleton, mito, traffic);
  const live = <M extends THREE.Material>(m: THREE.Mesh) => (m.userData.base ?? m.material) as M;
  const rand = rng(404);
  const v = new THREE.Vector3(), w = new THREE.Vector3(), q = new THREE.Quaternion(), m4 = new THREE.Matrix4(), sc = new THREE.Vector3();
  const Y = new THREE.Vector3(0, 1, 0);

  /* plasma membrane, opened as a lit bowl of cytoplasm */
  const cellGeo = blob(24, d => {
    const r = Math.pow(Math.abs(d.x / CELL.a) ** CELL.n + Math.abs(d.y / CELL.b) ** CELL.n + Math.abs(d.z / CELL.c) ** CELL.n, -1 / CELL.n);
    return r * (1 + 0.012 * fbm(d.x * 3, d.y * 3, d.z * 3, 3, 51));
  });
  const cytoplasm = new THREE.MeshStandardMaterial({ color: '#f1e5d6', side: THREE.BackSide, roughness: 0.85, emissive: new THREE.Color(ACCENT), emissiveIntensity: 0 });
  const cellMesh = solid(cellGeo, tissue('#e8cfb6', { roughness: 0.5, clearcoat: 0.45, sheen: 0.5, sheenColor: new THREE.Color('#fff0e0') }), cytoplasm, false);
  membrane.add(tag(cellMesh, 'membrane'));
  const cytoMesh = cellMesh.children[1] as THREE.Mesh;
  // Microvilli crowd the apical surface.
  const VILLI = 150;
  const villi = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.034, 0.2, 4, 8), tissue('#e8cfb6', { roughness: 0.5, sheen: 0.5 }), VILLI);
  for (let i = 0; i < VILLI; i++) {
    let x = 0, z = 0;
    do { x = (rand() * 2 - 1) * CELL.a * 0.82; z = (rand() * 2 - 1) * CELL.c * 0.82; } while (Math.abs(x / CELL.a) ** 3 + Math.abs(z / CELL.c) ** 3 > 0.55);
    v.set(x, apicalY(x, z) + 0.1, z);
    q.setFromUnitVectors(Y, w.set(x * 0.08, 1, z * 0.08).normalize());
    villi.setMatrixAt(i, m4.compose(v, q, sc.set(1, 0.8 + 0.4 * rand(), 1)));
  }
  membrane.add(tag(villi, 'membrane'));

  /* nucleus: envelope with pores, chromatin, nucleolus */
  const nucGeo = blob(16, d => {
    const r = 1 / Math.hypot(d.x / NUC_R.x, d.y / NUC_R.y, d.z / NUC_R.z);
    return r * (1 + 0.02 * fbm(d.x * 2.5, d.y * 2.5, d.z * 2.5, 3, 52));
  });
  nucGeo.translate(NUC.x, NUC.y, NUC.z);
  const nucMesh = solid(nucGeo, tissue('#8c74a8', { roughness: 0.45, clearcoat: 0.5, sheen: 0.4, sheenColor: new THREE.Color('#d8c8ef') }), capMaterial('#bba7cf'), false);
  nucleus.add(tag(nucMesh, 'nucleus'));
  const dir = new THREE.Vector3();
  const onNucleus = (lift: number, out: THREE.Vector3) => {
    dir.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
    const r = 1 / Math.hypot(dir.x / NUC_R.x, dir.y / NUC_R.y, dir.z / NUC_R.z);
    return out.copy(dir).multiplyScalar(r + lift).add(NUC);
  };
  const PORES = 90;
  const pores = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.42, 6, 14), tissue('#4f3d6b', { roughness: 0.6 }), PORES);
  for (let i = 0; i < PORES; i++) {
    onNucleus(0.012, v);
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    pores.setMatrixAt(i, m4.compose(v, q, sc.setScalar(0.03)));
  }
  nucleus.add(innerOnly(tag(pores, 'nucleus')));
  const CHROMATIN = 46;
  const chromatin = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: '#6b528c', roughness: 0.7, side: THREE.DoubleSide }), CHROMATIN);
  for (let i = 0; i < CHROMATIN; i++) {
    onNucleus(-0.12 - 0.12 * rand(), v);
    q.setFromAxisAngle(dir, rand() * TAU);
    chromatin.setMatrixAt(i, m4.compose(v, q, sc.set(0.07 + 0.08 * rand(), 0.05 + 0.05 * rand(), 0.08 + 0.07 * rand())));
  }
  nucleus.add(innerOnly(tag(chromatin, 'nucleus')));
  const NUCLEOLUS = NUC.clone().add(new THREE.Vector3(0.18, 0.05, -0.25));
  const nucleolusGeo = roughen(new THREE.IcosahedronGeometry(0.24, 6), 0.025, 6, 53);
  nucleolusGeo.translate(NUCLEOLUS.x, NUCLEOLUS.y, NUCLEOLUS.z);
  nucleus.add(innerOnly(tag(solid(nucleolusGeo, tissue('#4f3670', { roughness: 0.6 }), capMaterial('#5d4280'), false), 'nucleolus')));

  /* rough ER: stacked sheets wrapped round the nucleus, studded with ribosomes */
  const erMat = tissue('#8fa3c9', { roughness: 0.45, clearcoat: 0.5, side: THREE.DoubleSide, emissive: new THREE.Color(ACCENT), emissiveIntensity: 0 });
  const erMeshes = ER_R.map((_, j) => {
    const m = new THREE.Mesh(sac((u, vv, h, out) => erPoint(j, u, vv, h, out), ER_T, erLumen, 14, 120), erMat);
    if (j < ER_R.length - 1) m.userData.inner = true;
    er.add(tag(m, 'er'));
    return m;
  });
  const RIBOSOMES = 3400, RIB_NUC = 500;
  const ribosomes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), tissue('#353a66', { roughness: 0.6, clearcoat: 0 }), RIBOSOMES + RIB_NUC);
  for (let i = 0; i < RIBOSOMES; i++) {
    const r = Math.sqrt(rand()) * 0.97, a = rand() * TAU, c = Math.cos(a), s = Math.sin(a);
    const side = rand() < 0.5 ? 1 : -1;
    erPoint(i % ER_R.length, r * Math.sign(c) * Math.abs(c) ** 0.6, r * Math.sign(s) * Math.abs(s) ** 0.6, side * (ER_T * erLumen(r) + 0.017), v);
    ribosomes.setMatrixAt(i, m4.compose(v, q.identity(), sc.setScalar(0.016)));
  }
  for (let i = 0; i < RIB_NUC; i++) ribosomes.setMatrixAt(RIBOSOMES + i, m4.compose(onNucleus(0.02, v), q.identity(), sc.setScalar(0.015)));
  er.add(innerOnly(tag(ribosomes, 'ribosomes')));

  /* ER–Golgi intermediate compartment: a cloud of small tubules and vesicles */
  const ERGIC = 16;
  const ergic = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), tissue('#b3b7cf', { roughness: 0.45, clearcoat: 0.4 }), ERGIC);
  for (let i = 0; i < ERGIC; i++) {
    const G = GROUP[i % GROUPS];
    v.set(lerp(G.gx, 0.5, 0.25) + (rand() - 0.5) * 0.3, 0.06 + rand() * 0.14, G.gz + (rand() - 0.5) * 0.2);
    ergic.setMatrixAt(i, m4.compose(v, q.setFromAxisAngle(Y, rand() * TAU), sc.set(0.05 + 0.03 * rand(), 0.035, 0.035 + 0.02 * rand())));
  }
  golgi.add(tag(ergic, 'golgi'));

  /* Golgi stack: six curved cisternae, cis below and trans above, then the TGN */
  const cisternae = Array.from({ length: CISTERNAE }, (_, k) => {
    const [a, b] = cisternaSize(k);
    const tone = new THREE.Color('#c98e3c').lerp(new THREE.Color('#ecd39a'), k / (CISTERNAE - 1));
    const mat = tissue(tone, { roughness: 0.4, clearcoat: 0.55, side: THREE.DoubleSide, emissive: new THREE.Color(ACCENT), emissiveIntensity: 0 });
    const g = sac((u, vv, h, out) => {
      const x = GOLGI.x + u * a, z = GOLGI.z - vv * b;
      out.set(x, cisternaY(k, x, z) + h, z);
    }, 0.024, cisternaLumen, 12, 72);
    const m = new THREE.Mesh(g, mat);
    golgi.add(tag(m, 'golgi'));
    return m;
  });
  const tgnMat = tissue('#ecd08e', { roughness: 0.4, clearcoat: 0.5, emissive: new THREE.Color(ACCENT), emissiveIntensity: 0 });
  const tgn = new THREE.Group();
  for (let k = 0; k < 9; k++) {
    let x = GOLGI.x + (rand() - 0.5) * 1.3, z = GOLGI.z + (rand() - 0.5) * 0.8, a = rand() * TAU;
    const pts: [number, number, number][] = [];
    for (let s = 0; s < 6; s++) {
      pts.push([x, TGN_Y + GOLGI.kappa * ((x - GOLGI.x) ** 2 + 0.6 * (z - GOLGI.z) ** 2) + 0.03 * Math.sin(s * 1.7 + k), z]);
      a += (rand() - 0.5) * 1.2; x += Math.cos(a) * 0.12; z += Math.sin(a) * 0.09;
    }
    tgn.add(new THREE.Mesh(tube(curve(pts), 0.03, 30, 8), tgnMat));
    const bud = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 2), tgnMat);
    bud.position.set(...pts[pts.length - 1]);
    tgn.add(bud);
  }
  golgi.add(tag(tgn, 'tgn'));
  const tgnMeshes = tgn.children as THREE.Mesh[];

  /* centrosome and microtubules: the tracks vesicles ride to the apex */
  const mtMat = tissue('#86aaa3', { roughness: 0.5, clearcoat: 0.3 });
  const centriole = (axis: THREE.Vector3) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.16, 9), tissue('#5f7f7a', { roughness: 0.5 }));
    c.position.copy(CENTROSOME);
    c.quaternion.setFromUnitVectors(Y, axis);
    return c;
  };
  cytoskeleton.add(tag(centriole(new THREE.Vector3(0, 1, 0)), 'centrosome'), tag(centriole(new THREE.Vector3(1, 0, 0.3).normalize()), 'centrosome'));
  const track = (end: THREE.Vector3) => new THREE.CatmullRomCurve3([
    CENTROSOME.clone(), CENTROSOME.clone().add(new THREE.Vector3(0.12, 0.75, 0)),
    new THREE.Vector3(lerp(CENTROSOME.x, end.x, 0.55), 1.65, lerp(CENTROSOME.z, end.z, 0.55)), end,
  ]);
  const tracks = GROUP.map(G => track(new THREE.Vector3(G.fx, apicalY(G.fx, G.fz) - 0.05, G.fz)));
  for (const c of tracks) cytoskeleton.add(tag(new THREE.Mesh(tube(c, 0.009, 48, 5), mtMat), 'microtubules'));
  // Radiating microtubules end just inside the membrane, threading between organelles.
  for (let k = 0, tries = 0; k < 12 && tries < 400; tries++) {
    const d = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize();
    const end = d.multiplyScalar(0.88 * Math.pow(Math.abs(d.x / CELL.a) ** CELL.n + Math.abs(d.y / CELL.b) ** CELL.n + Math.abs(d.z / CELL.c) ** CELL.n, -1 / CELL.n));
    const c = new THREE.CatmullRomCurve3([CENTROSOME.clone(), CENTROSOME.clone().lerp(end, 0.5).add(new THREE.Vector3(0, 0.2, 0)), end]);
    if (c.getSpacedPoints(40).slice(3).some(blocked)) continue;
    cytoskeleton.add(tag(new THREE.Mesh(tube(c, 0.009, 40, 5), mtMat), 'microtubules'));
    k++;
  }

  /* mitochondria, with cristae visible once cut */
  const spread: { object: THREE.Object3D; offset: THREE.Vector3 }[] = [];
  const mitoMat = tissue('#b86a66', { roughness: 0.45, clearcoat: 0.5 });
  const cristaMat = new THREE.MeshStandardMaterial({ color: '#8a4440', roughness: 0.6, side: THREE.DoubleSide });
  MITO.forEach(([x, y, z, ax, az], k) => {
    const g = roughen(new THREE.CapsuleGeometry(0.11, 0.42, 8, 18), 0.012, 5, 60 + k);
    const m = solid(g, mitoMat, capMaterial('#e6b6ad'), false);
    for (let c = -2; c <= 2; c++) {
      const crista = new THREE.Mesh(new THREE.CircleGeometry(0.085, 14), cristaMat);
      crista.position.y = c * 0.1;
      crista.rotation.set(Math.PI / 2 + 0.3 * (c % 2), 0, 0);
      m.add(innerOnly(crista));
    }
    m.position.set(x, y, z);
    m.rotation.set(ax, 0, az);
    // Each sits in its own holder at the origin so it can be exploded outward.
    const holder = new THREE.Group();
    holder.add(m);
    mito.add(tag(holder, 'mitochondria'));
    spread.push({ object: holder, offset: new THREE.Vector3(x, y * 0.6, 0).normalize().multiplyScalar(0.6) });
  });

  /* traffic: the cohort, its carriers, and the granule pool */
  const cargo = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color: ACCENT, toneMapped: false }), N);
  const copii = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshPhysicalMaterial({
    color: '#b9c3dc', transparent: true, opacity: 0.5, roughness: 0.3, clearcoat: 0.6, depthWrite: false,
  }), GROUPS);
  const vesicles = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 3), new THREE.MeshPhysicalMaterial({
    color: '#ecd2a2', transparent: true, opacity: 0.5, roughness: 0.3, clearcoat: 0.6, depthWrite: false,
  }), GROUPS + POOL + BACKGROUND);
  const cores = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), tissue('#b4532a', { roughness: 0.5, sheen: 0.2 }), GROUPS + POOL);
  for (const m of [cargo, copii, vesicles, cores]) m.frustumCulled = false;
  traffic.add(tag(cargo, 'cargo', 'fluid'), tag(copii, 'carriers', 'mechanism'), tag(vesicles, 'vesicles', 'mechanism'), tag(cores, 'vesicles', 'mechanism'));
  const poolAt = Array.from({ length: POOL }, () => {
    const x = lerp(-1.1, 1.1, rand()), z = lerp(-0.85, -0.12, rand());
    return { p: new THREE.Vector3(x, apicalY(x, z) - 0.17 - rand() * 0.3, z), fuse: STIMULUS + 0.004 + rand() * 0.05 };
  });

  // Fixed waypoints for each group, from ER exit to the membrane.
  const ways = GROUP.map((G, g) => {
    const exit = erPoint(G.sheet, G.exit[0], G.exit[1], 0.1, new THREE.Vector3());
    const cis = new THREE.Vector3(G.gx, cisternaY(0, G.gx, G.gz) - 0.07, G.gz);
    const bud = new THREE.Vector3(G.gx * 1.1, TGN_Y + 0.07 + GOLGI.kappa * G.gx * G.gx, G.gz);
    const dock = new THREE.Vector3(G.fx, apicalY(G.fx, G.fz) - 0.16, G.fz);
    const pore = new THREE.Vector3(G.fx, apicalY(G.fx, G.fz) - 0.01, G.fz);
    const copiiPath = new THREE.QuadraticBezierCurve3(exit, exit.clone().lerp(cis, 0.5).add(new THREE.Vector3(0, 0.18, 0)), cis);
    const route = new THREE.CatmullRomCurve3([bud, tracks[g].getPoint(0.4), tracks[g].getPoint(0.75), dock]);
    return { exit, cis, bud, dock, pore, copiiPath, route };
  });
  const smooth = (k: number) => k * k * (3 - 2 * k);
  const hidden = m4.clone().makeScale(0, 0, 0);
  const groupPos = new THREE.Vector3();

  const set = (t: number, seq: string) => {
    const regulated = seq === 'regulated';
    const tau = t - Math.floor(t);
    // carriers follow each group's lead molecule
    for (let g = 0; g < GROUPS; g++) {
      const W = where(g * PER + PER - 1, t, seq), path = ways[g];
      let copiiOn = false, vesOn = false, vs = 1;
      if (W.stage === Stage.COPII) { copiiOn = true; path.copiiPath.getPoint(smooth(W.k), groupPos); }
      else if (W.stage === Stage.TGN && W.k > 0.4) { vesOn = true; vs = ramp(W.k, 0.4, 1); groupPos.copy(path.bud); }
      else if (W.stage === Stage.Transport) { vesOn = true; path.route.getPoint(smooth(W.k), groupPos); }
      else if (W.stage === Stage.Docked) { vesOn = true; groupPos.copy(path.dock); }
      else if (W.stage === Stage.Fusing) { vesOn = true; vs = 1 - W.k; groupPos.lerpVectors(path.dock, path.pore, smooth(W.k)); }
      copii.setMatrixAt(g, copiiOn ? m4.compose(groupPos, q.identity(), sc.setScalar(0.09)) : hidden);
      const rad = regulated ? 0.13 : 0.1;
      vesicles.setMatrixAt(g, vesOn ? m4.compose(groupPos, q.identity(), sc.set(rad * vs, rad * vs * (W.stage === Stage.Fusing ? 1 - 0.5 * W.k : 1), rad * vs)) : hidden);
      cores.setMatrixAt(g, vesOn && regulated ? m4.compose(groupPos, q.identity(), sc.setScalar(0.07 * vs)) : hidden);
    }
    // the standing pool of mature granules (regulated only)
    poolAt.forEach((P, k) => {
      let s = 0;
      if (regulated) s = tau < P.fuse ? ramp(tau, 0, 0.06) : 1 - ramp(tau, P.fuse, P.fuse + 0.03);
      const sink = regulated && tau >= P.fuse ? ramp(tau, P.fuse, P.fuse + 0.03) * 0.15 : 0;
      v.copy(P.p).add(w.set(0, sink, 0));
      vesicles.setMatrixAt(GROUPS + k, s > 0 ? m4.compose(v, q.identity(), sc.setScalar(0.13 * s)) : hidden);
      cores.setMatrixAt(GROUPS + k, s > 0 ? m4.compose(v, q.identity(), sc.setScalar(0.07 * s)) : hidden);
    });
    // unlabelled vesicles from other cohorts: the cell never stops secreting
    for (let k = 0; k < BACKGROUND; k++) {
      const p = (tau * 3 + k / BACKGROUND) % 1, path = ways[(k * 7) % GROUPS];
      const s = ramp(p, 0, 0.08) * (1 - ramp(p, 0.84, 0.92));
      if (p < 0.8) path.route.getPoint(smooth(p / 0.8), v); else v.lerpVectors(path.dock, path.pore, ramp(p, 0.8, 0.92));
      vesicles.setMatrixAt(GROUPS + POOL + k, s > 0 ? m4.compose(v, q.identity(), sc.setScalar(0.09 * s)) : hidden);
    }
    // each molecule
    for (let i = 0; i < N; i++) {
      const W = where(i, t, seq), P = PARTICLE[i], G = GROUP[Math.floor(i / PER)], path = ways[Math.floor(i / PER)];
      let s = 1;
      switch (W.stage) {
        case Stage.Pre: s = 0; break;
        case Stage.Synth: erPoint(G.sheet, P.start[0], P.start[1], lerp(ER_T + 0.03, 0, smooth(W.k)), v); s = W.k; break;
        case Stage.ER: {
          const k = smooth(W.k);
          erPoint(G.sheet, lerp(P.start[0], G.exit[0], k), lerp(P.start[1], G.exit[1], k), 0.1 * ramp(W.k, 0.85, 1), v);
          break;
        }
        case Stage.COPII: path.copiiPath.getPoint(smooth(W.k), v).add(P.off); break;
        case Stage.Golgi: {
          const x = G.gx + P.dx, z = G.gz + P.dz, next = Math.min(CISTERNAE - 1, W.cisterna + 1);
          v.set(x, lerp(cisternaY(W.cisterna, x, z), cisternaY(next, x, z), ramp(W.k, 0.65, 1)), z);
          if (W.cisterna === 0) v.lerp(path.cis, 1 - ramp(W.k, 0, 0.5));
          break;
        }
        case Stage.TGN: {
          const x = G.gx + P.dx, z = G.gz + P.dz;
          v.set(x, cisternaY(CISTERNAE - 1, x, z), z).lerp(w.copy(path.bud).add(P.off), smooth(W.k));
          break;
        }
        case Stage.Transport: path.route.getPoint(smooth(W.k), v).add(P.off); break;
        case Stage.Docked: v.copy(path.dock).add(P.off); break;
        case Stage.Fusing: v.lerpVectors(path.dock, path.pore, smooth(W.k)).add(P.off).add(w.set(0, 0.12 * W.k, 0)); break;
        case Stage.Out: {
          const k = W.k;
          v.copy(path.pore).add(w.copy(P.drift).multiplyScalar(0.9 * k)).add(w.set(0, 0.12 + 0.55 * k, 0)).add(w.copy(P.off).multiplyScalar(1 + 6 * k));
          s = 1 - ramp(k, 0.2, 0.7);
          break;
        }
      }
      cargo.setMatrixAt(i, s > 0 ? m4.compose(v, q.identity(), sc.setScalar(0.038 * s)) : hidden);
    }
    for (const m of [cargo, copii, vesicles, cores]) m.instanceMatrix.needsUpdate = true;

    // Compartments glow with the share of the cohort they hold.
    const c = cohort(t, seq);
    for (const m of erMeshes) live<THREE.MeshPhysicalMaterial>(m).emissiveIntensity = (0.5 * c.counts[0]) / N;
    cisternae.forEach((m, k) => { live<THREE.MeshPhysicalMaterial>(m).emissiveIntensity = Math.min(0.75, (3.5 * c.cisternae[k]) / N); });
    for (const m of tgnMeshes) live<THREE.MeshPhysicalMaterial>(m).emissiveIntensity = Math.min(0.75, (3 * c.counts[5]) / N);
    // The calcium signal flushes the cytoplasm.
    live<THREE.MeshStandardMaterial>(cytoMesh).emissiveIntensity = 0.5 * clamp01((c.ca - 0.1) / 0.9);
  };
  set(0, 'constitutive');

  // Framing markers for the close-up views.
  const marker = (a: THREE.Vector3, b: THREE.Vector3) => new THREE.Points(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.PointsMaterial({ visible: false }));
  const golgiFocus = marker(new THREE.Vector3(-1.0, -0.1, -0.8), new THREE.Vector3(1.1, 1.25, 0.2));
  const apicalFocus = marker(new THREE.Vector3(-1.2, 1.2, -0.9), new THREE.Vector3(1.2, 3.0, 0.1));
  root.add(golgiFocus, apicalFocus);

  const anchors: Anchor[] = [
    { label: 'Plasma membrane', object: membrane, at: [-0.9, apicalY(-0.9, -0.3) + 0.02, -0.3], side: [1, -1.9] },
    { label: 'Microvilli', object: membrane, at: [1.0, apicalY(1.0, -0.3) + 0.25, -0.3], side: [1, -0.9] },
    { label: 'Nucleus', object: nucleus, at: [NUC.x - 0.4, NUC.y - 0.35, -0.05], side: [-1, 1], inside: true },
    { label: 'Nucleolus', object: nucleus, at: NUCLEOLUS.toArray() as [number, number, number], side: [1, 0.7], inside: true },
    { label: 'Rough ER', object: er, at: erPoint(3, uAt(-12), -0.2, ER_T, new THREE.Vector3()).toArray() as [number, number, number], side: [1, 0.4], inside: true },
    { label: 'Golgi stack', object: golgi, at: [GOLGI.x - 0.55, cisternaY(2, GOLGI.x - 0.55, -0.1), -0.1], side: [-1, -0.4], inside: true },
    { label: 'Trans-Golgi network', object: golgi, at: [0.35, TGN_Y + 0.05, -0.1], side: [1, -0.4], inside: true },
    { label: 'Secretory vesicle', object: traffic, at: ways[7].dock.toArray() as [number, number, number], side: [-1, -0.4], inside: true },
    { label: 'Microtubule', object: cytoskeleton, at: tracks[3].getPoint(0.6).toArray() as [number, number, number], side: [1, -0.2], inside: true },
    { label: 'Centrosome', object: cytoskeleton, at: CENTROSOME.toArray() as [number, number, number], side: [1, 0.2], inside: true },
    { label: 'Mitochondrion', object: mito, at: [MITO[5][0] + 0.2, MITO[5][1], MITO[5][2]], side: [1, 0.8], inside: true },
  ];

  return {
    root,
    context: buildEpithelium(),
    // The membrane slides back to a backdrop and the mitochondria spread out in the
    // plane of the cut. Nothing moves toward +z, where the section would clip it, and
    // the pathway stays put so the cohort stays on its organelles.
    explode: [{ object: membrane, offset: new THREE.Vector3(0, 0, -3.4) }, ...spread],
    anchors,
    // Cut across the middle of the cell, keeping the half at −z.
    section: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
    set,
    groups: { golgiFocus, apicalFocus },
  };
}

/** Ghosted neighbours: the epithelium this cell sits in. */
function buildEpithelium() {
  const g = new THREE.Group();
  const ghost = ghostMaterial('#2a2724', 0.45);
  ghost.userData.ghost = true;
  const shape = blob(8, d => Math.pow(Math.abs(d.x / CELL.a) ** 3 + Math.abs(d.y / CELL.b) ** 3 + Math.abs(d.z / CELL.c) ** 3, -1 / 3));
  for (const [x, z] of [[-3.4, 0], [3.4, 0], [-1.7, -2.9], [1.7, -2.9], [-1.7, 2.9], [1.7, 2.9]]) {
    const m = new THREE.Mesh(shape, ghost);
    m.position.set(x, 0, z);
    g.add(m);
  }
  const lamina = new THREE.Mesh(new THREE.BoxGeometry(9, 0.06, 7.5), ghost);
  lamina.position.y = -CELL.b - 0.08;
  g.add(lamina);
  tag(g, 'epithelium', 'context');
  return g;
}

/* ── panels ───────────────────────────────────────────────────────────── */

/** The pathway as a chain of compartments, filled by the cohort. */
function schematic(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, seq: string, ink: Ink) {
  const c = cohort(t, seq), pH = PH(seq);
  const k = Math.min(w / 300, h / 160);
  ctx.save();
  ctx.translate((w - 300 * k) / 2, (h - 160 * k) / 2);
  ctx.scale(k, k);
  const bw = 29, gap = 6, x0 = 19, y0 = 48, bh = 46;
  let lead = 0;
  for (let b = 1; b < BOXES.length; b++) if (c.counts[b] > c.counts[lead]) lead = b;
  BOXES.forEach((label, b) => {
    const x = x0 + b * (bw + gap);
    const frac = c.counts[b] / N;
    ctx.fillStyle = ink.accent; ctx.globalAlpha = 0.85;
    if (frac > 0) ctx.fillRect(x, y0 + bh * (1 - Math.sqrt(frac)), bw, bh * Math.sqrt(frac));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = b === lead && c.counts[b] ? ink.accent : ink.ink; ctx.lineWidth = b === lead && c.counts[b] ? 1.8 : 1;
    ctx.strokeRect(x, y0, bw, bh);
    font(ctx, 6.2, 600); ctx.fillStyle = ink.soft; ctx.textAlign = 'center';
    ctx.fillText(b === 6 && seq === 'regulated' ? 'GRAN' : label, x + bw / 2, y0 - 6);
    font(ctx, 6.6, 500); ctx.fillStyle = ink.faint;
    ctx.fillText(pH[b].toFixed(1), x + bw / 2, y0 + bh + 12);
    if (c.counts[b]) { ctx.fillStyle = ink.ink; font(ctx, 6.6, 600); ctx.fillText(String(c.counts[b]), x + bw / 2, y0 + bh + 24); }
    ctx.textAlign = 'left';
    if (b < BOXES.length - 1) {
      ctx.strokeStyle = ink.faint; ctx.fillStyle = ink.faint; ctx.lineWidth = 1;
      arrow(ctx, x + bw + 1, y0 + bh / 2, x + bw + gap - 1, y0 + bh / 2, 3);
    }
  });
  font(ctx, 6.4, 500); ctx.fillStyle = ink.faint;
  ctx.fillText('PH', 2, y0 + bh + 12);
  ctx.fillText('LUMEN', 5, 18);
  ctx.textAlign = 'right';
  ctx.fillText(`COHORT ${N} MOLECULES`, 295, 18);
  if (seq === 'regulated' && c.ca > 0.2) { font(ctx, 7.2, 600); ctx.fillStyle = ink.accent; ctx.fillText('CA²⁺ SPIKE', 295, 150); }
  ctx.textAlign = 'left';
  ctx.restore();
}

const traces = new Map<string, number[][]>();
/** Where the cohort is over time: ER, Golgi, carriers, and secreted. */
function plot(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, seq: string, ink: Ink) {
  const M = 160;
  let tr = traces.get(seq);
  if (!tr) {
    tr = [[], [], [], []];
    for (let i = 0; i <= M; i++) {
      const c = cohort(i / M, seq);
      tr[0].push(c.counts[0] / N); tr[1].push((c.counts[2] + c.counts[3] + c.counts[4] + c.counts[5]) / N);
      tr[2].push((c.counts[1] + c.counts[6]) / N); tr[3].push(c.secreted);
    }
    traces.set(seq, tr);
  }
  const x = (u: number) => 14 + u * (w - 28);
  const y = (f: number) => h - 14 - f * (h - 26);
  ctx.strokeStyle = ink.ink; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(10, h - 14); ctx.lineTo(w - 10, h - 14); ctx.stroke();
  ctx.fillStyle = ink.accent; ctx.globalAlpha = 0.16;
  ctx.beginPath(); ctx.moveTo(x(0), y(0));
  tr[3].forEach((f, i) => ctx.lineTo(x(i / M), y(f)));
  ctx.lineTo(x(1), y(0)); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
  const line = (data: number[], color: string, width: number, dash: number[] = []) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
    ctx.beginPath(); data.forEach((f, i) => (i ? ctx.lineTo(x(i / M), y(f)) : ctx.moveTo(x(0), y(f)))); ctx.stroke();
    ctx.setLineDash([]);
  };
  line(tr[0], ink.soft, 1.1);
  line(tr[1], ink.ink, 1.3);
  line(tr[2], ink.faint, 1.1, [3, 3]);
  line(tr[3], ink.accent, 1.5);
  const tau = t - Math.floor(t);
  ctx.strokeStyle = ink.faint; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x(tau), 10); ctx.lineTo(x(tau), h - 14); ctx.stroke();
  font(ctx, 7, 500); ctx.fillStyle = ink.faint;
  ctx.fillText('SHARE OF COHORT', 12, 10);
  ctx.textAlign = 'right';
  ctx.fillText('ER · GOLGI · - - CARRIERS · OUT', w - 12, 10);
  ctx.fillText('TIME →', w - 12, h - 3);
  ctx.textAlign = 'left';
}

function calciumStrip(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, seq: string, ink: Ink) {
  const yy = (ca: number) => h * 0.82 - ((ca - 0.1) / 0.9) * h * 0.66;
  ctx.strokeStyle = ink.soft; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 200; i++) { const c = cohort(i / 200, seq); if (i === 0) ctx.moveTo(0, yy(c.ca)); else ctx.lineTo((i / 200) * w, yy(c.ca)); }
  ctx.stroke();
  const c = cohort(t, seq);
  ctx.fillStyle = ink.accent;
  ctx.beginPath(); ctx.arc(c.tau * w, yy(c.ca), 2.6, 0, TAU); ctx.fill();
}

/* ── the study ────────────────────────────────────────────────────────── */

export const cellStudy: Study = {
  id: 'cell',
  code: '03',
  mark: 'CEL',
  eyebrow: 'Cell biology',
  title: 'Secretory cell',
  short: 'Cell',
  subtitle: 'Secretory pathway',
  tagline: 'ER · Golgi · vesicle',
  figure: '60',
  figureUnit: seq => (seq === 'regulated' ? '72' : '60'),
  motto: ['Make', 'Sort', 'Ship'],
  stateTitle: 'Cargo state',
  dynamicsTitle: 'Transport',
  operationTitle: 'Pulse–chase',
  overview: {
    heading: 'One cohort, followed',
    text: 'A batch of protein is made in a single pulse and followed to the surface. It is threaded into the rough ER as it is translated, folded there, then exported in COPII vesicles and passed cis to trans through the Golgi, growing more acidic as it goes. The trans-Golgi network sorts it into vesicles that ride microtubules to the membrane.',
    stats: [['~60 min', 'ER to surface'], ['7.2 → 5.5', 'Lumen pH'], ['6', 'Cisternae']],
  },
  sequenceTitle: 'Pathway',
  sequences: [{ id: 'constitutive', label: 'Constitutive' }, { id: 'regulated', label: 'Regulated' }],
  defaultDisplay: ['labels', 'section'],
  views: [
    { id: 'hero', label: 'Hero', dir: [0.62, 0.42, 1] },
    { id: 'cut', label: 'Cut face', dir: [0.04, 0.08, 1] },
    { id: 'golgi', label: 'Golgi', dir: [0.22, 0.3, 1], focus: 'golgiFocus', note: 'Golgi stack, cut across\nCis face below, trans above' },
    { id: 'apical', label: 'Apical', dir: [0.3, 0.35, 1], focus: 'apicalFocus', note: 'Apical membrane\nWhere vesicles fuse' },
  ],
  contextLabel: 'Epithelium',
  footer: ['Mechanism study', 'Driven by one number: time since synthesis'],
  caption: 'Cut through the middle of the cell.\nOrganelles and vesicles not to scale.',
  readouts: [
    { label: 'Lumen pH', unit: '', max: 8, digits: 1 },
    { label: 'Secreted', unit: '%', max: 100 },
    { label: 'Ca²⁺', unit: 'µM', max: 1.2, digits: 2 },
  ],
  parts: [
    { id: 'membrane', name: 'Plasma membrane', role: 'Vesicle membrane joins it at each fusion, so exocytosis also grows the surface; endocytosis takes it back.' },
    { id: 'nucleus', name: 'Nucleus', role: 'Holds the gene for the cargo. Its outer envelope membrane is continuous with the rough ER.' },
    { id: 'nucleolus', name: 'Nucleolus', role: 'Where ribosomes are assembled.' },
    { id: 'er', name: 'Rough ER', role: 'The cargo is threaded into its lumen as it is made, then folded, glycosylated and checked before it may leave.' },
    { id: 'ribosomes', name: 'Ribosomes', role: 'Bound ribosomes translate the cargo straight through the ER membrane.' },
    { id: 'carriers', name: 'COPII vesicles', role: 'Coat-protein vesicles that carry folded cargo from ER exit sites toward the Golgi.' },
    { id: 'golgi', name: 'Golgi stack', role: 'Cisternae mature from cis to trans, carrying the cargo through and trimming its sugars on the way.' },
    { id: 'tgn', name: 'Trans-Golgi network', role: 'The sorting station: cargo is packed into vesicles bound for the surface, granules or lysosomes.' },
    { id: 'vesicles', name: 'Secretory vesicles', role: 'Constitutive vesicles fuse on arrival. Regulated granules condense their cargo and wait docked for a Ca²⁺ signal.' },
    { id: 'cargo', name: 'Cargo protein', role: 'One cohort, made in a single pulse and followed molecule by molecule.' },
    { id: 'microtubules', name: 'Microtubules', role: 'Tracks from the centrosome region toward the apex; motor proteins walk vesicles along them.' },
    { id: 'centrosome', name: 'Centrosome', role: 'The pair of centrioles at the cell’s main microtubule-organising centre, beside the Golgi.' },
    { id: 'mitochondria', name: 'Mitochondria', role: 'Supply the ATP and GTP that folding, coat assembly and vesicle transport spend.' },
    { id: 'epithelium', name: 'Epithelium', role: 'Context only.' },
  ],
  playback: seq => (seq === 'regulated' ? 14 : 12),
  phases: seq => (PHASES[seq] ?? PHASES.constitutive).map(([at, label]) => ({ at, label })),
  frame: (t, seq) => {
    const c = cohort(t, seq), list = PHASES[seq] ?? PHASES.constitutive, k = phaseAt(t, seq);
    let lead = 0;
    for (let b = 1; b < BOXES.length; b++) if (c.counts[b] > c.counts[lead]) lead = b;
    const where = ['in the rough ER', 'in the ERGIC', 'in cis-Golgi', 'in medial Golgi', 'in trans-Golgi', 'at the TGN', seq === 'regulated' ? 'in granules' : 'in vesicles', 'secreted'][lead];
    const clock = seq === 'regulated'
      ? (c.tau < 0.74 ? `${Math.round((c.tau / 0.74) * 50)} min` : c.tau < STIMULUS ? 'Stored · awaiting signal' : `Signal + ${(((c.tau - STIMULUS) / (1 - STIMULUS)) * 30).toFixed(0)} s`)
      : `${Math.round(c.tau * 60)} / 60 min`;
    return {
      status: list[k][1],
      detail: `Most cargo ${where} · pH ${c.ph.toFixed(1)}`,
      values: [c.ph, c.secreted * 100, c.ca],
      clock,
    };
  },
  schematic,
  plot,
  strip: { label: 'Ca²⁺', draw: calciumStrip },
  build: buildCell,
};
