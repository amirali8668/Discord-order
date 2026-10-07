/**
 * discord-client.ts — Railway version.
 * Identical logic to the Cloudflare version but runs on Node.js.
 * All imports use .js extensions for ESM compatibility.
 */

import type { CredentialPurpose } from "./types.js";

export type RequestPriority = "HIGH" | "MEDIUM" | "LOW";

export interface DiscordRequestOptions {
  method?:     "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
  body?:       unknown;
  priority?:   RequestPriority;
  purpose?:    string;
  maxRetries?: number;
  skipCache?:  boolean;
}

export interface DiscordResponse<T = unknown> {
  ok: boolean; status: number; data: T | null;
  permanent: boolean; rateLimited: boolean;
  retryAfter?: number; bucket?: string; retries: number; fromCache: boolean;
}

export function isPermanentError(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404;
}
export function isRetryableError(status: number): boolean {
  return status === 429 || status >= 500 || status === 0;
}

export function resolveToken(
  env: { DISCORD_TOKEN: string; DISCORD_READ_TOKEN?: string },
  purpose: CredentialPurpose
): string {
  if (purpose === "ACTION") return env.DISCORD_TOKEN;
  if (!env.DISCORD_READ_TOKEN) {
    throw new Error("[discord-client] DISCORD_READ_TOKEN is not configured.");
  }
  return env.DISCORD_READ_TOKEN;
}
export function resolveTokenSafe(
  env: { DISCORD_TOKEN: string; DISCORD_READ_TOKEN?: string },
  purpose: CredentialPurpose
): string | null {
  if (purpose === "ACTION") return env.DISCORD_TOKEN;
  return env.DISCORD_READ_TOKEN ?? null;
}

// ─── In-memory state (per-process — Worker-equivalent within one Node process) ─

interface BucketState { limit:number; remaining:number; resetAt:number; resetAfterMs:number; bucket:string; }
interface CacheEntry<T> { data:T; expiresAt:number; }

const buckets  = new Map<string, BucketState>();
const cache    = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<DiscordResponse<unknown>>>();

export const rateLimitStats = {
  total429s:0, lastRateLimit:0, lastRetryAfter:0, totalRetries:0, totalRequests:0,
  totalCacheHits:0, lastSuccessAt:0, failedRequests:0, permanentErrors:0, skippedRetries:0,
};

const BASE_V9               = "https://discord.com/api/v9";
const DEFAULT_MAX_RETRIES   = 4;
const CACHE_TTL_METADATA_MS = 5 * 60 * 1000;
const CACHE_TTL_REALTIME_MS = 10 * 1000;
const DEDUP_WINDOW_MS       = 5_000;
const MAX_RETRY_WAIT_MS     = 30_000;
const JITTER_FACTOR         = 0.10;

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, Math.max(0,ms))); }
function withJitter(ms: number): number {
  const j = ms * JITTER_FACTOR * (Math.random()*2-1);
  return Math.min(MAX_RETRY_WAIT_MS, Math.max(0, ms+j));
}
function cacheTtl(path: string): number {
  return path.includes("/messages") ? CACHE_TTL_REALTIME_MS : CACHE_TTL_METADATA_MS;
}
function deriveBucketKey(method: string, path: string): string {
  const chM = path.match(/\/channels\/(\d+)/);
  const gM  = path.match(/\/guilds\/(\d+)/);
  const major = chM?.[1] ?? gM?.[1] ?? "global";
  const norm = path.replace(/\/\d{17,21}/g,"/{id}").replace(/\?.*$/,"");
  return `${method}:${norm}:${major}`;
}
function cacheKey(method: string, path: string): string { return `${method}:${path}`; }

async function proactiveThrottle(bucketKey: string): Promise<void> {
  const s = buckets.get(bucketKey);
  if (!s) return;
  const now = Date.now();
  if (s.remaining <= 0 && s.resetAt > now) await sleep(withJitter(s.resetAt - now + 100));
}
function parseBucketHeaders(resp: Response, bucketKey: string): void {
  const remaining = resp.headers.get("X-RateLimit-Remaining");
  if (remaining !== null) {
    buckets.set(bucketKey, {
      limit:        parseInt(resp.headers.get("X-RateLimit-Limit") ?? "5"),
      remaining:    parseInt(remaining),
      resetAt:      parseFloat(resp.headers.get("X-RateLimit-Reset") ?? "0") * 1000,
      resetAfterMs: parseFloat(resp.headers.get("X-RateLimit-Reset-After") ?? "1") * 1000,
      bucket:       resp.headers.get("X-RateLimit-Bucket") ?? bucketKey,
    });
  }
}

async function executeRequest<T>(token: string, path: string, method: string, body: unknown, maxRetries: number, purpose: string): Promise<DiscordResponse<T>> {
  const bucketKey = deriveBucketKey(method, path);
  let retries = 0, lastStatus = 0;
  while (retries <= maxRetries) {
    await proactiveThrottle(bucketKey);
    const url = path.startsWith("http") ? path : `${BASE_V9}${path}`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers: { Authorization: token, "Content-Type": "application/json", "User-Agent": "DiscordBot (railway, 1.0)" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      retries++; rateLimitStats.totalRetries++;
      if (retries > maxRetries) { rateLimitStats.failedRequests++; return { ok:false,status:0,data:null,permanent:false,rateLimited:false,retries,fromCache:false }; }
      await sleep(withJitter(Math.min(1000*2**(retries-1), MAX_RETRY_WAIT_MS)));
      continue;
    }
    lastStatus = resp.status;
    parseBucketHeaders(resp, bucketKey);
    if (resp.status === 429) {
      rateLimitStats.total429s++; rateLimitStats.lastRateLimit = Date.now();
      let retryAfterMs = 1000;
      try { const b = await resp.json() as { retry_after?: number }; retryAfterMs = ((b.retry_after??1)*1000); } catch {}
      retryAfterMs = Math.min(retryAfterMs, MAX_RETRY_WAIT_MS);
      rateLimitStats.lastRetryAfter = retryAfterMs;
      retries++; rateLimitStats.totalRetries++;
      if (retries > maxRetries) { rateLimitStats.failedRequests++; return { ok:false,status:429,data:null,permanent:false,rateLimited:true,retryAfter:retryAfterMs,retries,fromCache:false }; }
      await sleep(withJitter(retryAfterMs + 100));
      continue;
    }
    if (isPermanentError(resp.status)) {
      rateLimitStats.permanentErrors++; rateLimitStats.failedRequests++;
      rateLimitStats.skippedRetries += maxRetries - retries;
      console.warn(`[discord-client] Permanent ${resp.status} ${method} ${path} — not retrying. ${purpose}`);
      return { ok:false,status:resp.status,data:null,permanent:true,rateLimited:false,retries,fromCache:false };
    }
    if (resp.status >= 500) {
      retries++; rateLimitStats.totalRetries++;
      if (retries > maxRetries) { rateLimitStats.failedRequests++; return { ok:false,status:resp.status,data:null,permanent:false,rateLimited:false,retries,fromCache:false }; }
      await sleep(withJitter(Math.min(1000*2**(retries-1), MAX_RETRY_WAIT_MS)));
      continue;
    }
    if (resp.ok) {
      rateLimitStats.lastSuccessAt = Date.now();
      let data: T | null = null;
      const ct = resp.headers.get("Content-Type") ?? "";
      if (ct.includes("application/json")) { try { data = await resp.json() as T; } catch {} }
      return { ok:true,status:resp.status,data,permanent:false,rateLimited:false,bucket:buckets.get(bucketKey)?.bucket,retries,fromCache:false };
    }
    rateLimitStats.failedRequests++;
    return { ok:false,status:resp.status,data:null,permanent:false,rateLimited:false,retries,fromCache:false };
  }
  rateLimitStats.failedRequests++;
  return { ok:false,status:lastStatus,data:null,permanent:false,rateLimited:false,retries,fromCache:false };
}

export async function discordRequest<T = unknown>(token: string, path: string, options: DiscordRequestOptions = {}): Promise<DiscordResponse<T>> {
  const { method="GET", body, priority="MEDIUM", purpose="", maxRetries=DEFAULT_MAX_RETRIES, skipCache=false } = options;
  rateLimitStats.totalRequests++;

  if (method === "GET" && !skipCache) {
    const ck = cacheKey(method, path);
    const cached = cache.get(ck);
    if (cached && cached.expiresAt > Date.now()) {
      rateLimitStats.totalCacheHits++;
      return { ok:true,status:200,data:cached.data as T,permanent:false,rateLimited:false,retries:0,fromCache:true };
    }
  }

  if (method === "GET" && !skipCache) {
    const dk = cacheKey(method, path);
    const existing = inFlight.get(dk);
    if (existing) {
      try { const r = await existing as DiscordResponse<T>; rateLimitStats.totalCacheHits++; return {...r,fromCache:true}; } catch {}
    }
  }

  if (priority === "LOW") await sleep(withJitter(100));
  else if (priority === "MEDIUM") await sleep(withJitter(10));

  const requestPromise = executeRequest<T>(token, path, method, body, maxRetries, purpose);

  if (method === "GET" && !skipCache) {
    const dk = cacheKey(method, path);
    inFlight.set(dk, requestPromise as Promise<DiscordResponse<unknown>>);
    sleep(DEDUP_WINDOW_MS).then(() => inFlight.delete(dk));
  }

  const result = await requestPromise;

  if (method === "GET" && result.ok && result.data !== null && !skipCache) {
    cache.set(cacheKey(method, path), { data: result.data, expiresAt: Date.now() + cacheTtl(path) });
  }
  return result;
}

export async function discordGet<T>(token: string, path: string, opts?: Omit<DiscordRequestOptions,"method">): Promise<T | null> {
  const r = await discordRequest<T>(token, path, { ...opts, method: "GET" });
  return r.data;
}
export async function discordPost<T>(token: string, path: string, body: unknown, opts?: Omit<DiscordRequestOptions,"method"|"body">): Promise<T | null> {
  const r = await discordRequest<T>(token, path, { ...opts, method:"POST", body });
  return r.data;
}
export async function discordPostFull<T>(token: string, path: string, body: unknown, opts?: Omit<DiscordRequestOptions,"method"|"body">): Promise<DiscordResponse<T>> {
  return discordRequest<T>(token, path, { ...opts, method:"POST", body });
}

export function invalidateCache(method: string, path: string): void { cache.delete(cacheKey(method, path)); }
export function invalidateChannelCache(channelId: string): void {
  for (const k of cache.keys()) { if (k.includes(`/channels/${channelId}`)) cache.delete(k); }
}
export function invalidateGuildCache(guildId: string): void {
  for (const k of cache.keys()) { if (k.includes(`/guilds/${guildId}`)) cache.delete(k); }
}
export function clearAllCache(): void { cache.clear(); }
export function clearAllState(): void {
  cache.clear(); buckets.clear(); inFlight.clear();
  Object.assign(rateLimitStats, { total429s:0,lastRateLimit:0,lastRetryAfter:0,totalRetries:0,totalRequests:0,totalCacheHits:0,lastSuccessAt:0,failedRequests:0,permanentErrors:0,skippedRetries:0 });
}
export function getRateLimitStats() {
  return { ...rateLimitStats, activeBuckets:buckets.size, cacheSize:cache.size, inFlightCount:inFlight.size };
}
