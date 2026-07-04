# ADR-005 — SSE plutôt que WebSocket, sans replay `Last-Event-ID`

## Statut

Accepté (2026-07-03, phase 3).

## Contexte

Le portail pousse en temps réel les statuts CI, les notes et les notifications (GR-10,
NT-01). Le flux est strictement unidirectionnel serveur vers navigateur : le canal montant
existe déjà (REST). Aucune exigence fonctionnelle ne dépend du temps réel — c'est un confort
d'affichage.

## Décision

1. **Server-Sent Events** sur `GET /app/events` (session cookie requise, même plan d'auth
   AU-06 que le portail, hors de la surface `/api/v1` réservée à l'API à clé).
2. Filtrage par autorisation côté serveur : un student ne reçoit que les événements de ses
   propres dépôts (AU-26).
3. **Pas de replay `Last-Event-ID`** ni de ring buffer : à la (re)connexion, le front réémet
   ses requêtes TanStack Query — l'état de reprise à maintenir côté serveur est nul.
4. Heartbeat `:ping` toutes les 25 s ; `flush_interval -1` sur la route dans Caddy.
   Dégradation : sans SSE, refetch périodique 30 s.

## Conséquences

- HTTP simple : cookies réutilisés tels quels, reconnexion native `EventSource`, testable au
  `curl`, aucune bibliothèque cliente ni serveur dédiée.
- La perte d'un événement SSE n'est jamais une perte de donnée : la vérité est en base et le
  refetch la restitue.
- Environ 200 connexions simultanées au maximum : trivial pour un processus Node. En cas de
  scission `WORKER_MODE` (ADR-001), le relais interne passe par `LISTEN/NOTIFY` Postgres.

## Alternatives rejetées

1. **WebSocket** : n'apporterait que du bidirectionnel inutile, une bibliothèque serveur,
   une gestion de ping-pong et d'authentification dédiée — du code d'exploitation pour rien.
2. **SSE avec replay `Last-Event-ID` et ring buffer** (propositions productivité et
   robustesse) : plus fin, mais introduit un état serveur et un chemin de resynchronisation
   qui peuvent diverger du refetch ; la revue a retenu la variante sans état, dont la
   dégradation naturelle est un simple polling.
3. **Polling pur** : fonctionnel mais dégrade la réactivité perçue (NFR-12 vise moins de
   2 min entre fin de run et note visible) et multiplie les requêtes inutiles.
