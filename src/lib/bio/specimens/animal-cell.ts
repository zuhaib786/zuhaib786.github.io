import * as THREE from "three";
import { centriole, cytoskeleton, cytosol, golgi, lysosome, mitochondrion, nucleus, plasmaMembrane, ribosomes, roughER, vesicle } from "../organelles";
import { rng, structure } from "../toolkit";
import { part, type Specimen } from "../types";

const RADIUS = 2;

const parts = [
  part("membrane", "Plasma membrane", "Cell boundary", "#49d5bd",
    "A fluid phospholipid bilayer enclosing the cytoplasm and defining a selective boundary.",
    "Controls molecular exchange, receives extracellular signals, and anchors the cell to its surroundings.",
    "Phospholipid bilayer", "≈ 7–10 nm thick",
    "Lipids and many membrane proteins diffuse laterally, so this boundary behaves more like a fluid than a rigid shell."),
  part("nucleus", "Nucleus", "Nuclear apparatus", "#9c78ff",
    "The membrane-bound information centre, holding most of the cell's DNA as chromatin around a dense nucleolus.",
    "Coordinates gene expression and DNA replication while nuclear pores regulate molecular traffic.",
    "Double-membrane organelle", "≈ 5–10 µm",
    "The pores dotted over the envelope are not holes but protein rings, each about thirty times the mass of a ribosome."),
  part("er", "Rough endoplasmic reticulum", "Endomembrane system", "#4f9cff",
    "Nested cisternal sheets wrapping the nucleus, their outer faces studded with ribosomes.",
    "Folds and quality-checks proteins destined for membranes, lysosomes, or secretion.",
    "Membrane network", "spans the cytoplasm",
    "Its membrane is continuous with the nuclear envelope — one system, drawn here as two structures."),
  part("ribosomes", "Ribosomes", "Protein synthesis", "#2c4f8f",
    "Two-subunit RNA-protein machines, both free in the cytosol and bound to the ER.",
    "Translate messenger RNA into polypeptide chains, at roughly twenty amino acids per second.",
    "Ribonucleoprotein particle", "≈ 25 nm",
    "A ribosome is not membrane-bound, which is why it survives here as grain rather than as a compartment."),
  part("mitochondria", "Mitochondria", "Energy metabolism", "#ff8f55",
    "Double-membraned organelles whose inner membrane is thrown into lamellar shelves — the cristae.",
    "Run oxidative phosphorylation, generating most of the cell's ATP across the cristal membrane.",
    "Semi-autonomous organelle", "≈ 0.5–3 µm",
    "The cristae exist to buy surface area: folding lets a 1 µm organelle carry many times its own area of respiratory chain."),
  part("golgi", "Golgi apparatus", "Endomembrane system", "#ffc64f",
    "A polarised stack of dished cisternae, widest at the cis face, shedding vesicles from the trans face.",
    "Modifies, sorts, and packages proteins and lipids for delivery or secretion.",
    "Stacked cisternae", "≈ 1–3 µm",
    "Cargo crosses the stack cis to trans; the vesicles budding below are that traffic leaving."),
  part("lysosomes", "Lysosomes", "Recycling system", "#ff597b",
    "Acidic, enzyme-filled vesicles carrying visibly granular contents.",
    "Break macromolecules and worn-out organelles down into reusable building blocks.",
    "Acidic vesicle", "≈ 0.1–1.2 µm",
    "Proton pumps hold the lumen near pH 4.5 — its enzymes are nearly inactive at the cytosol's neutral pH, which is the cell's safety catch."),
  part("centrosome", "Centrosome", "Cytoskeleton organiser", "#ef5bd2",
    "Two centrioles set at right angles, each a barrel of nine microtubule triplets.",
    "Nucleates and anchors microtubules, and forms the two spindle poles during division.",
    "Microtubule-organising centre", "≈ 1–2 µm",
    "The ninefold symmetry drawn here is near-universal, from this centriole to the basal body of a sperm's flagellum."),
  part("cytoskeleton", "Cytoskeleton", "Structural scaffold", "#8fe3d0",
    "Microtubules radiating from the centrosome to the cortex, over a tangle of cortical actin.",
    "Gives the cell shape and mechanical strength, and provides the tracks that vesicles are hauled along.",
    "Filament network", "25 nm to 7 nm filaments",
    "The vesicles crossing the cytoplasm are not drifting — motor proteins walk them along these tracks."),
];

export const animalCell: Specimen = {
  id: "animal-cell",
  name: "Animal cell",
  subtitle: "eukaryotic ultrastructure",
  code: "SPECIMEN 01 / EUKARYOTA",
  scale: "≈ 20 µm",
  aria: "three-dimensional animal cell",
  category: "micro",
  parts,
  build() {
    const group = new THREE.Group();
    const random = rng(97);
    const nucleusAt = new THREE.Vector3(-0.5, 0.14, 0.05);
    const golgiAt = new THREE.Vector3(0.92, 0.72, -0.1);
    const centrosomeAt = new THREE.Vector3(-0.15, -0.95, 0.72);

    group.add(structure("membrane", "#49d5bd", plasmaMembrane("#49d5bd", RADIUS, 59), cytosol("#8ad9ff", RADIUS * 0.96, 61)));

    const nucleusGroup = nucleus("#9c78ff", 0.8, 11);
    nucleusGroup.position.copy(nucleusAt);
    group.add(structure("nucleus", "#9c78ff", nucleusGroup));

    const er = roughER("#4f9cff", 1.0, 3, 17);
    er.position.copy(nucleusAt);
    er.rotation.set(0.2, -0.4, 0.15);
    group.add(structure("er", "#4f9cff", er));

    group.add(structure("ribosomes", "#2c4f8f", ribosomes(260, RADIUS * 0.88, 47)));

    // Mitochondria: differing lengths and attitudes, as in any real section.
    const mitochondria = new THREE.Group();
    const placements: [THREE.Vector3, THREE.Euler, number, number][] = [
      [new THREE.Vector3(1.12, -0.42, 0.24), new THREE.Euler(0.2, 0.4, 0.75), 3.6, 0.25],
      [new THREE.Vector3(0.24, 1.18, 0.42), new THREE.Euler(-0.5, 1.1, 0.15), 3.0, 0.21],
      [new THREE.Vector3(-1.02, -0.78, -0.62), new THREE.Euler(0.9, -0.3, -0.5), 4.2, 0.22],
      [new THREE.Vector3(0.62, -1.18, -0.66), new THREE.Euler(-0.2, 0.8, 1.25), 2.7, 0.19],
    ];
    placements.forEach(([position, rotation, length, radius], i) => {
      const m = mitochondrion("#ff8f55", 5 + i * 4, length, radius);
      m.position.copy(position);
      m.rotation.copy(rotation);
      mitochondria.add(m);
    });
    group.add(structure("mitochondria", "#ff8f55", mitochondria));

    const golgiGroup = golgi("#ffc64f", 23);
    golgiGroup.position.copy(golgiAt);
    golgiGroup.rotation.set(0.32, 0, -0.42);
    group.add(structure("golgi", "#ffc64f", golgiGroup));

    const lysosomes = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const l = lysosome("#ff597b", 0.11 + random() * 0.08, 29 + i * 6);
      l.position.set((random() - 0.5) * 2.6, (random() - 0.5) * 2.4, (random() - 0.5) * 2.2);
      if (l.position.length() > RADIUS * 0.8) l.position.setLength(RADIUS * 0.78);
      lysosomes.add(l);
    }
    group.add(structure("lysosomes", "#ff597b", lysosomes));

    const centrosomeGroup = new THREE.Group();
    const first = centriole("#ef5bd2");
    const second = centriole("#ef5bd2");
    second.rotation.set(0, 0, Math.PI / 2);            // the daughter sits at right angles
    second.position.set(0.16, 0.16, 0);
    centrosomeGroup.add(first, second);
    centrosomeGroup.position.copy(centrosomeAt);
    centrosomeGroup.rotation.set(0.4, 0.7, 0);
    group.add(structure("centrosome", "#ef5bd2", centrosomeGroup));

    group.add(structure("cytoskeleton", "#8fe3d0", cytoskeleton("#8fe3d0", centrosomeAt, RADIUS, 53)));

    // Secretory traffic: vesicles walking ER → Golgi → membrane, then recycling.
    // This is the cell's one continuous motion, and it is a real pathway.
    const traffic = new THREE.Group();
    const routes: THREE.CatmullRomCurve3[] = [];
    const cargo: THREE.Object3D[] = [];
    for (let i = 0; i < 9; i++) {
      const exit = nucleusAt.clone().add(new THREE.Vector3((random() - 0.5) * 1.6, (random() - 0.5) * 1.4, (random() - 0.2) * 1.4));
      const surface = new THREE.Vector3((random() - 0.5), (random() - 0.5), (random() - 0.5)).normalize().multiplyScalar(RADIUS * 0.92);
      const via = golgiAt.clone().add(new THREE.Vector3((random() - 0.5) * 0.3, -0.35, (random() - 0.5) * 0.3));
      routes.push(new THREE.CatmullRomCurve3([exit, exit.clone().lerp(via, 0.55), via, via.clone().lerp(surface, 0.5), surface], false, "catmullrom", 0.4));
      const v = vesicle("#ffd88a", 0.05 + random() * 0.035, 41 + i * 3);
      cargo.push(v);
      traffic.add(v);
    }
    group.add(structure("golgi", "#ffc64f", traffic));

    const offsets = cargo.map(() => random());
    const drifters = [mitochondria, lysosomes, traffic];

    return {
      group,
      update(time) {
        cargo.forEach((v, i) => {
          const t = (offsets[i] + time * 0.055) % 1;
          routes[i].getPointAt(t, v.position);
          v.scale.setScalar(0.55 + 0.45 * Math.sin(t * Math.PI));   // bud small, fuse small
        });
        // Everything in a cell jitters; a perfectly still cytoplasm reads as plastic.
        drifters.forEach((node, i) => {
          node.position.y = Math.sin(time * 0.42 + i * 2.1) * 0.035;
          node.position.x = Math.cos(time * 0.31 + i * 1.3) * 0.03;
        });
        mitochondria.children.forEach((m, i) => { m.rotation.z += 0.0008 * (i % 2 ? 1 : -1); });
        nucleusGroup.rotation.y = Math.sin(time * 0.13) * 0.07;
      },
    };
  },
};
