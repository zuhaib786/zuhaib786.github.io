import * as THREE from 'three';

const material = (color: string, extras: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.63, metalness: 0, side: THREE.DoubleSide, ...extras });
const v3 = (p: number[]) => new THREE.Vector3(...p as [number, number, number]);

function tube(points: number[][], radius: number, color: string, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points.map(v3), closed);
  return new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, points.length * 5), radius, 8, closed), material(color));
}
function sphere(radius: number, color: string, position: number[], scale = [1, 1, 1]) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 28, 20), material(color));
  mesh.position.copy(v3(position)); mesh.scale.copy(v3(scale)); return mesh;
}
function beads(points: number[][], radius: number, color: string) {
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(radius, 9, 7), material(color), points.length);
  const matrix = new THREE.Matrix4();
  points.forEach((p, i) => { matrix.makeTranslation(...p as [number, number, number]); mesh.setMatrixAt(i, matrix); });
  mesh.instanceMatrix.needsUpdate = true; return mesh;
}
function sheet(f: (u: number, v: number) => number[], color: string, nu = 44, nv = 14) {
  const positions: number[] = [], indices: number[] = [];
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) positions.push(...f(i / nu, j / nv));
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const a = i * (nv + 1) + j, b = a + nv + 1; indices.push(a, b, a + 1, b, b + 1, a + 1); }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material(color));
}
function bowl(radius: number, color: string, scale = [1, 1, 1]) {
  const shell = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 36, Math.PI, Math.PI), material(color));
  shell.scale.copy(v3(scale)); return shell;
}
function rim(rx: number, ry: number, color: string, radius: number, z = 0) {
  return tube(Array.from({ length: 65 }, (_, i) => { const a = i / 64 * 2 * Math.PI; return [rx * Math.cos(a), ry * Math.sin(a), z]; }), radius, color, true);
}

function nucleus() {
  const g = new THREE.Group();
  g.add(bowl(0.86, '#a58bcc'), bowl(0.79, '#c6acd9'), rim(0.84, 0.84, '#9777b6', 0.043), sphere(0.26, '#79608e', [0.19, -0.1, 0.1]));
  for (let i = 0; i < 13; i++) {
    const points = Array.from({ length: 30 }, (_, j) => { const t = j / 29 * Math.PI * 2; return [0.55 * Math.cos(t + i * 0.7) * Math.sin(i + 0.9), 0.57 * Math.sin(t * 1.3 + i), -0.22 + 0.16 * Math.sin(t * 2 + i)]; });
    g.add(tube(points, 0.014, i % 2 ? '#8a68ae' : '#dac0e2'));
  }
  for (let i = 0; i < 22; i++) {
    const a = i * 2.39996, y = 1 - 2 * (i + 0.5) / 22;
    const normal = new THREE.Vector3(Math.sqrt(1 - y * y) * Math.cos(a), y, -Math.abs(Math.sqrt(1 - y * y) * Math.sin(a))).normalize();
    const pore = new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.017, 8, 14), material('#dfcce8'));
    pore.position.copy(normal).multiplyScalar(0.863); pore.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal); g.add(pore);
  }
  g.position.set(-0.58, 0.26, 0.12); return g;
}
function mitochondrion() {
  const g = new THREE.Group();
  g.add(bowl(1, '#ca8251', [0.99, 0.44, 0.38]), bowl(1, '#ecc090', [0.93, 0.38, 0.32]), rim(0.98, 0.43, '#dc925d', 0.05));
  for (let i = 0; i < 10; i++) {
    const x = -0.76 + i * 0.165, h = 0.32 * Math.sqrt(1 - x * x);
    g.add(sheet((u, v) => [x + 0.04 * Math.sin(u * Math.PI * 3), (u * 2 - 1) * h, -0.13 + v * 0.25 + 0.05 * Math.cos(u * Math.PI * 4)], '#e5a458', 20, 6));
    g.add(tube(Array.from({ length: 20 }, (_, j) => { const u = j / 19; return [x + 0.04 * Math.sin(u * Math.PI * 3), (u * 2 - 1) * h, 0.12 + 0.05 * Math.cos(u * Math.PI * 4)]; }), 0.022, '#f4d299'));
  }
  g.rotation.z = -0.48; g.position.set(1.33, -0.38, 0.3); return g;
}
function er() {
  const g = new THREE.Group(); const dots: number[][] = [];
  for (let k = 0; k < 5; k++) {
    const f = (u: number, v: number) => { const a = 0.5 + u * 2.75, r = 0.98 + k * 0.12 + v * 0.19; return [-0.58 + r * Math.cos(a), 0.26 + r * Math.sin(a) * 0.85, -0.12 + k * 0.07 + 0.065 * Math.sin(a * 4) + v * 0.10]; };
    g.add(sheet(f, k % 2 ? '#849dc0' : '#6985ae'));
    g.add(tube(Array.from({ length: 42 }, (_, j) => f(j / 41, 1)), 0.032, '#a6b9d0'));
    for (let i = 0; i < 36; i++) { const p = f((i + 0.3) / 37, 0.2 + (i % 3) * 0.25); p[2] += 0.045; dots.push(p); }
  }
  g.add(beads(dots, 0.023, '#354c73'));
  for (let k = 0; k < 4; k++) g.add(tube([[-1.7, 0.6, -0.1], [-2.1, 0.1 + k * 0.13, 0.1], [-1.9, -0.35 + k * 0.11, 0.18], [-2.15 + k * 0.12, -0.6, 0.08]], 0.043, '#819bbc'));
  return g;
}
function golgi() {
  const g = new THREE.Group();
  for (let k = 0; k < 6; k++) {
    const f = (u: number, v: number) => { const x = (u * 2 - 1) * (0.65 - Math.abs(k - 2.5) * 0.06); return [x, k * 0.115 + 0.2 * x * x, (v * 2 - 1) * 0.23 + 0.1 * Math.cos(u * Math.PI * 2)]; };
    g.add(sheet(f, k % 2 ? '#c9a560' : '#e2c487'));
    g.add(tube(Array.from({ length: 30 }, (_, j) => f(j / 29, 1)), 0.035, '#ecd59e'));
  }
  g.add(beads([[0.73, 0.12, 0.1], [0.64, 0.53, 0.17], [-0.7, 0.3, 0.13], [0.58, 0.82, 0], [-0.57, -0.08, 0.1]], 0.085, '#dcc389'));
  g.rotation.set(0.32, -0.25, -0.23); g.position.set(1.15, 0.82, 0.2); return g;
}
function lysosomes() {
  const g = new THREE.Group(); g.add(bowl(0.33, '#bf778a'), rim(0.33, 0.33, '#d89da9', 0.027));
  const points = Array.from({ length: 30 }, (_, i) => { const a = i * 2.39996, r = 0.25 * Math.sqrt((i + 1) / 30); return [r * Math.cos(a), r * Math.sin(a), -0.07 + 0.03 * Math.sin(i)]; });
  g.add(beads(points, 0.025, '#e7bac0'), sphere(0.19, '#c1879b', [0.45, 0.24, -0.16]), sphere(0.14, '#ad7d92', [-0.29, -0.28, -0.02]));
  g.position.set(0.32, -1.22, 0.24); return g;
}
function centrosome() {
  const g = new THREE.Group();
  for (let c = 0; c < 2; c++) {
    const centriole = new THREE.Group();
    for (let i = 0; i < 9; i++) for (let j = 0; j < 3; j++) {
      const a = i / 9 * Math.PI * 2 + j * 0.13;
      const microtubule = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.54, 10, 1, true), material(j === 1 ? '#a8cec0' : '#689b8b'));
      microtubule.position.set((0.16 + j * 0.018) * Math.cos(a), 0, (0.16 + j * 0.018) * Math.sin(a)); centriole.add(microtubule);
    }
    if (c) { centriole.rotation.z = Math.PI / 2; centriole.position.set(0.36, -0.12, 0.05); }
    g.add(centriole);
  }
  g.rotation.set(0.4, 0.2, -0.3); g.position.set(-1.08, -1.05, 0.25); return g;
}
function membrane() {
  const g = new THREE.Group();
  g.add(bowl(2.5, '#b2c3ac', [1.15, 0.87, 0.63]), bowl(2.45, '#dde0c4', [1.15, 0.87, 0.63]), rim(2.87, 2.17, '#9db49b', 0.055), rim(2.79, 2.10, '#c7d3ad', 0.043, 0.012));
  g.add(beads(Array.from({ length: 145 }, (_, i) => { const a = i / 145 * Math.PI * 2; return [2.84 * Math.cos(a), 2.145 * Math.sin(a), 0.025]; }), 0.025, '#cbd8bf'));
  return g;
}

export function buildCell(): THREE.Group {
  const group = new THREE.Group();
  for (const [id, build] of Object.entries({ membrane, nucleus, mitochondria: mitochondrion, er, golgi, lysosomes, centrosome })) {
    const object = build(); object.name = id;
    object.traverse(mesh => { if (mesh instanceof THREE.Mesh) { mesh.userData.partId = id; mesh.userData.label = id; } });
    group.add(object);
  }
  return group;
}
