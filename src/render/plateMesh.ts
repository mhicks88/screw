import * as THREE from 'three';
import type { PlateDef } from '../core/types';
import { LAYER_SPACING, PLATE_BEVEL, PLATE_THICKNESS } from './layout';

export interface PlateVisual {
  id: number;
  layer: number;
  mesh: THREE.Mesh<THREE.ExtrudeGeometry, THREE.MeshStandardMaterial>;
  dropped: boolean;
}

/** Build a THREE.Shape from a PlateShape outline + holes (plate-local coords). */
export function shapeFromOutline(outline: { x: number; y: number }[], holes?: { x: number; y: number }[][]): THREE.Shape {
  const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, p.y)));
  if (holes) {
    for (const h of holes) {
      if (h.length >= 3) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
    }
  }
  return shape;
}

/**
 * Extrude the plate outline in local space; the mesh is positioned/rotated so
 * the local origin lands on (plate.x, plate.y) at the plate's layer height.
 */
export function createPlateVisual(plate: PlateDef): PlateVisual {
  const shape = shapeFromOutline(plate.shape.outline, plate.shape.holes);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: PLATE_THICKNESS - 2 * PLATE_BEVEL,
    bevelEnabled: true,
    bevelThickness: PLATE_BEVEL,
    bevelSize: PLATE_BEVEL * 0.9,
    bevelOffset: -PLATE_BEVEL * 0.9,
    bevelSegments: 3,
    curveSegments: 8,
  });
  geometry.computeVertexNormals();

  const isMetal = plate.material === 'metal';
  const isWood = plate.material === 'wood';
  const material = new THREE.MeshStandardMaterial({
    color: plate.color,
    roughness: isMetal ? 0.32 : isWood ? 0.8 : 0.5,
    metalness: isMetal ? 0.55 : 0.04,
    envMapIntensity: isMetal ? 1 : 0.5,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(plate.x, plate.y, plate.layer * LAYER_SPACING + PLATE_BEVEL);
  mesh.rotation.z = plate.rotation;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = `plate-${plate.id}`;
  mesh.userData.plateId = plate.id;
  return { id: plate.id, layer: plate.layer, mesh, dropped: false };
}

export function disposePlateVisual(v: PlateVisual): void {
  v.mesh.removeFromParent();
  v.mesh.geometry.dispose();
  v.mesh.material.dispose();
}
