# ADR-008 — Frontend SPA React + Vite, composants headless accessibles, sans SSR

## Statut

Accepté (2026-07-03, phase 3).

## Contexte

Le portail est une application authentifiée (teacher, student) sans aucun besoin de SEO.
Les vues tableau doivent s'afficher en moins de 2 s à 100 lignes (NFR-11). L'interface est
livrée en français avec l'anglais ajoutable sans refonte (NFR-14), les dates en
Europe/Zurich (C-02), et neuf critères WCAG 2.1 AA sont exigés sur les parcours principaux
(NFR-15).

## Décision

1. **SPA React 19 + Vite 7**, servie en fichiers statiques par le monolithe : aucun serveur
   front à exploiter, redéploiement trivial.
2. **TanStack Router + Query + Table** : cache et invalidation pilotés par les événements
   SSE (ADR-005), tableaux de 100 lignes sans agrégation à la volée.
3. **Radix UI (headless)** comme socle de composants : clavier, focus et ARIA couverts par
   construction — la conformité NFR-15 ne repose pas sur un effort continu.
4. **i18next** avec chaînes externalisées (NFR-14) ; **Luxon** pour l'affichage
   Europe/Zurich (C-02).
5. Types partagés avec le backend et le CLI via les schémas Zod de `packages/contracts`.

## Conséquences

- Le front est un dossier de fichiers statiques versionné avec le backend : l'API portail
  n'a pas besoin d'être versionnée (déployés ensemble).
- L'audit d'accessibilité de recette (axe-core, NFR-15) vérifie un socle déjà accessible au
  lieu de rattraper des composants maison.
- La reconnexion SSE se résout par refetch TanStack Query : aucun état temps réel dupliqué.

## Alternatives rejetées

1. **Next.js ou SSR** : aucun rendu serveur nécessaire (portail derrière login, SEO sans
   objet) ; ajouterait un serveur front à exploiter et un couplage de déploiement.
2. **Composants UI maison** : coût d'accessibilité récurrent, risque permanent sur NFR-15 ;
   les trois propositions convergeaient vers un socle headless.
3. **Monorepo outillé Turborepo + pnpm multi-pipelines** (proposition productivité) : six
   paquets et des pipelines de build pour un projet à un mainteneur ; les workspaces pnpm
   simples suffisent aux trois paquets partagés.
