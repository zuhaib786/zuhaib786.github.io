import * as THREE from "three";
import { golgi, mitochondrion, nucleus, roughER } from "../organelles";
import { blob, fluid, membrane, mesh, rng, structure, tissue, tube } from "../toolkit";
import { part, type Specimen } from "../types";

const HALF = 1.9;   // half-width of the boxy cell

/** Superquadric radius for a direction — how a plant cell gets its flat faces
 *  and soft corners without ever becoming a literal cube. */
const boxy = (dir: THREE.Vector3, exponent = 6) =>
  1 / Math.pow(Math.abs(dir.x) ** exponent + Math.abs(dir.y) ** exponent + Math.abs(dir.z) ** exponent, 1 / exponent);

const boxWarp = (scale: number, exponent = 6) => (dir: THREE.Vector3, radius: number) => radius * (boxy(dir, exponent) * scale - 1);

/**
 * A chloroplast: lens-shaped, with grana — stacks of thylakoid discs — wired
 * together by stroma lamellae. The stacking is the point; that is where the
 * light reactions happen.
 */
function chloroplast(seed = 3) {
  const group = new THREE.Group();
  const random = rng(seed);
  const envelope = mesh(
    blob(0.3, { detail: 14, amp: 0.09, freq: 2.6, seed, scale: [1.75, 0.62, 1.15] }),
    membrane("#7ad17a", 0.34, { thickness: 0.4, roughness: 0.18 }),
  );
  envelope.userData.noShadow = true;
  group.add(envelope);

  const stroma = mesh(
    blob(0.3, { detail: 10, amp: 0.08, seed: seed + 1, scale: [1.68, 0.56, 1.08] }),
    tissue("#3f8a4c", { transparent: true, opacity: 0.4, roughness: 0.8, wet: 0.1 }),
  );
  stroma.userData.noShadow = true;
  group.add(stroma);

  const thylakoidMaterial = tissue("#1f6b3a", { roughness: 0.45, emissive: new THREE.Color("#0d3a1e"), wet: 0.4 });
  const lamellaMaterial = tissue("#2f7f45", { side: THREE.DoubleSide, roughness: 0.6, transparent: true, opacity: 0.85 });
  const granaAt: THREE.Vector3[] = [];

  // Lay out the grana first, then draw every thylakoid in the plastid as one
  // instanced batch — nine chloroplasts of loose meshes would be 300 draw calls.
  const discs: { offset: number; scale: number; stack: number }[] = [];
  const stacks: THREE.Matrix4[] = [];
  for (let g = 0; g < 7; g++) {
    const position = new THREE.Vector3((random() - 0.5) * 0.72, (random() - 0.5) * 0.16, (random() - 0.5) * 0.42);
    granaAt.push(position);
    stacks.push(new THREE.Matrix4().compose(
      position,
      new THREE.Quaternion().setFromEuler(new THREE.Euler((random() - 0.5) * 0.5, random() * Math.PI, (random() - 0.5) * 0.5)),
      new THREE.Vector3(1, 1, 1),
    ));
    const count = 4 + Math.floor(random() * 4);
    for (let d = 0; d < count; d++) discs.push({ offset: (d - (count - 1) / 2) * 0.018, scale: 0.85 + random() * 0.3, stack: g });
  }
  const thylakoids = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.062, 0.062, 0.012, 18), thylakoidMaterial, discs.length);
  const local = new THREE.Matrix4();
  discs.forEach((disc, i) => {
    local.makeTranslation(0, disc.offset, 0).scale(new THREE.Vector3(disc.scale, 1, disc.scale));
    thylakoids.setMatrixAt(i, local.premultiply(stacks[disc.stack]));
  });
  thylakoids.userData.noShadow = true;
  group.add(thylakoids);
  // Stroma lamellae: the flat membranes that link one granum to the next.
  for (let i = 0; i < granaAt.length - 1; i++) {
    const a = granaAt[i], b = granaAt[i + 1];
    const lamella = mesh(tube([a, a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, 0.03, 0)), b], 0.05, 12, 3), lamellaMaterial);
    lamella.scale.y = 0.16;
    lamella.userData.noShadow = true;
    group.add(lamella);
  }
  return group;
}

const parts = [
  part("wall", "Cell wall", "Structural boundary", "#d8c79a",
    "A rigid cellulose casing outside the membrane, giving the cell its boxy geometry.",
    "Resists turgor pressure, sets cell shape, and bonds neighbouring cells into tissue.",
    "Cellulose microfibrils", "≈ 0.1–10 µm thick",
    "The flat faces and soft corners here are the wall's doing — the membrane inside it has no shape of its own."),
  part("membrane", "Plasma membrane", "Cell boundary", "#49d5bd",
    "A bilayer pressed tight against the inside of the wall by the vacuole's turgor.",
    "Controls what enters and leaves, and senses the wall's mechanical state.",
    "Phospholipid bilayer", "≈ 7–10 nm thick",
    "Lose water and this layer peels away from the wall — plasmolysis, and the reason a dry plant wilts."),
  part("vacuole", "Central vacuole", "Turgor & storage", "#6fc9ff",
    "A single fluid-filled compartment occupying most of the cell's volume.",
    "Stores water, ions, and pigments, and its pressure against the wall holds the plant upright.",
    "Tonoplast-bound sac", "up to 90% of cell volume",
    "Plants stand up hydraulically. This bag of water under pressure is the structural member."),
  part("chloroplasts", "Chloroplasts", "Photosynthesis", "#5cc85c",
    "Lens-shaped plastids whose internal thylakoid membranes are stacked into grana.",
    "Capture light and fix carbon dioxide into sugar across those stacked membranes.",
    "Semi-autonomous plastid", "≈ 5 µm across",
    "Like mitochondria they keep their own genome — two separate ancient bacteria, both still resident."),
  part("nucleus", "Nucleus", "Nuclear apparatus", "#9c78ff",
    "The genome, pushed out to the cell's edge by the expanding vacuole.",
    "Coordinates gene expression and DNA replication for the whole cell.",
    "Double-membrane organelle", "≈ 10 µm",
    "In an animal cell the nucleus sits centrally; here the vacuole has simply taken the middle."),
  part("mitochondria", "Mitochondria", "Energy metabolism", "#ff8f55",
    "Cristae-filled organelles working alongside the chloroplasts.",
    "Respire the sugars photosynthesis makes, releasing ATP day and night.",
    "Semi-autonomous organelle", "≈ 1–2 µm",
    "Chloroplasts only earn in the light; the mitochondria are what keep the cell solvent after dark."),
  part("er", "Endomembrane system", "Synthesis & sorting", "#4f9cff",
    "Rough ER wrapping the nucleus, with Golgi stacks alongside it.",
    "Builds and sorts proteins — including the wall polysaccharides exported outward.",
    "Membrane network", "spans the cytoplasm",
    "The Golgi here also manufactures the wall: hemicellulose and pectin are made inside and shipped out."),
  part("plasmodesmata", "Plasmodesmata", "Cell-to-cell transport", "#ffa9d8",
    "Membrane-lined channels bored through the wall into neighbouring cells.",
    "Connect the cytoplasm of adjacent cells into one continuous compartment.",
    "Cytoplasmic channel", "≈ 40 nm wide",
    "Because of these, a plant tissue is closer to one shared cytoplasm than to a heap of separate cells."),
];

export const plantCell: Specimen = {
  id: "plant-cell",
  name: "Plant cell",
  subtitle: "chloroplasts & turgor",
  code: "SPECIMEN 02 / PLANTAE",
  scale: "≈ 50 µm",
  aria: "three-dimensional plant cell",
  category: "micro",
  parts,
  build() {
    const group = new THREE.Group();
    const random = rng(211);

    const wall = mesh(
      blob(HALF, { detail: 34, amp: 0.02, freq: 3.2, seed: 71, warp: boxWarp(1) }),
      tissue("#d8c79a", { transparent: true, opacity: 0.3, roughness: 0.85, side: THREE.DoubleSide, wet: 0.05 }),
    );
    wall.userData.noShadow = true;
    group.add(structure("wall", "#d8c79a", wall));

    const plasma = mesh(
      blob(HALF * 0.955, { detail: 26, amp: 0.02, freq: 3.2, seed: 71, warp: boxWarp(1) }),
      membrane("#49d5bd", 0.16, { thickness: 0.8, transmission: 0.88 }),
    );
    plasma.userData.noShadow = true;
    group.add(structure("membrane", "#49d5bd", plasma));

    const vacuole = mesh(
      blob(HALF * 0.78, { detail: 24, amp: 0.035, freq: 2, seed: 83, warp: boxWarp(1, 4) }),
      fluid("#6fc9ff", { opacity: 0.24, thickness: 2.6 }),
    );
    vacuole.userData.noShadow = true;
    group.add(structure("vacuole", "#6fc9ff", vacuole));

    const nucleusGroup = nucleus("#9c78ff", 0.52, 13, 60);
    nucleusGroup.position.set(-1.28, 0.55, 0.5);
    group.add(structure("nucleus", "#9c78ff", nucleusGroup));

    const er = roughER("#4f9cff", 0.66, 2, 19);
    er.position.copy(nucleusGroup.position);
    er.rotation.set(0.1, 1.9, 0.3);
    const golgiGroup = golgi("#4f9cff", 27);
    golgiGroup.scale.setScalar(0.62);
    golgiGroup.position.set(-0.9, -0.85, 1.05);
    golgiGroup.rotation.set(0.5, 0.2, 0.3);
    group.add(structure("er", "#4f9cff", er, golgiGroup));

    // Chloroplasts and mitochondria ride in the thin cytoplasmic shell that the
    // vacuole leaves between itself and the membrane.
    const shell = HALF * 0.86;
    const chloroplasts = new THREE.Group();
    const orbits: { axis: THREE.Vector3; radius: number; phase: number; speed: number; tilt: number }[] = [];
    for (let i = 0; i < 9; i++) {
      const c = chloroplast(3 + i * 5);
      chloroplasts.add(c);
      orbits.push({
        axis: new THREE.Vector3(0, 1, 0),
        radius: shell * (0.86 + random() * 0.12),
        phase: random() * Math.PI * 2,
        speed: 0.16 + random() * 0.07,
        tilt: (random() - 0.5) * 2.4,
      });
    }
    group.add(structure("chloroplasts", "#5cc85c", chloroplasts));

    const mitochondria = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const m = mitochondrion("#ff8f55", 101 + i * 7, 3.1, 0.15);
      const angle = random() * Math.PI * 2;
      m.position.set(Math.cos(angle) * shell * 0.9, (random() - 0.5) * 2.4, Math.sin(angle) * shell * 0.9);
      m.rotation.set(random() * 3, random() * 3, random() * 3);
      mitochondria.add(m);
    }
    group.add(structure("mitochondria", "#ff8f55", mitochondria));

    // Plasmodesmata: channels crossing the wall, so they must sit on the faces.
    const channels = new THREE.Group();
    const channelMaterial = tissue("#ffa9d8", { roughness: 0.4, side: THREE.DoubleSide, wet: 0.5 });
    const faces: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
    faces.forEach(([fx, fy, fz], f) => {
      for (let i = 0; i < 4; i++) {
        const u = (random() - 0.5) * 2.2, v = (random() - 0.5) * 2.2;
        const centre = new THREE.Vector3(fx * HALF, fy * HALF, fz * HALF);
        const along = fx ? new THREE.Vector3(0, u, v) : fy ? new THREE.Vector3(u, 0, v) : new THREE.Vector3(u, v, 0);
        centre.add(along);
        const normal = new THREE.Vector3(fx, fy, fz);
        const start = centre.clone().addScaledVector(normal, -0.16), end = centre.clone().addScaledVector(normal, 0.16);
        const channel = mesh(tube([start, centre, end], 0.035, 8, 10), channelMaterial);
        channel.userData.noShadow = true;
        channels.add(channel);
      }
    });
    group.add(structure("plasmodesmata", "#ffa9d8", channels));

    return {
      group,
      update(time) {
        // Cyclosis: the cytoplasm circulates, sweeping chloroplasts round the
        // vacuole in a loop. Watch one long enough and it comes back.
        chloroplasts.children.forEach((c, i) => {
          const o = orbits[i];
          const angle = o.phase + time * o.speed;
          c.position.set(Math.cos(angle) * o.radius, Math.sin(angle * 0.5 + o.tilt) * shell * 0.72, Math.sin(angle) * o.radius);
          c.rotation.y = -angle + o.tilt;
          c.rotation.z = Math.sin(angle * 1.3) * 0.35;
        });
        vacuole.scale.setScalar(1 + Math.sin(time * 0.35) * 0.006);   // turgor, breathing slightly
        nucleusGroup.rotation.y = Math.sin(time * 0.12) * 0.06;
      },
    };
  },
};
