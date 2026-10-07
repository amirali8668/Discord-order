/**
 * resource-cooldown.ts — Railway version.
 * Same logic as Cloudflare version but uses PostgreSQL (db.ts) instead of D1.
 */

import type { Env } from "./types.js";
import { getResourceFailure, upsertResourceFailure, resolveResourceFailure } from "./db.js";

export type FailureType = "FORBIDDEN"|"NOT_FOUND"|"UNAUTHORIZED"|"BAD_REQUEST"|"SEND_FAILED";

export interface FailureRecord {
  resourceKey:   string;
  failureType:   FailureType;
  httpStatus:    number;
  firstFailedAt: number;
  lastFailedAt:  number;
  failureCount:  number;
  cooldownUntil: number;
  resolvedAt:    number | null;
}

export const COOLDOWN_MS = {
  FORBIDDEN:    30 * 60 * 1000,
  FORBIDDEN_EX: 2  * 60 * 60 * 1000,
  NOT_FOUND:    10 * 60 * 1000,
  UNAUTHORIZED: 60 * 60 * 1000,
  BAD_REQUEST:   5 * 60 * 1000,
  SEND_FAILED:   5 * 60 * 1000,
} as const;

export function cooldownDuration(type: FailureType, failureCount: number): number {
  switch (type) {
    case "FORBIDDEN":    return failureCount >= 3 ? COOLDOWN_MS.FORBIDDEN_EX : COOLDOWN_MS.FORBIDDEN;
    case "NOT_FOUND":    return COOLDOWN_MS.NOT_FOUND;
    case "UNAUTHORIZED": return COOLDOWN_MS.UNAUTHORIZED;
    case "BAD_REQUEST":  return COOLDOWN_MS.BAD_REQUEST;
    case "SEND_FAILED":  return COOLDOWN_MS.SEND_FAILED;
  }
}

export function classifyHttpStatus(status: number): FailureType | null {
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  return null;
}

export function channelKey(channelId: string): string { return `channel:${channelId}`; }
export function guildKey(guildId: string):     string { return `guild:${guildId}`; }
export function dmKey(userId: string):          string { return `dm:${userId}`; }
export function messageKey(channelId: string, msgId: string): string { return `message:${channelId}:${msgId}`; }

export class ResourceCooldown {
  private readonly mem = new Map<string, FailureRecord | null>();
  constructor(private readonly env: Env) {}

  async isOnCooldown(resourceKey: string): Promise<boolean> {
    const now = Date.now();
    if (this.mem.has(resourceKey)) {
      const rec = this.mem.get(resourceKey)!;
      if (rec === null) return false;
      if (rec.resolvedAt !== null) return false;
      return rec.cooldownUntil > now;
    }
    try {
      const row = await getResourceFailure(this.env, resourceKey);
      if (!row) { this.mem.set(resourceKey, null); return false; }
      const rec: FailureRecord = {
        resourceKey:   row.resource_key,
        failureType:   row.failure_type as FailureType,
        httpStatus:    row.http_status,
        firstFailedAt: row.first_failed_at,
        lastFailedAt:  row.last_failed_at,
        failureCount:  row.failure_count,
        cooldownUntil: row.cooldown_until,
        resolvedAt:    row.resolved_at,
      };
      this.mem.set(resourceKey, rec);
      if (rec.resolvedAt !== null) return false;
      return rec.cooldownUntil > now;
    } catch { return false; }
  }

  async recordFailure(resourceKey: string, failureType: FailureType, httpStatus: number): Promise<void> {
    const now = Date.now();
    const existing = this.mem.has(resourceKey) ? this.mem.get(resourceKey) : await this.loadFromDb(resourceKey);
    const failureCount = (existing ? existing.failureCount : 0) + 1;
    const cooldownUntil = now + cooldownDuration(failureType, failureCount);
    const rec: FailureRecord = {
      resourceKey, failureType, httpStatus,
      firstFailedAt: existing?.firstFailedAt ?? now,
      lastFailedAt: now, failureCount, cooldownUntil, resolvedAt: null,
    };
    this.mem.set(resourceKey, rec);
    try {
      await upsertResourceFailure(this.env, {
        resource_key:    rec.resourceKey,
        failure_type:    rec.failureType,
        http_status:     rec.httpStatus,
        first_failed_at: rec.firstFailedAt,
        last_failed_at:  rec.lastFailedAt,
        failure_count:   rec.failureCount,
        cooldown_until:  rec.cooldownUntil,
        resolved_at:     null,
      });
    } catch {}
  }

  async recordSuccess(resourceKey: string): Promise<void> {
    const existing = this.mem.get(resourceKey);
    if (existing === null || existing === undefined) return;
    const resolved = { ...existing, resolvedAt: Date.now() };
    this.mem.set(resourceKey, resolved);
    try { await resolveResourceFailure(this.env, resourceKey); } catch {}
  }

  cooldownReason(resourceKey: string): string {
    const rec = this.mem.get(resourceKey);
    if (!rec) return "on cooldown (no details)";
    const remainSec = Math.ceil((rec.cooldownUntil - Date.now()) / 1000);
    return `on cooldown for ${remainSec}s (${rec.failureType} HTTP ${rec.httpStatus}, failed ${rec.failureCount}x)`;
  }

  private async loadFromDb(resourceKey: string): Promise<FailureRecord | null> {
    try {
      const row = await getResourceFailure(this.env, resourceKey);
      if (!row) { this.mem.set(resourceKey, null); return null; }
      const rec: FailureRecord = {
        resourceKey:   row.resource_key,
        failureType:   row.failure_type as FailureType,
        httpStatus:    row.http_status,
        firstFailedAt: row.first_failed_at,
        lastFailedAt:  row.last_failed_at,
        failureCount:  row.failure_count,
        cooldownUntil: row.cooldown_until,
        resolvedAt:    row.resolved_at,
      };
      this.mem.set(resourceKey, rec);
      return rec;
    } catch { return null; }
  }
}
