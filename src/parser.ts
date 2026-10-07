/**
 * parser.ts – Channel name parser for M+ boost channels (v2).
 *
 * Expected format:  <type>-<count>x<level>-<targetId>
 *
 * IMPORTANT (v2 change):
 *   The Target ID is EVERYTHING after the second "-".
 *   Target IDs may themselves contain "-" characters.
 *   DO NOT split on "-" and take only index[2].
 *
 * Examples:
 *   nostack-1x10-hakem             → type="nostack" count=1  level=10 customer="hakem"
 *   nostack-4x12-ovhel             → type="nostack" count=4  level=12 customer="ovhel"
 *   cloth-4x12-abc-def-123         → type="cloth"   count=4  level=12 customer="abc-def-123"
 *   leather-3x15-player-with-many  → type="leather" count=3  level=15 customer="player-with-many"
 *   mail-8x10-ayzaw                → type="mail"    count=8  level=10 customer="ayzaw"
 *
 * Algorithm:
 *   1. Find the FIRST "-" → everything before is the type.
 *   2. From the remaining string, find the FIRST "-" → everything before is NxM.
 *   3. Everything remaining (after that second "-") is the customer/targetId.
 */

import type { ChannelParseResult, ParsedChannel, UnparsedChannel } from "./types.js";

const UNPARSED: UnparsedChannel = { parsed: false, status: "UNPARSED" };

// Validates type segment: starts with letter, alphanumeric only
const TYPE_RE    = /^[a-z][a-z0-9]*$/i;
// Validates key segment: <digits>x<digits>  (case-insensitive X)
const KEY_RE     = /^(\d+)[xX](\d+)$/;
// Customer must be non-empty, may contain letters/digits/hyphens/underscores
const CUST_RE    = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Parse a Discord channel name.
 * Returns a ParsedChannel on success or UnparsedChannel on failure.
 * Never throws.
 */
export function parseChannelName(name: string): ChannelParseResult {
  if (!name || typeof name !== "string") return UNPARSED;

  const normalized = name.trim();
  if (normalized.length === 0) return UNPARSED;

  // ── Split on the first "-" → type segment ─────────────────────────────
  const firstDash = normalized.indexOf("-");
  if (firstDash < 1) return UNPARSED;              // no dash, or dash at position 0

  const rawType = normalized.slice(0, firstDash);
  const rest1   = normalized.slice(firstDash + 1); // "NxM-targetId..."

  // ── Split rest on the first "-" → key segment ─────────────────────────
  const secondDash = rest1.indexOf("-");
  if (secondDash < 1) return UNPARSED;             // no second dash

  const rawKey      = rest1.slice(0, secondDash);
  const rawCustomer = rest1.slice(secondDash + 1); // everything after second dash

  // ── Validate type ──────────────────────────────────────────────────────
  if (!TYPE_RE.test(rawType)) return UNPARSED;

  // ── Validate key (NxM) ─────────────────────────────────────────────────
  const keyMatch = KEY_RE.exec(rawKey);
  if (!keyMatch) return UNPARSED;

  const count = parseInt(keyMatch[1], 10);
  const level = parseInt(keyMatch[2], 10);

  if (!Number.isInteger(count) || count <= 0) return UNPARSED;
  if (!Number.isInteger(level) || level <= 0) return UNPARSED;
  if (count > 100) return UNPARSED;
  if (level > 99)  return UNPARSED;

  // ── Validate customer/targetId ─────────────────────────────────────────
  if (!rawCustomer || rawCustomer.length === 0) return UNPARSED;
  if (!CUST_RE.test(rawCustomer)) return UNPARSED;

  const result: ParsedChannel = {
    parsed:   true,
    type:     rawType.toLowerCase(),
    count,
    level,
    customer: rawCustomer.toLowerCase(),
  };

  return result;
}

/**
 * Type guard: check whether a parse result is parsed.
 */
export function isParsed(result: ChannelParseResult): result is ParsedChannel {
  return result.parsed === true;
}
