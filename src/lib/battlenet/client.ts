// Battle.net client: same-origin only, no credentials (server holds), no character data leaks.

import {
  BATTLENET_CONTRACT_VERSION, MAX_BATCH_IDS, batchMediaPath, batchTooltipPath,
  healthPath, iconPath, isValidItemId, itemPath, mediaPath, tooltipPath,
  type BaseItem, type ErrorCode, type HealthResponse, type ItemMedia, type ItemTooltip,
  type Locale, type Region,
} from './contract';

export interface ClientOptions {
  region?: Region;
  locale?: Locale;
  fetchImpl?: typeof fetch;
  /** Per-request timeout. A tooltip must never hold up a screen. */
  timeoutMs?: number;
}

/** Lookup outcome: ok, absent (item genuinely has none), or error (couldn't find out). */
export type Lookup<T> =
  | { status: 'ok'; value: T; expiresAt: string; attribution: string }
  | { status: 'absent' }
  | { status: 'error'; code: ErrorCode; message: string; retryable: boolean };

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['rate_limited', 'upstream_unavailable', 'upstream_timeout']);

export class BattleNetClient {
  private readonly region?: Region;
  private readonly locale?: Locale;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** Deduplicate concurrent identical lookups. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private configured: boolean | null = null;

  constructor(options: ClientOptions = {}) {
    this.region = options.region;
    this.locale = options.locale;
    // Deferred: capture fetch at call time, not construction (ignores polyfill if captured early).
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Deployment has item data (cached): UI hides art if false. */
  async isConfigured(): Promise<boolean> {
    if (this.configured !== null) return this.configured;
    try {
      const res = await this.request<HealthResponse>(healthPath);
      this.configured = res !== null && res.configured === true;
    } catch {
      this.configured = false;
    }
    return this.configured;
  }

  /** Same-origin icon URL (safe in src tag): 404 → placeholder; bytes proxied. */
  iconUrl(itemId: number): string | null {
    return isValidItemId(itemId) ? iconPath(itemId, { region: this.region }) : null;
  }

  async item(itemId: number): Promise<Lookup<BaseItem>> {
    return this.one(itemPath(itemId, { region: this.region, locale: this.locale }), (b) => b.item as BaseItem);
  }

  async media(itemId: number): Promise<Lookup<ItemMedia>> {
    return this.one(mediaPath(itemId, { region: this.region, locale: this.locale }), (b) => b.media as ItemMedia);
  }

  async tooltip(itemId: number): Promise<Lookup<ItemTooltip>> {
    return this.one(tooltipPath(itemId, { region: this.region, locale: this.locale }), (b) => b.tooltip as ItemTooltip);
  }

  /** Batch: IDs chunked to server cap; partial success normal (failed listed). */
  async mediaBatch(itemIds: number[]): Promise<{ media: Map<number, ItemMedia>; failed: number[] }> {
    return this.batch(itemIds, batchMediaPath, 'media', (m: ItemMedia) => m.id);
  }

  async tooltipBatch(itemIds: number[]): Promise<{ media: Map<number, ItemTooltip>; failed: number[] }> {
    return this.batch(itemIds, (ids) => batchTooltipPath(ids, { region: this.region, locale: this.locale }), 'tooltips', (t: ItemTooltip) => t.itemId);
  }

  private async batch<T>(
    itemIds: number[],
    path: (ids: number[]) => string,
    field: string,
    idOf: (value: T) => number,
  ): Promise<{ media: Map<number, T>; failed: number[] }> {
    const valid = [...new Set(itemIds.filter(isValidItemId))];
    const out = new Map<number, T>();
    const failed: number[] = itemIds.filter((id) => !isValidItemId(id));

    for (let i = 0; i < valid.length; i += MAX_BATCH_IDS) {
      const chunk = valid.slice(i, i + MAX_BATCH_IDS);
      try {
        const body = await this.request<Record<string, unknown>>(path(chunk));
        if (!body) { failed.push(...chunk); continue; }
        for (const value of (body[field] as T[]) ?? []) out.set(idOf(value), value);
        failed.push(...((body.failed as number[]) ?? []));
      } catch {
        failed.push(...chunk);
      }
    }
    return { media: out, failed };
  }

  private async one<T>(path: string, pick: (body: Record<string, unknown>) => T): Promise<Lookup<T>> {
    try {
      const res = await this.requestRaw(path);
      const body = (await res.json()) as Record<string, unknown>;
      if (res.ok && body.ok === true) {
        const provenance = body.provenance as { expiresAt: string; attribution: string } | undefined;
        return {
          status: 'ok',
          value: pick(body),
          expiresAt: provenance?.expiresAt ?? '',
          attribution: provenance?.attribution ?? '',
        };
      }
      const code = (body.error as ErrorCode) ?? 'internal_error';
      if (code === 'not_found') return { status: 'absent' };
      return {
        status: 'error',
        code,
        message: typeof body.message === 'string' ? body.message : 'Item data is unavailable.',
        retryable: RETRYABLE.has(code),
      };
    } catch {
      return {
        status: 'error',
        code: 'upstream_unavailable',
        message: 'Item data could not be reached.',
        retryable: true,
      };
    }
  }

  private async request<T>(path: string): Promise<T | null> {
    const existing = this.inFlight.get(path);
    if (existing) return existing as Promise<T | null>;
    const promise = (async () => {
      const res = await this.requestRaw(path);
      if (!res.ok) return null;
      const body = (await res.json()) as T & { ok?: boolean };
      return body.ok === false ? null : body;
    })().finally(() => this.inFlight.delete(path));
    this.inFlight.set(path, promise);
    return promise as Promise<T | null>;
  }

  private async requestRaw(path: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(path, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        // Same-origin only, no credentials (endpoint needs none).
        credentials: 'omit',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Merge API data into catalog item (catalog wins on known fields; API adds icon, text, binding, set). */
export function mergeWithCatalog<T extends { itemLevel: number; name: string; quality: number }>(
  resolved: T,
  tooltip: ItemTooltip | null,
): T & { iconUrl: string | null; description: string | null; spells: ItemTooltip['spells']; bindingText: string | null; setName: string | null; baseItemLevel: number | null } {
  return {
    ...resolved,
    // Catalog fields (itemLevel, name, quality, stats) untouched.
    iconUrl: tooltip?.iconUrl ?? null,
    description: tooltip?.description ?? null,
    spells: tooltip?.spells ?? [],
    bindingText: tooltip?.bindingText ?? null,
    setName: tooltip?.set?.name ?? null,
    /** Base item level (UI explains difference; never shown as item level). */
    baseItemLevel: tooltip?.baseItemLevel ?? null,
  };
}

export { BATTLENET_CONTRACT_VERSION };
