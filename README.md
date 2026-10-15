# @alphapay/react-native

SDK React Native / TypeScript officiel pour les sessions de checkout hébergé
AlphaPay.

> **Statut : v0.1.0, non publié.**

**TypeScript pur, aucune dépendance native** — repose uniquement sur le
`fetch`/`AbortController` global que React Native fournit nativement depuis
un bon moment ; fonctionne donc aussi bien dans une app RN (iOS/Android) que
dans du code web ou Node ≥18. `react-native` n'est déclaré qu'en
`peerDependency` optionnelle : ce paquet n'importe jamais `react-native`
lui-même, comme `alphapay_checkout` (Flutter) est du Dart pur sans
dépendance Flutter.

## ⚠️ Ce SDK est fondamentalement différent des SDK Node.js/PHP/Python

Ce paquet **ne prend jamais de clé API secrète** — c'est un client
volontairement limité aux endpoints publics de paiement
(`/checkout/{slug}/*`, `authentication_classes = []` côté API, cf.
`apps.checkout.views.public._PublicCheckoutMixin`), fait pour tourner
**côté client** (app mobile) sans jamais exposer de secret. C'est
l'équivalent TypeScript exact du [SDK Flutter](../AlphaPaySDK-flutter) —
mêmes endpoints, même modèle de sécurité, même absence d'auth.

Le flux complet, en 2 parties :

1. **Côté serveur** (votre backend), avec le
   [SDK Node.js](../AlphaPaySDK-node), [PHP](../AlphaPaySDK-php) ou
   [Python](../AlphaPaySDK-python) — qui, eux, portent la clé secrète :
   ```ts
   const session = await alphapay.checkoutSessions.create({
     amount: 5000, currency: "XOF",
     customer_email: "client@exemple.com", customer_name: "Client",
   });
   // Transmettez UNIQUEMENT session.slug à l'app (jamais la clé API).
   ```
2. **Côté app**, avec ce paquet — aucun secret, seul le `slug` suffit :
   ```ts
   import { AlphaPayCheckout } from "@alphapay/react-native";

   const checkout = new AlphaPayCheckout();
   const session = await checkout.getSession(slug);
   ```

**Ne mettez jamais une clé `sk_live_.../sk_test_...` dans le bundle d'une
app mobile** — n'importe qui peut l'extraire de l'APK/IPA. Le `slug` d'une
session de checkout (24 octets d'entropie, à usage unique) est conçu pour
être exposé côté client ; une clé API secrète ne l'est pas.

## Installation

```bash
npm install @alphapay/react-native
# ou
yarn add @alphapay/react-native
```

## Démarrage rapide

```ts
import { AlphaPayCheckout, isTerminal } from "@alphapay/react-native";

const checkout = new AlphaPayCheckout();

// 1. Affiche le montant et les réseaux payables.
const session = await checkout.getSession(slug);
console.log(`${session.amount} ${session.currency} chez ${session.merchant_name}`);

// 2. Si la session n'impose pas de pays, demandez-le et rechargez les réseaux.
const networks = session.networks.length > 0
  ? session.networks
  : (await checkout.getNetworks(slug, "BJ")).networks;

// 3. Le client choisit un réseau et saisit son numéro.
const result = await checkout.pay(slug, {
  network: "mtn_bj",
  customer: { phone: "+22900000000", first_name: "Ayaba" },
});

// 4. Si un OTP est requis (Coris Bénin, Wizall Sénégal...), collectez-le et confirmez.
if (result.otp_required) {
  await checkout.confirmOtp(slug, "123456");
}

// 5. Sondez jusqu'à confirmation.
for await (const status of checkout.pollStatus(slug)) {
  console.log(status.status); // PENDING, puis PAID/FAILED/EXPIRED/CANCELLED
  if (isTerminal(status)) break;
}
```

### Dans un composant (exemple `useEffect` minimal)

```tsx
import { useEffect, useRef, useState } from "react";
import { AlphaPayCheckout, isTerminal, type StatusResult } from "@alphapay/react-native";

function usePaymentStatus(slug: string) {
  const [status, setStatus] = useState<StatusResult | null>(null);
  const checkoutRef = useRef(new AlphaPayCheckout());

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        for await (const s of checkoutRef.current.pollStatus(slug, { signal: controller.signal })) {
          setStatus(s);
          if (isTerminal(s)) break;
        }
      } catch (err) {
        if (!controller.signal.aborted) throw err;
      }
    })();
    return () => controller.abort();
  }, [slug]);

  return status;
}
```

## Réseaux à redirection (Wave, Orange QR, Djamo, carte 3DS)

`PayResult.payment_url`/`StatusResult.payment_url` n'est non-vide que pour
les rares réseaux qui imposent une redirection plutôt qu'un push USSD
direct. Ouvrez-le dans une `WebView` (`react-native-webview`) ou via
`Linking.openURL` — jamais une page brandée AlphaPay, toujours celle du
fournisseur. Le client revient ensuite sur `return_url` : rechargez alors
`getStatus`/`pollStatus`, la session peut déjà avoir un paiement en vol.

## Gestion des erreurs

```ts
import {
  AlphaPayConflictError,
  AlphaPaySessionGoneError,
  AlphaPayValidationError,
  AlphaPayError,
} from "@alphapay/react-native";

try {
  await checkout.pay(slug, { network: "mtn_bj", customer });
} catch (err) {
  if (err instanceof AlphaPaySessionGoneError) {
    // 410 — session déjà payée/expirée/annulée. err.code = "paid"/"expired"/"cancelled".
  } else if (err instanceof AlphaPayConflictError) {
    // 409, err.code === "payment_already_pending" — un paiement est déjà en vol sur cette session.
  } else if (err instanceof AlphaPayValidationError) {
    console.log(err.fieldErrors); // erreurs de validation par champ, si applicable
  } else if (err instanceof AlphaPayError) {
    console.log(`${err.status} ${err.code}: ${err.message}`);
  }
}
```

Le client retente automatiquement (backoff exponentiel + gigue) sur
429/5xx/erreur réseau — 2 tentatives supplémentaires par défaut,
configurable via `maxRetries`.

## Réseaux nécessitant un OTP pré-paiement

Certains réseaux (Orange Money Côte d'Ivoire/Burkina notamment) exigent que
le client génère un code USSD **avant** de payer. Vérifiez
`NetworkOption.otp_required`/`otp_instructions` avant d'afficher le champ
numéro, et transmettez le code via le paramètre `otp` de `pay()`
directement — ce n'est pas la même chose que `confirmOtp()` (utilisé, lui,
pour les réseaux qui confirment APRÈS le push initial).

## Lien de paiement : de la page publique à la session de checkout

Un lien de paiement (créé côté serveur avec le SDK Node/PHP/Python) a sa
propre page publique, elle aussi sans clé secrète. `createCheckoutFromPaymentLink`
crée une CheckoutSession one-shot à partir du lien : son `slug` se pilote
ensuite exactement comme au [Démarrage rapide](#démarrage-rapide) ci-dessus.

```ts
const link = await checkout.getPaymentLink(linkSlug);
console.log(`${link.amount ?? "montant libre"} ${link.currency} chez ${link.merchant_name}`);

const result = await checkout.createCheckoutFromPaymentLink(linkSlug, {
  customer: { email: "client@exemple.com", first_name: "Ayaba" },
  amount: link.amount_type === "FREE" ? "5000" : undefined, // requis seulement si montant libre
  custom_field_values: { reference_client: "CMD-42" },
});

const session = await checkout.getSession(result.slug); // même flux que ci-dessus à partir d'ici
```

## Endpoints couverts

| Méthode | Endpoint | Description |
|---|---|---|
| `getSession(slug)` | `GET /checkout/{slug}/` | Détails d'affichage |
| `getNetworks(slug, country)` | `GET /checkout/{slug}/networks/` | Réseaux payables pour un pays |
| `pay(slug, params)` | `POST /checkout/{slug}/pay/` | Initie le paiement |
| `getStatus(slug)` | `GET /checkout/{slug}/status/` | Un instantané du statut |
| `pollStatus(slug, options)` | (sonde `getStatus` en boucle) | Attend un statut terminal |
| `confirmOtp(slug, otp)` | `POST /checkout/{slug}/confirm-otp/` | 2e étape pour les réseaux qui l'exigent |
| `getPaymentLink(slug)` | `GET /payment-links/public/{slug}/` | Détails publics d'un lien de paiement |
| `createCheckoutFromPaymentLink(slug, params)` | `POST /payment-links/public/{slug}/checkout/` | Crée une CheckoutSession à partir du lien |

Pas couvert par design : tout endpoint marchand nécessitant la clé API
secrète (créer/lister un lien de paiement, `/transactions/`, etc.) — ça
appartient aux SDK Node/PHP/Python, jamais à un client embarqué dans une app.

## Options du client

```ts
new AlphaPayCheckout({
  baseUrl: "https://api.alphapay.me/api/v1", // défaut — override dev/self-hosted uniquement
  timeout: 30_000,                            // ms avant abandon d'une requête
  maxRetries: 2,                              // tentatives supplémentaires sur 429/5xx/réseau
  fetch: myFetch,                             // injection pour les tests
});
```

## Développement

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Licence

MIT
