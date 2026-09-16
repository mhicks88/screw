import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { VIEW_BOUNDS } from './layout';

const CAMERA_TILT = THREE.MathUtils.degToRad(9);
const CAMERA_FOV = 34;
const FIT_MARGIN = 0.025;

/**
 * Owns the WebGLRenderer, scene graph root, camera, lights and background.
 * Camera framing keeps VIEW_BOUNDS visible inside the container minus insets.
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
  private readonly probe = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.5, 100);
  private envTexture: THREE.Texture | null = null;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x141a30, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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

    // Lights: soft hemisphere fill + one shadow-casting key light.
    const hemi = new THREE.HemisphereLight(0xdde6ff, 0x2a2f45, 1.1);
    hemi.position.set(0, 0, 1);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xfff3e0, 2.4);
    dir.position.set(4.5, 6, 11);
    dir.target.position.set(0, 0, 0);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 40;
    dir.shadow.camera.left = -5;
    dir.shadow.camera.right = 5;
    dir.shadow.camera.top = 8;
    dir.shadow.camera.bottom = -8;
    dir.shadow.bias = -0.0006;
    dir.shadow.normalBias = 0.03;
    dir.shadow.radius = 3;
    dir.shadow.intensity = 0.72;
    this.scene.add(dir);
    this.scene.add(dir.target);
    this.dirLight = dir;

    const rim = new THREE.DirectionalLight(0x8fb8ff, 0.5);
    rim.position.set(-5, -3, 6);
    this.scene.add(rim);

    // Background: a large vertex-coloured plane far behind the board that
    // receives the bottom layer's shadows.
    this.ground = makeGround();
    this.scene.add(this.ground);

    // Image-based lighting so metallic screws pick up reflections.
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environment = this.envTexture;
      this.scene.environmentIntensity = 0.55;
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
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(this.width, this.height, false);
    this.frame();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.envTexture?.dispose();
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
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
    cam.near = Math.max(0.5, dist - 8);
    cam.far = dist + 30;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }
}

function makeGround(): THREE.Mesh {
  const size = 80;
  const geo = new THREE.PlaneGeometry(size, size, 1, 8);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0x2a3563);
  const mid = new THREE.Color(0x1b2244);
  const bottom = new THREE.Color(0x0f1326);
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
    envMapIntensity: 0.15,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.z = -0.22;
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}
