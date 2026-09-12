# Avant publication npm

Ce SDK est maintenant compilé et testé (`npm install && npm run typecheck
&& npm test && npm run build` — tous passent : `tsc --noEmit` propre, 6/6
tests `node:test` verts, build tsup ESM+CJS+d.ts sans erreur). Reste avant
`npm publish` :

## Bloquant

- [ ] **Tester contre une vraie session de checkout** (créée avec le SDK
      Node/PHP/Python) sur `api.alphapay.me` — comme pour les 4 autres SDK,
      aucun n'a d'endpoint de checkout PUBLIC testé en conditions réelles
      pour l'instant.
- [ ] **Tester dans une vraie app React Native** (Hermes iOS + Android, pas
      seulement Node) — en particulier `pollStatus()` (générateur async :
      Hermes le supporte nativement depuis RN 0.71, à confirmer sur les
      versions RN réellement ciblées par les intégrateurs) et
      `AbortController`/`fetch` (globaux RN, pas de polyfill ajouté ici en
      partant du principe qu'ils sont déjà fournis par le runtime — à
      vérifier sur les versions RN plus anciennes qui pourraient exiger
      `whatwg-fetch`/`abort-controller`).
- [ ] Choisir le nom de package npm définitif (`@alphapay/react-native` est
      provisoire, comme `@alphapay/node`).
- [ ] `npm audit` (pas lancé) sur les 51 paquets installés (`tsup`,
      `typescript`, `@types/node` et leurs dépendances transitives).

## Souhaitable avant v1.0.0

- [ ] Exemple d'app RN complète (`example/`) avec un écran de paiement réel
      (formulaire réseau/numéro, WebView pour les réseaux à redirection,
      indicateur de polling, gestion des erreurs) — ce SDK n'expose que la
      couche client API, pas de composants UI (même choix que le SDK
      Flutter : "pas de widgets").
- [ ] CI (GitHub Actions) : `typecheck` + `test` + `build` sur chaque PR, et
      idéalement un job Detox/Maestro contre une vraie app RN pour couvrir ce
      qu'un test Node seul ne peut pas (Hermes réel, polyfills RN réels).
- [ ] Vérifier si RN impose des contraintes supplémentaires sur `exports`
      dans `package.json` selon la version de Metro ciblée (le resolver
      `package.json:exports` n'est activé par défaut que depuis Metro/RN
      0.72+ — documenter le minimum RN supporté si un projet plus ancien a
      besoin d'un champ `main` CJS pur en repli).

## Fait

- [x] Endpoints publics de checkout retracés depuis le SDK Flutter
      (`../AlphaPaySDK-flutter`), lui-même vérifié champ par champ contre le
      code source réel d'AlphaPayBack (`apps.checkout.views.public`,
      `apps.checkout.serializers.public`) — mêmes endpoints, mêmes formes de
      requête/réponse, pas redevinés depuis les noms.
- [x] Architecture volontairement SANS clé API secrète — ce SDK ne peut
      physiquement pas exposer un secret marchand, même conception que le
      SDK Flutter.
- [x] Enveloppe `{success, data, code}` déballée, `http.ts`/`errors.ts` bâtis
      sur les mêmes fondations que `AlphaPaySDK-node` (Bearer en moins) :
      retries avec backoff sur 429/5xx/erreur réseau, timeout configurable
      via `AbortController`, erreurs typées.
- [x] Deux erreurs propres à ce flux, absentes du SDK Node (qui n'a pas de
      notion de session one-shot côté client) : `AlphaPayConflictError` (409
      `payment_already_pending`) et `AlphaPaySessionGoneError` (410) —
      équivalent TS de `AlphaPayConflictException`/`AlphaPaySessionGoneException`
      côté Flutter.
- [x] `pollStatus()` — générateur async (`for await`) sondant jusqu'à statut
      terminal, avec `AbortSignal` pour l'annulation (ex. l'utilisateur
      quitte l'écran) — équivalent TS du `Stream<StatusResult>` Flutter.
- [x] 6 tests (`node:test`, `fetch` injecté) couvrant l'enveloppe, l'absence
      totale de header d'auth, les 2 erreurs propres à ce flux, le retry 429,
      et `pollStatus` — repris un à un des 6 tests Dart du SDK Flutter,
      **exécutés avec succès (6/6 verts)**.
- [x] `npm run typecheck` (`tsc --noEmit`) : aucune erreur.
- [x] `npm run build` (tsup) : ESM + CJS + `.d.ts`/`.d.cts` générés sans erreur.
- [x] 2026-09-12 — synchronisé avec le SDK PHP (commit "Add public payment
      link features") et le SDK Flutter jumeau : `getPaymentLink()`/
      `createCheckoutFromPaymentLink()` (page publique d'un lien de paiement
      -> CheckoutSession one-shot, `PublicPaymentLink`/`PublicCheckoutResult`/
      `PaymentLinkCustomField`/`CreateCheckoutFromPaymentLinkParams` dans
      `types.ts`), et corrigé la même casse de code réseau erronée que les
      SDK PHP/Flutter (`"MTN_BJ"` -> `"mtn_bj"`, README + tests + docblock
      `NetworkOption.code`). 2 tests ajoutés (8 au total), tous verts.
      `typecheck`/`test`/`build` exécutés avec succès après ces changements.
