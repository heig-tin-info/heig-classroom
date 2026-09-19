# ADR-008 — SPA React + Vite en front-end, composants headless accessibles, pas de SSR

## Statut

Acceptée (2026-07-03, phase 3).

## Contexte

Le portail est une application authentifiée (enseignant, étudiant) sans le moindre besoin de
référencement. Les vues en table doivent s'afficher en moins de 2 s pour 100 lignes (NFR-11).
L'interface est livrée en français, l'anglais pouvant être ajouté sans réécriture (NFR-14),
les dates en Europe/Zurich (C-02), et neuf critères WCAG 2.1 AA sont exigés sur les parcours
principaux (NFR-15).

## Décision

1. Une **SPA React 19 + Vite 7**, servie en fichiers statiques par le monolithe : aucun
   serveur front-end à exploiter, redéploiement trivial.
2. **TanStack Router + Query + Table** : cache et invalidation pilotés par les événements SSE
   (ADR-005), tables de 100 lignes sans agrégation à la volée.
3. **Radix UI (headless)** comme socle de composants : clavier, focus et ARIA couverts par
   construction — la conformité NFR-15 ne repose pas sur un effort continu.
4. **i18next** avec des chaînes externalisées (NFR-14) ; **Luxon** pour l'affichage
   Europe/Zurich (C-02).
5. Types partagés avec le backend et la CLI par les schémas Zod de
   `packages/contracts`.

## Conséquences

- Le front-end est un dossier de fichiers statiques versionné avec le backend : l'API du
  portail n'a pas besoin d'être versionnée (ils sont déployés ensemble).
- L'audit d'accessibilité de recette (axe-core, NFR-15) contrôle un socle déjà accessible au
  lieu de rattraper des composants faits maison.
- La reconnexion SSE est résolue par un refetch TanStack Query : aucun état temps réel
  dupliqué.

## Alternatives rejetées

1. **Next.js ou SSR** : aucun rendu serveur n'est nécessaire (le portail est derrière une
   authentification, le référencement est hors sujet) ; cela ajouterait un serveur front-end
   à exploiter et un couplage de déploiement.
2. **Composants d'interface faits maison** : un coût d'accessibilité récurrent et un risque
   permanent sur NFR-15 ; les trois propositions ont convergé vers un socle headless.
3. **Une configuration de monorepo Turborepo + pnpm à pipelines multiples** (proposition
   productivité) : six paquets et pipelines de construction pour un projet à un seul
   mainteneur ; les simples espaces de travail pnpm suffisent pour les trois paquets
   partagés.
