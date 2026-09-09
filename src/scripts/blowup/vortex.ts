import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type Sample = (r: number, z: number) => { ur: number; uz: number; ut: number };

export type Palette = { low: string; mid: string; high: string; ink: string; ground: string };

const CURVES = 120;
const FWD = 360;
const BACK = 210;
const STEP = 0.028;
const SPAN = 1.55;   // half-extent the built bundle is normalised to
const R_MAX = 2.4;   // radial reach of the drawn bundle at tau = 1
const Z_MAX = 3.0;   // axial reach of the drawn bundle at tau = 1
const RADIAL = 6;

type Curve = { pts: THREE.Vector3[]; omega: number[] };

/**
 * A three-dimensional view of the collapsing vortex. The leading flow is
 * self-similar, so in the scaled coordinates (r/sqrt(tau), z/tau^D) the bundle
 * of streamlines has a fixed shape: the geometry is built once and then simply
 * scaled by (sqrt(tau), tau^D, sqrt(tau)), which is exactly the anisotropic
 * collapse the construction describes.
 */
export class VortexView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.01, 200);
  private controls: OrbitControls;
  private bundle = new THREE.Group();
  private mesh?: THREE.Mesh;
  private ghost?: THREE.LineSegments;
  private axis = new THREE.Group();
  private curves: Curve[] = [];
  private omegaMax = 1;
  private norm = 1;
  private spin = 0;
  ready = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.camera.position.set(3.15, 1.05, 3.15);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableZoom = true;
    this.controls.minDistance = 1.6;
    this.controls.maxDistance = 16;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.5;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(2.4, 3.2, 1.8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4);
    fill.position.set(-2.6, -1.4, -2.2);
    this.scene.add(fill);
    this.scene.add(this.bundle);
    this.scene.add(this.axis);
  }

  /** Trace streamlines of the full three-dimensional field at tau = 1. */
  private trace(sample: Sample, xCore: number, xAnn: number) {
    const curves: Curve[] = [];
    let omegaMax = 1e-9;
    let seed = 20260908;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const walk = (r0: number, th0: number, z0: number, dir: 1 | -1, steps: number) => {
      const pts: THREE.Vector3[] = [];
      const om: number[] = [];
      let r = r0, th = th0, z = z0;
      for (let i = 0; i < steps; i++) {
        const f = sample(r, z);
        const speed = Math.hypot(f.ur, f.uz, f.ut);
        if (!Number.isFinite(speed) || speed < 1e-9) break;
        const w = r > 1e-6 ? Math.abs(f.ut) / r : 0;
        if (w > omegaMax) omegaMax = w;
        pts.push(new THREE.Vector3(r * Math.cos(th), z, r * Math.sin(th)));
        om.push(w);
        const k = (dir * STEP) / speed;
        r += k * f.ur;
        z += k * f.uz;
        if (r > 1e-6) th += (k * f.ut) / r;
        if (!Number.isFinite(r) || !Number.isFinite(z)) break;
        if (r < 0) r = 0;
        if (r > R_MAX || Math.abs(z) > Z_MAX) break;
      }
      return { pts, om };
    };

    for (let k = 0; k < CURVES; k++) {
      // roughly half the curves start inside the core, where they wind many
      // times around the axis, and half out in the annulus that feeds it
      const inner = k % 2 === 0;
      const eta = (rnd() * 2 - 1) * (inner ? 0.5 : 0.66);
      const X0 = inner
        ? 0.12 + rnd() * (xCore - 0.12)
        : xCore + Math.pow(rnd(), 1.2) * (xAnn - xCore);
      const q = 1 / (1 - eta * eta);
      const r0 = Math.sqrt(2 * q * X0);
      const z0 = Math.sqrt(q) * eta;
      const th0 = rnd() * Math.PI * 2;
      const back = walk(r0, th0, z0, -1, BACK);
      const fwd = walk(r0, th0, z0, 1, FWD);
      back.pts.reverse(); back.om.reverse();
      const pts = back.pts.concat(fwd.pts.slice(1));
      const om = back.om.concat(fwd.om.slice(1));
      if (pts.length > 24) curves.push({ pts, omega: om });
    }
    let extent = 1e-6;
    for (const c of curves) for (const p of c.pts) extent = Math.max(extent, p.length());
    this.norm = SPAN / extent;
    for (const c of curves) for (const p of c.pts) p.multiplyScalar(this.norm);
    this.curves = curves;
    this.omegaMax = omegaMax;
  }

  /** Sweep a tapered tube along every curve into one merged geometry. */
  private buildMesh(palette: Palette) {
    const low = new THREE.Color(palette.low);
    const mid = new THREE.Color(palette.mid);
    const high = new THREE.Color(palette.high);
    let verts = 0, quads = 0;
    for (const c of this.curves) { verts += c.pts.length * (RADIAL + 1); quads += (c.pts.length - 1) * RADIAL; }

    const position = new Float32Array(verts * 3);
    const normal = new Float32Array(verts * 3);
    const color = new Float32Array(verts * 3);
    const index = new Uint32Array(quads * 6);
    let vp = 0, ip = 0, base = 0;

    const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), tmp = new THREE.Vector3();
    const col = new THREE.Color();

    for (const c of this.curves) {
      const n = c.pts.length;
      N.set(0, 1, 0);
      for (let i = 0; i < n; i++) {
        const p = c.pts[i];
        const a = c.pts[Math.max(0, i - 1)], b = c.pts[Math.min(n - 1, i + 1)];
        T.subVectors(b, a);
        if (T.lengthSq() < 1e-16) T.set(0, 1, 0);
        T.normalize();
        // rotation-minimising frame: project the previous normal off the tangent
        tmp.copy(T).multiplyScalar(N.dot(T));
        N.sub(tmp);
        if (N.lengthSq() < 1e-10) N.set(T.y > 0.9 ? 1 : 0, T.y > 0.9 ? 0 : 1, 0).sub(tmp.copy(T).multiplyScalar(N.dot(T)));
        N.normalize();
        B.crossVectors(T, N);

        const taper = Math.pow(Math.sin((Math.PI * i) / (n - 1)), 0.3);
        // faster-rotating filaments are drawn thicker, so the core column
        // reads through the slower outer skirt
        const t = Math.pow(Math.min(1, c.omega[i] / this.omegaMax), 0.8);
        const radius = 0.0125 * (0.3 + 0.7 * taper) * (0.62 + 0.9 * t);
        if (t < 0.5) col.copy(low).lerp(mid, t / 0.5);
        else col.copy(mid).lerp(high, (t - 0.5) / 0.5);

        for (let j = 0; j <= RADIAL; j++) {
          const a2 = (j / RADIAL) * Math.PI * 2;
          const nx = Math.cos(a2) * N.x + Math.sin(a2) * B.x;
          const ny = Math.cos(a2) * N.y + Math.sin(a2) * B.y;
          const nz = Math.cos(a2) * N.z + Math.sin(a2) * B.z;
          position[vp] = p.x + nx * radius; normal[vp] = nx; color[vp] = col.r; vp++;
          position[vp] = p.y + ny * radius; normal[vp] = ny; color[vp] = col.g; vp++;
          position[vp] = p.z + nz * radius; normal[vp] = nz; color[vp] = col.b; vp++;
        }
      }
      for (let i = 0; i < n - 1; i++) {
        for (let j = 0; j < RADIAL; j++) {
          const a = base + i * (RADIAL + 1) + j;
          const b = a + RADIAL + 1;
          index[ip++] = a; index[ip++] = b; index[ip++] = a + 1;
          index[ip++] = a + 1; index[ip++] = b; index[ip++] = b + 1;
        }
      }
      base += n * (RADIAL + 1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.04 });
    const mesh = new THREE.Mesh(geo, mat);
    if (this.mesh) {
      this.bundle.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
    this.mesh = mesh;
    this.bundle.add(mesh);
  }

  private buildFurniture(palette: Palette) {
    this.axis.clear();
    const inkColor = new THREE.Color(palette.ink);
    const line = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute([0, -SPAN * 1.05, 0, 0, SPAN * 1.02, 0], 3),
      ),
      new THREE.LineBasicMaterial({ color: inkColor, transparent: true, opacity: 0.55 }),
    );
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(0.04, 0.15, 16),
      new THREE.MeshBasicMaterial({ color: inkColor, transparent: true, opacity: 0.6 }),
    );
    tip.position.set(0, SPAN * 1.09, 0);
    this.axis.add(line, tip);

    // the size of the core at tau = 1, left behind as the bundle contracts
    const ring: number[] = [];
    const SEG = 96;
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2, b = ((i + 1) / SEG) * Math.PI * 2;
      const R = 2.236 * this.norm;
      ring.push(Math.cos(a) * R, 0, Math.sin(a) * R, Math.cos(b) * R, 0, Math.sin(b) * R);
    }
    if (this.ghost) { this.ghost.geometry.dispose(); this.scene.remove(this.ghost); }
    this.ghost = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(ring, 3)),
      new THREE.LineDashedMaterial({ color: inkColor, transparent: true, opacity: 0.3, dashSize: 0.12, gapSize: 0.1 }),
    );
    this.ghost.computeLineDistances();
    this.scene.add(this.ghost);
  }

  build(sample: Sample, xCore: number, xAnn: number, palette: Palette) {
    this.trace(sample, xCore, xAnn);
    this.buildMesh(palette);
    this.buildFurniture(palette);
    this.scene.background = new THREE.Color(palette.ground);
    this.ready = true;
  }

  retheme(palette: Palette) {
    if (!this.ready) return;
    this.buildMesh(palette);
    this.buildFurniture(palette);
    this.scene.background = new THREE.Color(palette.ground);
  }

  resize(w: number, h: number) {
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(tau: number, D: number, frame: 'lab' | 'similarity', ds: number) {
    this.spin += ds * 1.9;
    const sr = Math.sqrt(tau), sz = Math.pow(tau, D);
    if (frame === 'lab') this.bundle.scale.set(sr, sz, sr);
    else this.bundle.scale.set(1, Math.pow(tau, D - 0.5), 1);
    this.bundle.rotation.y = this.spin;
    if (this.ghost) this.ghost.visible = frame === 'lab';
    this.axis.scale.setScalar(frame === 'lab' ? 1 : 1);
    this.controls.update();
  }

  render() { this.renderer.render(this.scene, this.camera); }

  dispose() {
    this.controls.dispose();
    this.mesh?.geometry.dispose();
    (this.mesh?.material as THREE.Material | undefined)?.dispose();
    this.ghost?.geometry.dispose();
    this.renderer.dispose();
  }
}
