export * from './types';
export { TOTAL_LEVELS, difficultyFor, difficultyLabelFor, type DifficultyParams, type DifficultyLabel } from './difficulty';
export { generateLevel, simulateWithLazyQueue, lastGenerationStats } from './generator';
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
