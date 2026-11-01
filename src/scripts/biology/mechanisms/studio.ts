// <mechanism-study>: the instrument that hosts one procedural biology study.
//
// The study supplies geometry, a single degree of freedom and three small 2D
// drawings; this element supplies everything around it — camera views, the
// display modes (labels, section, x-ray, exploded, context, orbit), leader
// labels, hover/click identification, and the transport.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ghostMaterial } from './toolkit';
import type { Ink, Rig, Study } from './types';
import { heartStudy } from './heart';
import { eyeStudy } from './eye';
import { cellStudy } from './cell';

const STUDIES: Study[] = [heartStudy, eyeStudy, cellStudy];
const DISPLAY = ['labels', 'section', 'xray', 'exploded', 'context', 'orbit'] as const;
type Display = (typeof DISPLAY)[number];

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

type Built = {
  rig: Rig;
  rest: THREE.Box3;
  span: THREE.Box3;
  ghost: THREE.ShaderMaterial;
  meshes: THREE.Mesh[];
};

class MechanismStudyElement extends HTMLElement {
  private renderer?: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.05, 200);
  private controls?: OrbitControls;
  private canvas!: HTMLCanvasElement;
  private stage!: HTMLElement;
  private key = new THREE.DirectionalLight('#fff4e8', 2.3);
  private floor = new THREE.Mesh(new THREE.PlaneGeometry(36, 36), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
  private shadow = new THREE.Mesh(new THREE.PlaneGeometry(36, 36), new THREE.ShadowMaterial({ opacity: 0.16 }));
  private floorTexture?: THREE.CanvasTexture;

  private cache = new Map<string, Built>();
  private study: Study = heartStudy;
  private built?: Built;
  private seq = 'rest';
  private t = 0;
  private playing = true;
  private speed = 0.8;
  private display = new Set<Display>(['labels']);
  private explode = 0;
  private view = 'hero';
  private flight?: { from: THREE.Vector3; to: THREE.Vector3; fromR: number; toR: number; target: THREE.Vector3; fromTarget: THREE.Vector3; start: number };
  private selected = '';
  private hover = '';
  private ink!: Ink;
  private worldPlane = new THREE.Plane();
  private raycaster = new THREE.Raycaster();
  private down?: { x: number; y: number; moved: boolean };

  private aborter = new AbortController();
  private frame = 0;
  private last = 0;
  private visible = true;
  private dirty = true;
  private stale = true;
  private destroyed = false;
  private token = 0;
  private resize?: ResizeObserver;
  private intersect?: IntersectionObserver;
  private themeWatch?: MutationObserver;

  connectedCallback() {
    this.canvas = this.$('[data-canvas]') as HTMLCanvasElement;
    this.stage = this.$('[data-stage]')!;
    this.readInk();
    this.buildChrome();
    const params = new URLSearchParams(location.search);
    const initial = STUDIES.find(s => s.id === params.get('study'))?.id ?? this.dataset.study ?? 'heart';
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch {
      this.status('3D rendering is unavailable', 'This study needs WebGL. The panels still describe the mechanism.', true);
      this.select(initial, params);
      return;
    }
    const r = this.renderer;
    r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.localClippingEnabled = true;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.setClearColor(0x000000, 0);

    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight('#fffaf2', '#8a7462', 0.7));
    this.key.position.set(-3.5, 7, 4.5);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.radius = 6;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    this.scene.add(this.key, this.key.target);
    const rim = new THREE.DirectionalLight('#ffe2d0', 1.4); rim.position.set(4, 3, -5); this.scene.add(rim);
    const fill = new THREE.DirectionalLight('#dfe8ff', 0.55); fill.position.set(5, 1, 3); this.scene.add(fill);
    this.floor.rotation.x = -Math.PI / 2;
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.receiveShadow = true;
    this.floor.renderOrder = -2;
    this.scene.add(this.floor, this.shadow);
    this.paintFloor();

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.autoRotateSpeed = 0.7;
    this.controls.addEventListener('start', () => { this.flight = undefined; });
    this.controls.addEventListener('change', () => { this.dirty = true; });

    this.bindCanvas();
    this.resize = new ResizeObserver(() => this.layout());
    this.resize.observe(this.stage);
    this.intersect = new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; this.dirty = true; });
    this.intersect.observe(this);
    this.themeWatch = new MutationObserver(() => this.retheme());
    this.themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) this.playing = false;
    this.select(initial, params);
    this.frame = requestAnimationFrame(this.loop);
  }

  disconnectedCallback() {
    this.destroyed = true;
    this.aborter.abort();
    cancelAnimationFrame(this.frame);
    this.resize?.disconnect(); this.intersect?.disconnect(); this.themeWatch?.disconnect();
    this.controls?.dispose();
    for (const b of this.cache.values()) b.rig.root.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const mat of [m.material, m.userData.base].flat()) (mat as THREE.Material | undefined)?.dispose();
    });
    this.floorTexture?.dispose();
    this.renderer?.dispose();
  }

  /* ── chrome ─────────────────────────────────────────────────────────── */

  private $(s: string) { return this.querySelector<HTMLElement>(s); }
  private text(s: string, v: string) { const n = this.$(s); if (n && n.textContent !== v) n.textContent = v; }
  private on<K extends keyof HTMLElementEventMap>(el: EventTarget | null, type: K, fn: (e: HTMLElementEventMap[K]) => void) {
    el?.addEventListener(type, fn as EventListener, { signal: this.aborter.signal });
  }

  private buildChrome() {
    const nav = this.$('[data-studies]')!;
    nav.replaceChildren(...STUDIES.map(s => {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.studyId = s.id;
      b.innerHTML = `<span>${s.code}</span>${s.short}`;
      b.title = s.title;
      this.on(b, 'click', () => this.select(s.id));
      return b;
    }));
    const display = this.$('[data-display]')!;
    display.replaceChildren(...DISPLAY.map(d => {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.mode = d;
      b.textContent = d === 'xray' ? 'X-ray' : d === 'context' ? 'Context' : d[0].toUpperCase() + d.slice(1);
      this.on(b, 'click', () => this.toggle(d));
      return b;
    }));
    this.on(this.$('[data-play]'), 'click', () => { this.playing = !this.playing; this.syncTransport(); });
    const scrub = this.$('[data-scrub]') as HTMLInputElement;
    this.on(scrub, 'input', () => { this.t = Number(scrub.value) / 1000; this.playing = false; this.stale = true; this.syncTransport(); });
    const speed = this.$('[data-speed]') as HTMLInputElement;
    this.on(speed, 'input', () => { this.speed = Number(speed.value); this.text('[data-speed-value]', `${this.speed.toFixed(2).replace(/0$/, '')}×`); });
    this.on(this.$('[data-clear]'), 'click', () => this.choose(''));
  }

  private select(id: string, params?: URLSearchParams) {
    const study = STUDIES.find(s => s.id === id) ?? heartStudy;
    this.study = study;
    this.seq = study.sequences[0].id;
    this.t = 0;
    this.selected = '';
    this.view = study.views[0].id;
    this.display = new Set<Display>((study.defaultDisplay ?? ['labels']).filter((d): d is Display => (DISPLAY as readonly string[]).includes(d)));
    if (params) {
      if (params.get('seq') && study.sequences.some(s => s.id === params.get('seq'))) this.seq = params.get('seq')!;
      if (params.get('t')) this.t = Number(params.get('t')) % 1;
      if (params.get('view') && study.views.some(v => v.id === params.get('view'))) this.view = params.get('view')!;
      if (params.get('display') !== null) this.display = new Set(params.get('display')!.split(',').filter((d): d is Display => (DISPLAY as readonly string[]).includes(d)));
      if (params.has('paused')) this.playing = false;
      if (params.get('speed')) this.speed = Number(params.get('speed'));
      if (params.get('zoom')) this.zoom = Number(params.get('zoom'));
    }
    this.explode = this.display.has('exploded') ? 1 : 0;
    this.dataset.study = study.id;
    this.querySelectorAll<HTMLButtonElement>('[data-study-id]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.studyId === study.id)));

    this.text('[data-code]', study.code);
    this.text('[data-mark]', study.mark);
    this.text('[data-eyebrow]', study.eyebrow);
    this.text('[data-title]', study.title);
    this.text('[data-subtitle]', study.subtitle);
    this.text('[data-tagline]', study.tagline);
    this.text('[data-state-title]', study.stateTitle);
    this.text('[data-dynamics-title]', study.dynamicsTitle);
    this.text('[data-operation-title]', study.operationTitle);
    this.text('[data-sequence-title]', study.sequenceTitle);
    this.text('[data-strip-label]', study.strip.label);
    this.text('[data-foot-right]', study.footer[1]);
    this.text('[data-caption]', study.caption);
    this.text('[data-watermark]', study.mark);
    this.$('[data-motto]')!.replaceChildren(...study.motto.map(m => Object.assign(document.createElement('span'), { textContent: m })));
    this.$('[data-readouts]')!.replaceChildren(...study.readouts.map(r => {
      const row = document.createElement('div');
      row.className = 'ms-readout';
      row.innerHTML = '<span class="ms-readout-label"></span><span class="ms-bar"><i></i></span><output></output>';
      row.querySelector('.ms-readout-label')!.textContent = r.label;
      return row;
    }));
    this.$('[data-sequences]')!.replaceChildren(...study.sequences.map(s => {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.seq = s.id; b.textContent = s.label;
      this.on(b, 'click', () => { this.seq = s.id; this.stale = true; this.syncSequence(); });
      return b;
    }));
    this.$('[data-views]')!.replaceChildren(...study.views.map(v => {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.view = v.id; b.textContent = v.label;
      this.on(b, 'click', () => this.fly(v.id));
      return b;
    }));
    const ctx = this.$('[data-mode="context"]');
    if (ctx) ctx.textContent = study.contextLabel;
    this.showOverview();
    this.syncSequence();
    this.syncDisplay();
    this.syncTransport();
    this.layoutPanels();
    if (!this.renderer) { this.drawPanels(); return; }
    this.load(study);
  }

  private load(study: Study) {
    const token = ++this.token;
    if (this.built) this.scene.remove(this.built.rig.root);
    this.built = undefined;
    const cached = this.cache.get(study.id);
    if (!cached) this.status('Generating geometry', `${study.title}: building every surface in code`);
    // Two frames so the status paints before the synchronous build blocks.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (this.destroyed || token !== this.token) return;
      let built = cached;
      try {
        built ??= this.build(study);
      } catch (error) {
        console.error('Mechanism study:', error);
        this.status('The model could not be generated', 'Reload the page to try again.', true);
        return;
      }
      this.cache.set(study.id, built);
      this.built = built;
      this.scene.add(built.rig.root);
      for (const x of built.rig.explode) x.object.position.copy(x.offset).multiplyScalar(ease(this.explode));
      this.applyDisplay();
      this.stale = true;
      this.placeStage();
      this.fly(this.view, true);
      this.$('[data-status]')!.hidden = true;
      this.dataset.ready = 'true';
      this.dirty = true;
    }));
  }

  private build(study: Study): Built {
    const rig = study.build();
    const meshes: THREE.Mesh[] = [];
    // Each part owns its materials, so isolating one never recolours another
    // that happened to share a material instance.
    const owned = new Map<string, THREE.Material>();
    rig.root.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || o.userData.role === 'context') return;
      const key = `${o.userData.part}:${(m.material as THREE.Material).uuid}`;
      if (!owned.has(key)) owned.set(key, (m.material as THREE.Material).clone());
      m.material = owned.get(key)!;
      m.userData.base = m.material;
      meshes.push(m);
    });
    if (rig.context) rig.root.add(rig.context);
    const ghost = ghostMaterial(this.ink.ink, 0.75);
    ghost.userData.ghost = true;
    rig.set(0, study.sequences[0].id);
    rig.root.updateMatrixWorld(true);
    const rest = new THREE.Box3();
    for (const m of meshes) rest.expandByObject(m);
    const span = rest.clone();
    for (const e of rig.explode) e.object.position.copy(e.offset);
    rig.root.updateMatrixWorld(true);
    for (const m of meshes) span.expandByObject(m);
    for (const e of rig.explode) e.object.position.set(0, 0, 0);
    // Centre the specimen over the origin and rest it just above the floor.
    const c = rest.getCenter(new THREE.Vector3());
    rig.root.position.set(-c.x, -c.y, -c.z);
    rest.translate(rig.root.position); span.translate(rig.root.position);
    rig.root.updateMatrixWorld(true);
    return { rig, rest, span, ghost, meshes };
  }

  /* ── display modes ─────────────────────────────────────────────────── */

  private toggle(d: Display) {
    if (this.display.has(d)) this.display.delete(d); else this.display.add(d);
    this.syncDisplay();
    this.applyDisplay();
    if (d === 'exploded') this.fly(this.view);
  }

  private syncDisplay() {
    this.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(this.display.has(b.dataset.mode as Display))));
    this.$('[data-labels]')!.hidden = !this.display.has('labels');
    this.controls && (this.controls.autoRotate = this.display.has('orbit'));
  }

  private applyDisplay() {
    const b = this.built;
    if (!b) return;
    const xray = this.display.has('xray'), section = this.display.has('section');
    b.rig.root.updateMatrixWorld(true);
    this.worldPlane.copy(b.rig.section).applyMatrix4(b.rig.root.matrixWorld);
    const planes = section ? [this.worldPlane] : null;
    for (const m of b.meshes) {
      const role = m.userData.role as string;
      const part = m.userData.part as string;
      const ghosted = this.selected ? part !== this.selected : xray && role === 'shell';
      if (role === 'cap') {
        // Cut faces only make sense while a section is open.
        m.visible = section && !ghosted && !xray;
      } else {
        // Ghosted linings would stack into mud; only outer silhouettes ghost.
        m.visible = !(ghosted && m.userData.inner);
        m.material = ghosted ? b.ghost : m.userData.base;
      }
      (m.material as THREE.Material).clippingPlanes = planes;
      (m.userData.base as THREE.Material).clippingPlanes = planes;
    }
    b.ghost.clippingPlanes = planes;
    if (b.rig.context) b.rig.context.visible = this.display.has('context');
    this.dirty = true;
  }

  private choose(part: string) {
    this.selected = part === this.selected ? '' : part;
    this.applyDisplay();
    if (this.selected) {
      const info = this.study.parts.find(p => p.id === this.selected);
      this.text('[data-overview-kicker]', 'Selected structure');
      this.text('[data-overview-heading]', info?.name ?? this.selected);
      this.text('[data-overview-text]', info?.role ?? '');
      this.$('[data-stats]')!.hidden = true;
      this.$('[data-clear]')!.hidden = false;
    } else this.showOverview();
  }

  private showOverview() {
    const o = this.study.overview;
    this.text('[data-overview-kicker]', 'System overview');
    this.text('[data-overview-heading]', o.heading);
    this.text('[data-overview-text]', o.text);
    const stats = this.$('[data-stats]')!;
    stats.hidden = false;
    stats.replaceChildren(...o.stats.map(([v, l]) => {
      const d = document.createElement('div');
      d.innerHTML = '<strong></strong><span></span>';
      d.querySelector('strong')!.textContent = v; d.querySelector('span')!.textContent = l;
      return d;
    }));
    this.$('[data-clear]')!.hidden = true;
  }

  private syncSequence() {
    this.querySelectorAll<HTMLButtonElement>('[data-seq]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.seq === this.seq)));
    this.text('[data-figure]', this.study.figureUnit(this.seq));
    this.stale = true;
  }

  private syncTransport() {
    const play = this.$('[data-play]')!;
    play.setAttribute('aria-pressed', String(this.playing));
    play.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
    (this.$('[data-speed]') as HTMLInputElement).value = String(this.speed);
    this.text('[data-speed-value]', `${this.speed.toFixed(2).replace(/0$/, '')}×`);
  }

  /* ── camera ─────────────────────────────────────────────────────────── */

  private fly(id: string, instant = false) {
    const b = this.built;
    this.view = id;
    this.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.view === id)));
    if (!b || !this.controls) return;
    const v = this.study.views.find(x => x.id === id)!;
    for (const [name, group] of Object.entries(b.rig.groups ?? {})) group.visible = !v.hide?.includes(name);
    this.text('[data-caption]', v.note ? `${v.note}.` : this.study.caption);
    const dir = (b.rig.viewDirs?.[id]?.clone() ?? new THREE.Vector3(...v.dir)).normalize();
    let box = this.display.has('exploded') ? b.span : b.rest;
    const focus = v.focus && b.rig.groups?.[v.focus];
    if (focus) box = new THREE.Box3().setFromObject(focus);
    const target = box.getCenter(new THREE.Vector3());
    const r = this.fitDistance(box, dir) * (v.zoom ?? 1) * this.zoom;
    if (instant) {
      this.camera.position.copy(target).addScaledVector(dir, r);
      this.controls.target.copy(target);
      this.flight = undefined;
    } else {
      const from = this.camera.position.clone().sub(this.controls.target);
      this.flight = { from: from.clone().normalize(), to: dir, fromR: from.length(), toR: r, target, fromTarget: this.controls.target.clone(), start: performance.now() };
    }
    this.controls.minDistance = r * 0.35;
    this.controls.maxDistance = r * 2.6;
    this.controls.update();
    this.dirty = true;
  }

  /** Distance at which the box's projected corners fit the clear area between panels. */
  private fitDistance(box: THREE.Box3, dir: THREE.Vector3) {
    const centre = box.getCenter(new THREE.Vector3());
    const up = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, dir).normalize();
    const upv = new THREE.Vector3().crossVectors(dir, right).normalize();
    const { fx, fy } = this.safe;
    const tv = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * fy;
    const th = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * this.camera.aspect * fx;
    let d = 0;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = new THREE.Vector3(x, y, z).sub(centre);
      d = Math.max(d, p.dot(dir) + Math.max(Math.abs(p.dot(right)) / th, Math.abs(p.dot(upv)) / tv));
    }
    return d * 1.04;
  }

  private safe = { fx: 1, fy: 1 };
  private clear = { left: 0, right: 0, top: 0, bottom: 0 };
  private zoom = 1;

  /** Measure how much of the stage the floating panels leave clear and steer
   *  the projection centre into that gap. */
  private layoutPanels() {
    if (!this.renderer) return;
    const s = this.stage.getBoundingClientRect();
    if (!s.width || !s.height) return;
    const overlay = getComputedStyle(this).getPropertyValue('--ms-overlay').trim() === '1';
    let left = 0, right = s.width, top = 0, bottom = s.height;
    if (overlay) {
      const l = this.$('[data-left]')?.getBoundingClientRect(), r = this.$('[data-right]')?.getBoundingClientRect();
      const h = this.$('[data-head]')?.getBoundingClientRect(), tr = this.$('[data-transport]')?.getBoundingClientRect();
      if (l) left = l.right - s.left + 12;
      if (r) right = r.left - s.left - 12;
      if (h) top = h.bottom - s.top;
      if (tr) bottom = tr.top - s.top - 10;
    }
    const w = Math.max(80, right - left), h = Math.max(80, bottom - top);
    this.safe = { fx: w / s.width, fy: h / s.height };
    this.clear = { left, right, top, bottom };
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    this.renderer.setSize(s.width, s.height, false);
    this.camera.aspect = s.width / s.height;
    this.camera.setViewOffset(s.width, s.height, s.width / 2 - cx, s.height / 2 - cy, s.width, s.height);
    this.camera.updateProjectionMatrix();
    this.sizePanels();
  }

  private layout() {
    this.layoutPanels();
    if (this.built) this.fly(this.view, true);
    this.dirty = true; this.stale = true;
  }

  /** Floor and shadow sit just under the lowest point the specimen reaches. */
  private placeStage() {
    const b = this.built;
    if (!b) return;
    const y = b.span.min.y - 0.04;
    this.floor.position.y = y; this.shadow.position.y = y + 0.002;
    const size = b.span.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.z, size.y) * 0.75;
    const cam = this.key.shadow.camera as THREE.OrthographicCamera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.near = 0.5; cam.far = 40;
    cam.updateProjectionMatrix();
    this.key.target.position.set(0, y, 0);
    this.key.position.set(-3.5, y + 9, 4.5);
  }

  /* ── theme ──────────────────────────────────────────────────────────── */

  private readInk() {
    const cs = getComputedStyle(this);
    const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
    this.ink = {
      ink: v('--ms-ink', '#2a2724'), soft: v('--ms-soft', '#6b645c'), faint: v('--ms-faint', '#a39a8f'),
      rule: v('--ms-rule', 'rgba(42,39,36,.12)'), accent: v('--ms-accent', '#e0662b'), paper: v('--ms-paper', '#fbf7f1'),
    };
  }

  private retheme() {
    this.readInk();
    this.paintFloor();
    for (const b of this.cache.values()) {
      b.ghost.uniforms.color.value.set(this.ink.ink);
      b.rig.context?.traverse(o => {
        const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
        if (m?.userData?.ghost) m.uniforms.color.value.set(this.ink.ink);
      });
    }
    this.shadow.material.opacity = document.documentElement.dataset.theme === 'dark' ? 0.32 : 0.16;
    this.stale = true; this.dirty = true;
  }

  /** A drafting table drawn into the floor: a centreline, a ranging circle,
   *  degree ticks, all fading out radially. */
  private paintFloor() {
    const size = 1024, c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const px = size / 36, mid = size / 2;
    g.strokeStyle = this.ink.ink; g.fillStyle = this.ink.ink;
    g.globalAlpha = 0.16; g.lineWidth = 2;
    g.setLineDash([22, 18]);
    g.beginPath(); g.moveTo(mid, 0); g.lineTo(mid, size); g.moveTo(0, mid); g.lineTo(size, mid); g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 0.12; g.lineWidth = 1.5;
    for (const r of [3.2, 5.6]) { g.beginPath(); g.arc(mid, mid, r * px, 0, Math.PI * 2); g.stroke(); }
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2, r0 = 3.2 * px, r1 = r0 + (k % 6 === 0 ? 16 : 8);
      g.globalAlpha = k % 18 === 0 ? 0.55 : 0.2;
      g.strokeStyle = k % 18 === 0 ? this.ink.accent : this.ink.ink;
      g.beginPath(); g.moveTo(mid + r0 * Math.cos(a), mid + r0 * Math.sin(a)); g.lineTo(mid + r1 * Math.cos(a), mid + r1 * Math.sin(a)); g.stroke();
    }
    g.globalAlpha = 0.14; g.fillStyle = this.ink.ink;
    for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) {
      if (Math.hypot(i, j) < 2.6 || (i % 2 && j % 2)) continue;
      const x = mid + i * 2.4 * px, y = mid + j * 2.4 * px;
      g.fillRect(x - 4, y - 0.5, 8, 1); g.fillRect(x - 0.5, y - 4, 1, 8);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'destination-in';
    const fade = g.createRadialGradient(mid, mid, 0, mid, mid, mid);
    fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(0.45, 'rgba(0,0,0,.85)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fade; g.fillRect(0, 0, size, size);
    this.floorTexture?.dispose();
    this.floorTexture = new THREE.CanvasTexture(c);
    this.floorTexture.colorSpace = THREE.SRGBColorSpace;
    this.floorTexture.anisotropy = 8;
    const mat = this.floor.material as THREE.MeshBasicMaterial;
    mat.map = this.floorTexture; mat.needsUpdate = true;
    this.dirty = true;
  }

  /* ── interaction ────────────────────────────────────────────────────── */

  private bindCanvas() {
    const c = this.canvas;
    this.on(c, 'pointerdown', e => { this.down = { x: e.clientX, y: e.clientY, moved: false }; });
    this.on(c, 'pointermove', e => {
      if (this.down) { if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) this.down.moved = true; this.tooltip(); return; }
      this.pickHover(e.clientX, e.clientY);
    });
    this.on(c, 'pointerup', e => {
      if (this.down && !this.down.moved) { const hit = this.pick(e.clientX, e.clientY); this.choose(hit ? hit.object.userData.part : ''); }
      this.down = undefined;
    });
    this.on(c, 'pointerleave', () => { this.tooltip(); });
    this.on(c, 'keydown', e => {
      if (e.key === ' ' || e.key === 'k') { this.playing = !this.playing; this.syncTransport(); e.preventDefault(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        this.playing = false; this.t = (this.t + (e.key === 'ArrowRight' ? 0.01 : 0.99)) % 1; this.stale = true; this.syncTransport(); e.preventDefault();
      } else if (e.key === 'Escape') this.choose('');
    });
    c.addEventListener('webglcontextlost', e => { e.preventDefault(); this.status('The 3D view was interrupted', 'Reload the page to restore it.', true); }, { signal: this.aborter.signal });
  }

  private pick(x: number, y: number) {
    const b = this.built;
    if (!b) return undefined;
    const r = this.canvas.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), this.camera);
    const section = this.display.has('section');
    const shown = (m: THREE.Object3D) => { for (let o: THREE.Object3D | null = m; o; o = o.parent) if (!o.visible) return false; return true; };
    const hits = this.raycaster.intersectObjects(b.meshes.filter(m => m.userData.role !== 'cap' && shown(m)), false);
    return hits.find(h => {
      if (section && this.worldPlane.distanceToPoint(h.point) < 0) return false;
      // Ghosted shells are glass: look through them to what they contain.
      return h.object.userData.role === 'mechanism' || (h.object as THREE.Mesh).material !== b.ghost;
    });
  }

  private pickHover(x: number, y: number) {
    const hit = this.pick(x, y);
    const id = hit?.object.userData.part ?? '';
    this.canvas.style.cursor = id ? 'pointer' : 'grab';
    if (!id) { this.tooltip(); return; }
    const info = this.study.parts.find(p => p.id === id);
    const r = this.stage.getBoundingClientRect();
    this.tooltip(info?.name ?? id, x - r.left, y - r.top);
  }

  private tooltip(name = '', x = 0, y = 0) {
    const tip = this.$('[data-tooltip]')!;
    tip.hidden = !name;
    if (!name) return;
    tip.textContent = name;
    tip.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y - 30)}px)`;
  }

  /* ── frame loop ─────────────────────────────────────────────────────── */

  private loop = (now: number) => {
    if (this.destroyed) return;
    this.frame = requestAnimationFrame(this.loop);
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
    this.last = now;
    if (!this.visible || document.hidden) return;
    const b = this.built;
    if (this.playing && b) { this.t = (this.t + (dt * this.speed) / this.study.playback(this.seq)) % 1; this.stale = true; }
    const target = this.display.has('exploded') ? 1 : 0;
    if (b && this.explode !== target) {
      this.explode += Math.sign(target - this.explode) * Math.min(Math.abs(target - this.explode), dt * 1.6);
      const e = ease(this.explode);
      for (const x of b.rig.explode) x.object.position.copy(x.offset).multiplyScalar(e);
      this.stale = true;
    }
    if (this.flight && this.controls) {
      const k = Math.min(1, (now - this.flight.start) / 900), e = ease(k);
      const dir = this.flight.from.clone().lerp(this.flight.to, e).normalize();
      if (dir.lengthSq() < 0.5) dir.copy(this.flight.to);
      this.controls.target.lerpVectors(this.flight.fromTarget, this.flight.target, e);
      this.camera.position.copy(this.controls.target).addScaledVector(dir, THREE.MathUtils.lerp(this.flight.fromR, this.flight.toR, e));
      if (k >= 1) this.flight = undefined;
      this.dirty = true;
    }
    const moved = this.controls?.update(dt) ?? false;
    if (this.stale && b) { b.rig.set(this.t, this.seq); this.drawPanels(); }
    if (this.stale || this.dirty || moved || this.display.has('orbit')) {
      this.renderer?.render(this.scene, this.camera);
      this.placeLabels();
      this.stale = false; this.dirty = false;
    }
  };

  /* ── panels ─────────────────────────────────────────────────────────── */

  private canvases: [HTMLCanvasElement, number, number][] = [];

  private sizePanels() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvases = [];
    for (const sel of ['[data-schematic]', '[data-plot]', '[data-strip]']) {
      const c = this.$(sel) as HTMLCanvasElement | null;
      if (!c) continue;
      const r = c.getBoundingClientRect();
      if (!r.width) continue;
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
      this.canvases.push([c, r.width, r.height]);
    }
    this.drawPanels();
  }

  private drawPanels() {
    const s = this.study, t = this.t, seq = this.seq;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    for (const [c, w, h] of this.canvases) {
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (c.matches('[data-schematic]')) s.schematic(ctx, w, h, t, seq, this.ink);
      else if (c.matches('[data-plot]')) s.plot(ctx, w, h, t, seq, this.ink);
      else s.strip.draw(ctx, w, h, t, seq, this.ink);
    }
    const f = s.frame(t, seq);
    this.text('[data-status-name]', f.status);
    this.text('[data-status-detail]', f.detail);
    this.text('[data-clock]', f.clock);
    this.querySelectorAll<HTMLElement>('.ms-readout').forEach((row, i) => {
      const r = s.readouts[i], v = f.values[i] ?? 0;
      (row.querySelector('i') as HTMLElement).style.transform = `scaleX(${Math.max(0, Math.min(1, v / r.max))})`;
      const out = row.querySelector('output')!;
      const text = `${v.toFixed(r.digits ?? 0)} ${r.unit}`;
      if (out.textContent !== text) out.textContent = text;
    });
    const scrub = this.$('[data-scrub]') as HTMLInputElement;
    if (document.activeElement !== scrub) scrub.value = String(Math.round(t * 1000));
    this.style.setProperty('--ms-progress', String(t));
    const phases = s.phases(seq);
    let i = 0;
    for (let k = 0; k < phases.length; k++) if (t >= phases[k].at) i = k;
    const n = phases.length;
    this.text('[data-phase-prev]', phases[(i - 1 + n) % n].label);
    this.text('[data-phase-now]', phases[i].label);
    this.text('[data-phase-next]', phases[(i + 1) % n].label);
    const ticks = this.$('[data-ticks]')!;
    if (ticks.dataset.key !== `${s.id}:${seq}`) {
      ticks.dataset.key = `${s.id}:${seq}`;
      ticks.replaceChildren(...phases.map(p => { const e = document.createElement('i'); e.style.left = `${p.at * 100}%`; return e; }));
    }
  }

  /* ── leader labels ──────────────────────────────────────────────────── */

  private placeLabels() {
    const b = this.built, layer = this.$('[data-labels]')!;
    if (!b || layer.hidden) return;
    const svg = layer.querySelector('svg')!;
    const rect = this.stage.getBoundingClientRect();
    svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    const interior = this.display.has('section') || this.display.has('xray') || this.display.has('exploded');
    const section = this.display.has('section');
    let paths = '';
    const p = new THREE.Vector3();
    const spans = layer.querySelectorAll<HTMLElement>('span');
    if (spans.length !== b.rig.anchors.length) {
      layer.querySelectorAll('span').forEach(s => s.remove());
      b.rig.anchors.forEach(a => layer.append(Object.assign(document.createElement('span'), { textContent: a.label })));
    }
    const els = layer.querySelectorAll<HTMLElement>('span');
    b.rig.anchors.forEach((a, i) => {
      const el = els[i];
      a.object.localToWorld(p.set(...a.at));
      let hiddenGroup = false;
      for (let o: THREE.Object3D | null = a.object; o; o = o.parent) if (!o.visible) hiddenGroup = true;
      let show = !hiddenGroup && (a.inside ? interior || this.view === 'valve-plane' : !interior || !section || this.worldPlane.distanceToPoint(p) >= 0);
      if (this.selected) show = false;
      p.project(this.camera);
      const x = (p.x * 0.5 + 0.5) * rect.width, y = (-p.y * 0.5 + 0.5) * rect.height;
      if (p.z > 1 || x < 8 || x > rect.width - 8 || y < 8 || y > rect.height - 8) show = false;
      el.hidden = !show;
      if (!show) return;
      // Keep the text inside the clear area: flip a label that would run under a panel.
      const width = el.offsetWidth || el.textContent!.length * 7;
      let sx = Math.sign(a.side[0]) || 1;
      if (sx < 0 && x - 72 - width < this.clear.left) sx = 1;
      else if (sx > 0 && x + 72 + width > this.clear.right) sx = -1;
      const ex = x + sx * 30, ey = y + a.side[1] * 34, tx = ex + sx * 42;
      paths += `<path d="M${x.toFixed(1)} ${y.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}L${tx.toFixed(1)} ${ey.toFixed(1)}"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4"/>`;
      el.style.transform = `translate(${(sx > 0 ? tx + 5 : tx - 5).toFixed(1)}px, ${(ey - 7).toFixed(1)}px) translateX(${sx > 0 ? 0 : -100}%)`;
    });
    svg.innerHTML = paths;
  }

  private status(title: string, detail: string, error = false) {
    const n = this.$('[data-status]')!;
    n.hidden = false; n.dataset.error = String(error);
    this.text('[data-status-title]', title); this.text('[data-status-text]', detail);
  }
}

if (!customElements.get('mechanism-study')) customElements.define('mechanism-study', MechanismStudyElement);
