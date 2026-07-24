import * as THREE from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { nucleus } from "../organelles";
import { blob, clamp01, fluid, membrane, mesh, onSphere, ramp, rng, scatter, structure, tissue } from "../toolkit";
import { part, type Specimen } from "../types";

const SIZE = 2.3;      // half-extent of the marching-cubes volume, in scene units

const parts = [
  part("pseudopodia", "Pseudopodia", "Locomotion", "#8ae0c4",
    "Blunt lobes of cytoplasm pushed out from the cell body, formed and withdrawn continuously.",
    "Drive crawling and capture food: the cell flows into the advancing lobe rather than swimming.",
    "Cytoplasmic projection", "tens of µm",
    "There is no fixed front or back. Whichever lobe wins becomes the front, and the animal turns by changing its mind."),
  part("endoplasm", "Endoplasm", "Cytoplasmic streaming", "#ffd9a0",
    "The granular, fluid inner cytoplasm, visibly flowing toward whichever pseudopod is advancing.",
    "Carries organelles forward and converts to stiff gel at the tip — the engine of amoeboid movement.",
    "Sol-phase cytoplasm", "granules ≈ 1 µm",
    "Sol flows forward down the middle, gels at the front, and creeps back as a tube. It is a fountain turned inside out."),
  part("nucleus", "Nucleus", "Nuclear apparatus", "#9c78ff",
    "A single large nucleus carried along in the streaming endoplasm.",
    "Holds the genome and directs the protein synthesis that rebuilds the cytoskeleton constantly.",
    "Double-membrane organelle", "≈ 10 µm",
    "It is passively rafted about by the streaming — the nucleus does not steer the cell."),
  part("contractile", "Contractile vacuole", "Osmoregulation", "#7fd4ff",
    "A clear vesicle that swells steadily with water, then abruptly collapses.",
    "Bails out the water that constantly leaks in osmotically, preventing the cell from bursting.",
    "Osmoregulatory organelle", "fills in ≈ 5–10 s",
    "Watch it: slow fill, sudden empty. A freshwater amoeba can expel its own volume of water in under an hour."),
  part("food", "Food vacuoles", "Digestion", "#ff8f55",
    "Membrane-bound pockets holding engulfed prey at various stages of breakdown.",
    "Fuse with lysosomes so enzymes can digest the contents, releasing nutrients to the cytoplasm.",
    "Phagosome", "≈ 5–20 µm",
    "Each one began as a pseudopod closing around a meal — the same motion you can see running at the surface."),
];

export const amoeba: Specimen = {
  id: "amoeba",
  name: "Amoeba",
  subtitle: "crawling & streaming",
  code: "SPECIMEN 03 / PROTISTA",
  scale: "≈ 400 µm",
  aria: "three-dimensional amoeba with moving pseudopodia",
  category: "micro",
  parts,
  build() {
    const group = new THREE.Group();
    const random = rng(307);

    // The body is a metaball field. Pseudopodia are chains of balls whose reach
    // is animated, so the surface genuinely re-forms every frame rather than
    // being a fixed mesh that wobbles.
    const surface = new MarchingCubes(
      44,
      membrane("#8ae0c4", 0.46, { transmission: 0.5, thickness: 0.5, roughness: 0.14, side: THREE.FrontSide, depthWrite: false }),
      true, false, 30000,
    );
    surface.scale.setScalar(SIZE);
    surface.isolation = 55;
    surface.userData.noShadow = true;
    surface.userData.volume = 1;      // tells the explorer to frame by field extent
    group.add(structure("pseudopodia", "#8ae0c4", surface));

    const lobes = Array.from({ length: 5 }, (_, i) => ({
      dir: onSphere(random).setY(onSphere(random).y * 0.5).normalize(),
      phase: (i / 5) * Math.PI * 2 + random(),
      speed: 0.32 + random() * 0.16,
    }));

    const nucleusGroup = nucleus("#9c78ff", 0.34, 17, 48);
    group.add(structure("nucleus", "#9c78ff", nucleusGroup));

    const contractile = mesh(blob(0.3, { detail: 20, amp: 0.05, seed: 23 }), fluid("#7fd4ff", { opacity: 0.5, thickness: 0.8 }));
    contractile.userData.noShadow = true;
    group.add(structure("contractile", "#7fd4ff", contractile));

    const foodGroup = new THREE.Group();
    const foodVacuoles: THREE.Object3D[] = [];
    for (let i = 0; i < 4; i++) {
      const shell = mesh(blob(0.16 + random() * 0.09, { detail: 16, amp: 0.11, seed: 31 + i * 5 }), membrane("#ff8f55", 0.5, { thickness: 0.3 }));
      const prey = mesh(blob(0.08 + random() * 0.04, { detail: 12, amp: 0.3, freq: 4, seed: 61 + i }), tissue("#8a3d16", { roughness: 0.8, wet: 0.2 }));
      prey.userData.noShadow = true;
      const vac = new THREE.Group();
      vac.add(shell, prey);
      vac.position.set((random() - 0.5) * 1.6, (random() - 0.5) * 1.1, (random() - 0.5) * 1.6);
      foodVacuoles.push(vac);
      foodGroup.add(vac);
    }
    group.add(structure("food", "#ff8f55", foodGroup));

    // Endoplasmic granules. Each one runs a fountain circuit: forward down the
    // core, out at the advancing tip, back along the periphery.
    const COUNT = 150;
    const granules = scatter(new THREE.IcosahedronGeometry(0.03, 0), tissue("#ffd9a0", { roughness: 0.55, wet: 0.3 }), COUNT, () => {}, 401);
    granules.userData.noShadow = true;
    group.add(structure("endoplasm", "#ffd9a0", granules));
    const seeds = Array.from({ length: COUNT }, () => ({ t: random(), spin: random() * Math.PI * 2, radius: 0.25 + random() * 0.55, speed: 0.1 + random() * 0.1 }));
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), tip = new THREE.Vector3(), lateral = new THREE.Vector3(), bitangent = new THREE.Vector3();

    return {
      group,
      update(time) {
        surface.reset();
        // Body core.
        surface.addBall(0.5, 0.5, 0.5, 0.62, 12);
        surface.addBall(0.53, 0.47, 0.52, 0.4, 12);
        surface.addBall(0.46, 0.52, 0.48, 0.4, 12);

        let leadReach = 0;
        tip.set(0, 0, 0);
        lobes.forEach(lobe => {
          // Each lobe swells and withdraws on its own cycle; three balls along
          // the axis taper it into a finger rather than a bud.
          const reach = 0.5 * clamp01(Math.sin(time * lobe.speed + lobe.phase) * 1.5);
          if (reach > leadReach) { leadReach = reach; tip.copy(lobe.dir).multiplyScalar(reach * SIZE); }
          for (let s = 1; s <= 3; s++) {
            const d = (s / 3) * reach;
            surface.addBall(
              0.5 + lobe.dir.x * d, 0.5 + lobe.dir.y * d, 0.5 + lobe.dir.z * d,
              0.34 * (1 - 0.42 * (s / 3)), 14,
            );
          }
        });
        surface.update();

        nucleusGroup.position.set(Math.sin(time * 0.21) * 0.28, Math.cos(time * 0.17) * 0.2, Math.sin(time * 0.13 + 1) * 0.26).addScaledVector(tip, 0.14);
        nucleusGroup.rotation.y = time * 0.06;

        // Contractile vacuole: slow osmotic fill, then a fast systolic collapse.
        const cycle = (time % 7) / 7;
        const empty = ramp(cycle, 0.86, 1);
        contractile.scale.setScalar((0.35 + 0.65 * cycle) * (1 - 0.92 * empty));
        contractile.position.set(-0.7 + Math.sin(time * 0.19) * 0.16, 0.55, -0.5).addScaledVector(tip, -0.1);
        contractile.visible = empty < 0.98;

        foodVacuoles.forEach((vac, i) => {
          vac.position.x += Math.sin(time * 0.31 + i) * 0.0016;
          vac.position.y += Math.cos(time * 0.27 + i * 2) * 0.0014;
          vac.position.addScaledVector(tip, 0.00035);
          if (vac.position.length() > 1.5) vac.position.setLength(1.5);
          vac.rotation.y += 0.0025;
        });

        // Fountain flow, oriented along whichever pseudopod currently leads.
        const forward = tip.lengthSq() > 1e-6 ? tip.clone().normalize() : new THREE.Vector3(0, 1, 0);
        lateral.set(-forward.y, forward.x, 0);
        if (lateral.lengthSq() < 1e-6) lateral.set(1, 0, 0);
        lateral.normalize();
        bitangent.copy(forward).cross(lateral);
        const reachLen = Math.max(tip.length(), 0.7);
        for (let i = 0; i < COUNT; i++) {
          const s = seeds[i];
          const u = (s.t + time * s.speed) % 1;
          // 0 → 0.5 : forward through the core.  0.5 → 1 : back along the outside.
          const forwardLeg = u < 0.5;
          const p = forwardLeg ? u * 2 : (1 - u) * 2;
          const axis = -reachLen * 0.75 + p * reachLen * 1.5;
          const spread = forwardLeg ? s.radius * 0.35 : s.radius * (0.85 + 0.3 * Math.sin(p * Math.PI));
          const angle = s.spin + time * 0.2;
          position.copy(forward).multiplyScalar(axis)
            .addScaledVector(lateral, Math.cos(angle) * spread)
            .addScaledVector(bitangent, Math.sin(angle) * spread);
          matrix.makeTranslation(position.x, position.y, position.z);
          granules.setMatrixAt(i, matrix);
        }
        granules.instanceMatrix.needsUpdate = true;
      },
    };
  },
};
