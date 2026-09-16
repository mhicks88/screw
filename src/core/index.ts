export * from './types';
export { TOTAL_LEVELS, MAX_TRAY_SLOTS, difficultyFor, difficultyLabelFor, bandFor, type DifficultyParams, type DifficultyLabel } from './difficulty';
export {
  generateLevel, simulateWithLazyQueue, lastGenerationStats, measureLevel, nonLinearityTargets, winningMoves,
  type LevelStats, type GenerationStats, type NonLinearityTargets,
} from './generator';
export {
  BOARD, SCREW_SPACING, SCREW_EDGE_MARGIN, PLATE_GAP, pairSpacingOk, coverageExempt, spacingViolations,
} from './spacing';
export { bottomLayerFraction } from './placement';
export { Game, type GameOptions } from './game';
export {
  plateContainsWorldPoint, plateWorldOutline, plateWorldHoles, plateWorldAabb, plateEdgeDistance,
  pointInPolygon, pointInShape, transformPolygon, polygonAabb, polygonsOverlap, polygonDistance, polygonArea, shapeArea,
  type Aabb,
} from './geometry';
export { solveNextMoves } from './solver';
export { playBot, type BotResult } from './bot';
export { Rng, hashSeed } from './rng';
export * as shapes from './shapes';
