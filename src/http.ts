import { AlphaPayConnectionError, AlphaPayRateLimitError, AlphaPayServerError, buildErrorFromResponse } from "./errors.js";

const DEFAULT_BASE_URL = "https://api.alphapay.me/api/v1";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

export interface AlphaPayCheckoutOptions {
  /**
   * Override de l'URL de base — utile en dev/self-hosted uniquement.
   * Par défaut : `https://api.alphapay.me/api/v1`.
   */
  baseUrl?: string;
  /** Délai avant abandon d'une requête, en ms (défaut 30000). */
  timeout?: number;
  /** Nombre de tentatives supplémentaires sur erreur réseau/429/5xx (défaut 2 — donc 3 tentatives au total). */
  maxRetries?: number;
  /** Injecte un `fetch` personnalisé (tests, ou runtime sans `fetch` global). React Native fournit `fetch` globalement par défaut. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  /**
   * Clé d'idempotence explicite pour cette requête (header `Idempotency-Key`).
   * Optionnelle : sans elle, l'API dérive elle-même une clé depuis le slug +
   * le contenu de la requête pour `pay()` (cf. `CheckoutSessionPayView.
   * get_idempotency_key` côté API) — une resoumission identique (double-tap,
   * retry réseau) est donc déjà protégée par défaut, sans rien à fournir ici.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

function buildQueryString(query: RequestOptions["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function backoffMs(attempt: number): number {
  // Backoff exponentiel + gigue : 400-600ms, 800-1200ms, 1600-2400ms...
  const base = 400 * 2 ** attempt;
  return base + Math.random() * base * 0.5;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `fetch` échoue en TypeError sur erreur réseau/DNS (spec WHATWG, respectée par le polyfill RN) — jamais un statut HTTP, donc jamais couvert par `buildErrorFromResponse`. */
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

/** Timeout interne (AbortController déclenché par `this.timeout`, pas par un signal externe fourni par l'appelant). */
function isInternalTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Client HTTP bas niveau, partagé par [AlphaPayCheckout]. Gère l'enveloppe
 * standard `{success, data, code}`, les retries avec backoff sur
 * 429/5xx/erreur réseau, et le mapping vers des erreurs typées (cf. errors.ts).
 *
 * AUCUN header d'authentification — ces endpoints sont publics par design
 * (`authentication_classes = []` côté AlphaPayBack, cf.
 * `apps.checkout.views.public._PublicCheckoutMixin`) : le slug de la session
 * fait office de capacité, jamais une clé API secrète.
 */
export class Http {
  readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AlphaPayCheckoutOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error(
        "AlphaPayCheckout: aucun `fetch` global trouvé — passez `fetch` explicitement dans les options (environnement de test ?)."
      );
    }
    this.fetchImpl = fetchImpl;
  }

  async request<T>(method: "GET" | "POST", path: string, options: RequestOptions = {}): Promise<T> {
    const url = /^https?:\/\//.test(path) ? path : `${this.baseUrl}${path}${buildQueryString(options.query)}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    if (options.idempotencyKey) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    for (let attempt = 0; ; attempt++) {
      const isLastAttempt = attempt >= this.maxRetries;
      const internalTimeout = new AbortController();
      const timeoutId = setTimeout(() => internalTimeout.abort(), this.timeout);
      const onExternalAbort = () => internalTimeout.abort();
      options.signal?.addEventListener("abort", onExternalAbort);

      try {
        const response = await this.fetchImpl(url, { method, headers, body, signal: internalTimeout.signal });
        return await this.parseResponse<T>(response);
      } catch (err) {
        // Annulation volontaire par l'appelant (jamais retentée, contrairement à un timeout interne).
        if (options.signal?.aborted) throw err;

        const retryable =
          err instanceof AlphaPayRateLimitError ||
          err instanceof AlphaPayServerError ||
          isNetworkError(err) ||
          isInternalTimeout(err);

        if (!retryable || isLastAttempt) {
          if (isInternalTimeout(err)) {
            throw new AlphaPayConnectionError(`Requête AlphaPay expirée après ${this.timeout}ms.`, { status: 0, raw: err });
          }
          if (isNetworkError(err)) {
            throw new AlphaPayConnectionError(`Impossible de joindre l'API AlphaPay : ${(err as Error).message}`, {
              status: 0,
              raw: err,
            });
          }
          throw err;
        }

        const retryAfterMs = err instanceof AlphaPayRateLimitError && err.retryAfter ? err.retryAfter * 1000 : backoffMs(attempt);
        await sleep(retryAfterMs);
      } finally {
        clearTimeout(timeoutId);
        options.signal?.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    const requestId = response.headers.get("X-Request-Id") ?? undefined;
    const text = await response.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // Réponse non-JSON (page d'erreur d'un proxy en amont) — traité ci-dessous
        // comme un succès sans corps, ou une erreur serveur au message générique.
      }
    }

    if (response.ok) {
      const envelope = json as { data?: T } | undefined;
      return (envelope && typeof envelope === "object" && "data" in envelope ? envelope.data : json) as T;
    }

    const envelope = json as { error?: unknown } | undefined;
    const errorBody = envelope && typeof envelope === "object" && "error" in envelope ? envelope.error : json;
    const error = buildErrorFromResponse(response.status, errorBody, requestId);

    if (error instanceof AlphaPayRateLimitError) {
      const header = response.headers.get("Retry-After");
      if (header) (error as { retryAfter?: number }).retryAfter = Number(header);
    }
    throw error;
  }
}
