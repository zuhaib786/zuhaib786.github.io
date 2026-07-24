import * as THREE from "three";
import { blob, clamp01, fluid, mesh, onSphere, ramp, rng, scatter, structure, tissue } from "../toolkit";
import { part, type Specimen } from "../types";

/*
 * The alimentary canal is one continuous tube, so it is built as one: a chain
 * of swept surfaces sharing endpoints, each with a radius that varies along the
 * tube *and* around it. That single idea produces the whole tract — the gastric
 * sac is a wide stretch, rugae are an angular ripple, haustra are a periodic
 * bulge, and peristalsis is a travelling constriction that rides through all of
 * them. The wall is deformed on the fly, so the wave is real motion of real
 * vertices rather than a texture scrolling past.
 *
 * +x is the patient's left, so the ascending colon runs up the -x side.
 */

/** A tube swept along a curve whose radius can be rewritten every frame. */
class Swept {
  curve: THREE.CatmullRomCurve3;
  segments: number;
  radial: number;
  arcStart: number;
  arcLength: number;
  centres: THREE.Vector3[] = [];
  normals: THREE.Vector3[] = [];
  binormals: THREE.Vector3[] = [];
  geometry = new THREE.BufferGeometry();
  length: number;

  constructor(points: THREE.Vector3[], segments: number, radial: number, arcStart = 0, arcLength = Math.PI * 2) {
    this.curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5);
    this.segments = segments; this.radial = radial;
    this.arcStart = arcStart; this.arcLength = arcLength;
    this.length = this.curve.getLength();

    const frames = this.curve.computeFrenetFrames(segments, false);
    for (let i = 0; i <= segments; i++) {
      this.centres.push(this.curve.getPointAt(i / segments));
      this.normals.push(frames.normals[Math.min(i, segments - 1)]);
      this.binormals.push(frames.binormals[Math.min(i, segments - 1)]);
    }
    const indices: number[] = [];
    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < radial; j++) {
        const a = i * (radial + 1) + j, b = a + radial + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    this.geometry.setIndex(indices);
    this.geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array((segments + 1) * (radial + 1) * 3), 3));
  }

  /** Rewrite the wall. `radius(t, angle)` is evaluated per vertex. */
  deform(radius: (t: number, angle: number) => number, recomputeNormals = true) {
    const position = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    let k = 0;
    for (let i = 0; i <= this.segments; i++) {
      const t = i / this.segments, c = this.centres[i], N = this.normals[i], B = this.binormals[i];
      for (let j = 0; j <= this.radial; j++, k++) {
        const angle = this.arcStart + (j / this.radial) * this.arcLength;
        const r = radius(t, angle);
        const cos = Math.cos(angle), sin = Math.sin(angle);
        position.setXYZ(k, c.x + r * (cos * N.x + sin * B.x), c.y + r * (cos * N.y + sin * B.y), c.z + r * (cos * N.z + sin * B.z));
      }
    }
    position.needsUpdate = true;
    if (recomputeNormals) this.geometry.computeVertexNormals();
  }

  /** A point on the lumen axis, plus the local frame, for anything travelling inside. */
  at(t: number, target: THREE.Vector3) {
    const i = THREE.MathUtils.clamp(Math.round(t * this.segments), 0, this.segments);
    return target.copy(this.centres[i]);
  }
}

/** Constriction profile of a peristaltic wave centred at `head`. */
const wave = (t: number, head: number, width: number, depth: number) =>
  1 - depth * Math.exp(-((t - head) ** 2) / (width * width));

/* ── the tract, laid out once ── */

const OESOPHAGUS = [
  new THREE.Vector3(0.02, 2.75, 0), new THREE.Vector3(0.03, 2.2, 0.02),
  new THREE.Vector3(0.05, 1.7, 0.04), new THREE.Vector3(0.08, 1.32, 0.05),
];
const STOMACH = [
  new THREE.Vector3(0.08, 1.32, 0.05), new THREE.Vector3(0.34, 1.1, 0.08),
  new THREE.Vector3(0.62, 0.72, 0.06), new THREE.Vector3(0.56, 0.3, 0.02),
  new THREE.Vector3(0.24, 0.12, 0.0), new THREE.Vector3(-0.06, 0.34, 0.03),
  new THREE.Vector3(-0.24, 0.42, 0.04),
];
/** Duodenal C-loop, then jejunal and ileal coils filling the abdomen. */
function intestinePoints() {
  const points = [
    new THREE.Vector3(-0.24, 0.42, 0.04), new THREE.Vector3(-0.5, 0.28, 0.02),
    new THREE.Vector3(-0.58, -0.06, 0.06), new THREE.Vector3(-0.3, -0.24, 0.1),
    new THREE.Vector3(-0.02, -0.12, 0.12),
  ];
  const random = rng(733);
  const LOOPS = 5;
  for (let l = 0; l < LOOPS; l++) {
    const y = -0.18 - l * 0.27;
    const width = 0.82 - l * 0.045;
    const depth = 0.54 - l * 0.05;
    const steps = 10;
    for (let s = 0; s < steps; s++) {
      const a = (s / steps) * Math.PI * 2 + (l % 2 ? Math.PI : 0);
      points.push(new THREE.Vector3(
        Math.sin(a) * width + (random() - 0.5) * 0.06,
        y - (s / steps) * 0.24 + Math.cos(a * 2) * 0.07,
        Math.cos(a) * depth + (random() - 0.5) * 0.05,
      ));
    }
  }
  points.push(new THREE.Vector3(-0.86, -1.62, 0.06));
  return points;
}
// The colon frames the coils: up the patient's right, across the front, down
// the left, so it sits anterior to the jejunum at the transverse segment.
const COLON = [
  new THREE.Vector3(-0.86, -1.62, 0.1), new THREE.Vector3(-1.16, -1.74, -0.12),
  new THREE.Vector3(-1.24, -1.1, -0.26), new THREE.Vector3(-1.2, -0.3, -0.3),
  new THREE.Vector3(-1.12, 0.5, -0.24), new THREE.Vector3(-0.72, 0.86, 0.02),
  new THREE.Vector3(0.0, 0.94, 0.16), new THREE.Vector3(0.78, 0.86, 0.02),
  new THREE.Vector3(1.16, 0.5, -0.24), new THREE.Vector3(1.22, -0.4, -0.3),
  new THREE.Vector3(1.12, -1.2, -0.24), new THREE.Vector3(0.72, -1.62, -0.1),
  new THREE.Vector3(0.24, -1.92, 0.02), new THREE.Vector3(0.04, -2.32, 0.06),
];

const parts = [
  part("oesophagus", "Oesophagus", "Transport", "#e0a48f",
    "A muscular tube running from the pharynx to the stomach, collapsed flat when empty.",
    "Drives the swallowed bolus down by peristalsis — a ring of contraction travelling behind it.",
    "Muscular tube", "≈ 25 cm",
    "Swallowing does not rely on gravity. The wave works upside down, which is how an astronaut eats."),
  part("stomach", "Stomach", "Mechanical & acid digestion", "#e8735f",
    "A J-shaped muscular sac, its lining thrown into longitudinal folds — the rugae.",
    "Churns food with hydrochloric acid and pepsin until it becomes a semi-fluid chyme.",
    "Muscular sac", "holds ≈ 1–1.5 L",
    "The rugae are slack that lets the stomach expand. They flatten out as it fills, which is why it can hold a litre."),
  part("small-intestine", "Small intestine", "Digestion & absorption", "#ffb35f",
    "Duodenum, jejunum and ileum, coiled into the abdomen in metres of tube.",
    "Completes digestion with pancreatic enzymes and bile, and absorbs nearly all the nutrients.",
    "Coiled tube", "≈ 6–7 m",
    "It is folded this tightly because it has to be long. Length is surface area, and surface area is absorption."),
  part("villi", "Villi", "Absorptive surface", "#ffd98a",
    "Finger-like projections of the lining, shown here through a cut in one loop, each covered in microvilli.",
    "Multiply the absorptive area roughly sixty-fold and hand nutrients to blood and lymph.",
    "Mucosal projection", "≈ 1 mm tall",
    "Villi, folds and microvilli together take the gut's surface from a few square metres to about thirty."),
  part("large-intestine", "Large intestine", "Water recovery", "#c47f9c",
    "The colon framing the small intestine, pouched into haustra by its incomplete muscle bands.",
    "Reclaims water and salts and houses the microbiota that ferment what is left.",
    "Pouched tube", "≈ 1.5 m",
    "The pouches exist because the outer muscle is three narrow ribbons shorter than the gut, so it gathers like a curtain."),
  part("bolus", "Bolus & chyme", "The meal itself", "#8fbf5f",
    "The swallowed mass, tracked from bolus through acidic chyme to compacted residue.",
    "Nothing — this is what is being acted on, and its changing state is the point of the whole tract.",
    "Luminal contents", "transit ≈ 24–72 h",
    "Follow it: solid down the oesophagus, fluid in the stomach, thinned in the small intestine, dried out in the colon."),
];

export const digestion: Specimen = {
  id: "digestion",
  name: "Digestion",
  subtitle: "one meal, end to end",
  code: "PROCESS 03 / ALIMENTARY CANAL",
  scale: "≈ 30 hours, compressed",
  aria: "animated digestive tract moving a meal along",
  category: "process",
  duration: 26,
  phases: [
    { at: 0, name: "Swallowing", caption: "A peristaltic ring travels down the oesophagus, pushing the bolus ahead of it." },
    { at: 0.16, name: "Gastric churning", caption: "The stomach's rugae work the bolus against acid and pepsin until it liquefies into chyme." },
    { at: 0.4, name: "Gastric emptying", caption: "The pylorus releases chyme into the duodenum a few millilitres at a time." },
    { at: 0.52, name: "Absorption", caption: "Along the coils, villi take up nutrients — see them through the cut loop at the front." },
    { at: 0.78, name: "Water recovery", caption: "The colon's haustra reclaim water and salts from what could not be absorbed." },
    { at: 0.92, name: "Residue", caption: "What remains is compacted and held in the sigmoid colon." },
  ],
  parts,
  build() {
    const group = new THREE.Group();
    const random = rng(881);

    const wallMaterial = (color: string) => tissue(color, { roughness: 0.6, wet: 0.55, side: THREE.DoubleSide });

    const oesophagus = new Swept(OESOPHAGUS, 48, 20);
    const stomach = new Swept(STOMACH, 96, 30);
    const intestinePts = intestinePoints();
    const intestine = new Swept(intestinePts, 260, 16);
    const colon = new Swept(COLON, 180, 22);
    // The cut loop: the same path as one jejunal coil, swept through part of a
    // circle so the lumen is open to the viewer and the villi are visible.
    const cutPoints = intestinePts.slice(16, 27);
    const cutLoop = new Swept(cutPoints, 90, 18, Math.PI * 0.62, Math.PI * 1.16);

    const oesophagusMesh = mesh(oesophagus.geometry, wallMaterial("#e0a48f"));
    const stomachMesh = mesh(stomach.geometry, wallMaterial("#e8735f"));
    const intestineMesh = mesh(intestine.geometry, wallMaterial("#ffb35f"));
    const colonMesh = mesh(colon.geometry, wallMaterial("#c47f9c"));
    const cutMesh = mesh(cutLoop.geometry, tissue("#ffc98a", { roughness: 0.55, wet: 0.6, side: THREE.DoubleSide }));

    group.add(structure("oesophagus", "#e0a48f", oesophagusMesh));
    group.add(structure("stomach", "#e8735f", stomachMesh));
    group.add(structure("small-intestine", "#ffb35f", intestineMesh, cutMesh));
    group.add(structure("large-intestine", "#c47f9c", colonMesh));

    /* ── villi lining the cut loop ── */
    const VILLI = 520;
    const villusGeometry = new THREE.CylinderGeometry(0.004, 0.011, 0.055, 5, 1);
    villusGeometry.translate(0, 0.0275, 0);
    const villi = scatter(villusGeometry, tissue("#ffd98a", { roughness: 0.55, wet: 0.5 }), VILLI, () => {}, 977);
    villi.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    villi.userData.noShadow = true;
    group.add(structure("villi", "#ffd98a", villi));
    const villusSeeds = Array.from({ length: VILLI }, () => ({
      t: random(), angle: Math.PI * 0.66 + random() * Math.PI * 1.08, phase: random() * Math.PI * 2, scale: 0.7 + random() * 0.6,
    }));

    /* ── the meal ── */
    const bolus = mesh(blob(0.12, { detail: 18, amp: 0.2, freq: 3.4, seed: 41 }), tissue("#8fbf5f", { roughness: 0.7, wet: 0.4 }));
    const chyme = mesh(blob(0.19, { detail: 18, amp: 0.14, freq: 2.6, seed: 47 }), fluid("#b9a05f", { opacity: 0.62, transmission: 0.6, thickness: 0.5 }));
    chyme.userData.noShadow = true;
    const grains = scatter(new THREE.IcosahedronGeometry(0.018, 0), tissue("#8f7a3f", { roughness: 0.8 }), 90, () => {}, 1031);
    grains.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    grains.userData.noShadow = true;
    group.add(structure("bolus", "#8fbf5f", bolus, chyme, grains));
    const grainSeeds = Array.from({ length: 90 }, () => ({ dir: onSphere(random), radius: random(), speed: 0.6 + random() * 1.4, phase: random() * Math.PI * 2 }));

    /* ── nutrients crossing the villous surface during absorption ── */
    const NUTRIENTS = 60;
    const nutrients = scatter(new THREE.IcosahedronGeometry(0.016, 0), tissue("#ffe9a8", { roughness: 0.3, emissive: new THREE.Color("#5a4610"), wet: 0.8 }), NUTRIENTS, () => {}, 1087);
    nutrients.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    nutrients.userData.noShadow = true;
    group.add(structure("villi", "#ffd98a", nutrients));
    const nutrientSeeds = Array.from({ length: NUTRIENTS }, () => ({ t: random(), angle: Math.PI * 0.66 + random() * Math.PI * 1.08, offset: random() }));

    const matrix = new THREE.Matrix4(), point = new THREE.Vector3(), scaleVec = new THREE.Vector3();
    const quaternion = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), inward = new THREE.Vector3();
    const surface = new THREE.Vector3();

    /** Where the meal is: which tube, and how far along it. */
    const locate = (progress: number) => {
      if (progress < 0.16) return { tube: oesophagus, t: ramp(progress, 0.0, 0.16) };
      if (progress < 0.44) return { tube: stomach, t: ramp(progress, 0.14, 0.44) };
      if (progress < 0.8) return { tube: intestine, t: ramp(progress, 0.42, 0.8) };
      return { tube: colon, t: ramp(progress, 0.78, 1) };
    };

    return {
      group,
      seek(progress) {
        const here = locate(progress);
        const churn = ramp(progress, 0.16, 0.3) * (1 - ramp(progress, 0.42, 0.5));
        const liquefy = ramp(progress, 0.2, 0.4);
        const absorbing = ramp(progress, 0.5, 0.6) * (1 - ramp(progress, 0.76, 0.84));
        const clock = progress * 40;

        // Oesophagus: a single deep ring travelling ahead of nothing but the bolus.
        const oesoHead = here.tube === oesophagus ? here.t : 2;
        oesophagus.deform((t, angle) => 0.095 * wave(t, oesoHead, 0.1, 0.72) * (1 + 0.05 * Math.sin(angle * 6)), here.tube === oesophagus);

        // Stomach: a wide sac with longitudinal rugae, and churning waves that
        // sweep toward the pylorus once there is something in it.
        stomach.deform((t, angle) => {
          const sac = 0.11 + 0.34 * Math.sin(Math.PI * THREE.MathUtils.clamp((t - 0.02) / 0.92, 0, 1)) ** 0.8;
          const rugae = 1 + 0.075 * Math.sin(angle * 9 + t * 5.5) * (1 - 0.5 * liquefy);
          const churning = 1 - 0.24 * churn * Math.exp(-((t - ((clock * 0.16) % 1.2)) ** 2) / 0.012);
          const pylorus = 1 - 0.55 * Math.exp(-((t - 0.97) ** 2) / 0.0025) * (1 - ramp(progress, 0.4, 0.46));
          return sac * rugae * churning * pylorus;
        }, true);

        // Small intestine: segmentation contractions everywhere, plus the wave
        // that is actually carrying this meal along.
        const gutHead = here.tube === intestine ? here.t : -2;
        intestine.deform((t, angle) => {
          const base = 0.082 - 0.016 * t;
          const segmentation = 1 - 0.12 * Math.sin(t * 210 - clock * 1.4) ** 2;
          return base * segmentation * wave(t, gutHead, 0.035, 0.5) * (1 + 0.03 * Math.sin(angle * 8));
        }, here.tube === intestine);
        cutLoop.deform((t, angle) => 0.085 * (1 - 0.08 * Math.sin(t * 60 - clock * 1.4) ** 2) * (1 + 0.02 * Math.sin(angle * 8)), false);

        // Colon: haustral pouches, and mass movements when the residue arrives.
        const colonHead = here.tube === colon ? here.t : -2;
        colon.deform((t, angle) => {
          const base = 0.135 - 0.035 * t;
          const haustra = 1 + 0.16 * Math.sin(t * 46) ** 2 - 0.1;
          return base * haustra * wave(t, colonHead, 0.05, 0.35) * (1 + 0.04 * Math.sin(angle * 5 + t * 20));
        }, here.tube === colon);

        /* ── the meal itself ── */
        here.tube.at(here.t, point);
        const solid = 1 - liquefy;
        bolus.position.copy(point);
        bolus.visible = solid > 0.08;
        bolus.scale.setScalar(0.6 + 0.5 * solid);
        chyme.position.copy(point);
        chyme.visible = liquefy > 0.05 && progress < 0.94;
        chyme.scale.setScalar((0.5 + 0.6 * liquefy) * (1 - 0.45 * ramp(progress, 0.5, 0.85)));
        const chymeMaterial = chyme.material as THREE.MeshPhysicalMaterial;
        chymeMaterial.color.set("#b9a05f").lerp(new THREE.Color("#8a6a3a"), ramp(progress, 0.55, 0.95));

        grainSeeds.forEach((seed, i) => {
          const spin = clock * seed.speed * (0.2 + churn * 1.6) + seed.phase;
          const spread = (0.06 + 0.16 * liquefy) * (0.4 + 0.6 * seed.radius);
          scaleVec.copy(seed.dir).applyAxisAngle(up, spin).multiplyScalar(spread);
          matrix.makeTranslation(point.x + scaleVec.x, point.y + scaleVec.y * 0.7, point.z + scaleVec.z);
          grains.setMatrixAt(i, matrix);
        });
        grains.instanceMatrix.needsUpdate = true;

        /* ── villi: always there, swaying; lit up while absorbing ── */
        villusSeeds.forEach((seed, i) => {
          const index = THREE.MathUtils.clamp(Math.round(seed.t * cutLoop.segments), 0, cutLoop.segments);
          const c = cutLoop.centres[index], N = cutLoop.normals[index], B = cutLoop.binormals[index];
          const sway = 0.16 * Math.sin(clock * 0.9 + seed.phase) * (0.3 + absorbing);
          const angle = seed.angle + sway * 0.25;
          const r = 0.083;
          inward.set(-(Math.cos(angle) * N.x + Math.sin(angle) * B.x), -(Math.cos(angle) * N.y + Math.sin(angle) * B.y), -(Math.cos(angle) * N.z + Math.sin(angle) * B.z)).normalize();
          surface.set(c.x - inward.x * r, c.y - inward.y * r, c.z - inward.z * r);
          quaternion.setFromUnitVectors(up, inward);
          matrix.compose(surface, quaternion, scaleVec.set(1, seed.scale * (0.85 + 0.3 * absorbing), 1));
          villi.setMatrixAt(i, matrix);
        });
        villi.instanceMatrix.needsUpdate = true;

        nutrients.visible = absorbing > 0.03;
        nutrientSeeds.forEach((seed, i) => {
          const index = THREE.MathUtils.clamp(Math.round(seed.t * cutLoop.segments), 0, cutLoop.segments);
          const c = cutLoop.centres[index], N = cutLoop.normals[index], B = cutLoop.binormals[index];
          // Travel from the lumen, through the villous tip, out into the wall.
          const u = (seed.offset + clock * 0.06) % 1;
          const depth = 0.055 - u * 0.11;
          const cos = Math.cos(seed.angle), sin = Math.sin(seed.angle);
          const r = 0.083 - depth;
          matrix.makeTranslation(c.x + r * (cos * N.x + sin * B.x), c.y + r * (cos * N.y + sin * B.y), c.z + r * (cos * N.z + sin * B.z));
          matrix.scale(scaleVec.setScalar(clamp01(Math.sin(u * Math.PI) * 1.6) * absorbing));
          nutrients.setMatrixAt(i, matrix);
        });
        nutrients.instanceMatrix.needsUpdate = true;
      },
    };
  },
};
