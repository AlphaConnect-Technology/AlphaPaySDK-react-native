import { AlphaPayPollTimeoutError } from "./errors.js";
import { AlphaPayCheckoutOptions, Http } from "./http.js";
import type {
  CheckoutSessionDetail,
  CreateCheckoutFromPaymentLinkParams,
  NetworksResult,
  OtpConfirmResult,
  PayParams,
  PayResult,
  PublicCheckoutResult,
  PublicPaymentLink,
  StatusResult,
} from "./types.js";

export interface PollStatusOptions {
  /** Intervalle entre deux appels à `getStatus()`, en ms (défaut 3000). */
  interval?: number;
  /** Délai total avant d'abandonner si aucun statut terminal n'est atteint, en ms (défaut 300000 = 5min). */
  timeout?: number;
  /** Annule le sondage en cours (ex. l'utilisateur quitte l'écran de paiement). */
  signal?: AbortSignal;
}

/**
 * Client de checkout hébergé AlphaPay — SANS clé secrète, conçu pour être
 * embarqué dans une app React Native (contrairement aux SDK Node/PHP/Python,
 * qui portent la clé API complète et ne doivent jamais tourner côté client).
 *
 * Le flux complet :
 * 1. Votre backend crée une session avec le SDK Node/PHP/Python
 *    (`client.checkoutSessions.create(...)`) et transmet le `slug` obtenu à
 *    l'app (jamais la clé API).
 * 2. L'app affiche le montant/les réseaux via `getSession`/`getNetworks`.
 * 3. Le client choisit un réseau et saisit son numéro → `pay`.
 * 4. Si `PayResult.otp_required`, collectez le code SMS et appelez `confirmOtp`.
 * 5. Sondez le paiement avec `pollStatus` jusqu'à un statut terminal.
 *
 * Chaque appel réseau ici porte le `slug` — 24 octets d'entropie généré
 * côté serveur — comme SEULE preuve d'autorisation (cf.
 * `apps.checkout.views.public._PublicCheckoutMixin`,
 * `authentication_classes = []` côté API). Ne journalisez/n'exposez jamais
 * un `slug` en dehors du flux de paiement qu'il représente.
 */
export class AlphaPayCheckout {
  private readonly http: Http;

  constructor(options: AlphaPayCheckoutOptions = {}) {
    this.http = new Http(options);
  }

  /** Données d'affichage de la page : montant, marchand, réseaux payables. */
  getSession(slug: string): Promise<CheckoutSessionDetail> {
    return this.http.request("GET", `/checkout/${slug}/`);
  }

  /**
   * Réseaux payables pour un pays donné — à appeler quand
   * `CheckoutSessionDetail.networks` est vide (la session n'impose pas de
   * pays, demandez-le d'abord au client).
   */
  getNetworks(slug: string, country: string): Promise<NetworksResult> {
    return this.http.request("GET", `/checkout/${slug}/networks/`, { query: { country } });
  }

  /**
   * Pousse le paiement (push USSD/mobile money direct, ou renvoie
   * `PayResult.payment_url` pour les rares réseaux à redirection).
   *
   * `idempotencyKey` est optionnelle : sans elle, l'API dérive elle-même une
   * clé depuis le slug + le contenu de la requête (cf.
   * `CheckoutSessionPayView.get_idempotency_key` côté API) — une
   * resoumission identique (double-tap, retry réseau) est donc déjà
   * protégée par défaut. Ne la fournissez explicitement que si vous voulez
   * distinguer vous-même deux tentatives qui auraient autrement le même payload.
   */
  pay(slug: string, params: PayParams, options: { idempotencyKey?: string } = {}): Promise<PayResult> {
    return this.http.request("POST", `/checkout/${slug}/pay/`, { body: params, idempotencyKey: options.idempotencyKey });
  }

  /** Un seul appel de statut — préférez `pollStatus` pour attendre une confirmation, ce endpoint seul ne fait qu'un instantané. */
  getStatus(slug: string): Promise<StatusResult> {
    return this.http.request("GET", `/checkout/${slug}/status/`);
  }

  /**
   * 2e étape pour les réseaux qui l'exigent (cf. `PayResult.otp_required`/
   * `NetworkOption.otp_required`) — le code que le client a reçu par SMS de
   * son opérateur après `pay`.
   */
  confirmOtp(slug: string, otp: string): Promise<OtpConfirmResult> {
    return this.http.request("POST", `/checkout/${slug}/confirm-otp/`, { body: { otp } });
  }

  /**
   * Sonde `getStatus` à intervalle régulier jusqu'à un statut terminal
   * (payé/échoué/expiré/annulé) ou jusqu'à `timeout`. Émet chaque résultat
   * intermédiaire (utile pour un indicateur "en attente de confirmation...")
   * puis se termine après avoir émis le résultat terminal — ne lève jamais
   * pour un simple statut PENDING persistant, seulement sur une vraie
   * erreur réseau/API ou si `timeout` est atteint sans statut terminal.
   *
   * ```ts
   * for await (const status of checkout.pollStatus(slug)) {
   *   console.log(status.status);
   *   if (isTerminal(status)) break;
   * }
   * ```
   *
   * Nécessite un moteur JS supportant les générateurs async (Hermes les
   * supporte nativement depuis RN 0.71) — sinon, appelez `getStatus` vous-même
   * dans un `setInterval`/hook `useEffect`.
   */
  async *pollStatus(slug: string, options: PollStatusOptions = {}): AsyncGenerator<StatusResult, void, void> {
    const interval = options.interval ?? 3_000;
    const timeout = options.timeout ?? 300_000;
    const deadline = Date.now() + timeout;

    while (true) {
      // Pas `signal.throwIfAborted()` — absent de certains polyfills
      // AbortController encore en circulation sur RN/Hermes plus anciens.
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Aborted");
      const status = await this.getStatus(slug);
      yield status;
      if (isTerminal(status)) return;
      if (Date.now() > deadline) {
        throw new AlphaPayPollTimeoutError(`Le paiement est resté PENDING au-delà de ${timeout}ms.`);
      }
      await sleep(interval, options.signal);
    }
  }

  /**
   * Consultation publique d'un lien de paiement (montant, champs
   * personnalisés à collecter, etc.) — `slug` fait office de capacité,
   * comme pour une session de checkout. Appelez ceci pour construire le
   * formulaire AVANT `createCheckoutFromPaymentLink`.
   */
  getPaymentLink(slug: string): Promise<PublicPaymentLink> {
    return this.http.request("GET", `/payment-links/public/${slug}/`);
  }

  /**
   * Crée une CheckoutSession one-shot à partir du lien (montant + identité
   * client) — un lien étant réutilisable, chaque appel en crée une NOUVELLE.
   * Ni pays ni réseau ici : ça se choisit ensuite sur la session renvoyée,
   * pilotable avec `getSession`/`getNetworks`/`pay` via `PublicCheckoutResult.slug`.
   */
  createCheckoutFromPaymentLink(slug: string, params: CreateCheckoutFromPaymentLinkParams): Promise<PublicCheckoutResult> {
    return this.http.request("POST", `/payment-links/public/${slug}/checkout/`, { body: params });
  }
}

/** true une fois `status.status` sorti de PENDING — plus la peine de sonder après ça. */
export function isTerminal(status: Pick<StatusResult, "status">): boolean {
  return status.status !== "PENDING";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
