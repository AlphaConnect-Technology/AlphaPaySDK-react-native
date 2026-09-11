/**
 * Types alignés champ par champ sur les serializers réels d'AlphaPayBack
 * (`apps.checkout.serializers.public`), vérifiés contre le code source, pas
 * devinés depuis un nom d'endpoint. Contrairement au SDK Flutter, ce sont de
 * simples interfaces reflétant la forme JSON telle quelle (snake_case) — pas
 * de couche de parsing : le SDK Node fait le même choix pour ses ressources.
 */

/** PENDING / PAID / EXPIRED / CANCELLED / FAILED — cf. CheckoutStatus côté API. */
export type CheckoutStatus = "PENDING" | "PAID" | "EXPIRED" | "CANCELLED" | "FAILED";

/** Réponse de `GET /checkout/{slug}/` — ce que voit la page de paiement : jamais l'id interne du marchand ni ses métadonnées privées. */
export interface CheckoutSessionDetail {
  slug: string;
  merchant_name: string;
  amount: string;
  currency: string;
  description?: string | null;
  customer_email?: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  status: CheckoutStatus;
  expires_at?: string | null;
  /** false dès que `status` n'accepte plus de paiement (payée, expirée, annulée). */
  is_usable: boolean;
  /** Vide si la session n'impose pas de pays — appelez alors `getNetworks()` une fois le pays choisi par le client. */
  networks: NetworkOption[];
  /** Statut du dernier paiement tenté sur cette session, si un paiement est en cours (le client peut être reparti sur la page d'un fournisseur puis être revenu ici). */
  transaction_status?: string | null;
  payment_url?: string | null;
  return_url?: string | null;
}

/** Un réseau payable (MTN Bénin, Orange Money CI, carte...), avec son estimation de frais pour le montant de la session. */
export interface NetworkOption {
  /** Code réseau à passer tel quel à `pay()` (ex. "MTN_BJ"). */
  code: string;
  name: string;
  /**
   * true pour les réseaux exigeant un code généré par le client AVANT de
   * payer (ex. Orange Money CI/Burkina, #144*82#) — affichez
   * `otp_instructions` et collectez le code avant d'appeler `pay()` avec `otp`.
   */
  otp_required?: boolean;
  otp_instructions?: string | null;
  /** Frais estimés à la charge du client (0 en mode frais déduits du marchand) — absent si `unavailable`. */
  fee?: string | null;
  /** Montant total estimé que le client paiera — absent si `unavailable`. */
  total?: string | null;
  currency?: string | null;
  /** true si ce réseau n'a aucune règle de tarification active : le paiement y échouerait à coup sûr, ne le proposez pas. */
  unavailable?: boolean;
}

/** Réponse de `GET /checkout/{slug}/networks/?country=XX`. */
export interface NetworksResult {
  networks: NetworkOption[];
  /** Montant converti dans la devise de CE pays si elle diffère de celle de la session — affichez celui-ci, pas celui de `CheckoutSessionDetail.amount`. */
  amount: string;
  currency: string;
  /** true si la conversion a échoué (taux indisponible) — les réseaux non globaux (carte/crypto exceptés) sont alors marqués `unavailable`. */
  exchange_rate_error?: boolean;
}

/** Coordonnées du client final — optionnel si la session vient déjà d'un lien de paiement (déjà pré-remplies côté serveur), requis sinon. */
export interface CheckoutCustomer {
  email?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
}

/** Corps de `POST /checkout/{slug}/pay/`. */
export interface PayParams {
  /** Code réseau choisi, cf. `NetworkOption.code`. */
  network: string;
  /** Requis si la session n'impose pas déjà de pays (`CheckoutSessionDetail.networks` vide à l'origine). */
  country?: string;
  customer?: CheckoutCustomer;
  /** Code généré par le client sur son mobile AVANT de payer — cf. `NetworkOption.otp_required`. */
  otp?: string;
}

/** Réponse de `POST /checkout/{slug}/pay/`. */
export interface PayResult {
  message: string;
  transaction_id: string;
  status: string;
  /**
   * Non-vide UNIQUEMENT si l'opérateur impose une redirection (Wave, Orange
   * QR, Djamo, carte 3DS) — jamais une page brandée de gateway. Vide/absent
   * pour tous les réseaux à push USSD direct (MTN, Moov, Celtiis...).
   */
  payment_url?: string | null;
  /** true pour Coris Bénin/Wizall Sénégal notamment — appelez `confirmOtp()` avec le code reçu par SMS au lieu d'attendre/sonder `getStatus()`. */
  otp_required?: boolean;
  /** Consigne à afficher au client MAINTENANT (composer un code USSD, etc.) — forme libre, peut être vide. */
  instructions?: unknown;
}

/** Réponse de `GET /checkout/{slug}/status/` — à sonder après `pay()` jusqu'à un statut terminal (cf. `pollStatus()`). */
export interface StatusResult {
  slug: string;
  /** PENDING / PAID / EXPIRED / CANCELLED / FAILED. */
  status: CheckoutStatus;
  amount: string;
  currency: string;
  transaction_status?: string | null;
  transaction_id?: string | null;
  transaction_reference?: string | null;
  return_url?: string | null;
  otp_required?: boolean;
  instructions?: unknown;
  payment_url?: string | null;
}

/** Réponse de `POST /checkout/{slug}/confirm-otp/`. */
export interface OtpConfirmResult {
  transaction_id: string;
  status: string;
}
