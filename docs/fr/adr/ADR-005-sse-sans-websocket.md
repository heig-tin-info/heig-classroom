# ADR-005 — SSE plutôt que WebSocket, sans rejeu `Last-Event-ID`

## Statut

Acceptée (2026-07-03, phase 3).

## Contexte

Le portail pousse les statuts CI, les notes et les notifications en temps réel (GR-10, NT-01). Le
flux est strictement unidirectionnel, du serveur vers le navigateur : le canal montant existe déjà (REST).
Aucune exigence fonctionnelle ne dépend du temps réel — c'est un confort d'affichage.

## Décision

1. **Server-Sent Events** sur `GET /app/events` (cookie de session requis, le même schéma
   d'authentification AU-06 que le portail, hors de la surface `/api/v1` réservée à l'API par clé).
2. Filtrage d'autorisation côté serveur : un étudiant ne reçoit que les événements de ses
   propres dépôts (AU-26).
3. **Pas de rejeu `Last-Event-ID`** ni de tampon circulaire : à la (re)connexion, le front end rejoue
   ses requêtes TanStack Query — il n'y a aucun état de reprise à maintenir sur le serveur.
4. Un battement de cœur `:ping` toutes les 25 s ; `flush_interval -1` sur la route dans Caddy.
   Dégradation : sans SSE, un refetch périodique de 30 s.

## Conséquences

- Du HTTP simple : cookies réutilisés tels quels, reconnexion `EventSource` native, testable avec `curl`,
  aucune bibliothèque cliente ou serveur dédiée.
- Perdre un événement SSE n'est jamais perdre une donnée : la vérité est dans la base de données et le refetch
  la ramène.
- Environ 200 connexions simultanées au maximum : trivial pour un processus Node unique. Si un découpage
  `WORKER_MODE` devait survenir (ADR-001), le relais interne passerait par `LISTEN/NOTIFY` de
  Postgres.

## Alternatives rejetées

1. **WebSocket** : cela n'apporterait qu'une bidirectionnalité inutile, une bibliothèque serveur, une gestion
   de ping-pong et une authentification dédiée — du code d'exploitation pour rien.
2. **SSE avec rejeu `Last-Event-ID` et tampon circulaire** (propositions productivité et robustesse) :
   plus fin, mais cela introduit un état serveur et un chemin de resynchronisation qui peut
   diverger du refetch ; la revue a conservé la variante sans état, dont la dégradation naturelle
   est l'interrogation périodique simple.
3. **Interrogation périodique pure** : fonctionnelle, mais elle dégrade la réactivité perçue (la NFR-12 vise
   moins de 2 min entre la fin d'une exécution et une note visible) et multiplie les requêtes inutiles.
