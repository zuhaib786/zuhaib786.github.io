import * as THREE from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { nucleus } from "../organelles";
import { blob, clamp01, membrane, mesh, ramp, rng, structure, tissue, tube } from "../toolkit";
import { part, type Specimen } from "../types";

/*
 * Phagocytosis has to be shown with a surface that can actually change its
 * topology — a fixed mesh cannot wrap around something and seal behind it. So
 * the macrophage is a metaball field: the pseudopods are chains of balls laid
 * along a curving path, and when the two arms meet on the far side of the
 * bacterium the isosurface closes over it on its own. Nothing is faked with a
 * cut or a fade; the cup really shuts.
 */

const SIZE = 2.4;
const put = (field: MarchingCubes, p: THREE.Vector3, strength: number, subtract = 12) =>
  field.addBall(0.5 + p.x * 0.5, 0.5 + p.y * 0.5, 0.5 + p.z * 0.5, strength, subtract);

const parts = [
  part("macrophage", "Macrophage", "Innate immunity", "#7fd4c4",
    "A professional phagocyte, crawling by the same cytoplasmic flow an amoeba uses.",
    "Patrols tissue, recognises what does not belong there, and eats it.",
    "White blood cell", "≈ 20 µm",
    "The name means 'big eater'. A single macrophage can clear a hundred bacteria before it dies."),
  part("pseudopodia", "Phagocytic cup", "Engulfment", "#9ce8ff",
    "Two arms of membrane raised around the bound target, driven by the actin bundles drawn inside them.",
    "Zipper up along the pathogen's surface until they meet and fuse behind it.",
    "Actin-driven projection", "closes in ≈ 30 s",
    "The arms follow the target's contour receptor by receptor — this is called the zipper model, and it is why the fit is so close."),
  part("pathogen", "Bacterium", "Target", "#b9e05f",
    "A rod-shaped bacterium, flagellated, tagged by antibody and complement.",
    "Nothing — from here on it is substrate. Those surface tags are what marked it for eating.",
    "Prokaryote", "≈ 2 µm long",
    "Opsonins are the label. An unlabelled bacterium is often ignored; the immune system mostly eats what has been marked."),
  part("phagosome", "Phagosome", "Internalised vesicle", "#ffb35f",
    "The sealed vesicle formed when the cup closes, its membrane derived from the cell surface.",
    "Isolates the pathogen and matures by fusing with lysosomes.",
    "Membrane-bound vesicle", "≈ 3 µm",
    "The inner face of this vesicle was the outside of the cell a moment ago — the bacterium is still technically outside it."),
  part("lysosome", "Lysosomes", "Digestion", "#ff597b",
    "Acidic vesicles converging on the phagosome and fusing with it.",
    "Deliver hydrolases and drop the pH, digesting the contents into fragments.",
    "Acidic vesicle", "pH ≈ 4.5",
    "Fused, the two become a phagolysosome — and some of the fragments get displayed on the surface to recruit the rest of the immune system."),
  part("nucleus", "Nucleus", "Nuclear apparatus", "#9c78ff",
    "The macrophage's kidney-shaped nucleus, shouldered aside by the growing vesicle.",
    "Transcribes the inflammatory response the cell mounts while it is eating.",
    "Double-membrane organelle", "≈ 8 µm",
    "Eating is not silent — the cell is signalling to the immune system throughout."),
];

export const phagocytosis: Specimen = {
  id: "phagocytosis",
  name: "Phagocytosis",
  subtitle: "a macrophage eats",
  code: "PROCESS 01 / INNATE IMMUNITY",
  scale: "≈ 30 s, real time",
  aria: "animated macrophage engulfing a bacterium",
  category: "process",
  duration: 16,
  phases: [
    { at: 0, name: "Chemotaxis", caption: "The macrophage crawls up a chemical gradient toward the bacterium." },
    { at: 0.17, name: "Recognition", caption: "Surface receptors bind the opsonins tagging the bacterium. The membrane commits." },
    { at: 0.3, name: "Cup extension", caption: "Actin drives two arms of membrane out around the target, following its contour." },
    { at: 0.52, name: "Closure", caption: "The arms meet behind the bacterium and fuse. The surface seals into a phagosome." },
    { at: 0.68, name: "Lysosome fusion", caption: "Lysosomes dock and empty into the vesicle, collapsing its pH toward 4.5." },
    { at: 0.84, name: "Digestion", caption: "Hydrolases break the bacterium down; what is left will be presented or expelled." },
  ],
  parts,
  build() {
    const group = new THREE.Group();
    const random = rng(509);

    const cell = new MarchingCubes(
      48,
      membrane("#7fd4c4", 0.5, { transmission: 0.46, thickness: 0.6, roughness: 0.16, side: THREE.FrontSide, depthWrite: false }),
      true, false, 40000,
    );
    cell.scale.setScalar(SIZE);
    cell.isolation = 55;
    cell.userData.noShadow = true;
    cell.userData.volume = 1;
    group.add(structure("macrophage", "#7fd4c4", cell));

    // The arms are part of the same isosurface as the body, so the cup gets its
    // own geometry from what actually builds it: bundles of actin polymerising
    // along each arm. Selecting the cup selects those.
    const SEGMENTS = 12, ARMS = 2;
    const actin = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 1, 5, 1, true),
      tissue("#9ce8ff", { roughness: 0.4, transparent: true, opacity: 0.85, wet: 0.5, side: THREE.DoubleSide }),
      SEGMENTS * ARMS,
    );
    actin.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    actin.userData.noShadow = true;
    group.add(structure("pseudopodia", "#9ce8ff", actin));

    const nucleusGroup = nucleus("#9c78ff", 0.42, 19, 52);
    group.add(structure("nucleus", "#9c78ff", nucleusGroup));

    /* ── the bacterium: a rod with flagella ── */
    const bug = new THREE.Group();
    const body = mesh(blob(0.17, { detail: 22, amp: 0.07, freq: 3, seed: 71, scale: [2.1, 1, 1] }), tissue("#b9e05f", { roughness: 0.42, wet: 0.6 }));
    bug.add(body);
    const flagellumMaterial = tissue("#8fbf3f", { roughness: 0.5, transparent: true, opacity: 0.9 });
    const flagella: THREE.Object3D[] = [];
    for (let i = 0; i < 3; i++) {
      const base = new THREE.Vector3(-0.34, (i - 1) * 0.07, (random() - 0.5) * 0.12);
      const points = Array.from({ length: 7 }, (_, k) => new THREE.Vector3(base.x - k * 0.09, base.y + Math.sin(k * 1.1 + i) * 0.06, base.z + Math.cos(k * 1.1 + i) * 0.06));
      const f = mesh(tube(points, 0.014, 26, 6), flagellumMaterial);
      f.userData.noShadow = true;
      flagella.push(f);
      bug.add(f);
    }
    group.add(structure("pathogen", "#b9e05f", bug));

    /* ── phagosome membrane, revealed once the cup seals ── */
    const phagosome = mesh(blob(0.34, { detail: 24, amp: 0.08, freq: 2.6, seed: 83 }), membrane("#ffb35f", 0.34, { thickness: 0.4 }));
    phagosome.userData.noShadow = true;
    group.add(structure("phagosome", "#ffb35f", phagosome));

    /* ── lysosomes that migrate in and fuse ── */
    const lysosomes = new THREE.Group();
    const lysosomeBodies: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const l = mesh(blob(0.1 + random() * 0.03, { detail: 16, amp: 0.14, seed: 91 + i * 4 }), membrane("#ff597b", 0.62, { thickness: 0.3 }));
      lysosomeBodies.push(l);
      lysosomes.add(l);
    }
    group.add(structure("lysosome", "#ff597b", lysosomes));

    const bugStart = new THREE.Vector3(0.95, 0.12, 0.06);
    const lysosomeHome = [new THREE.Vector3(-0.75, 0.42, 0.3), new THREE.Vector3(-0.82, -0.3, -0.25), new THREE.Vector3(-0.5, -0.55, 0.45)];
    const armDirs = [1, -1];
    const point = new THREE.Vector3(), bugAt = new THREE.Vector3();
    const controls = [new THREE.Vector3(), new THREE.Vector3()];
    const start = new THREE.Vector3(), meet = new THREE.Vector3();
    const matrix = new THREE.Matrix4(), head = new THREE.Vector3(), tail = new THREE.Vector3();
    const span = new THREE.Vector3(), mid = new THREE.Vector3(), quaternion = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0), scaleVec = new THREE.Vector3();

    /** A point `along` the arm's sweep, as a quadratic Bezier: body → round the
     *  side of the bacterium → the meeting point beyond it. */
    const armAt = (arm: number, along: number, out: THREE.Vector3) => {
      const control = controls[arm], inv = 1 - along;
      return out.set(
        inv * inv * start.x + 2 * inv * along * control.x + along * along * meet.x,
        inv * inv * start.y + 2 * inv * along * control.y + along * along * meet.y,
        inv * inv * start.z + 2 * inv * along * control.z + along * along * meet.z,
      );
    };

    return {
      group,
      seek(progress) {
        const approach = ramp(progress, 0.02, 0.2);
        const extend = ramp(progress, 0.3, 0.55);
        const sealed = ramp(progress, 0.52, 0.62);
        const internalise = ramp(progress, 0.58, 0.72);
        const fusing = ramp(progress, 0.66, 0.8);
        const digested = ramp(progress, 0.82, 0.98);

        // Where the target is: outside, then bound at the surface, then hauled in.
        const bound = bugStart.clone().multiplyScalar(0.62);
        bugAt.copy(bugStart).lerp(bound, approach).lerp(new THREE.Vector3(0.16, -0.05, 0), internalise);
        bug.position.copy(bugAt);
        bug.rotation.z = 0.2 - 0.5 * internalise;
        bug.scale.setScalar(1 - 0.62 * digested);
        (body.material as THREE.MeshPhysicalMaterial).roughness = 0.42 + 0.4 * digested;
        flagella.forEach(f => { f.visible = digested < 0.35; });

        /* ── the metaball field ── */
        cell.reset();
        put(cell, new THREE.Vector3(-0.18, 0, 0), 0.72);
        put(cell, new THREE.Vector3(-0.34, 0.12, 0.08), 0.42);
        put(cell, new THREE.Vector3(-0.24, -0.16, -0.1), 0.42);
        // A trailing uropod, so the cell reads as crawling rather than sitting.
        put(cell, new THREE.Vector3(-0.62, -0.06, -0.04), 0.3 * (1 - internalise * 0.5));

        // Both arms follow the same sweep: from the cell body, past the
        // bacterium on either side, to a meeting point beyond it.
        const toBug = span.copy(bugAt).normalize();
        const side = mid.set(-toBug.y, toBug.x, 0.35).normalize();
        meet.copy(bugAt).addScaledVector(toBug, 0.34);
        start.copy(toBug).multiplyScalar(0.22);
        armDirs.forEach((sign, arm) => controls[arm].copy(bugAt).addScaledVector(side, sign * 0.62).addScaledVector(toBug, -0.1));

        const reach = digested < 0.9 ? extend : 0;
        if (reach > 0.001) {
          const STEPS = 7;
          for (let arm = 0; arm < ARMS; arm++) {
            for (let s = 1; s <= STEPS; s++) {
              put(cell, armAt(arm, (s / STEPS) * reach, point), 0.3 * (1 - 0.25 * (s / STEPS)) * (1 - 0.8 * internalise), 14);
            }
          }
        }
        if (internalise > 0.01) put(cell, point.copy(bugAt).multiplyScalar(0.9), 0.34 * internalise, 12);
        cell.update();

        // Actin bundles laid segment by segment along the same two sweeps, in
        // scene units — the field is normalised, the mesh is not.
        const thickness = 0.028 * SIZE * (1 - internalise * 0.7);
        for (let arm = 0, index = 0; arm < ARMS; arm++) {
          for (let s = 0; s < SEGMENTS; s++, index++) {
            armAt(arm, (s / SEGMENTS) * reach, tail).multiplyScalar(SIZE);
            armAt(arm, ((s + 1) / SEGMENTS) * reach, head).multiplyScalar(SIZE);
            span.copy(head).sub(tail);
            const length = span.length();
            if (reach < 0.02 || length < 1e-5) { actin.setMatrixAt(index, matrix.makeScale(0, 0, 0)); continue; }
            mid.copy(tail).addScaledVector(span, 0.5);
            quaternion.setFromUnitVectors(up, span.divideScalar(length));
            const taper = thickness * (1 - 0.45 * (s / SEGMENTS));
            actin.setMatrixAt(index, matrix.compose(mid, quaternion, scaleVec.set(taper, length * 0.86, taper)));
          }
        }
        actin.instanceMatrix.needsUpdate = true;

        nucleusGroup.position.set(-0.62 - 0.18 * internalise, 0.16, -0.18);
        nucleusGroup.scale.setScalar(1 + 0.04 * fusing);

        // Phagosome: only once the cup has sealed. Before that there is no vesicle.
        phagosome.visible = sealed > 0.02;
        phagosome.position.copy(bugAt);
        phagosome.scale.setScalar((0.85 + 0.45 * sealed) * (1 - 0.3 * digested));
        const phagosomeMaterial = phagosome.material as THREE.MeshPhysicalMaterial;
        phagosomeMaterial.opacity = 0.34 * clamp01(sealed * 1.4);
        // Acidification: the vesicle visibly turns as the lysosomes empty into it.
        phagosomeMaterial.color.set("#ffb35f").lerp(new THREE.Color("#ff4f6f"), fusing);

        lysosomeBodies.forEach((l, i) => {
          const arrive = ramp(progress, 0.6 + i * 0.045, 0.76 + i * 0.05);
          l.position.copy(lysosomeHome[i]).lerp(bugAt, arrive);
          l.scale.setScalar(1 - 0.9 * ramp(progress, 0.72 + i * 0.05, 0.84 + i * 0.05));
          l.visible = l.scale.x > 0.06;
        });
      },
    };
  },
};
