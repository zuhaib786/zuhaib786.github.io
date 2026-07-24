// Procedural anatomy toolkit.
//
// Every model in the Biology Atlas is generated here at runtime — there are no
// downloaded meshes. Realism comes from four things, in order of importance:
//
//   1. Surfaces are *displaced*, never primitive. An icosphere pushed around by
//      fractal noise reads as tissue; a SphereGeometry reads as a balloon.
//   2. Structures are built the way the real thing is built. Cristae are one
//      folded ribbon inside a second membrane. A centriole is nine microtubule
//      triplets. Gyri come from ridged noise, which creases instead of bumping.
//   3. Wet, subsurface-ish materials: sheen for the velvety grazing-angle
//      falloff, a thin clearcoat for the film of moisture, transmission where
//      tissue is genuinely translucent.
//   4. Vertex-colour mottling, so no surface is one flat colour.
import * as THREE from "three";
import { SimplexNoise } from "three/examples/jsm/math/SimplexNoise.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/* ── noise ──────────────────────────────────────────────────────────────── */

// Seeded so every visitor sees the same specimen — an organ that reshuffles its
// folds on reload stops looking like a specimen and starts looking like a bug.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const noiseCache = new Map<number, SimplexNoise>();
export function noise(seed = 1) {
  let n = noiseCache.get(seed);
  if (!n) noiseCache.set(seed, (n = new SimplexNoise({ random: rng(seed * 7919 + 13) } as unknown as typeof Math)));
  return n;
}

export type FbmOptions = { octaves?: number; freq?: number; lacunarity?: number; gain?: number; seed?: number };

/** Fractal Brownian motion — smooth lumps. Returns roughly [-1, 1]. */
export function fbm(v: THREE.Vector3, o: FbmOptions = {}) {
  const { octaves = 4, freq = 1, lacunarity = 2.02, gain = 0.5, seed = 1 } = o;
  const n = noise(seed);
  let sum = 0, amp = 1, f = freq, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * n.noise3d(v.x * f, v.y * f, v.z * f);
    norm += amp; amp *= gain; f *= lacunarity;
  }
  return sum / norm;
}

/** Ridged noise — `1 - |n|` folds the field at zero crossings, so it creases
 *  instead of bulging. This is what turns a smooth ball into a gyrified cortex. */
export function ridged(v: THREE.Vector3, o: FbmOptions = {}) {
  const { octaves = 4, freq = 1, lacunarity = 2.07, gain = 0.55, seed = 1 } = o;
  const n = noise(seed);
  let sum = 0, amp = 1, f = freq, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const r = 1 - Math.abs(n.noise3d(v.x * f, v.y * f, v.z * f));
    sum += amp * r * r; norm += amp; amp *= gain; f *= lacunarity;
  }
  return sum / norm;
}

/* ── geometry ───────────────────────────────────────────────────────────── */

/** Weld an icosphere's duplicated vertices so normals come out smooth, not faceted. */
export function smooth(geometry: THREE.BufferGeometry, tolerance = 1e-4) {
  const welded = mergeVertices(geometry, tolerance);
  welded.computeVertexNormals();
  return welded;
}

export type BlobOptions = {
  // Icosahedron subdivision. Note this is edge segments, not recursion depth:
  // `detail` yields 20·(detail+1)² triangles, so 20 ≈ 8.8k and 44 ≈ 40k.
  // High-frequency displacement needs roughly eight vertices per fold.
  detail?: number;
  amp?: number;             // displacement as a fraction of radius
  scale?: [number, number, number];
  warp?: (dir: THREE.Vector3, radius: number) => number;  // extra shaping, in radius units
  mottle?: [string, string]; // vertex-colour range, driven by a second noise field
  mottleAmount?: number;
} & FbmOptions;

/**
 * The workhorse: a sphere of tissue. Displaces an icosphere along its own
 * normals with fbm, optionally warped by an anatomical shaping function, then
 * squashed. Nearly every soft structure in the atlas starts here.
 */
export function blob(radius: number, o: BlobOptions = {}) {
  const { detail = 18, amp = 0.1, scale = [1, 1, 1], warp, mottle, mottleAmount = 1, ...noiseOpts } = o;
  const geometry = new THREE.IcosahedronGeometry(radius, detail);
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const dir = new THREE.Vector3();
  const colors = mottle ? new Float32Array(position.count * 3) : null;
  const c0 = mottle ? new THREE.Color(mottle[0]) : null;
  const c1 = mottle ? new THREE.Color(mottle[1]) : null;
  const mix = new THREE.Color();

  for (let i = 0; i < position.count; i++) {
    dir.fromBufferAttribute(position, i).normalize();
    let r = radius * (1 + amp * fbm(dir, noiseOpts));
    if (warp) r += warp(dir, radius);
    position.setXYZ(i, dir.x * r * scale[0], dir.y * r * scale[1], dir.z * r * scale[2]);
    if (colors && c0 && c1) {
      const t = THREE.MathUtils.clamp(0.5 + 0.5 * fbm(dir, { ...noiseOpts, freq: (noiseOpts.freq ?? 1) * 3.1, seed: (noiseOpts.seed ?? 1) + 41 }) * mottleAmount, 0, 1);
      mix.copy(c0).lerp(c1, t).toArray(colors, i * 3);
    }
  }
  position.needsUpdate = true;
  const welded = smooth(geometry);
  if (colors) welded.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return welded;
}

/** A tube swept along a spline with a per-length radius — vessels, nerves,
 *  gut, microtubules. TubeGeometry can't taper, so we frame the curve ourselves. */
export function tube(
  points: THREE.Vector3[] | THREE.Curve<THREE.Vector3>,
  radius: number | ((t: number) => number),
  segments = 64, radial = 16, closed = false,
) {
  const curve = Array.isArray(points) ? new THREE.CatmullRomCurve3(points, closed, "catmullrom", 0.5) : points;
  const frames = curve.computeFrenetFrames(segments, closed);
  const at = typeof radius === "function" ? radius : () => radius;
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  const point = new THREE.Vector3(), normal = new THREE.Vector3();

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, point);
    const r = at(t), N = frames.normals[Math.min(i, segments - 1)], B = frames.binormals[Math.min(i, segments - 1)];
    for (let j = 0; j <= radial; j++) {
      const angle = (j / radial) * Math.PI * 2, sin = Math.sin(angle), cos = -Math.cos(angle);
      normal.set(cos * N.x + sin * B.x, cos * N.y + sin * B.y, cos * N.z + sin * B.z).normalize();
      positions.push(point.x + r * normal.x, point.y + r * normal.y, point.z + r * normal.z);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(t, j / radial);
    }
  }
  for (let i = 1; i <= segments; i++) {
    for (let j = 1; j <= radial; j++) {
      const a = (radial + 1) * (i - 1) + (j - 1), b = (radial + 1) * i + (j - 1), c = (radial + 1) * i + j, d = (radial + 1) * (i - 1) + j;
      indices.push(a, b, d, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

/** A parametric surface sampled on a grid — cristae, thylakoids, ER cisternae,
 *  anything that is really a folded sheet rather than a solid. */
export function sheet(
  fn: (u: number, v: number, target: THREE.Vector3) => void,
  su = 40, sv = 40,
) {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const point = new THREE.Vector3();
  for (let i = 0; i <= su; i++) {
    for (let j = 0; j <= sv; j++) {
      fn(i / su, j / sv, point);
      positions.push(point.x, point.y, point.z);
      uvs.push(i / su, j / sv);
    }
  }
  for (let i = 0; i < su; i++) {
    for (let j = 0; j < sv; j++) {
      const a = i * (sv + 1) + j, b = a + sv + 1, c = a + sv + 2, d = a + 1;
      indices.push(a, b, d, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

/** Lathe a hand-digitised cross-section. Used where the real structure is
 *  genuinely a solid of revolution: the eye, the lens, vessel cuffs. */
export function revolve(profile: [number, number][], segments = 96, arc = Math.PI * 2) {
  const points = profile.map(([x, y]) => new THREE.Vector2(Math.max(x, 1e-5), y));
  const geometry = new THREE.LatheGeometry(points, segments, 0, arc);
  geometry.computeVertexNormals();
  return geometry;
}

/* ── materials ──────────────────────────────────────────────────────────── */

export type TissueOptions = Partial<THREE.MeshPhysicalMaterialParameters> & { wet?: number };

/** Living tissue: sheen supplies the velvety grazing-angle falloff of muscle and
 *  cortex, a thin clearcoat supplies the film of moisture on top of it. */
export function tissue(color: THREE.ColorRepresentation, o: TissueOptions = {}) {
  const { wet = 0.45, ...rest } = o;
  return new THREE.MeshPhysicalMaterial({
    color, roughness: 0.62, metalness: 0,
    sheen: 0.75, sheenRoughness: 0.6, sheenColor: new THREE.Color(color).lerp(new THREE.Color("#ffd9d2"), 0.55),
    clearcoat: wet, clearcoatRoughness: 0.42,
    ...rest,
  });
}

/** Membranes and cytosol: genuinely see-through, so you can read the interior. */
export function membrane(color: THREE.ColorRepresentation, opacity = 0.18, o: TissueOptions = {}) {
  return new THREE.MeshPhysicalMaterial({
    color, roughness: 0.16, metalness: 0, transparent: true, opacity,
    transmission: 0.72, thickness: 0.6, ior: 1.36, clearcoat: 0.8, clearcoatRoughness: 0.18,
    depthWrite: false, side: THREE.DoubleSide, ...o,
  });
}

/** Fluid-filled compartments — vacuoles, vitreous, phagosomes. */
export function fluid(color: THREE.ColorRepresentation, o: TissueOptions = {}) {
  return new THREE.MeshPhysicalMaterial({
    color, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.42,
    transmission: 0.92, thickness: 1.2, ior: 1.34, clearcoat: 1, depthWrite: false, ...o,
  });
}

/* ── assembly ───────────────────────────────────────────────────────────── */

/** Tag a subtree as one selectable structure. The explorer raycasts meshes and
 *  reads `partId` back off them, so anything untagged is scenery. */
export function label(object: THREE.Object3D, partId: string, color: string) {
  object.traverse(child => {
    if (!(child instanceof THREE.Mesh)) return;
    child.userData.partId = partId;
    child.userData.partColor = color;
    const soft = child.userData.noShadow === true;
    child.castShadow = !soft;
    child.receiveShadow = !soft;
  });
  return object;
}

/** Build one selectable structure from a set of meshes. */
export function structure(partId: string, color: string, ...children: THREE.Object3D[]) {
  const group = new THREE.Group();
  group.name = partId;
  children.forEach(child => group.add(child));
  return label(group, partId, color);
}

export function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, position?: [number, number, number], rotation?: [number, number, number]) {
  const m = new THREE.Mesh(geometry, material);
  if (position) m.position.set(...position);
  if (rotation) m.rotation.set(...rotation);
  return m;
}

/** Copies of one geometry scattered with per-instance transforms — ribosomes,
 *  nuclear pores, villi, chromatin. One draw call for thousands of bodies. */
export function scatter(
  geometry: THREE.BufferGeometry, material: THREE.Material, count: number,
  place: (i: number, matrix: THREE.Matrix4, random: () => number) => void, seed = 3,
) {
  const instanced = new THREE.InstancedMesh(geometry, material, count);
  const matrix = new THREE.Matrix4();
  const random = rng(seed);
  for (let i = 0; i < count; i++) { matrix.identity(); place(i, matrix, random); instanced.setMatrixAt(i, matrix); }
  instanced.instanceMatrix.needsUpdate = true;
  return instanced;
}

/** Random unit vector, evenly distributed over the sphere. */
export function onSphere(random: () => number, target = new THREE.Vector3()) {
  const z = random() * 2 - 1, a = random() * Math.PI * 2, r = Math.sqrt(1 - z * z);
  return target.set(r * Math.cos(a), r * Math.sin(a), z);
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Smooth 0→1 ramp between two thresholds. Every animation phase uses this. */
export const ramp = (x: number, a: number, b: number) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};
/** 0 → 1 → 0 pulse across [a, b]. */
export const pulse = (x: number, a: number, b: number) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return Math.sin(t * Math.PI);
};
