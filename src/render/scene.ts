import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { DEPTH_TINT, KEY_LIGHT, VIEW_BOUNDS } from './layout';

/**
 * v2: a 15-layer stack is only 1.78 world units deep, so the tilt does the
 * heavy lifting for "which plate is on top". 13° gives ~0.41 units (~24 CSS px)
 * of vertical parallax between the bottom and the top of a full stack while
 * keeping screw heads round enough to tap confidently.
 */
const CAMERA_TILT = THREE.MathUtils.degToRad(13);
const CAMERA_FOV = 34;
const FIT_MARGIN = 0.025;

/**
 * The target device is dpr 3 (1320x2868). Rendering the backing store at 2x
 * with 4x MSAA is both sharper on edges and ~2.2x cheaper in fill than a 3x
 * buffer with no MSAA, so we cap here rather than chase the native ratio.
 */
const MAX_PIXEL_RATIO = 2;

/**
 * Owns the WebGLRenderer, scene graph root, camera, lights and background.
 * Camera framing keeps VIEW_BOUNDS visible inside the container minus insets.
 *
 * There is deliberately no shadow map: at 0.12 layer spacing a depth-map
 * shadow either acnes or peter-pans, and a second pass over ~40 plates plus the
 * screw field costs more than the authored contact shadows in plateMesh.ts.
 */
export class SceneRig {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Everything belonging to the current level goes here (cleared on loadLevel). */
  readonly boardRoot = new THREE.Group();
  readonly canvas: HTMLCanvasElement;
  readonly dirLight: THREE.DirectionalLight;

  private width = 1;
  private height = 1;
  private insetTop = 0;
  private insetBottom = 0;
  private readonly ground: THREE.Mesh;
  private readonly pit: THREE.Mesh;
  private readonly probe = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.5, 100);
  private envTexture: THREE.Texture | null = null;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x141a30, 1);
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.canvas = this.renderer.domElement;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.touchAction = 'none';
    this.canvas.style.userSelect = 'none';
    (this.canvas.style as unknown as Record<string, string>).webkitUserSelect = 'none';
    (this.canvas.style as unknown as Record<string, string>).webkitTouchCallout = 'none';
    container.appendChild(this.canvas);

    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.5, 100);
    this.camera.position.set(0, -3, 18);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(this.camera);
    this.scene.add(this.boardRoot);

    // Lights. Total irradiance on an upward-facing surface is kept near 1.2 so
    // plate colours never clip to white — with NoToneMapping, a blown-out top
    // face destroys both the colour identity and the per-layer depth tint.
    const hemi = new THREE.HemisphereLight(0xe4ecff, 0x232842, 0.34);
    hemi.position.set(0, 0, 1);
    this.scene.add(hemi);

    // Key light, deliberately grazing (z is only ~1.2x the xy reach) so plate
    // sides catch light and the authored contact shadows have a real offset.
    const dir = new THREE.DirectionalLight(0xfff4e6, 1.12);
    dir.position.set(KEY_LIGHT.x, KEY_LIGHT.y, KEY_LIGHT.z);
    dir.target.position.set(0, 0, 0);
    dir.castShadow = false;
    this.scene.add(dir);
    this.scene.add(dir.target);
    this.dirLight = dir;

    // Cool rim from the opposite side: lights the *far* edge of every plate,
    // which is what makes a 0.10-thick sheet read as a solid slab.
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.5);
    rim.position.set(-6.5, -4.5, 2.2);
    this.scene.add(rim);

    // Background: a large vertex-coloured plane far behind the board.
    this.ground = makeGround();
    this.scene.add(this.ground);

    // A soft dark blob right behind the stack: gives the whole tower an
    // ambient-occlusion "seat" so it does not float on the gradient.
    this.pit = makePit();
    this.scene.add(this.pit);

    // Image-based lighting so metallic screws pick up reflections.
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environment = this.envTexture;
      this.scene.environmentIntensity = 0.22;
      pmrem.dispose();
    } catch {
      /* environment is cosmetic; ignore failures (e.g. very old GPUs) */
    }
  }

  setInsets(topPx: number, bottomPx: number): void {
    this.insetTop = Math.max(0, topPx);
    this.insetBottom = Math.max(0, bottomPx);
    this.frame();
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.renderer.setPixelRatio(Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1));
    this.renderer.setSize(this.width, this.height, false);
    this.frame();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.envTexture?.dispose();
    for (const m of [this.ground, this.pit]) {
      m.geometry.dispose();
      const mat = m.material as THREE.Material & { map?: THREE.Texture | null };
      mat.map?.dispose();
      mat.dispose();
    }
    this.renderer.dispose();
    this.canvas.remove();
  }

  /**
   * Place the camera so VIEW_BOUNDS fits inside the non-inset area.
   * The visible region is treated as the "full" image and the canvas as an
   * enlarged view of it via setViewOffset, so framing math stays symmetric.
   */
  private frame(): void {
    const W = this.width;
    const H = this.height;
    const visH = Math.max(40, H - this.insetTop - this.insetBottom);
    const aspect = W / visH;

    const cam = this.camera;
    cam.fov = CAMERA_FOV;
    cam.aspect = aspect;
    cam.setViewOffset(W, visH, 0, -this.insetTop, W, H);

    const probe = this.probe;
    probe.fov = CAMERA_FOV;
    probe.aspect = aspect;
    probe.updateProjectionMatrix();

    const b = VIEW_BOUNDS;
    const corners: THREE.Vector3[] = [];
    for (const x of [-b.x, b.x])
      for (const y of [-b.y, b.y])
        for (const z of [b.zMin, b.zMax]) corners.push(new THREE.Vector3(x, y, z));

    let dist = 18;
    let targetY = 0;
    const halfTan = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2));
    const v = new THREE.Vector3();
    for (let iter = 0; iter < 10; iter++) {
      probe.position.set(0, targetY - dist * Math.sin(CAMERA_TILT), dist * Math.cos(CAMERA_TILT));
      probe.lookAt(0, targetY, 0);
      probe.updateMatrixWorld(true);
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const c of corners) {
        v.copy(c).project(probe);
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      }
      const cy = (maxY + minY) / 2;
      const halfHWorld = halfTan * dist;
      targetY += cy * halfHWorld;
      const sx = Math.max(-minX, maxX);
      const sy = (maxY - minY) / 2;
      const scale = Math.max(sx, sy) / (1 - FIT_MARGIN);
      dist *= scale;
      if (Math.abs(scale - 1) < 0.002 && Math.abs(cy) < 0.002) break;
    }
    cam.position.set(0, targetY - dist * Math.sin(CAMERA_TILT), dist * Math.cos(CAMERA_TILT));
    cam.lookAt(0, targetY, 0);
    // Tight near/far: the whole scene lives within ~9 units of the focus plane
    // (plus the background quad). Keeping the range short buys depth precision
    // for the 0.02-unit air gaps between stacked plates.
    cam.near = Math.max(1, dist - 9);
    cam.far = dist + 24;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }
}

function makeGround(): THREE.Mesh {
  const size = 44;
  const geo = new THREE.PlaneGeometry(size, size, 1, 12);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0x2c3868);
  const mid = new THREE.Color(0x1b2244);
  const bottom = new THREE.Color(0x0e1224);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    // map y ∈ [-size/2, size/2] but weight the gradient toward the visible band
    const t = THREE.MathUtils.clamp((pos.getY(i) + 9) / 18, 0, 1);
    if (t < 0.5) c.lerpColors(bottom, mid, t * 2);
    else c.lerpColors(mid, top, (t - 0.5) * 2);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    envMapIntensity: 0.12,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.z = -1.1;
  mesh.name = 'ground';
  return mesh;
}

/** Soft elliptical darkening behind the board so the stack has an AO "seat". */
function makePit(): THREE.Mesh {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(0,0,0,0.62)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.34)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    color: new THREE.Color(DEPTH_TINT).multiplyScalar(2),
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(12.5, 13.5), mat);
  mesh.position.set(-0.3, -0.35, -0.9);
  mesh.name = 'pit';
  return mesh;
}
