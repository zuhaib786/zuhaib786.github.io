import * as THREE from "three";
import { fbm, fluid, membrane, mesh, revolve, rng, sheet, structure, tissue, tube } from "../toolkit";
import { part, type Specimen } from "../types";

/*
 * The eye is the one specimen here that genuinely is a solid of revolution, so
 * it is lathed from a real cross-section rather than sculpted. The outer coats
 * are revolved through 292° instead of a full circle: from the front it reads
 * as an eye, and one drag reveals the anterior chamber, lens and fundus through
 * the cut — the way a dissected specimen is mounted.
 *
 * The optical axis is built along +y and the whole assembly is tipped to +z.
 */

const CUT_START = 0.12 * Math.PI, CUT_ARC = 1.62 * Math.PI;

/** Points along a circular arc of the profile, measured from the anterior pole. */
const arc = (radius: number, centre: number, from: number, to: number, steps = 40): [number, number][] =>
  Array.from({ length: steps }, (_, i) => {
    const a = THREE.MathUtils.lerp(from, to, i / (steps - 1));
    return [Math.sin(a) * radius, centre + Math.cos(a) * radius];
  });

const LIMBUS = 0.30 * Math.PI;          // where the cornea meets the sclera
const CORNEA_R = 0.826, CORNEA_C = 0.35, CORNEA_EDGE = 0.39 * Math.PI;
const IRIS_ROOT = 0.74;

/** Iris surface: a shallow cone of radial fibres running from the pupil margin
 *  out to the root, ridged at the collarette. Rebuilt whenever the pupil moves. */
function irisPoint(rho: number, angle: number, pupil: number, target: THREE.Vector3) {
  const r = THREE.MathUtils.lerp(pupil, IRIS_ROOT, rho);
  const fibre = 0.008 * Math.sin(angle * 86) * (0.35 + 0.65 * rho) + 0.004 * Math.sin(angle * 31 + rho * 8);
  const collarette = 0.022 * Math.exp(-((rho - 0.32) ** 2) / 0.008);
  const y = 0.33 + 0.1 * (1 - rho) ** 1.3 + collarette + fibre * 0.4;
  return target.set(Math.cos(angle) * (r + fibre), y, Math.sin(angle) * (r + fibre));
}

const parts = [
  part("cornea", "Cornea", "Optical surface", "#63e0d0",
    "The clear, steeply curved front window, bulging proudly out of the white of the eye.",
    "Does about two thirds of the eye's focusing — most of the bending happens here, not in the lens.",
    "Transparent avascular tissue", "≈ 11 mm across",
    "It has no blood supply and takes oxygen straight from the air, which is why corneal grafts are rarely rejected."),
  part("iris", "Iris", "Aperture control", "#5f9ae8",
    "A pigmented muscular diaphragm of radial fibres, ridged at the collarette.",
    "Opens and closes the pupil to hold retinal illumination roughly constant across a huge range of light.",
    "Muscular diaphragm", "pupil ≈ 2–8 mm",
    "There is no blue pigment in a blue iris. It is scattering in a low-pigment stroma — the same physics as the sky."),
  part("lens", "Lens", "Accommodation", "#ffd98a",
    "A transparent biconvex body slung behind the iris on the zonular fibres.",
    "Changes shape to fine-tune focus, adding the last third of the eye's optical power.",
    "Crystalline lens", "≈ 10 mm across",
    "It keeps growing all your life and never sheds a cell. Its centre is as old as you are, which is why it eventually stiffens."),
  part("retina", "Retina", "Photoreception", "#e8735f",
    "The light-sensitive inner lining, with vessels fanning out from the optic disc.",
    "Converts light into neural signals and does the first stages of image processing before anything reaches the brain.",
    "Neural tissue layer", "≈ 0.5 mm thick",
    "It is installed backwards: light passes through the wiring and the blood vessels before reaching the photoreceptors."),
  part("optic-nerve", "Optic nerve", "Signal output", "#ffb35f",
    "A cable of over a million axons leaving the back of the globe, slightly toward the nose.",
    "Carries the retina's output to the thalamus and on to the visual cortex.",
    "Cranial nerve II", "≈ 4 mm across",
    "Where it leaves there is no room for photoreceptors, so every eye has a blind spot you never notice."),
  part("sclera", "Sclera", "Structural coat", "#e6e9f2",
    "The tough white outer shell, shown cut away here, with the extraocular muscles inserting on it.",
    "Holds the eye's shape against internal pressure and gives the muscles something to pull against.",
    "Dense fibrous coat", "≈ 0.5–1 mm thick",
    "Its pressure is what keeps the globe spherical; the shape of the eye is inflation, not scaffolding."),
];

export const eye: Specimen = {
  id: "eye",
  name: "Human eye",
  subtitle: "cutaway optics",
  code: "SPECIMEN 06 / SENSORY",
  scale: "≈ 24 mm",
  aria: "three-dimensional cutaway human eye",
  category: "anatomy",
  parts,
  build() {
    const globe = new THREE.Group();

    /* ── sclera: a walled shell, so the cut edge shows real thickness ── */
    const scleraProfile: [number, number][] = [
      ...arc(1.0, 0, LIMBUS, 0.93 * Math.PI, 46),
      ...arc(0.93, 0, 0.93 * Math.PI, LIMBUS, 46),
    ];
    const sclera = mesh(revolve(scleraProfile, 96, CUT_ARC), tissue("#e6e9f2", { roughness: 0.52, wet: 0.5, side: THREE.DoubleSide }));
    sclera.rotation.y = CUT_START;

    // Extraocular muscle insertions — flat straps running back over the globe.
    const muscleMaterial = tissue("#d4646f", { roughness: 0.68, wet: 0.4, side: THREE.DoubleSide });
    const muscles = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const around = CUT_START + 0.35 + (i / 4) * CUT_ARC * 0.92;
      const strap = mesh(sheet((u, v, target) => {
        const a = THREE.MathUtils.lerp(0.36 * Math.PI, 0.92 * Math.PI, u);
        const spread = (v - 0.5) * (0.34 - 0.12 * u);
        const r = 1.015;
        const y = Math.cos(a) * r, radial = Math.sin(a) * r;
        target.set(Math.cos(around + spread) * radial, y, Math.sin(around + spread) * radial);
      }, 24, 8), muscleMaterial);
      muscles.add(strap);
    }
    globe.add(structure("sclera", "#e6e9f2", sclera, muscles));

    /* ── retina and choroid ── */
    const retinaMaterial = tissue("#e8735f", { roughness: 0.42, wet: 0.65, side: THREE.DoubleSide, emissive: new THREE.Color("#3a0d0a") });
    const retina = mesh(revolve(arc(0.9, 0, 0.42 * Math.PI, 0.93 * Math.PI, 44), 96, CUT_ARC), retinaMaterial);
    retina.rotation.y = CUT_START;
    const choroid = mesh(revolve(arc(0.915, 0, 0.42 * Math.PI, 0.93 * Math.PI, 40), 96, CUT_ARC), tissue("#7a2230", { roughness: 0.6, side: THREE.DoubleSide }));
    choroid.rotation.y = CUT_START;

    // Retinal vessels, fanning out from the optic disc exactly as a fundus photo
    // shows them: arcading above and below, sparing the macula.
    const discAngle = 0.86 * Math.PI, discAround = CUT_START + 0.5;
    const onRetina = (a: number, around: number, r = 0.885) =>
      new THREE.Vector3(Math.cos(around) * Math.sin(a) * r, Math.cos(a) * r, Math.sin(around) * Math.sin(a) * r);
    const disc = onRetina(discAngle, discAround);
    const vesselMaterial = tissue("#8e1f2a", { roughness: 0.4, wet: 0.7 });
    const vessels = new THREE.Group();
    const random = rng(151);
    for (let i = 0; i < 10; i++) {
      const spread = ((i / 9) - 0.5) * 2.6;
      const reach = 0.36 + random() * 0.24;
      const mid = onRetina(discAngle - reach * 0.5, discAround + spread * 0.5);
      const end = onRetina(discAngle - reach, discAround + spread * 1.5);
      vessels.add(mesh(tube([disc, mid, end], t => 0.022 - 0.014 * t, 26, 8), vesselMaterial));
      const branch = onRetina(discAngle - reach * 1.4, discAround + spread * 2.2 + (random() - 0.5));
      vessels.add(mesh(tube([mid, mid.clone().lerp(branch, 0.5), branch], t => 0.012 - 0.007 * t, 18, 6), vesselMaterial));
    }
    // Macula: a darker, vessel-free patch temporal to the disc, pitted at the fovea.
    const macula = mesh(
      sheet((u, v, target) => {
        const a = v * Math.PI * 2, rr = u * 0.16;
        const dip = 0.03 * Math.exp(-(rr * rr) / 0.0025);
        const base = onRetina(discAngle - 0.02, discAround - 0.42, 0.884 - dip);
        const tangent = onRetina(discAngle + 0.4, discAround - 0.42, 0.884).sub(base).normalize();
        const bitangent = base.clone().normalize().cross(tangent).normalize();
        target.copy(base).addScaledVector(tangent, Math.cos(a) * rr).addScaledVector(bitangent, Math.sin(a) * rr);
      }, 10, 28),
      tissue("#8f2f20", { roughness: 0.5, side: THREE.DoubleSide }),
    );
    globe.add(structure("retina", "#e8735f", retina, choroid, vessels, macula));

    /* ── vitreous: a faint gel so the globe is not hollow ── */
    const vitreous = mesh(revolve(arc(0.86, 0, 0.02, Math.PI - 0.02, 40), 72, Math.PI * 2), fluid("#cfe4ff", { opacity: 0.14, thickness: 1.8 }));
    vitreous.userData.noShadow = true;
    vitreous.scale.set(1, 0.98, 1);
    globe.add(structure("sclera", "#e6e9f2", vitreous));

    /* ── cornea and anterior chamber ── */
    const corneaProfile: [number, number][] = [
      ...arc(CORNEA_R, CORNEA_C, 0.004, CORNEA_EDGE, 34),
      ...arc(0.76, CORNEA_C, CORNEA_EDGE, 0.004, 34),
    ];
    const cornea = mesh(revolve(corneaProfile, 96, CUT_ARC), membrane("#63e0d0", 0.2, { transmission: 0.94, thickness: 0.22, roughness: 0.03, ior: 1.376, side: THREE.DoubleSide }));
    cornea.rotation.y = CUT_START;
    cornea.userData.noShadow = true;
    globe.add(structure("cornea", "#63e0d0", cornea));

    /* ── iris, rebuilt each time the pupil changes ── */
    const IRIS_U = 26, IRIS_V = 128;
    let pupil = 0.2;
    const irisGeometry = sheet((u, v, target) => irisPoint(u, v * Math.PI * 2, pupil, target), IRIS_U, IRIS_V);
    const irisColour = new Float32Array((IRIS_U + 1) * (IRIS_V + 1) * 3);
    const near = new THREE.Color("#2f5fa8"), far = new THREE.Color("#9fd4e8"), mix = new THREE.Color();
    const probe = new THREE.Vector3();
    for (let i = 0, k = 0; i <= IRIS_U; i++) {
      for (let j = 0; j <= IRIS_V; j++, k++) {
        const angle = (j / IRIS_V) * Math.PI * 2, rho = i / IRIS_U;
        probe.set(Math.cos(angle) * 3.4, rho * 5.5, Math.sin(angle) * 3.4);
        const t = THREE.MathUtils.clamp(0.35 + 0.55 * rho + 0.4 * fbm(probe, { octaves: 3, freq: 1.4, seed: 5 }), 0, 1);
        mix.copy(near).lerp(far, t).toArray(irisColour, k * 3);
      }
    }
    irisGeometry.setAttribute("color", new THREE.BufferAttribute(irisColour, 3));
    const iris = mesh(irisGeometry, tissue("#5f9ae8", { vertexColors: true, roughness: 0.44, wet: 0.55, side: THREE.DoubleSide }));
    // Pupil: a black disc set just behind the aperture, because a pupil is a
    // hole into a light-trap — it is not a dark-coloured object.
    const pupilDisc = mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ color: "#05070d" }), [0, 0.3, 0], [Math.PI / 2, 0, 0]);
    pupilDisc.userData.noShadow = true;
    globe.add(structure("iris", "#5f9ae8", iris, pupilDisc));

    /* ── lens and zonules ── */
    const lensProfile: [number, number][] = [
      ...arc(1.05, -0.72, 0, 0.4, 26).map(([r, y]) => [r * 0.42, y * 0.42 + 0.53] as [number, number]),
      ...arc(0.72, 1.02, Math.PI - 0.42, Math.PI, 26).map(([r, y]) => [r * 0.55, y * 0.55 - 0.29] as [number, number]),
    ];
    const lens = mesh(revolve(lensProfile, 72, Math.PI * 2), membrane("#ffd98a", 0.22, { transmission: 0.95, thickness: 0.5, roughness: 0.02, ior: 1.42 }));
    lens.userData.noShadow = true;
    const zonules = new THREE.Group();
    const zonuleMaterial = tissue("#ffeccf", { roughness: 0.5, transparent: true, opacity: 0.7 });
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const inner = new THREE.Vector3(Math.cos(a) * 0.4, 0.24, Math.sin(a) * 0.4);
      const outer = new THREE.Vector3(Math.cos(a) * 0.78, 0.3, Math.sin(a) * 0.78);
      const strand = mesh(tube([inner, inner.clone().lerp(outer, 0.5), outer], 0.007, 8, 5), zonuleMaterial);
      strand.userData.noShadow = true;
      zonules.add(strand);
    }
    globe.add(structure("lens", "#ffd98a", lens, zonules));

    /* ── optic nerve, leaving nasally with its fascicles ── */
    const nerveMaterial = tissue("#ffb35f", { roughness: 0.62, wet: 0.4 });
    const nerve = new THREE.Group();
    const exit = disc.clone().multiplyScalar(1.02);
    const away = exit.clone().normalize();
    nerve.add(mesh(tube([exit, exit.clone().addScaledVector(away, 0.45), exit.clone().addScaledVector(away, 1.05).add(new THREE.Vector3(0.1, -0.1, 0))], t => 0.15 + 0.06 * t, 40, 20), nerveMaterial));
    const fascicleMaterial = tissue("#e08a3f", { roughness: 0.7 });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const side = new THREE.Vector3(-away.y, away.x, 0).normalize();
      const other = away.clone().cross(side).normalize();
      const offset = side.multiplyScalar(Math.cos(a) * 0.07).addScaledVector(other, Math.sin(a) * 0.07);
      const s = exit.clone().addScaledVector(away, 0.5).add(offset);
      const e = exit.clone().addScaledVector(away, 1.02).add(offset).add(new THREE.Vector3(0.1, -0.1, 0));
      const fascicle = mesh(tube([s, e], 0.035, 12, 6), fascicleMaterial);
      fascicle.userData.noShadow = true;
      nerve.add(fascicle);
    }
    globe.add(structure("optic-nerve", "#ffb35f", nerve));

    // Tip the optical axis from +y to +z so the eye looks at the camera.
    const group = new THREE.Group();
    globe.rotation.x = Math.PI / 2;
    group.add(globe);

    const saccade = new THREE.Vector2();
    const target = new THREE.Vector2();
    let nextSaccade = 1.2;

    return {
      group,
      update(time, delta) {
        // Pupillary light reflex: fast constriction, slower redilation.
        const cycle = (time % 9) / 9;
        const bright = cycle < 0.45 ? 1 : 0;
        const wanted = bright ? 0.13 : 0.3;
        pupil += (wanted - pupil) * Math.min(1, delta * (bright ? 7 : 1.6));
        const position = irisGeometry.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0, k = 0; i <= IRIS_U; i++) {
          for (let j = 0; j <= IRIS_V; j++, k++) {
            irisPoint(i / IRIS_U, (j / IRIS_V) * Math.PI * 2, pupil, probe);
            position.setXYZ(k, probe.x, probe.y, probe.z);
          }
        }
        position.needsUpdate = true;
        irisGeometry.computeVertexNormals();
        pupilDisc.scale.setScalar(pupil * 1.02);

        // Microsaccades: eyes never hold still, and a perfectly steady eye is
        // the fastest way to make a model look dead.
        nextSaccade -= delta;
        if (nextSaccade <= 0) {
          target.set((Math.random() - 0.5) * 0.34, (Math.random() - 0.5) * 0.2);
          nextSaccade = 0.6 + Math.random() * 1.8;
        }
        saccade.lerp(target, Math.min(1, delta * 9));
        group.rotation.y = saccade.x;
        group.rotation.x = saccade.y;
      },
    };
  },
};
