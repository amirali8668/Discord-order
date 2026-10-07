/**
 * filter.ts – Centralised level filter for M+ matching.
 *
 * The range is inclusive: min ≤ level ≤ max
 */

export interface LevelFilter {
  minLevel: number;
  maxLevel: number;
}

/**
 * Check whether a dungeon level is within the configured inclusive range.
 */
export function levelInRange(level: number, filter: LevelFilter): boolean {
  if (!Number.isInteger(level)) return false;
  if (!Number.isInteger(filter.minLevel) || !Number.isInteger(filter.maxLevel)) return false;
  if (filter.minLevel > filter.maxLevel) return false;
  return level >= filter.minLevel && level <= filter.maxLevel;
}

/**
 * Validate a LevelFilter configuration.
 * Returns null if valid, or an error string if invalid.
 */
export function validateLevelFilter(filter: Partial<LevelFilter>): string | null {
  const min = filter.minLevel;
  const max = filter.maxLevel;

  if (min === undefined || max === undefined) return "minLevel and maxLevel are required";
  if (!Number.isInteger(min) || min < 1) return "minLevel must be a positive integer";
  if (!Number.isInteger(max) || max < 1) return "maxLevel must be a positive integer";
  if (min > max) return "minLevel must be <= maxLevel";

  return null;
}
