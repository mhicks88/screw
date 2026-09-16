export * from './types';
export { TOTAL_LEVELS, MAX_TRAY_SLOTS, difficultyFor, difficultyLabelFor, bandFor, type DifficultyParams, type DifficultyLabel } from './difficulty';
export {
  generateLevel, simulateWithLazyQueue, lastGenerationStats, measureLevel, nonLinearityTargets, winningMoves,
  minViewFacing,
  type LevelStats, type GenerationStats, type NonLinearityTargets,
} from './generator';
export {
  SCREW_SPACING, SCREW_EDGE_MARGIN, SCREW_HEAD_R, SCREW_HIT_R, PANEL_GAP, HEAD_CLEARANCE,
  requiredSeparation, pairSpacingOk, coverageExempt, spacingViolations, type ScrewSpot,
} from './spacing';
export {
  buildAssembly, placePanels, placeScrews, trimScrews, latticePoints, shellRadii, shellCount, outerShellFraction, type Assembly,
} from './assembly';
export { computeBlockers, blockersForScrew, reachableScrews, rayOriginFor, RAY_LENGTH, RAY_START_OFFSET } from './blocking';
export { Game, type GameOptions } from './game';
export {
  pointInPolygon, pointInShape, transformPolygon, polygonAabb, polygonsOverlap, polygonDistance, polygonArea,
  shapeArea, distanceToPolygonEdge, type Aabb,
} from './geometry';
export {
  v3, addV3, subV3, scaleV3, dotV3, crossV3, lengthV3, distV3, normalizeV3, angleBetween, perpendicularTo,
  QUAT_IDENTITY, quatNormalize, quatFromAxisAngle, quatMul, quatInvert, quatRotate, quatRotateInv,
  quatFromUnitVectors, quatFromFrame,
  panelToAssembly, assemblyToPanel, assemblyToPanelDir, panelNormal, panelFacePoint,
  panelBoundingSphere, panelMaxRadius, panelObb, obbOverlap, raySphere, rayPanelHit, PanelBvh,
  type Sphere, type Obb, type Ray,
} from './geometry3';
export { solveNextMoves } from './solver';
export { playBot, type BotResult } from './bot';
export { Rng, hashSeed } from './rng';
export * as shapes from './shapes';
