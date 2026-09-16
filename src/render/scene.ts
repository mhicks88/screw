import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ASSEMBLY_RADIUS, DEPTH_TINT, KEY_LIGHT, VIEW_BOUNDS } from './layout';

/**
 * v3: the camera never moves (CONTRACT_V3 §1) — the assembly group under it
 * does. A modest downward tilt still gives the object a "sitting on a bench"
 * read; anything steeper starts to hide the faces the player is turning toward.
 */
const CAMERA_TILT = THREE.MathUtils.degToRad(9);
const CAMERA_FOV = 34;
const FIT_MARGIN = 0.025;

/**
 * The target device is dpr 3 (1320x2868). Rendering the backing store at 2x
 * with 4x MSAA is both sharper on edges and ~2.2x cheaper in fill than a 3x
 * buffer with no MSAA, so we cap here rather than chase the native ratio.
 */
const MAX_PIXEL_RATIO = 2;

/**
 * Owns the WebGLRenderer, scene graph roots, camera, lights and background.
 *
 * Two roots, and the split is the whole architecture of v3:
 *   - `assemblyRoot` holds the panels, the seated screw field and the hit
 *     proxies. Its quaternion is driven by the drag gesture.
 *   - `fixedRoot` holds the box row, the tray, screws in flight and panels that
 *     have detached — everything that lives in world space and must NOT be
 *     dragged around when the player turns the object.
 *
 * There is deliberately no shadow map: a second pass over 60 panels plus the
 * screw field costs more than the lighting rig is worth, and a depth-map shadow
 * on a body that spins in place either acnes or peter-pans at every angle.
 */
export class SceneRig {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Rotating assembly (CONTRACT_V3 §1). Cleared on loadLevel. */
  readonly assemblyRoot = new THREE.Group();
  /** Fixed world-space furniture: boxes, tray, flights. Cleared on loadLevel. */
  readonly fixedRoot = new THREE.Group();
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
  /** Projected pixel radius of the assembly's bounding sphere (drag gain). */
  private radiusPx = 320;

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
    this.assemblyRoot.name = 'assembly';
    this.fixedRoot.name = 'fixed';
    this.scene.add(this.assemblyRoot);
    this.scene.add(this.fixedRoot);

    // Lights. The object turns inside a fixed rig, so the whole front hemisphere
    // has to be covered: a warm key from upper right, a cool rim from lower
    // left, a soft camera-side fill that keeps a face turned flat-on from going
    // muddy, and hemisphere ambient. Total irradiance on a camera-facing
    // surface stays near 1.3 so panel colours never clip to white.
    const hemi = new THREE.HemisphereLight(0xe4ecff, 0x232842, 0.38);
    hemi.position.set(0, 1, 0);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xfff4e6, 1.02);
    dir.position.set(KEY_LIGHT.x, KEY_LIGHT.y, KEY_LIGHT.z);
    dir.target.position.set(0, 0, 0);
    dir.castShadow = false;
    this.scene.add(dir);
    this.scene.add(dir.target);
    this.dirLight = dir;

    // Cool rim from the opposite side: picks out the extruded side walls, which
    // in v3 are a main surface rather than a 1 px sliver.
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.52);
    rim.position.set(-6.5, -4.5, 3.4);
    this.scene.add(rim);

    // Head-on fill so a panel that turns square to the camera still separates
    // from the panel behind it.
    const fill = new THREE.DirectionalLight(0xcfe0ff, 0.26);
    fill.position.set(-1.2, 1.6, 8);
    this.scene.add(fill);

    // Background: a large vertex-coloured plane far behind the assembly.
    this.ground = makeGround();
    this.scene.add(this.ground);

    // A soft dark blob behind the object so it has an ambient-occlusion "seat"
    // instead of floating on the gradient.
    this.pit = makePit();
    this.scene.add(this.pit);

    // Image-based lighting so metallic screws and brackets pick up reflections.
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environment = this.envTexture;
      this.scene.environmentIntensity = 0.24;
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

  /**
   * Projected radius of the FRAME the assembly is fitted to, in CSS pixels.
   *
   * Every level is zoomed so its own bounding sphere fills ASSEMBLY_RADIUS
   * (see layout.ts), so this is also the projected radius of the object itself
   * whatever level it is — which is exactly what the drag gain needs.
   */
  assemblyPixelRadius(): number {
    return this.radiusPx;
  }

  /** Uniform zoom applied to the assembly so small levels still fill the frame. */
  get assemblyScale(): number {
    return this.assemblyRoot.scale.x;
  }

  setAssemblyScale(k: number): void {
    this.assemblyRoot.scale.setScalar(k);
    this.assemblyRoot.updateMatrixWorld(true);
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
    // The assembly reaches 3 units toward the camera, so the near plane has to
    // sit further back than in v2 while still keeping the range short.
    cam.near = Math.max(1, dist - ASSEMBLY_RADIUS - 6);
    cam.far = dist + 32;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    // Pixel radius of the bounding sphere: drag gain (orbit.ts) and the radius
    // the off-screen-screw markers sit at.
    const centre = new THREE.Vector3(0, 0, 0).project(cam);
    const edge = new THREE.Vector3(ASSEMBLY_RADIUS, 0, 0).project(cam);
    this.radiusPx = Math.max(40, Math.abs(edge.x - centre.x) * 0.5 * W);
  }
}

function makeGround(): THREE.Mesh {
  const size = 70;
  const geo = new THREE.PlaneGeometry(size, size, 1, 14);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0x2c3868);
  const mid = new THREE.Color(0x1b2244);
  const bottom = new THREE.Color(0x0e1224);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp((pos.getY(i) + 11) / 22, 0, 1);
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
  // Well behind the assembly, which now reaches z = -3.
  mesh.position.z = -13;
  mesh.name = 'ground';
  return mesh;
}

/** Soft elliptical darkening behind the object so it has an AO "seat". */
function makePit(): THREE.Mesh {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(0,0,0,0.6)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.3)');
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
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(13.5, 13.5), mat);
  mesh.position.set(-0.4, -0.5, -5.5);
  mesh.name = 'pit';
  return mesh;
}
