// Organelles shared between the animal cell, the plant cell and the processes.
// Each builder returns a Group in its own local space, centred on the origin,
// so callers only ever position and rotate it.
import * as THREE from "three";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";
import { blob, fluid, membrane, mesh, onSphere, rng, scatter, sheet, tissue, tube } from "./toolkit";

/**
 * A mitochondrion built the way the organelle actually is: a translucent outer
 * membrane, and inside it a second membrane thrown into lamellar shelves — the
 * cristae — that carry the respiratory chain. The shelves are what you see.
 */
export function mitochondrion(color: string, seed = 5, length = 3.4, radius = 0.24) {
  const outer = blob(radius, { detail: 16, amp: 0.13, freq: 2.4, seed, scale: [length, 1, 1.06] });
  const outerMesh = mesh(outer, membrane(color, 0.3, { thickness: 0.3 }));
  outerMesh.userData.noShadow = true;

  const matrix = mesh(
    blob(radius * 0.86, { detail: 10, amp: 0.1, freq: 2.6, seed: seed + 3, scale: [length * 0.97, 1, 1.05] }),
    tissue(new THREE.Color(color).multiplyScalar(0.62), { transparent: true, opacity: 0.55, roughness: 0.75, wet: 0.1 }),
  );
  matrix.userData.noShadow = true;

  // Cristae: shelves invaginating from the inner membrane, roughly across the
  // long axis, each reaching most of the way to the centre.
  const crista = new THREE.Group();
  const random = rng(seed * 31 + 7);
  const span = radius * length * 0.78;
  const count = Math.max(5, Math.round(length * 2.6));
  const material = tissue(color, { side: THREE.DoubleSide, roughness: 0.5, emissive: new THREE.Color(color).multiplyScalar(0.16), wet: 0.3 });
  for (let i = 0; i < count; i++) {
    const x = -span + (2 * span * (i + 0.5)) / count + (random() - 0.5) * 0.05;
    const start = random() * Math.PI * 2;
    const arc = Math.PI * (1.15 + random() * 0.55);
    const tilt = (random() - 0.5) * 0.5;
    const geometry = sheet((u, v, target) => {
      const angle = start + u * arc;
      const depth = v;
      const r = radius * 0.88 * (1 - 0.86 * depth);
      const wave = 0.035 * Math.sin(depth * 5.5 + angle * 2.2 + i);
      target.set(x + wave + tilt * depth * 0.12, Math.cos(angle) * r, Math.sin(angle) * r * 1.04);
    }, 26, 7);
    const shelf = mesh(geometry, material);
    shelf.userData.noShadow = true;
    crista.add(shelf);
  }
  const group = new THREE.Group();
  group.add(outerMesh, matrix, crista);
  return group;
}

/**
 * Nucleus: chromatin mass inside a double envelope, with nuclear pores placed
 * on the real (displaced) envelope surface rather than on a mathematical sphere.
 */
export function nucleus(color: string, radius = 0.78, seed = 11, pores = 90) {
  const envelopeGeometry = blob(radius, { detail: 20, amp: 0.055, freq: 2.2, seed });
  const envelope = mesh(envelopeGeometry, membrane(color, 0.26, { thickness: 0.5, roughness: 0.1 }));
  envelope.userData.noShadow = true;

  const chromatin = mesh(
    blob(radius * 0.9, { detail: 22, amp: 0.09, freq: 3.4, octaves: 5, seed: seed + 2, mottle: ["#5b3aa8", "#c9aaff"] }),
    tissue(color, { vertexColors: true, roughness: 0.78, wet: 0.2, transparent: true, opacity: 0.94 }),
  );

  const nucleolus = mesh(
    blob(radius * 0.3, { detail: 14, amp: 0.16, freq: 4, seed: seed + 5 }),
    tissue("#3f2570", { roughness: 0.85, wet: 0.05 }),
  );
  nucleolus.position.set(radius * 0.24, radius * 0.16, radius * 0.3);

  // Pores are annular — sample the envelope for a point and its normal, then
  // stand a small ring up on that normal.
  const sampler = new MeshSurfaceSampler(new THREE.Mesh(envelopeGeometry)).build();
  const position = new THREE.Vector3(), normal = new THREE.Vector3(), quaternion = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0), scaleVec = new THREE.Vector3();
  const poreMesh = scatter(
    new THREE.TorusGeometry(radius * 0.052, radius * 0.019, 6, 12), tissue("#e5d6ff", { roughness: 0.5 }), pores,
    (_i, matrix, random) => {
      sampler.sample(position, normal);
      quaternion.setFromUnitVectors(up, normal);
      const s = 0.7 + random() * 0.6;
      matrix.compose(position.addScaledVector(normal, radius * 0.01), quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(up, random() * Math.PI)), scaleVec.setScalar(s));
    }, seed * 13,
  );
  poreMesh.rotateX(Math.PI / 2);   // TorusGeometry lies in XY; stand it on the sampled normal
  poreMesh.userData.noShadow = true;

  const group = new THREE.Group();
  group.add(chromatin, nucleolus, envelope, poreMesh);
  return group;
}

/**
 * Rough endoplasmic reticulum: nested, wavy cisternal sheets wrapping the
 * nucleus, each face studded with ribosomes sampled from the same surface
 * function that generated the sheet — so the grain sits on the membrane.
 */
export function roughER(color: string, inner = 0.95, layers = 3, seed = 17) {
  const group = new THREE.Group();
  const sheetMaterial = tissue(color, { side: THREE.DoubleSide, roughness: 0.5, transparent: true, opacity: 0.9, wet: 0.35 });
  const ribosomeGeometry = new THREE.IcosahedronGeometry(0.022, 1);
  const ribosomeMaterial = tissue("#1f3b6d", { roughness: 0.65, wet: 0.15 });

  for (let i = 0; i < layers; i++) {
    const radius = inner + i * 0.19;
    const a0 = -0.55 - i * 0.42, a1 = a0 + 2.5 + i * 0.35;
    const p0 = 0.62 - i * 0.06, p1 = 2.38 + i * 0.05;
    const surface = (u: number, v: number, target: THREE.Vector3) => {
      const theta = a0 + u * (a1 - a0);
      const phi = p0 + v * (p1 - p0);
      const fold = 0.055 * Math.sin(theta * 6.5 + i * 2.1) + 0.035 * Math.sin(phi * 7.5 - theta * 3);
      const r = radius + fold;
      target.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
    };
    const cisterna = mesh(sheet(surface, 54, 34), sheetMaterial);
    cisterna.userData.noShadow = true;
    group.add(cisterna);

    const point = new THREE.Vector3(), out = new THREE.Vector3();
    const ribosomes = scatter(ribosomeGeometry, ribosomeMaterial, 210, (_j, matrix, random) => {
      const u = random(), v = random();
      surface(u, v, point);
      out.copy(point).normalize();
      matrix.setPosition(point.addScaledVector(out, random() > 0.5 ? 0.03 : -0.03));
    }, seed + i * 9);
    ribosomes.userData.noShadow = true;
    group.add(ribosomes);
  }
  return group;
}

/** Golgi: a polarised stack of dished, wavy-rimmed cisternae, largest at the
 *  cis face, with vesicles budding off the trans face. */
export function golgi(color: string, seed = 23) {
  const group = new THREE.Group();
  const material = tissue(color, { side: THREE.DoubleSide, roughness: 0.44, transparent: true, opacity: 0.94, wet: 0.5 });
  const layers = 6;
  for (let i = 0; i < layers; i++) {
    const R = 0.44 - i * 0.045;
    const y = i * 0.078 - 0.2;
    const geometry = sheet((u, v, target) => {
      const rho = u, angle = v * Math.PI * 2;
      const r = R * rho * (0.87 + 0.13 * Math.sin(angle * 3 + i * 1.4));
      const dish = 0.19 * R * rho * rho + 0.022 * Math.sin(angle * 5 + i) * rho;
      target.set(Math.cos(angle) * r, y + dish, Math.sin(angle) * r);
    }, 22, 46);
    const cisterna = mesh(geometry, material);
    cisterna.userData.noShadow = true;
    group.add(cisterna);
  }
  const random = rng(seed);
  const vesicleMaterial = tissue(color, { roughness: 0.4, wet: 0.6 });
  for (let i = 0; i < 7; i++) {
    const v = mesh(blob(0.045 + random() * 0.03, { detail: 8, amp: 0.2, seed: seed + i }), vesicleMaterial);
    v.position.set((random() - 0.5) * 0.7, -0.28 - random() * 0.22, (random() - 0.5) * 0.7);
    group.add(v);
  }
  return group;
}

/** A lysosome: dense, acidic, with visible granular contents. */
export function lysosome(color: string, radius = 0.16, seed = 29) {
  const group = new THREE.Group();
  const shell = mesh(blob(radius, { detail: 16, amp: 0.13, freq: 3, seed }), tissue(color, { roughness: 0.34, transparent: true, opacity: 0.82, wet: 0.7 }));
  const grains = scatter(new THREE.IcosahedronGeometry(radius * 0.15, 0), tissue("#7c1533", { roughness: 0.8 }), 22, (_i, matrix, random) => {
    matrix.setPosition(onSphere(random).multiplyScalar(radius * 0.72 * Math.cbrt(random())));
  }, seed * 5);
  grains.userData.noShadow = true;
  group.add(shell, grains);
  return group;
}

/**
 * A centriole, drawn honestly: nine microtubule triplets set in a barrel, each
 * triplet tangentially tilted about 30°. This is the one place in the atlas
 * where cylinders are the correct primitive — microtubules really are tubes.
 */
export function centriole(color: string, radius = 0.085, length = 0.24) {
  const group = new THREE.Group();
  const material = tissue(color, { roughness: 0.42, wet: 0.4 });
  const geometry = new THREE.CylinderGeometry(radius * 0.17, radius * 0.17, length, 10, 1, true);
  for (let i = 0; i < 9; i++) {
    const angle = (i / 9) * Math.PI * 2;
    const triplet = new THREE.Group();
    for (let j = 0; j < 3; j++) {
      const tubule = mesh(geometry, material);
      tubule.rotation.z = Math.PI / 2;                 // lie along X, the barrel axis
      tubule.position.set(0, (j - 1) * radius * 0.33, 0);
      triplet.add(tubule);
    }
    triplet.position.set(0, Math.cos(angle) * radius, Math.sin(angle) * radius);
    // Rotating by angle + 90° puts the triplet's local +Y along the tangent, so
    // the three tubules stack sideways round the barrel rather than radially.
    triplet.rotation.x = angle + Math.PI / 2;
    triplet.rotateZ(0.52);                             // the ~30° tangential skew
    group.add(triplet);
  }
  const cartwheel = mesh(new THREE.TorusGeometry(radius * 0.42, radius * 0.06, 6, 18), material, [-length * 0.42, 0, 0], [0, Math.PI / 2, 0]);
  group.add(cartwheel);
  group.userData.material = material;
  return group;
}

/** A transport / secretory vesicle. */
export function vesicle(color: string, radius = 0.06, seed = 41) {
  return mesh(blob(radius, { detail: 10, amp: 0.18, freq: 4, seed }), membrane(color, 0.62, { thickness: 0.2, roughness: 0.2 }));
}

/** Free ribosomes drifting in the cytosol. */
export function ribosomes(count: number, extent: number, seed = 47) {
  const cloud = scatter(new THREE.IcosahedronGeometry(0.024, 1), tissue("#2c4f8f", { roughness: 0.6 }), count, (_i, matrix, random) => {
    matrix.setPosition(onSphere(random).multiplyScalar(extent * Math.cbrt(random())));
  }, seed);
  cloud.userData.noShadow = true;
  return cloud;
}

/**
 * The cytoskeleton: microtubules radiating from the centrosome out to the
 * cortex, plus a tangle of shorter cortical actin just under the membrane.
 */
export function cytoskeleton(color: string, origin: THREE.Vector3, cortex: number, seed = 53) {
  const group = new THREE.Group();
  const random = rng(seed);
  const material = tissue(color, { roughness: 0.5, transparent: true, opacity: 0.72, wet: 0.4 });
  const dir = new THREE.Vector3(), mid = new THREE.Vector3(), end = new THREE.Vector3();

  for (let i = 0; i < 26; i++) {
    onSphere(random, dir);
    end.copy(dir).multiplyScalar(cortex * (0.86 + random() * 0.1)).add(origin.clone().multiplyScalar(0.15));
    mid.copy(origin).lerp(end, 0.5).addScaledVector(onSphere(random, new THREE.Vector3()), cortex * 0.13);
    const geometry = tube([origin.clone(), mid.clone(), end.clone()], t => 0.014 * (1 - 0.45 * t), 24, 6);
    const filament = mesh(geometry, material);
    filament.userData.noShadow = true;
    group.add(filament);
  }
  // Cortical actin: short chords lying just inside the membrane.
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < 34; i++) {
    onSphere(random, a).multiplyScalar(cortex * 0.93);
    onSphere(random, dir);
    b.copy(a).addScaledVector(dir, cortex * 0.42).setLength(cortex * 0.95);
    c.copy(a).lerp(b, 0.5).setLength(cortex * 0.99);
    const geometry = tube([a.clone(), c.clone(), b.clone()], 0.009, 14, 5);
    const strand = mesh(geometry, material);
    strand.userData.noShadow = true;
    group.add(strand);
  }
  return group;
}

/** The plasma membrane itself: a bilayer read as two closely spaced shells. */
export function plasmaMembrane(color: string, radius: number, seed = 59, detail = 30) {
  const group = new THREE.Group();
  const outer = mesh(blob(radius, { detail, amp: 0.045, freq: 1.7, octaves: 4, seed }), membrane(color, 0.14, { thickness: 1.1, roughness: 0.08, transmission: 0.86 }));
  const inner = mesh(blob(radius * 0.975, { detail: detail - 6, amp: 0.045, freq: 1.7, octaves: 4, seed }), membrane(color, 0.1, { thickness: 0.4, side: THREE.BackSide }));
  outer.userData.noShadow = true; inner.userData.noShadow = true;
  group.add(outer, inner);
  return group;
}

/** Cytosol: a faint fluid volume so the interior does not read as empty air. */
export function cytosol(color: string, radius: number, seed = 61) {
  const m = mesh(blob(radius, { detail: 16, amp: 0.05, freq: 1.7, seed }), fluid(color, { opacity: 0.1, transmission: 0.96, thickness: 2.4 }));
  m.userData.noShadow = true;
  return m;
}
