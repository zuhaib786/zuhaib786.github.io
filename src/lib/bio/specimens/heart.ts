import * as THREE from "three";
import { blob, fbm, mesh, ramp, sheet, structure, tissue, tube } from "../toolkit";
import { part, type Specimen } from "../types";

/*
 * The heart is not a sphere with tubes stuck on. Its shape comes from one fact:
 * the left ventricle is a thick prolate cone, and the right ventricle is a thin
 * crescent wrapped around the front of it. Everything else — the silhouette,
 * the interventricular groove the coronary arteries run in, the difference in
 * wall thickness — falls out of that. So both chambers are lofted from real
 * cross-sections rather than modelled as blobs.
 *
 * Axes: +x is the patient's left, +z is anterior, +y is superior.
 */

const BASE_Y = 1.0, APEX_SPAN = 2.5;
const yOf = (t: number) => BASE_Y - APEX_SPAN * t;

/** Left-ventricular outer radius: a prolate ellipsoid that closes to a point at
 *  the apex, which is why the heart tapers instead of ending in a stump. */
function lvRadius(t: number) {
  const y = yOf(t);
  const k = (y - 0.35) / 1.9;
  return 0.84 * Math.sqrt(Math.max(0, 1 - k * k));
}

const LV_CENTRE = new THREE.Vector2(0.14, 0);      // x, z
const RV_START = 0.85, RV_END = 3.95;              // arc the crescent spans, radians
const RV_BOTTOM = 0.80;                            // the RV stops short of the apex
const rvWall = (t: number) => (0.36 - 0.22 * t) * (1 - 0.35 * t);

/** Muscle is not smooth — a little fbm keeps the myocardium from reading as vinyl. */
const grain = (t: number, angle: number, amount = 0.022) =>
  amount * fbm(new THREE.Vector3(Math.cos(angle) * 1.6, t * 3.4, Math.sin(angle) * 1.6), { octaves: 3, freq: 1.5, seed: 9 });

/** A point on the LV epicardial surface, for the chamber and for anything that
 *  has to lie on it (the coronary arteries do). */
function lvPoint(t: number, angle: number, offset = 0, target = new THREE.Vector3()) {
  const r = lvRadius(t) + grain(t, angle) + offset;
  return target.set(LV_CENTRE.x + Math.cos(angle) * r, yOf(t), LV_CENTRE.y + Math.sin(angle) * r);
}

/** Crescent outer radius, bulging to its maximum mid-arc. */
function rvOuter(t: number, angle: number) {
  const s = (angle - RV_START) / (RV_END - RV_START);
  return lvRadius(t) + rvWall(t) * Math.sin(Math.PI * THREE.MathUtils.clamp(s, 0, 1)) + grain(t, angle, 0.03);
}

const parts = [
  part("left-ventricle", "Left ventricle", "Systemic pump", "#c33b46",
    "The thick-walled cone that forms the apex and the whole left border of the heart.",
    "Ejects oxygenated blood through the aortic valve into the systemic circulation.",
    "Muscular chamber", "wall ≈ 8–15 mm",
    "Its wall is roughly three times the right ventricle's, because it pumps against about five times the pressure."),
  part("right-ventricle", "Right ventricle", "Pulmonary pump", "#a8365f",
    "A thin crescent wrapped across the front of the left ventricle, sharing the septum with it.",
    "Sends deoxygenated blood through the pulmonary valve toward the lungs.",
    "Muscular chamber", "wall ≈ 3–5 mm",
    "It moves the same volume per beat as the left ventricle with a fraction of the muscle — the lungs are a low-pressure circuit."),
  part("atria", "Atria", "Receiving chambers", "#8f5f9c",
    "The thin-walled upper chambers, with their ear-shaped appendages tucked over the great vessels.",
    "Receive venous return and top up ventricular filling with a final contraction.",
    "Paired chambers", "wall ≈ 2–3 mm",
    "Most ventricular filling is passive. The atrial kick adds only the last fifth — which is why people live in atrial fibrillation."),
  part("aorta", "Aorta", "Systemic outflow", "#e5876b",
    "Rises from the left ventricle, arches backward over the pulmonary artery, and descends.",
    "Distributes high-pressure oxygenated blood, its elastic wall smoothing each ejection into steady flow.",
    "Elastic artery", "≈ 25–35 mm across",
    "The three vessels leaving the arch feed the head and arms — everything else is supplied further down."),
  part("pulmonary", "Pulmonary trunk", "Pulmonary outflow", "#4f92c6",
    "Leaves the right ventricle anteriorly and immediately divides toward both lungs.",
    "Carries deoxygenated blood out of the heart for gas exchange.",
    "Elastic artery", "≈ 25–30 mm across",
    "It is an artery because it leaves the heart, not because of what it carries — the one artery with deoxygenated blood."),
  part("vena-cava", "Venae cavae", "Systemic return", "#3f6fa8",
    "The two great veins draining into the right atrium from above and below.",
    "Return deoxygenated blood from the whole body to the right side of the heart.",
    "Great veins", "≈ 20–30 mm across",
    "They run at almost no pressure; breathing and walking are what actually move blood along them."),
  part("coronary", "Coronary vessels", "Cardiac circulation", "#ffc85c",
    "Arteries running in the grooves between the chambers, then diving into the muscle.",
    "Supply the myocardium itself — the one tissue that cannot take oxygen from the blood passing through it.",
    "Arterial network", "stems ≈ 2–5 mm",
    "They fill during diastole. A contracting ventricle squeezes its own arteries shut, so the heart feeds itself between beats."),
];

export const heart: Specimen = {
  id: "heart",
  name: "Human heart",
  subtitle: "gross anatomy, beating",
  code: "SPECIMEN 04 / CARDIOVASCULAR",
  scale: "≈ 12 cm",
  aria: "three-dimensional beating human heart",
  category: "anatomy",
  parts,
  build() {
    const group = new THREE.Group();

    /* ── left ventricle ── */
    const lvMaterial = tissue("#c33b46", { roughness: 0.58, wet: 0.5 });
    const lvWall = mesh(sheet((u, v, target) => lvPoint(u * 1.02, v * Math.PI * 2, 0, target), 60, 72), lvMaterial);
    // Valve plane: the fibrous cap the ventricle is open into at the base.
    const lvCap = mesh(sheet((u, v, target) => {
      const angle = v * Math.PI * 2, r = lvRadius(0) * u;
      target.set(LV_CENTRE.x + Math.cos(angle) * r, BASE_Y + 0.1 * (1 - u * u), LV_CENTRE.y + Math.sin(angle) * r);
    }, 12, 60), tissue("#d8bfb0", { roughness: 0.7, wet: 0.3, side: THREE.DoubleSide }));
    const ventricleLeft = structure("left-ventricle", "#c33b46", lvWall, lvCap);

    /* ── right ventricle ── */
    const rvMaterial = tissue("#a8365f", { roughness: 0.6, wet: 0.5, side: THREE.DoubleSide });
    // The cross-section is a closed loop: out along the free wall, back along
    // the septal surface it shares with the LV.
    const rvWallMesh = mesh(sheet((u, v, target) => {
      const t = u * RV_BOTTOM;
      const outward = v < 0.5;
      const s = outward ? v * 2 : 1 - (v - 0.5) * 2;
      const angle = RV_START + s * (RV_END - RV_START);
      const r = outward ? rvOuter(t, angle) : lvRadius(t) + 0.012;
      target.set(LV_CENTRE.x + Math.cos(angle) * r, yOf(t), LV_CENTRE.y + Math.sin(angle) * r);
    }, 46, 92), rvMaterial);
    const rvCap = mesh(sheet((u, v, target) => {
      const angle = RV_START + u * (RV_END - RV_START);
      const r = THREE.MathUtils.lerp(lvRadius(0) + 0.012, rvOuter(0, angle), v);
      target.set(LV_CENTRE.x + Math.cos(angle) * r, BASE_Y + 0.06 * Math.sin(Math.PI * u), LV_CENTRE.y + Math.sin(angle) * r);
    }, 60, 8), rvMaterial);
    // Outflow tract: the RV funnels up and to the left before the valve.
    const infundibulum = mesh(
      tube([lvPoint(0.12, 1.5, 0.28), new THREE.Vector3(-0.12, 1.15, 0.62), new THREE.Vector3(-0.16, 1.45, 0.5)], t => 0.34 - 0.08 * t, 20, 22),
      rvMaterial,
    );
    const ventricleRight = structure("right-ventricle", "#a8365f", rvWallMesh, rvCap, infundibulum);

    const ventricles = new THREE.Group();
    ventricles.add(ventricleLeft, ventricleRight);
    group.add(ventricles);

    /* ── atria ── */
    const atrialMaterial = tissue("#8f5f9c", { roughness: 0.66, wet: 0.42 });
    const atria = new THREE.Group();
    const leftAtrium = mesh(blob(0.52, { detail: 26, amp: 0.11, freq: 2.2, seed: 31, scale: [1.05, 0.8, 1] }), atrialMaterial, [0.42, 1.36, -0.42]);
    const rightAtrium = mesh(blob(0.54, { detail: 26, amp: 0.12, freq: 2.1, seed: 37, scale: [1, 0.86, 1.05] }), atrialMaterial, [-0.52, 1.3, -0.12]);
    // Auricles — the flattened, hooked appendages that overlap the great vessels.
    const leftAuricle = mesh(blob(0.2, { detail: 16, amp: 0.22, freq: 3.4, seed: 41, scale: [1.5, 0.7, 0.9] }), atrialMaterial, [0.62, 1.18, 0.26], [0, -0.5, -0.4]);
    const rightAuricle = mesh(blob(0.21, { detail: 16, amp: 0.22, freq: 3.2, seed: 43, scale: [1.4, 0.72, 0.95] }), atrialMaterial, [-0.62, 1.16, 0.3], [0, 0.6, 0.4]);
    atria.add(leftAtrium, rightAtrium, leftAuricle, rightAuricle);
    group.add(structure("atria", "#8f5f9c", atria));

    /* ── great vessels ── */
    const aortaMaterial = tissue("#e5876b", { roughness: 0.44, wet: 0.6 });
    const aortaPath = [
      new THREE.Vector3(0.16, 1.05, 0.02), new THREE.Vector3(0.06, 1.62, 0.06), new THREE.Vector3(-0.04, 2.15, -0.16),
      new THREE.Vector3(0.16, 2.46, -0.62), new THREE.Vector3(0.5, 2.24, -0.94), new THREE.Vector3(0.5, 1.5, -1.02),
      new THREE.Vector3(0.44, 0.6, -1.0), new THREE.Vector3(0.4, -0.3, -0.98),
    ];
    const aorta = new THREE.Group();
    aorta.add(mesh(tube(aortaPath, t => 0.24 - 0.07 * ramp(t, 0, 0.6), 96, 24), aortaMaterial));
    // Brachiocephalic, left common carotid, left subclavian.
    ([[-0.12, 0.55], [0.06, 0.62], [0.24, 0.58]] as [number, number][]).forEach(([x, lean], i) => {
      const root = new THREE.Vector3(x * 0.6 - 0.02, 2.42, -0.5 + i * 0.06);
      aorta.add(mesh(tube([root, root.clone().add(new THREE.Vector3(x * 0.3, 0.36, -0.06)), root.clone().add(new THREE.Vector3(x * lean, 0.78, -0.12))], t => 0.075 - 0.02 * t, 24, 14), aortaMaterial));
    });
    group.add(structure("aorta", "#e5876b", aorta));

    const pulmonaryMaterial = tissue("#4f92c6", { roughness: 0.44, wet: 0.6 });
    const pulmonary = new THREE.Group();
    const trunk = [new THREE.Vector3(-0.16, 1.42, 0.5), new THREE.Vector3(-0.1, 1.86, 0.3), new THREE.Vector3(0.02, 2.16, -0.02)];
    pulmonary.add(mesh(tube(trunk, t => 0.22 - 0.03 * t, 40, 22), pulmonaryMaterial));
    const split = trunk[2];
    pulmonary.add(mesh(tube([split, split.clone().add(new THREE.Vector3(0.5, 0.06, -0.2)), split.clone().add(new THREE.Vector3(1.02, -0.02, -0.44))], t => 0.15 - 0.04 * t, 30, 16), pulmonaryMaterial));
    pulmonary.add(mesh(tube([split, split.clone().add(new THREE.Vector3(-0.52, 0.02, -0.22)), split.clone().add(new THREE.Vector3(-1.06, -0.12, -0.46))], t => 0.15 - 0.04 * t, 30, 16), pulmonaryMaterial));
    // Pulmonary veins returning into the left atrium.
    ([[0.95, 1.62, -0.9], [0.95, 1.16, -0.98], [0.2, 1.7, -1.05], [0.24, 1.12, -1.05]] as [number, number, number][]).forEach(p => {
      const end = new THREE.Vector3(...p);
      pulmonary.add(mesh(tube([new THREE.Vector3(0.42, 1.36, -0.5), end.clone().lerp(new THREE.Vector3(0.42, 1.36, -0.5), 0.4), end], 0.085, 22, 12), tissue("#d4646f", { roughness: 0.46, wet: 0.6 })));
    });
    group.add(structure("pulmonary", "#4f92c6", pulmonary));

    const venaMaterial = tissue("#3f6fa8", { roughness: 0.48, wet: 0.55 });
    const cava = new THREE.Group();
    cava.add(mesh(tube([new THREE.Vector3(-0.62, 1.5, -0.16), new THREE.Vector3(-0.72, 2.1, -0.3), new THREE.Vector3(-0.74, 2.9, -0.36)], t => 0.17 + 0.03 * t, 34, 18), venaMaterial));
    cava.add(mesh(tube([new THREE.Vector3(-0.5, 1.1, -0.3), new THREE.Vector3(-0.6, 0.4, -0.55), new THREE.Vector3(-0.58, -0.4, -0.62)], t => 0.18 + 0.04 * t, 34, 18), venaMaterial));
    group.add(structure("vena-cava", "#3f6fa8", cava));

    /* ── coronaries: they lie in the grooves, so they are drawn on the surface ── */
    const coronaryMaterial = tissue("#ffc85c", { roughness: 0.4, wet: 0.7 });
    const veinMaterial = tissue("#7f4fd8", { roughness: 0.45, wet: 0.6 });
    const coronary = new THREE.Group();
    const alongSurface = (from: number, to: number, angleAt: (s: number) => number, offset: number, steps = 22) =>
      Array.from({ length: steps }, (_, i) => lvPoint(THREE.MathUtils.lerp(from, to, i / (steps - 1)), angleAt(i / (steps - 1)), offset));

    // LAD in the anterior interventricular groove — the seam where the RV's free
    // wall meets the LV, i.e. exactly the start angle of the crescent.
    coronary.add(mesh(tube(alongSurface(0.06, 0.94, () => RV_START - 0.06, 0.05), t => 0.052 - 0.028 * t, 60, 12), coronaryMaterial));
    // Posterior descending, in the other groove.
    coronary.add(mesh(tube(alongSurface(0.08, 0.88, () => RV_END + 0.05, 0.05), t => 0.044 - 0.024 * t, 50, 12), coronaryMaterial));
    // Circumflex and RCA, running round the atrioventricular groove.
    coronary.add(mesh(tube(alongSurface(0.07, 0.16, s => RV_START - 0.1 - s * 2.5, 0.06, 26), 0.05, 46, 12), coronaryMaterial));
    coronary.add(mesh(tube(alongSurface(0.07, 0.17, s => RV_END + 0.1 + s * 2.2, 0.06, 26), 0.048, 46, 12), coronaryMaterial));
    // Diagonal branches peeling off the LAD.
    [0.3, 0.52, 0.7].forEach((t0, i) => {
      coronary.add(mesh(tube(alongSurface(t0, t0 + 0.16, s => RV_START - 0.06 - s * (0.9 + i * 0.2), 0.045, 14), 0.028, 24, 10), coronaryMaterial));
    });
    // Great cardiac vein, shadowing the LAD as it always does.
    coronary.add(mesh(tube(alongSurface(0.1, 0.86, () => RV_START + 0.16, 0.05), t => 0.04 - 0.016 * t, 50, 12), veinMaterial));
    group.add(structure("coronary", "#ffc85c", coronary));

    // Cardiac cycle, ≈ 0.86 s — atrial kick, then ventricular systole, then a
    // long diastole. The ventricles also twist: a real heart wrings itself out.
    const CYCLE = 0.86;
    return {
      group,
      update(time) {
        const c = (time % CYCLE) / CYCLE;
        const atrial = Math.sin(Math.PI * THREE.MathUtils.clamp(c / 0.14, 0, 1)) * (c < 0.14 ? 1 : 0);
        const ventricular = c < 0.12 ? 0
          : c < 0.4 ? ramp(c, 0.12, 0.32)
          : ramp(1 - c, 0, 0.28);
        ventricles.scale.set(1 - 0.055 * ventricular, 1 - 0.085 * ventricular, 1 - 0.055 * ventricular);
        ventricles.rotation.y = -0.075 * ventricular;
        ventricles.position.y = 0.055 * ventricular;
        atria.scale.setScalar(1 - 0.075 * atrial + 0.03 * ventricular);
        coronary.position.y = 0.052 * ventricular;
        coronary.scale.setScalar(1 - 0.03 * ventricular);
      },
    };
  },
};
