import * as THREE from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { centriole } from "../organelles";
import { blob, clamp01, membrane, mesh, ramp, rng, structure, tissue, tube } from "../toolkit";
import { part, type Specimen } from "../types";

/*
 * The whole reason this is a metaball cell: cytokinesis changes the topology.
 * One surface has to become two, and no fixed mesh can do that honestly. Here
 * the cell body is two field sources that drift apart — the isosurface necks,
 * the neck thins, and at some frame it simply is two cells. Nothing is swapped
 * out at the halfway point.
 *
 * The spindle runs along z; the metaphase plate is the xy plane.
 */

const SIZE = 2.5;
const COUNT = 6;                                   // chromosomes drawn
const POLE = 1.05;                                 // spindle pole distance, in local units

const put = (field: MarchingCubes, p: THREE.Vector3, strength: number, subtract = 12) =>
  field.addBall(0.5 + p.x * 0.5, 0.5 + p.y * 0.5, 0.5 + p.z * 0.5, strength, subtract);

/** One chromatid: a rod, waisted at the centromere, faintly bent. */
function chromatid(color: string, length: number, seed: number) {
  const random = rng(seed);
  const bend = (random() - 0.5) * 0.22;
  const points = Array.from({ length: 6 }, (_, i) => {
    const t = i / 5;
    return new THREE.Vector3(Math.sin(t * Math.PI) * bend, (t - 0.5) * length, Math.cos(t * 2.4 + seed) * 0.02);
  });
  const geometry = tube(points, t => 0.062 * (1 - 0.52 * Math.exp(-((t - 0.4) ** 2) / 0.006)), 40, 14);
  return mesh(geometry, tissue(color, { roughness: 0.52, wet: 0.5 }));
}

const parts = [
  part("chromosomes", "Chromosomes", "Genome", "#9c78ff",
    "Chromatin condensed into paired sister chromatids, waisted at the centromere.",
    "Package a metre of DNA into bodies compact enough to be dragged apart without tangling.",
    "Condensed chromatin", "≈ 1–10 µm",
    "Condensation is not for storage — it is so the DNA can be moved. Loose chromatin would snap or knot."),
  part("spindle", "Mitotic spindle", "Segregation machinery", "#7fd4ff",
    "Microtubules running pole to kinetochore, plus astral fibres bracing against the cortex.",
    "Align the chromosomes, then shorten to pull one chromatid of each pair to each pole.",
    "Microtubule array", "spans the cell",
    "The fibres are not static ropes. They are constantly growing and shrinking, and search the cell until they catch a kinetochore."),
  part("centrosomes", "Centrosomes", "Spindle poles", "#ef5bd2",
    "The duplicated pair of centriole barrels, driven to opposite ends of the cell.",
    "Nucleate the spindle and define the axis the cell will divide along.",
    "Microtubule-organising centre", "≈ 1–2 µm",
    "Where these end up determines where the cell splits — and in a developing embryo, which daughter inherits what."),
  part("envelope", "Nuclear envelope", "Compartment boundary", "#c4a8ff",
    "The nuclear membrane, which breaks down before segregation and re-forms afterwards.",
    "Separates genome from cytoplasm — and must be dismantled for the spindle to reach the chromosomes.",
    "Double membrane", "disassembles in ≈ 2 min",
    "Human cells demolish the nucleus entirely to divide. Many fungi never do, and build the spindle inside it instead."),
  part("membrane", "Plasma membrane", "Cleavage furrow", "#49d5bd",
    "The cell surface, drawn inward at the equator by a contractile ring of actin and myosin.",
    "Pinches the cytoplasm into two, completing the division the spindle set up.",
    "Phospholipid bilayer", "furrow closes in ≈ 10 min",
    "The ring tightens like a purse string. Watch the waist: one surface becomes two without ever tearing."),
];

export const mitosis: Specimen = {
  id: "mitosis",
  name: "Mitosis",
  subtitle: "one cell becomes two",
  code: "PROCESS 02 / CELL DIVISION",
  scale: "≈ 1 hour, compressed",
  aria: "animated cell dividing by mitosis",
  category: "process",
  duration: 22,
  phases: [
    { at: 0, name: "Prophase", caption: "Chromatin condenses into visible chromosomes; the centrosomes begin to separate." },
    { at: 0.2, name: "Prometaphase", caption: "The nuclear envelope breaks down and spindle fibres capture the kinetochores." },
    { at: 0.36, name: "Metaphase", caption: "Every chromosome is aligned on the equatorial plate, under tension from both poles." },
    { at: 0.52, name: "Anaphase", caption: "Cohesion is cut. Sister chromatids are dragged to opposite poles." },
    { at: 0.72, name: "Telophase", caption: "Chromosomes decondense and two new nuclear envelopes assemble around them." },
    { at: 0.85, name: "Cytokinesis", caption: "The contractile ring tightens at the equator until the surface separates into two cells." },
  ],
  parts,
  build() {
    const group = new THREE.Group();
    const random = rng(613);

    const cell = new MarchingCubes(
      52,
      membrane("#49d5bd", 0.4, { transmission: 0.55, thickness: 0.7, roughness: 0.15, side: THREE.FrontSide, depthWrite: false }),
      true, false, 40000,
    );
    cell.scale.setScalar(SIZE);
    cell.isolation = 58;
    cell.userData.noShadow = true;
    cell.userData.volume = 1;
    group.add(structure("membrane", "#49d5bd", cell));

    /* ── chromosomes ── */
    const chromosomes = new THREE.Group();
    const pairs = Array.from({ length: COUNT }, (_, i) => {
      const length = 0.34 + random() * 0.3;
      const a = chromatid("#9c78ff", length, 700 + i * 13);
      const b = chromatid("#b79aff", length, 900 + i * 17);
      const holder = new THREE.Group();
      holder.add(a, b);
      chromosomes.add(holder);
      return {
        a, b, holder, length,
        plateAngle: (i / COUNT) * Math.PI * 2 + random() * 0.3,
        plateRadius: 0.28 + random() * 0.22,
        scatter: new THREE.Vector3((random() - 0.5) * 0.85, (random() - 0.5) * 0.85, (random() - 0.5) * 0.7),
        tilt: (random() - 0.5) * 1.4,
      };
    });
    group.add(structure("chromosomes", "#9c78ff", chromosomes));

    /* ── spindle: one instanced cylinder per fibre, re-aimed every frame ── */
    const FIBRES = COUNT * 2 + 18;
    const fibreGeometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
    const spindle = new THREE.InstancedMesh(fibreGeometry, tissue("#7fd4ff", { roughness: 0.4, transparent: true, opacity: 0.62, wet: 0.4, side: THREE.DoubleSide }), FIBRES);
    spindle.userData.noShadow = true;
    spindle.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(structure("spindle", "#7fd4ff", spindle));
    const astral = Array.from({ length: 18 }, (_, i) => {
      const a = (i / 18) * Math.PI * 2;
      const pole = i % 2 ? 1 : -1;
      return { pole, dir: new THREE.Vector3(Math.cos(a) * 0.8, Math.sin(a) * 0.8, pole * 0.55).normalize() };
    });

    /* ── centrosomes ── */
    const poles = [-1, 1].map(sign => {
      const holder = new THREE.Group();
      const first = centriole("#ef5bd2", 0.06, 0.17);
      const second = centriole("#ef5bd2", 0.06, 0.17);
      second.rotation.set(0, 0, Math.PI / 2);
      second.position.set(0.11, 0.11, 0);
      holder.add(first, second);
      holder.userData.sign = sign;
      return holder;
    });
    group.add(structure("centrosomes", "#ef5bd2", ...poles));

    /* ── nuclear envelopes: one that dissolves, two that re-form ── */
    const envelopeMaterial = membrane("#c4a8ff", 0.24, { thickness: 0.5 });
    const envelopes = [0, 1, 2].map(i => {
      const m = mesh(blob(i === 0 ? 0.66 : 0.44, { detail: 24, amp: 0.06, freq: 2.4, seed: 33 + i * 5 }), envelopeMaterial.clone());
      m.userData.noShadow = true;
      return m;
    });
    group.add(structure("envelope", "#c4a8ff", ...envelopes));

    const matrix = new THREE.Matrix4(), from = new THREE.Vector3(), to = new THREE.Vector3();
    const mid = new THREE.Vector3(), dir = new THREE.Vector3(), quaternion = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0), scale = new THREE.Vector3();

    const aimFibre = (index: number, a: THREE.Vector3, b: THREE.Vector3, radius: number) => {
      dir.copy(b).sub(a);
      const length = dir.length() || 1e-5;
      mid.copy(a).addScaledVector(dir, 0.5);
      quaternion.setFromUnitVectors(up, dir.divideScalar(length));
      matrix.compose(mid, quaternion, scale.set(radius, length, radius));
      spindle.setMatrixAt(index, matrix);
    };

    return {
      group,
      seek(progress) {
        const condense = ramp(progress, 0.02, 0.2);
        const breakdown = ramp(progress, 0.2, 0.34);
        const align = ramp(progress, 0.3, 0.5);
        const separate = ramp(progress, 0.53, 0.72);
        const reform = ramp(progress, 0.72, 0.86);
        const furrow = ramp(progress, 0.78, 1);
        const poleGap = 0.25 + (POLE - 0.25) * ramp(progress, 0.05, 0.4);
        const bodyGap = furrow * 0.62;

        /* ── surface: two sources drifting apart until the neck lets go ── */
        cell.reset();
        put(cell, new THREE.Vector3(0, 0, -bodyGap), 0.78);
        put(cell, new THREE.Vector3(0, 0, bodyGap), 0.78);
        if (furrow < 0.02) put(cell, new THREE.Vector3(0, 0, 0), 0.28);
        // Elongation before the pinch — the cell stretches along the spindle first.
        const stretch = ramp(progress, 0.5, 0.8) * 0.2;
        put(cell, new THREE.Vector3(0, 0, -stretch - bodyGap * 0.3), 0.16);
        put(cell, new THREE.Vector3(0, 0, stretch + bodyGap * 0.3), 0.16);
        cell.update();

        poles.forEach(holder => {
          const sign = holder.userData.sign as number;
          holder.position.set(0, 0.06 * sign, sign * poleGap * SIZE * 0.42);
          holder.rotation.set(0, Math.PI / 2, progress * 0.6 * sign);
          holder.scale.setScalar(SIZE * 0.42);
        });
        const poleZ = poleGap * SIZE * 0.42;

        /* ── chromosomes ── */
        pairs.forEach(pair => {
          const condensed = (0.25 + 0.75 * condense) * (1 - 0.35 * reform);
          pair.a.scale.setScalar(condensed);
          pair.b.scale.setScalar(condensed);

          const plate = new THREE.Vector3(Math.cos(pair.plateAngle) * pair.plateRadius * SIZE * 0.5, Math.sin(pair.plateAngle) * pair.plateRadius * SIZE * 0.5, 0);
          const home = pair.scatter.clone().multiplyScalar(SIZE * 0.42);
          pair.holder.position.copy(home).lerp(plate, align);
          pair.holder.rotation.set(0, 0, THREE.MathUtils.lerp(pair.tilt, 0, align));

          // Sisters sit shoulder to shoulder, then are pulled to opposite poles.
          const split = separate * (poleZ * 0.82);
          const cluster = 0.055 * SIZE;
          pair.a.position.set(-cluster * (1 - separate), 0, -split);
          pair.b.position.set(cluster * (1 - separate), 0, split);
          // Anaphase chromosomes trail behind their centromeres — the classic V.
          pair.a.rotation.x = -separate * 0.7;
          pair.b.rotation.x = separate * 0.7;
        });

        /* ── spindle fibres ── */
        let index = 0;
        pairs.forEach(pair => {
          const visible = breakdown > 0.1 && reform < 0.9;
          const alpha = clamp01(breakdown) * (1 - reform);
          [pair.a, pair.b].forEach((chromatidMesh, side) => {
            const sign = side === 0 ? -1 : 1;
            chromatidMesh.getWorldPosition(to);
            group.worldToLocal(to);
            from.set(0, 0.06 * sign, sign * poleZ);
            aimFibre(index++, from, visible ? to : from, 0.012 * alpha);
          });
        });
        astral.forEach(a => {
          const alpha = clamp01(breakdown) * (1 - reform * 0.4);
          from.set(0, 0.06 * a.pole, a.pole * poleZ);
          to.copy(from).addScaledVector(a.dir, SIZE * 0.42);
          aimFibre(index++, from, to, 0.007 * alpha);
        });
        spindle.instanceMatrix.needsUpdate = true;

        /* ── envelopes ── */
        const parent = envelopes[0];
        parent.visible = breakdown < 0.98;
        parent.scale.setScalar(SIZE * 0.42 * (1 + 0.25 * breakdown));
        (parent.material as THREE.MeshPhysicalMaterial).opacity = 0.24 * (1 - breakdown);
        [1, 2].forEach(i => {
          const daughter = envelopes[i];
          const sign = i === 1 ? -1 : 1;
          daughter.visible = reform > 0.02;
          daughter.position.set(0, 0, sign * poleZ * 0.72);
          daughter.scale.setScalar(SIZE * 0.34 * reform);
          (daughter.material as THREE.MeshPhysicalMaterial).opacity = 0.24 * reform;
        });
      },
    };
  },
};
