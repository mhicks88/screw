import * as THREE from 'three';
import { COLOR_HEX } from '../core/types';

interface Burst {
  points: THREE.Points;
  velocities: Float32Array;
  age: number;
  life: number;
}

/** Cheap particle bursts (win confetti). */
export class Effects {
  private readonly bursts: Burst[] = [];
  private readonly root: THREE.Object3D;
  private material: THREE.PointsMaterial | null = null;

  constructor(root: THREE.Object3D) {
    this.root = root;
  }

  confetti(center: THREE.Vector3, count = 160, life = 1700): Promise<void> {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const palette = Object.values(COLOR_HEX).map((hex) => new THREE.Color(hex));
    for (let i = 0; i < count; i++) {
      positions[i * 3] = center.x + (Math.random() - 0.5) * 0.6;
      positions[i * 3 + 1] = center.y + (Math.random() - 0.5) * 0.6;
      positions[i * 3 + 2] = center.z;
      const a = Math.random() * Math.PI * 2;
      const s = 3 + Math.random() * 5;
      velocities[i * 3] = Math.cos(a) * s;
      velocities[i * 3 + 1] = Math.sin(a) * s + 5;
      velocities[i * 3 + 2] = 1 + Math.random() * 3;
      const c = palette[Math.floor(Math.random() * palette.length)];
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.material ??= new THREE.PointsMaterial({
      size: 0.16,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, this.material.clone());
    points.frustumCulled = false;
    this.root.add(points);
    const burst: Burst = { points, velocities, age: 0, life };
    this.bursts.push(burst);
    return new Promise((resolve) => {
      (burst as Burst & { resolve?: () => void }).resolve = resolve;
    });
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    for (let b = this.bursts.length - 1; b >= 0; b--) {
      const burst = this.bursts[b];
      burst.age += dtMs;
      const pos = burst.points.geometry.attributes.position as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      const vel = burst.velocities;
      for (let i = 0; i < pos.count; i++) {
        vel[i * 3 + 1] -= 14 * dt; // gravity along -y
        vel[i * 3] *= 0.985;
        arr[i * 3] += vel[i * 3] * dt;
        arr[i * 3 + 1] += vel[i * 3 + 1] * dt;
        arr[i * 3 + 2] += vel[i * 3 + 2] * dt;
      }
      pos.needsUpdate = true;
      const t = burst.age / burst.life;
      (burst.points.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - Math.max(0, t - 0.6) / 0.4);
      if (burst.age >= burst.life) {
        this.remove(burst);
        this.bursts.splice(b, 1);
        (burst as Burst & { resolve?: () => void }).resolve?.();
      }
    }
  }

  clear(): void {
    for (const b of this.bursts) {
      this.remove(b);
      (b as Burst & { resolve?: () => void }).resolve?.();
    }
    this.bursts.length = 0;
  }

  dispose(): void {
    this.clear();
    this.material?.dispose();
    this.material = null;
  }

  private remove(b: Burst): void {
    b.points.removeFromParent();
    b.points.geometry.dispose();
    (b.points.material as THREE.Material).dispose();
  }
}
