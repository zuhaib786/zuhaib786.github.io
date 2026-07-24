import * as THREE from "three";
import { blob, fbm, mesh, ridged, smooth, structure, tissue, tube } from "../toolkit";
import { part, type Specimen } from "../types";

/*
 * A cortex is not a bumpy ball. Gyri and sulci are creases, and creases come
 * from ridged noise — `1 - |n|`, which folds the field at every zero crossing
 * instead of rounding it off. On top of that the two anatomical landmarks that
 * actually define the silhouette are cut in explicitly: the longitudinal
 * fissure between the hemispheres, and the lateral (Sylvian) sulcus that lifts
 * the temporal lobe away from the frontal and parietal lobes.
 *
 * Axes: +z anterior, +y superior, +x the patient's left.
 */

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Height of the Sylvian sulcus at a given anteroposterior position. */
const sylvianLine = (z: number) => -0.1 + 0.26 * z;

/** The cortical surface, as a function of direction. Used for the mesh and,
 *  because it is analytic, for anything that has to sit on the cortex. */
function cortex(dir: THREE.Vector3, target = new THREE.Vector3()) {
  let r = 1;
  r += 0.082 * (ridged(dir, { octaves: 4, freq: 3.0, seed: 3 }) - 0.55);   // gyri
  r += 0.03 * (ridged(dir, { octaves: 3, freq: 7.4, seed: 8 }) - 0.5);     // secondary sulci
  r += 0.02 * fbm(dir, { octaves: 3, freq: 2.1, seed: 12 });               // gentle asymmetry

  // Longitudinal fissure: a deep midline cleft, only over the top.
  const midline = Math.exp(-(dir.x * dir.x) / 0.0042) * smoothstep(-0.05, 0.45, dir.y);
  r -= 0.13 * midline;

  // Lateral sulcus: a groove running back from the front, on the sides only.
  const lateral = Math.exp(-((dir.y - sylvianLine(dir.z)) ** 2) / 0.011) * smoothstep(0.22, 0.5, Math.abs(dir.x)) * smoothstep(-0.75, -0.4, dir.z);
  r -= 0.1 * lateral;

  // Central sulcus: the frontal/parietal border, an oblique groove over the top.
  const central = Math.exp(-((dir.z - 0.06 + 0.34 * dir.y) ** 2) / 0.006) * smoothstep(0.05, 0.4, dir.y);
  r -= 0.05 * central;

  target.set(dir.x * r * 0.94, dir.y * r * 0.87, dir.z * r * 1.16);
  // Flatten the inferior surface — a brain sits on the skull base, it is not round underneath.
  if (target.y < -0.3) target.y = -0.3 + (target.y + 0.3) * 0.7;
  // Draw the frontal pole in and drop the occipital pole slightly.
  target.z *= 1 - 0.12 * smoothstep(0.5, 1.15, target.z);
  target.y -= 0.06 * smoothstep(-0.6, -1.05, target.z);
  return target;
}

type Lobe = "frontal" | "parietal" | "temporal" | "occipital";

/** Which lobe a point on the cortex belongs to, using the same landmarks the
 *  surface was creased along — so the colour boundaries land in the sulci. */
function lobeOf(dir: THREE.Vector3): Lobe {
  if (dir.z < -0.6) return "occipital";
  if (Math.abs(dir.x) > 0.3 && dir.z < 0.5 && dir.y < sylvianLine(dir.z)) return "temporal";
  if (dir.z > 0.1 - 0.34 * dir.y) return "frontal";
  return "parietal";
}

const COLOURS: Record<Lobe, string> = { frontal: "#a17fe8", parietal: "#5f9ae8", temporal: "#e8935f", occipital: "#4fc9b0" };

/** Build one welded, smooth-shaded mesh per lobe out of a single displaced icosphere. */
function corticalLobes() {
  const base = new THREE.IcosahedronGeometry(1, 44);
  const position = base.getAttribute("position") as THREE.BufferAttribute;
  const buckets: Record<Lobe, number[]> = { frontal: [], parietal: [], temporal: [], occipital: [] };
  const dirs = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const centroid = new THREE.Vector3();

  for (let f = 0; f < position.count; f += 3) {
    centroid.set(0, 0, 0);
    for (let i = 0; i < 3; i++) {
      dirs[i].fromBufferAttribute(position, f + i).normalize();
      cortex(dirs[i], points[i]);
      centroid.add(dirs[i]);
    }
    const bucket = buckets[lobeOf(centroid.normalize())];
    for (let i = 0; i < 3; i++) bucket.push(points[i].x, points[i].y, points[i].z);
  }
  base.dispose();

  return (Object.keys(buckets) as Lobe[]).map(lobe => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(buckets[lobe], 3));
    return { lobe, mesh: mesh(smooth(geometry, 1e-5), tissue(COLOURS[lobe], { roughness: 0.66, wet: 0.55, sheenRoughness: 0.45 })) };
  });
}

/** Cerebellum: fine, parallel, transverse folia — a completely different fold
 *  pattern from the cortex, which is exactly how you recognise it. */
function cerebellum() {
  const geometry = blob(0.52, {
    detail: 38, amp: 0.03, freq: 3.4, seed: 21, scale: [1.5, 0.78, 0.98],
    warp: (dir, radius) => {
      const folia = Math.sin(Math.asin(THREE.MathUtils.clamp(dir.z, -1, 1)) * 15) * 0.5 + 0.5;
      const vermis = 1 - 0.55 * Math.exp(-(dir.x * dir.x) / 0.02);   // midline ridge sits proud
      return radius * (0.035 * folia * vermis - 0.03 * Math.exp(-(dir.x * dir.x) / 0.006));
    },
  });
  return mesh(geometry, tissue("#d9a15f", { roughness: 0.7, wet: 0.5 }));
}

const parts = [
  part("frontal", "Frontal lobe", "Cerebral cortex", COLOURS.frontal,
    "The largest lobe, running from the frontal pole back to the central sulcus.",
    "Drives voluntary movement, planning and judgement, and — on the left — the production of speech.",
    "Cortical lobe", "≈ 40% of the cortex",
    "The strip of cortex on its rear border maps the whole body, with absurdly large hands and lips."),
  part("parietal", "Parietal lobe", "Cerebral cortex", COLOURS.parietal,
    "Sits behind the central sulcus, across the upper-rear of each hemisphere.",
    "Integrates touch, position and spatial attention into a single sense of where the body and world are.",
    "Cortical lobe", "≈ upper-rear cortex",
    "Damage on the right can erase the left half of the world so completely that patients shave only one cheek."),
  part("temporal", "Temporal lobe", "Cerebral cortex", COLOURS.temporal,
    "Lifted away below the lateral sulcus, wrapping the side of each hemisphere.",
    "Handles hearing and the comprehension of language, and — via the hippocampus inside — lays down new memories.",
    "Cortical lobe", "≈ lower-side cortex",
    "The deep groove above it is the lateral sulcus; it is the most reliable landmark on the whole brain surface."),
  part("occipital", "Occipital lobe", "Cerebral cortex", COLOURS.occipital,
    "The rearmost lobe, tucked against the back of the skull above the cerebellum.",
    "Receives and interprets vision, from raw edges and motion up to recognisable objects.",
    "Cortical lobe", "≈ rear cortex",
    "It is at the back of the head, as far from the eyes as it is possible to be inside a skull."),
  part("cerebellum", "Cerebellum", "Motor coordination", "#d9a15f",
    "The tightly pleated structure beneath the occipital lobe, its folia far finer than cortical gyri.",
    "Times and smooths movement, balance and posture, and stores motor skills once they are learned.",
    "Hindbrain structure", "≈ 10% of brain volume",
    "It holds more neurons than the rest of the brain combined — the folding here is packing, not decoration."),
  part("brainstem", "Brainstem", "Vital control", "#c86b7a",
    "The stalk of midbrain, pons and medulla joining brain to spinal cord.",
    "Runs breathing, heart rate and consciousness, and carries every signal passing between brain and body.",
    "Midbrain, pons, medulla", "≈ 7–8 cm",
    "Almost nothing here is optional. It is the smallest region whose loss is immediately fatal."),
];

export const brain: Specimen = {
  id: "brain",
  name: "Human brain",
  subtitle: "cortical anatomy",
  code: "SPECIMEN 05 / NERVOUS SYSTEM",
  scale: "≈ 15 cm",
  aria: "three-dimensional human brain",
  category: "anatomy",
  parts,
  build() {
    const group = new THREE.Group();
    const cerebrum = new THREE.Group();
    corticalLobes().forEach(({ lobe, mesh: lobeMesh }) => cerebrum.add(structure(lobe, COLOURS[lobe], lobeMesh)));
    group.add(cerebrum);

    const cerebellumMesh = cerebellum();
    cerebellumMesh.position.set(0, -0.5, -0.82);
    cerebellumMesh.rotation.x = 0.22;
    group.add(structure("cerebellum", "#d9a15f", cerebellumMesh));

    const stemMaterial = tissue("#c86b7a", { roughness: 0.62, wet: 0.55 });
    const stem = new THREE.Group();
    stem.add(mesh(tube([
      new THREE.Vector3(0, -0.24, -0.1), new THREE.Vector3(0, -0.52, -0.22),
      new THREE.Vector3(0, -0.82, -0.34), new THREE.Vector3(0, -1.24, -0.44),
      new THREE.Vector3(0, -1.72, -0.5),
    ], t => 0.19 - 0.07 * t, 48, 22), stemMaterial));
    // Pons: the transverse bulge where fibres cross into the cerebellum.
    stem.add(mesh(blob(0.21, { detail: 20, amp: 0.08, freq: 3, seed: 27, scale: [1.15, 1.05, 1.1] }), stemMaterial, [0, -0.66, -0.14]));
    group.add(structure("brainstem", "#c86b7a", stem));

    // A brain visibly pulses with each arterial beat and again, more slowly,
    // with the respiratory cycle. Both are real; both are exaggerated here.
    return {
      group,
      update(time) {
        const beat = 1 + 0.006 * Math.sin(time * 7.3) + 0.004 * Math.sin(time * 1.1);
        cerebrum.scale.setScalar(beat);
        cerebellumMesh.scale.setScalar(beat);
      },
    };
  },
};
