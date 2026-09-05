import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildCell } from './cell';
import { classifyMesh, readableMeshName, specimens, type Part } from './data';

class BiologyExplorer extends HTMLElement {
  private renderer?: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100);
  private controls?: OrbitControls;
  private canvas!: HTMLCanvasElement;
  private model?: THREE.Group;
  private meshes: THREE.Mesh[] = [];
  private current = 'cell';
  private selected = '';
  private hover = '';
  private wholeBounds = new THREE.Box3();
  private bounds = new Map<string, THREE.Box3>();
  private raycaster = new THREE.Raycaster();
  private clip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.1);
  private cutaway = true;
  private auto = false;
  private down?: { x: number; y: number; moved: boolean };
  private aborter = new AbortController();
  private loading?: AbortController;
  private resize?: ResizeObserver;
  private intersection?: IntersectionObserver;
  private frame = 0;
  private visible = true;
  private dirty = true;
  private token = 0;
  private destroyed = false;
  private previousTime = 0;

  connectedCallback() {
    this.canvas = this.querySelector<HTMLCanvasElement>('[data-canvas]')!;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'default' });
    } catch {
      this.showStatus('3D rendering is unavailable', 'Try a browser with WebGL enabled. You can still explore the structure descriptions below.', true);
      this.buildButtons(); this.bindReadout(); this.showInfo();
      this.querySelectorAll<HTMLButtonElement>('[data-model]').forEach(button => button.addEventListener('click', () => {
        this.current = button.dataset.model!; this.selected = ''; this.buildButtons(); this.showInfo();
        this.querySelectorAll<HTMLButtonElement>('[data-model]').forEach(tab => tab.setAttribute('aria-pressed', String(tab === button)));
        this.text('[data-model-title]', specimens[this.current].name);
        this.text('[data-model-subtitle]', specimens[this.current].subtitle);
        this.text('[data-model-source]', specimens[this.current].source);
      }, { signal: this.aborter.signal }));
      this.querySelectorAll<HTMLButtonElement>('.view-controls button').forEach(button => { button.disabled = true; });
      return;
    }
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.localClippingEnabled = true;
    this.scene.add(new THREE.HemisphereLight(0xf1f3ff, 0x697481, 1.5));
    const key = new THREE.DirectionalLight(0xfff2e6, 2.6); key.position.set(-3, 5, 7); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xc7deff, 1.0); fill.position.set(4, 1, 4); this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xfaf1e1, 2.0); rim.position.set(0, 3, -4); this.scene.add(rim);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.autoRotateSpeed = 0.55;
    this.controls.enablePan = false;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.controls.addEventListener('start', () => { this.auto = false; this.syncControls(); });
    this.bind();
    this.resize = new ResizeObserver(() => this.layout()); this.resize.observe(this.canvas);
    this.intersection = new IntersectionObserver(([entry]) => { this.visible = entry.isIntersecting; this.dirty = true; }); this.intersection.observe(this);
    this.layout(); this.load('cell'); this.animate(0);
  }

  disconnectedCallback() {
    this.destroyed = true; this.token++; this.loading?.abort(); this.aborter.abort();
    cancelAnimationFrame(this.frame); this.resize?.disconnect(); this.intersection?.disconnect();
    this.controls?.dispose(); this.disposeModel(); this.renderer?.dispose();
  }

  private bindReadout() {
    this.querySelector('[data-parts]')?.addEventListener('click', (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-part]');
      if (button) this.select(button.dataset.part!);
    }, { signal: this.aborter.signal });
  }

  private bind() {
    const signal = this.aborter.signal;
    this.bindReadout();
    this.querySelectorAll<HTMLButtonElement>('[data-model]').forEach(button => button.addEventListener('click', () => this.load(button.dataset.model!), { signal }));
    this.querySelector('[data-whole]')?.addEventListener('click', () => this.showWhole(), { signal });
    this.querySelector('[data-reset]')?.addEventListener('click', () => this.fit(this.selected ? this.bounds.get(this.selected)! : this.wholeBounds), { signal });
    this.querySelector('[data-spin]')?.addEventListener('click', () => { this.auto = !this.auto; this.syncControls(); }, { signal });
    this.querySelector('[data-section]')?.addEventListener('click', () => { this.cutaway = !this.cutaway; this.updateVisibility(); this.syncControls(); }, { signal });
    this.canvas.addEventListener('pointerdown', e => { this.down = { x: e.clientX, y: e.clientY, moved: false }; this.hideHover(); }, { signal });
    this.canvas.addEventListener('pointermove', e => {
      if (this.down) { if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) this.down.moved = true; return; }
      const hit = this.pick(e.clientX, e.clientY);
      if (!hit) { this.hideHover(); return; }
      const id = hit.object.userData.partId;
      if (this.hover !== id) { this.hover = id; this.showInfo(id); this.highlight(); }
      const tooltip = this.querySelector<HTMLElement>('[data-tooltip]')!;
      const rect = this.canvas.getBoundingClientRect();
      tooltip.hidden = false;
      tooltip.style.left = `${Math.max(12, Math.min(e.clientX - rect.left + 15, rect.width - 240))}px`;
      tooltip.style.top = `${Math.max(12, Math.min(e.clientY - rect.top - 55, rect.height - 75))}px`;
      this.text('[data-tooltip-name]', this.part(id)?.name || '');
      const label = readableMeshName(hit.object.userData.label || '');
      this.text('[data-tooltip-detail]', this.current === 'cell' || this.current === 'anatomy' ? 'Click to isolate' : label);
      this.canvas.style.cursor = 'pointer';
    }, { signal });
    this.canvas.addEventListener('pointerup', e => {
      if (this.down && !this.down.moved && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) <= 5) {
        const hit = this.pick(e.clientX, e.clientY); if (hit) this.select(hit.object.userData.partId);
      }
      this.down = undefined;
    }, { signal });
    this.canvas.addEventListener('pointercancel', () => { this.down = undefined; this.hideHover(); }, { signal });
    this.canvas.addEventListener('pointerleave', () => { this.hideHover(); }, { signal });
    window.addEventListener('pointerup', () => { this.down = undefined; }, { signal });
    this.canvas.addEventListener('keydown', event => {
      if (!this.controls) return;
      const offset = this.camera.position.clone().sub(this.controls.target);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      switch (event.key) {
        case 'ArrowLeft': spherical.theta -= 0.12; break;
        case 'ArrowRight': spherical.theta += 0.12; break;
        case 'ArrowUp': spherical.phi -= 0.12; break;
        case 'ArrowDown': spherical.phi += 0.12; break;
        case '+': case '=': spherical.radius *= 0.9; break;
        case '-': spherical.radius *= 1.1; break;
        case 'Escape': this.showWhole(); event.preventDefault(); return;
        default: return;
      }
      event.preventDefault(); this.auto = false; this.syncControls(); spherical.makeSafe();
      spherical.radius = THREE.MathUtils.clamp(spherical.radius, this.controls.minDistance, this.controls.maxDistance);
      this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(spherical)); this.controls.update(); this.dirty = true;
    }, { signal });
    this.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.showStatus('The 3D view was interrupted', 'Reload this page to restore the graphics context. Structure descriptions remain available.', true); }, { signal });
  }

  private async load(name: string) {
    if (!specimens[name]) return;
    const token = ++this.token; this.loading?.abort(); this.loading = new AbortController();
    this.current = name; this.selected = ''; this.hover = ''; this.auto = false; this.cutaway = true;
    this.dataset.specimen = name; this.dataset.ready = 'false'; this.dataset.view = 'whole'; delete this.dataset.selected; this.hideHover();
    this.disposeModel(); this.bounds.clear(); this.buildButtons(); this.showInfo(); this.syncControls();
    this.querySelectorAll<HTMLButtonElement>('[data-model]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.model === name)));
    this.text('[data-model-title]', specimens[name].name);
    this.text('[data-model-subtitle]', specimens[name].subtitle);
    this.text('[data-model-source]', specimens[name].source);
    this.showStatus('Preparing the specimen', name === 'cell' ? 'Building the cutaway' : 'Loading reference anatomy…');
    let group: THREE.Group | undefined;
    try {
      if (name === 'cell') group = buildCell();
      else {
        const loaded: THREE.Group[] = [];
        try {
          // Sequential fetches keep peak parsing memory bounded on phones. Browser
          // caching shares the same brain/heart asset with the whole-body view.
          for (const [id, file] of Object.entries(specimens[name].files!)) {
            const response = await fetch(file, { signal: this.loading.signal });
            if (!response.ok) throw new Error(`Model request failed (${response.status})`);
            const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), '');
            loaded.push(gltf.scene);
            if (this.destroyed || token !== this.token) throw new Error('Superseded');
            gltf.scene.traverse(object => {
              if (!(object instanceof THREE.Mesh)) return;
              object.userData.partId = name === 'anatomy' ? id : classifyMesh(name, object.name);
              object.userData.label = object.name;
            });
            this.text('[data-status-detail]', `Loaded ${loaded.length} of ${Object.keys(specimens[name].files!).length} reference files`);
          }
          group = new THREE.Group(); loaded.forEach(root => group!.add(root));
        } catch (error) { loaded.forEach(root => this.dispose(root)); throw error; }
      }
      if (this.destroyed || token !== this.token) { this.dispose(group); return; }
      // One transform for the entire specimen preserves all relative positions.
      const box = new THREE.Box3().setFromObject(group);
      const size = box.getSize(new THREE.Vector3()); const scale = 4.8 / Math.max(size.x, size.y, size.z);
      const centre = box.getCenter(new THREE.Vector3());
      group.scale.setScalar(scale); group.position.copy(centre).multiplyScalar(-scale);
      this.model = group; this.scene.add(group); group.updateMatrixWorld(true);
      this.meshes = [];
      group.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        this.meshes.push(object);
        const id = object.userData.partId as string;
        const old = Array.isArray(object.material) ? object.material : [object.material];
        if (name !== 'cell') {
          // Source meshes share materials. Independent materials are essential:
          // otherwise highlighting one chamber recolours the entire organ.
          object.material = new THREE.MeshStandardMaterial({ color: /pupil/i.test(object.name) ? '#1d2633' : this.part(id)?.color || '#a8adb9', roughness: 0.6, metalness: 0, side: THREE.DoubleSide });
          old.forEach(m => m.dispose());
        }
        const bounds = this.bounds.get(id) || new THREE.Box3(); bounds.union(new THREE.Box3().setFromObject(object)); this.bounds.set(id, bounds);
      });
      this.wholeBounds.setFromObject(group); this.updateVisibility(); this.fit(this.wholeBounds);
      this.querySelector<HTMLElement>('[data-status]')!.hidden = true; this.dataset.ready = 'true';
      this.text('[data-announce]', `${specimens[name].name} ready. ${specimens[name].parts.length} selectable structures.`);
      this.dirty = true;
    } catch (error) {
      if (this.destroyed || token !== this.token) return;
      this.showStatus('The specimen could not be loaded', 'Check your connection and choose the specimen again to retry. The structure descriptions are still available.', true);
      console.error('Biology atlas:', error);
    }
  }

  private select(id: string) {
    if (!this.part(id)) return;
    if (!this.renderer) { this.showInfo(id); return; }
    this.selected = id; this.auto = false; this.hideHover(); this.showInfo(id); this.updateVisibility(); this.syncControls();
    const box = this.bounds.get(id); if (box) this.fit(box);
    this.dataset.view = 'isolated'; this.dataset.selected = id;
    this.querySelectorAll<HTMLButtonElement>('[data-part]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.part === id)));
    this.text('[data-announce]', `${this.part(id)!.name} isolated. Use Show whole model or Escape to return.`);
  }

  private showWhole() {
    this.selected = ''; this.hover = ''; this.auto = false; this.dataset.view = 'whole'; delete this.dataset.selected;
    this.hideHover(); this.showInfo(); this.updateVisibility(); this.syncControls(); this.fit(this.wholeBounds);
    this.querySelectorAll<HTMLButtonElement>('[data-part]').forEach(button => button.setAttribute('aria-pressed', 'false'));
    this.text('[data-announce]', `Showing the whole ${specimens[this.current].name.toLowerCase()}.`);
  }

  private updateVisibility() {
    for (const mesh of this.meshes) {
      const id = mesh.userData.partId;
      mesh.visible = !this.selected || id === this.selected;
      const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
      for (const m of materials) {
        const ghost = this.current === 'anatomy' && id === 'skin' && !this.selected;
        m.transparent = ghost; m.opacity = ghost ? 0.12 : 1; m.depthWrite = !ghost;
        m.clippingPlanes = this.current === 'eye' && this.cutaway && !this.selected && ['sclera', 'cornea', 'choroid', 'retina', 'conjunctiva'].includes(id) ? [this.clip] : null;
        if (this.current === 'eye' && !this.selected && ['fluids', 'conjunctiva'].includes(id)) mesh.visible = false;
        m.needsUpdate = true;
      }
    }
    this.text('[data-view-name]', this.selected ? `${this.part(this.selected)?.name} only` : 'Whole specimen');
    this.highlight(); this.dirty = true;
  }

  private pick(x: number, y: number) {
    const rect = this.canvas.getBoundingClientRect();
    const p = new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, -(y - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(p, this.camera);
    const hits = this.raycaster.intersectObjects(this.meshes.filter(mesh => mesh.visible), false).filter(hit => {
      const source = (hit.object as THREE.Mesh).material;
      const material = Array.isArray(source) ? source[0] : source;
      return !(material as THREE.Material).clippingPlanes?.some(plane => plane.distanceToPoint(hit.point) < 0);
    });
    return hits.find(hit => !(this.current === 'anatomy' && !this.selected && hit.object.userData.partId === 'skin')) || hits[0];
  }

  private hideHover() {
    this.querySelector<HTMLElement>('[data-tooltip]')!.hidden = true; this.canvas.style.cursor = 'grab';
    if (this.hover) { this.hover = ''; this.showInfo(this.selected); this.highlight(); }
  }

  private highlight() {
    this.meshes.forEach(mesh => {
      const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
      materials.forEach(m => { m.emissive.set(this.hover && mesh.userData.partId === this.hover ? this.part(this.hover)!.color : '#000000'); m.emissiveIntensity = 0.16; });
    }); this.dirty = true;
  }

  private fit(box: THREE.Box3) {
    if (!this.controls || box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const v = THREE.MathUtils.degToRad(this.camera.fov), h = 2 * Math.atan(Math.tan(v / 2) * this.camera.aspect);
    const direction = this.current === 'cell' ? new THREE.Vector3(0.12, 0.12, 1) : this.current === 'anatomy' ? new THREE.Vector3(0.08, 0, 1) : new THREE.Vector3(0.5, 0.24, 1);
    direction.normalize();
    const right = new THREE.Vector3().crossVectors(this.camera.up, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    let distance = 0;
    // Fit the projected corners, not the box's bounding sphere. Flat cutaways
    // and tall bodies otherwise waste most of the available screen space.
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const corner = new THREE.Vector3(x, y, z).sub(sphere.center);
      distance = Math.max(distance, corner.dot(direction) + Math.max(Math.abs(corner.dot(right)) / Math.tan(h / 2), Math.abs(corner.dot(up)) / Math.tan(v / 2)));
    }
    distance *= 1.16;
    this.controls.target.copy(sphere.center); this.camera.position.copy(sphere.center).add(direction.normalize().multiplyScalar(distance));
    this.controls.minDistance = distance * 0.25; this.controls.maxDistance = distance * 3;
    this.camera.near = Math.max(0.001, distance / 200); this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix(); this.controls.update(); this.dirty = true;
  }

  private buildButtons() {
    const list = this.querySelector('[data-parts]')!; list.replaceChildren();
    for (const part of specimens[this.current].parts) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.part = part.id; button.setAttribute('aria-pressed', 'false');
      const swatch = document.createElement('i'); swatch.style.backgroundColor = part.color; swatch.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span'); name.textContent = part.name;
      button.append(swatch, name); list.append(button);
    }
    this.text('[data-part-count]', `${specimens[this.current].parts.length} structures`);
  }

  private showInfo(id = '') {
    const part = this.part(id), specimen = specimens[this.current];
    this.text('[data-part-system]', part?.system || 'Explore the specimen');
    this.text('[data-part-name]', part?.name || specimen.name);
    this.text('[data-description]', part?.description || specimen.description);
    this.text('[data-role]', part?.role || 'Hover to identify a structure. Click the model or choose a structure below to isolate it.');
    this.text('[data-detail]', part?.detail || 'Drag to rotate, scroll or pinch to zoom. The information panel stays available while you explore.');
    this.querySelector<HTMLElement>('.biology-readout')?.style.setProperty('--part-color', part?.color || '#9aa9bb');
  }

  private syncControls() {
    if (this.controls) this.controls.autoRotate = this.auto;
    this.querySelector('[data-spin]')?.setAttribute('aria-pressed', String(this.auto));
    const whole = this.querySelector<HTMLButtonElement>('[data-whole]')!; whole.disabled = !this.selected;
    const section = this.querySelector<HTMLButtonElement>('[data-section]')!; section.hidden = this.current !== 'eye'; section.disabled = !!this.selected; section.setAttribute('aria-pressed', String(this.cutaway));
  }

  private showStatus(title: string, detail: string, error = false) {
    const node = this.querySelector<HTMLElement>('[data-status]')!; node.hidden = false; node.dataset.error = String(error);
    this.text('[data-status-title]', title); this.text('[data-status-detail]', detail);
  }
  private layout() {
    if (!this.renderer) return;
    const rect = this.canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    this.renderer.setSize(rect.width, rect.height, false); this.camera.aspect = rect.width / rect.height; this.camera.updateProjectionMatrix();
    if (this.model) this.fit(this.selected ? this.bounds.get(this.selected)! : this.wholeBounds);
    this.dirty = true;
  }
  private animate = (time: number) => {
    if (this.destroyed) return;
    const delta = Math.min((time - this.previousTime) / 1000, 0.1); this.previousTime = time;
    if (this.visible && !document.hidden && this.renderer) {
      const changed = this.controls?.update(delta);
      if (this.dirty || changed || this.auto) { this.renderer.render(this.scene, this.camera); this.dirty = false; }
    }
    this.frame = requestAnimationFrame(this.animate);
  };
  private part(id: string): Part | undefined { return specimens[this.current].parts.find(p => p.id === id); }
  private text(selector: string, value: string) { const node = this.querySelector(selector); if (node) node.textContent = value; }
  private disposeModel() { if (this.model) { this.scene.remove(this.model); this.dispose(this.model); } this.model = undefined; this.meshes = []; }
  private dispose(root: THREE.Object3D) {
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose(); (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => m.dispose());
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
  }
}

if (!customElements.get('solid-biology-explorer')) customElements.define('solid-biology-explorer', BiologyExplorer);
