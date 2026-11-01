// Procedural toolkit for the mechanism studies.
//
// Every model here is generated at load time: no meshes are downloaded. Each
// study is driven by one degree of freedom, so geometry is built once at rest
// and then *warped* every frame. Deformable meshes keep their rest positions,
// and a study supplies a warp field that maps rest → current.
import * as THREE from 'three';
import { SimplexNoise } from 'three/addons/math/SimplexNoise.js';

/* ── noise ─────────────────────────────────────────────────────────────── */

/** Seeded so every visitor sees the same specimen. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noises = new Map<number, SimplexNoise>();
function simplex(seed: number) {
  let n = noises.get(seed);
  if (!n) noises.set(seed, (n = new SimplexNoise({ random: rng(seed * 7919 + 13) } as unknown as Math)));
  return n;
}

/** Fractal noise in roughly [-1, 1]. */
export function fbm(x: number, y: number, z: number, octaves = 4, seed = 1) {
  const n = simplex(seed);
  let sum = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * n.noise3d(x * f, y * f, z * f);
    norm += amp; amp *= 0.5; f *= 2.03;
  }
  return sum / norm;
}

/* ── easing ────────────────────────────────────────────────────────────── */

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Smooth 0→1 between two thresholds. */
export const ramp = (x: number, a: number, b: number) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};
/** 0 → 1 → 0 across [a, b]. */
export const pulse = (x: number, a: number, b: number) => Math.sin(clamp01((x - a) / (b - a || 1e-6)) * Math.PI);
export const smoothMax = (a: number, b: number, k: number) => {
  const h = clamp01(0.5 + 0.5 * (a - b) / k);
  return lerp(b, a, h) + k * h * (1 - h);
};

/**
 * Periodic monotone cubic through (time, value) keys on [0, 1). Physiological
 * traces have plateaus (isovolumetric phases, held focus) that an ordinary
 * spline would overshoot; Fritsch–Carlson slopes keep every segment monotone.
 */
export function periodicCurve(keys: [number, number][]) {
  const n = keys.length;
  const xs = keys.map(k => k[0]), ys = keys.map(k => k[1]);
  const at = (i: number) => {
    const wrap = Math.floor(i / n);
    const j = ((i % n) + n) % n;
    return [xs[j] + wrap, ys[j]] as const;
  };
  const slope = (i: number) => {
    const [x0, y0] = at(i - 1), [x1, y1] = at(i), [x2, y2] = at(i + 1);
    const d0 = (y1 - y0) / (x1 - x0), d1 = (y2 - y1) / (x2 - x1);
    if (d0 * d1 <= 0) return 0;
    return (3 * (x2 - x0)) / ((2 * x2 - x1 - x0) / d0 + (x2 + x1 - 2 * x0) / d1);
  };
  const slopes = keys.map((_, i) => slope(i));
  return (t: number) => {
    t = t - Math.floor(t);
    let i = n - 1;
    for (let k = 0; k < n; k++) if (xs[k] <= t) i = k;
    let [x0, y0] = at(i), [x1, y1] = at(i + 1);
    if (t < x0) { t += 1; }
    const h = x1 - x0, s = (t - x0) / h;
    const m0 = slopes[i] * h, m1 = slopes[(i + 1) % n] * h;
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * y0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * y1 + (s3 - s2) * m1;
  };
}

/** Piecewise-linear remap of phase boundaries — used to speed up a cycle
 *  non-uniformly (exercise shortens diastole far more than systole). */
export function remap(t: number, from: number[], to: number[]) {
  t = t - Math.floor(t);
  for (let i = 0; i < from.length - 1; i++) {
    if (t <= from[i + 1]) return lerp(to[i], to[i + 1], (t - from[i]) / (from[i + 1] - from[i]));
  }
  return to[to.length - 1];
}

/* ── geometry ──────────────────────────────────────────────────────────── */

type RingFn = (v: number, out: THREE.Vector3[]) => void;

/**
 * Loft a stack of closed rings into one surface. `ring(v, out)` fills `out`
 * with `segments` points for the level v ∈ [0, 1]. Ends may be capped to a
 * single pole (an apex, a dome) or left open (a valve orifice, a cut vessel).
 * `inward` flips the winding so the surface faces its own interior — a cavity.
 */
export function loft(ring: RingFn, opts: { levels: number; segments: number; capStart?: boolean; capEnd?: boolean; inward?: boolean }) {
  const { levels, segments, capStart = false, capEnd = false, inward = false } = opts;
  const pts = Array.from({ length: segments }, () => new THREE.Vector3());
  const positions: number[] = [], uvs: number[] = [], index: number[] = [];
  for (let l = 0; l <= levels; l++) {
    const v = l / levels;
    ring(v, pts);
    for (let s = 0; s <= segments; s++) {
      const p = pts[s % segments];
      positions.push(p.x, p.y, p.z); uvs.push(s / segments, v);
    }
  }
  const row = segments + 1;
  const quad = (a: number, b: number, c: number, d: number) => {
    if (inward) index.push(a, d, b, b, d, c); else index.push(a, b, d, b, c, d);
  };
  for (let l = 0; l < levels; l++) for (let s = 0; s < segments; s++) {
    const a = l * row + s, b = (l + 1) * row + s;
    quad(a, b, b + 1, a + 1);
  }
  const pole = (l: number, flip: boolean) => {
    let cx = 0, cy = 0, cz = 0;
    for (let s = 0; s < segments; s++) { const k = (l * row + s) * 3; cx += positions[k]; cy += positions[k + 1]; cz += positions[k + 2]; }
    const c = positions.length / 3;
    positions.push(cx / segments, cy / segments, cz / segments); uvs.push(0.5, l ? 1 : 0);
    for (let s = 0; s < segments; s++) {
      const a = l * row + s, b = a + 1;
      if (flip !== inward) index.push(c, b, a); else index.push(c, a, b);
    }
  };
  if (capStart) pole(0, false);
  if (capEnd) pole(levels, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** A tube swept along a curve with a per-length radius. TubeGeometry can't
 *  taper, so frames are computed here. `inward` makes the lumen surface. */
export function tube(curve: THREE.Curve<THREE.Vector3>, radius: number | ((t: number) => number), segments = 48, radial = 14, inward = false) {
  const frames = curve.computeFrenetFrames(segments, false);
  const r = typeof radius === 'function' ? radius : () => radius;
  const positions: number[] = [], index: number[] = [];
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, p);
    const N = frames.normals[i], B = frames.binormals[i], rad = r(t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      n.copy(N).multiplyScalar(-Math.cos(a)).addScaledVector(B, Math.sin(a)).normalize();
      positions.push(p.x + rad * n.x, p.y + rad * n.y, p.z + rad * n.z);
    }
  }
  for (let i = 0; i < segments; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    if (inward) index.push(a, a + 1, b, b, a + 1, b + 1); else index.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

export const curve = (points: [number, number, number][], tension = 0.5) =>
  new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)), false, 'catmullrom', tension);

/**
 * A surface of revolution about +Z from an (r, z) profile, rebuilt in place as
 * the profile changes. Walk the profile clockwise (r to the right, z up) so the
 * normals face out, end it where it began to close the solid, and repeat a
 * point to crease the surface there. `bend` may displace each vertex.
 */
export class Revolved {
  readonly geometry = new THREE.BufferGeometry();
  private readonly row: number;
  constructor(readonly points: number, readonly segments: number) {
    this.row = segments + 1;
    const index: number[] = [], uv: number[] = [];
    for (let l = 0; l < points; l++) for (let s = 0; s <= segments; s++) uv.push(s / segments, l / (points - 1));
    for (let l = 0; l < points - 1; l++) for (let s = 0; s < segments; s++) {
      const a = l * this.row + s, b = a + this.row;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(points * this.row * 3), 3));
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    this.geometry.setIndex(index);
  }

  update(profile: readonly (readonly [number, number])[], bend?: (l: number, phi: number, p: THREE.Vector3) => void) {
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const p = new THREE.Vector3();
    for (let l = 0; l < this.points; l++) {
      const [r, z] = profile[l];
      for (let s = 0; s <= this.segments; s++) {
        const phi = ((s % this.segments) / this.segments) * Math.PI * 2;
        p.set(r * Math.cos(phi), r * Math.sin(phi), z);
        bend?.(l, phi, p);
        pos.setXYZ(l * this.row + s, p.x, p.y, p.z);
      }
    }
    pos.needsUpdate = true;
    this.geometry.computeVertexNormals();
    // The seam column is duplicated for the UVs; weld its normals.
    const n = this.geometry.getAttribute('normal') as THREE.BufferAttribute;
    for (let l = 0; l < this.points; l++) {
      const a = l * this.row, b = a + this.segments;
      const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
      const len = Math.hypot(x, y, z) || 1;
      n.setXYZ(a, x / len, y / len, z / len); n.setXYZ(b, x / len, y / len, z / len);
    }
    this.geometry.computeBoundingSphere();
    return this;
  }

  /** Vertex colours by profile index and angle, so they stay put as the shape moves. */
  paint(fn: (l: number, phi: number, out: THREE.Color) => void) {
    const colors = new Float32Array(this.points * this.row * 3), c = new THREE.Color();
    for (let l = 0; l < this.points; l++) for (let s = 0; s <= this.segments; s++) {
      fn(l, ((s % this.segments) / this.segments) * Math.PI * 2, c);
      c.toArray(colors, (l * this.row + s) * 3);
    }
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return this;
  }
}

/**
 * The exact cut face of a solid of revolution on the plane x = 0: its profile
 * on both sides of the axis. Set `depth` slightly behind the plane so the face
 * never fights the clipped surface. Works where back-face caps cannot — for
 * transparent parts and for solids that are not closed.
 */
export function profileFace(profile: readonly (readonly [number, number])[], depth: number) {
  const half = (sign: number) => new THREE.Shape(profile.map(([r, z]) => new THREE.Vector2(sign * r, z)));
  const g = new THREE.ShapeGeometry([half(1), half(-1)], 1);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setXYZ(i, -depth, pos.getX(i), pos.getY(i));
  g.deleteAttribute('normal');
  g.computeBoundingSphere();
  return g;
}

/** A parametric sheet sampled on a grid. Leaflets, cusps, cisternae. */
export function sheet(fn: (u: number, v: number, out: THREE.Vector3) => void, su = 24, sv = 12) {
  const g = new THREE.BufferGeometry();
  const index: number[] = [];
  for (let i = 0; i < su; i++) for (let j = 0; j < sv; j++) {
    const a = i * (sv + 1) + j, b = a + sv + 1;
    index.push(a, b, a + 1, b, b + 1, a + 1);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((su + 1) * (sv + 1) * 3), 3));
  g.setIndex(index);
  const out = new THREE.Vector3();
  const update = (f = fn) => {
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i <= su; i++) for (let j = 0; j <= sv; j++) {
      f(i / su, j / sv, out);
      pos.setXYZ(i * (sv + 1) + j, out.x, out.y, out.z);
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
  };
  update();
  return { geometry: g, update };
}

/** Displace every vertex along its normal by a noise field — breaks the
 *  machined look of a loft without changing its silhouette. */
export function roughen(g: THREE.BufferGeometry, amp: number, freq: number, seed = 1) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const d = amp * fbm(x * freq, y * freq, z * freq, 3, seed);
    pos.setXYZ(i, x + nor.getX(i) * d, y + nor.getY(i) * d, z + nor.getZ(i) * d);
  }
  g.computeVertexNormals();
  return g;
}

/** Vertex colours from a function of position. */
export function paint(g: THREE.BufferGeometry, fn: (p: THREE.Vector3, out: THREE.Color) => void) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) { fn(p.fromBufferAttribute(pos, i), c); c.toArray(colors, i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/* ── deformation ───────────────────────────────────────────────────────── */

export type Warp = (rest: THREE.Vector3, out: THREE.Vector3, mesh: THREE.Mesh) => void;

/** Remember a mesh's rest pose so a warp can be applied every frame. */
export function deformable<T extends THREE.Mesh>(mesh: T) {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  mesh.userData.rest = Float32Array.from(pos.array as Float32Array);
  mesh.frustumCulled = false;
  return mesh;
}

export function applyWarp(root: THREE.Object3D, warp: Warp) {
  const rest = new THREE.Vector3(), out = new THREE.Vector3();
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    const data = mesh.userData?.rest as Float32Array | undefined;
    if (!data) return;
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      rest.set(data[i], data[i + 1], data[i + 2]);
      warp(rest, out, mesh);
      arr[i] = out.x; arr[i + 1] = out.y; arr[i + 2] = out.z;
    }
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  });
}

/* ── materials ─────────────────────────────────────────────────────────── */

/** Living tissue: sheen for the velvet falloff of muscle at grazing angles,
 *  clearcoat for the film of moisture over it. */
export function tissue(color: THREE.ColorRepresentation, o: THREE.MeshPhysicalMaterialParameters = {}) {
  return new THREE.MeshPhysicalMaterial({
    color, roughness: 0.55, metalness: 0,
    sheen: 0.6, sheenRoughness: 0.55, sheenColor: new THREE.Color(color).lerp(new THREE.Color('#ffd8cf'), 0.5),
    clearcoat: 0.55, clearcoatRoughness: 0.35,
    ...o,
  });
}

/** Backface fill that reads as a solid cut face when a clipping plane opens a
 *  closed shell: the plane reveals back faces, and they are painted flat. */
export function capMaterial(color: THREE.ColorRepresentation) {
  return new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
}

/** Rim-lit glass for context anatomy and x-ray mode: nearly invisible face-on,
 *  inked along silhouettes, like the ghosted fuselage of an engineering plate. */
export function ghostMaterial(color: THREE.ColorRepresentation, strength = 1) {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, strength: { value: strength } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <clipping_planes_pars_vertex>
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 local = vec4(position, 1.0);
        vec3 n = normal;
        #ifdef USE_INSTANCING
          local = instanceMatrix * local;
          n = mat3(instanceMatrix) * n;
        #endif
        vec4 mv = modelViewMatrix * local;
        vN = normalize(normalMatrix * n); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <clipping_planes_pars_fragment>
      uniform vec3 color; uniform float strength;
      varying vec3 vN; varying vec3 vV;
      void main() {
        #include <clipping_planes_fragment>
        float rim = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float a = (0.035 + 0.55 * pow(rim, 3.0)) * strength;
        gl_FragColor = vec4(color, a);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, clipping: true,
  });
}

/* ── assembly ──────────────────────────────────────────────────────────── */

export type Role = 'shell' | 'mechanism' | 'cap' | 'context' | 'fluid';

/** Tag every mesh under `object` as part `id` with a display role. Shells
 *  ghost in x-ray and clip in section; mechanism stays solid in both. */
export function tag<T extends THREE.Object3D>(object: T, id: string, role: Role = 'shell') {
  object.traverse(o => {
    if (!(o as THREE.Mesh).isMesh) return;
    o.userData.part ??= id;
    o.userData.role ??= role;
    o.castShadow = role !== 'cap' && role !== 'context' && role !== 'fluid';
  });
  return object;
}

/** A shell with an inside: front faces in tissue, back faces as the cut. */
export function solid(geometry: THREE.BufferGeometry, material: THREE.Material, cut: THREE.Material, deform = true) {
  const group = new THREE.Group();
  const front = new THREE.Mesh(geometry, material);
  const back = new THREE.Mesh(geometry, cut);
  back.userData.role = 'cap';
  if (deform) { deformable(front); back.userData.shared = true; }
  group.add(front, back);
  return group;
}
