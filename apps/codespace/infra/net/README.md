# infra/net — réseau clos `codespace` (jalon 0, tâche P2)

Trois scripts et deux fichiers de règles :

| fichier | rôle |
| --- | --- |
| `common.sh` | constantes partagées + la fonction `pd()` (`podman --remote --url unix:///run/podman/podman.sock`) |
| `setup.sh` | crée le réseau, démarre l'ancrage, charge les tables nft. Idempotent. `sudo` requis pour la partie nft |
| `teardown.sh` | supprime tables, ancrage, réseau |
| `test.sh` | assertions d'acceptation P2 (`PASS` / `FAIL` / `BLOQUÉ`), sort non nul s'il y a un `FAIL` |
| `../nft/codespace.nft` | les deux règles fixes, famille `inet` |
| `../nft/codespace-bridge.nft` | la même règle ICC en famille `bridge`, défense en profondeur, optionnelle |

## Décision : conteneur d'ancrage, pas de liaison sur 0.0.0.0

Avec netavark, le pont d'un réseau Podman n'existe que tant qu'un conteneur y
est attaché : il est créé au premier `podman run --network codespace` et
**supprimé** au départ du dernier conteneur (vérifié le 2026-09-17 : `ip addr
show dev cs0` passe de `10.77.0.254/24` à « Device does not exist » après le
`podman rm` du dernier conteneur). Le portail, lui, doit se lier à
`10.77.0.254:9418` pour offrir le canal Git, et il démarre avant toute session.
Deux issues : maintenir en permanence un conteneur sur le réseau pour que le
pont et son adresse existent, ou lier le serveur Git sur `0.0.0.0` et compter
sur un filtrage applicatif plus nftables pour qu'il ne réponde que sur le pont.

La seconde issue est écartée parce qu'elle détruit la défense en profondeur que
demande explicitement analyse.md §4.1 : « la surface Git écoute **seulement**
sur l'IP du pont […] et une règle nftables `input` sur le pont ne laisse passer
que le port Git. Les deux, parce qu'une liaison d'adresse se casse par une
variable d'environnement ». Lier `0.0.0.0` inverse l'argument : le port 9418
devient exposé sur toutes les interfaces de l'hôte (en WSL, l'interface vers
l'hôte Windows et donc le réseau de l'école), et la règle nft devient l'unique
barrière au lieu d'être la seconde ; il faudrait en plus lui ajouter une règle
« refuser 9418 partout sauf sur cs0 », c'est-à-dire plus de surface nft pour
moins de sûreté. Le coût de l'ancrage est au contraire dérisoire : un
`alpine:3.20` en `sleep infinity`, 32 Mio de limite mémoire, 16 processus,
capacités nulles, racine en lecture seule, sur un réseau où la règle ICC
l'empêche de toute façon de parler aux conteneurs des étudiants. Il rend aussi
le nom d'interface `cs0` et l'adresse `10.77.0.254` permanents, ce dont
dépendent toutes les règles nft. **Décision : ancrage**, créé et relancé par
`setup.sh`, nommé `codespace-anchor`, marqué `heig-codespace.role=anchor`.

Conséquences à respecter ailleurs : le ramasse-miettes de sessions
(`src/sessions/`) doit ignorer les conteneurs portant ce label ;
la réconciliation ne doit pas le prendre pour une session orpheline ;
`teardown.sh` est le seul endroit qui le supprime. `--restart always` est posé,
mais il ne suffit pas après un redémarrage de l'hôte si
`podman-restart.service` n'est pas activé : `setup.sh` au démarrage est le
mécanisme normal.

## Cohabitation avec netavark

netavark pose ses propres chaînes dans `table inet netavark` (priorité `filter`,
0). Nos deux chaînes de base sont dans `table inet codespace` à la priorité
`filter - 10` : elles voient le paquet en premier. Ce n'est pas ce qui rend les
règles correctes — dans nftables un `drop` dans n'importe quelle chaîne d'un
hook est terminal pour le paquet, tandis qu'un `accept` n'est terminal que dans
sa propre chaîne — mais ça évite de dépendre de l'ordre de chargement.

Les deux chaînes ont `policy accept` et toutes leurs règles sont gardées par
`iifname "cs0"` / `oifname "cs0"`. Le pont `podman` par défaut, le réseau
`infra_default` de `compose.dev.yml` (Keycloak, Forgejo) et tout autre réseau
Podman ne sont donc jamais touchés. `teardown.sh` ne supprime que les tables
nommées `codespace`.

TODO(verify) netavark 1.x / nftables 1.1.6 : relire `sudo nft list table inet
netavark` une fois `setup.sh` passé et confirmer la priorité 0 ; la lecture du
ruleset demande root, elle n'a pas pu être faite au moment de l'écriture.

## Famille `bridge` indisponible sur ce noyau : équivalent retenu

analyse.md D1 prescrit la règle ICC en famille `bridge` avec `meta ibrname`.
Mesuré sur ce poste (noyau WSL2 `6.18.33.2-microsoft-standard`) : la famille
`bridge` n'existe pas. `nf_tables_bridge.ko` est absent de
`/lib/modules/$(uname -r)` comme de `modules.builtin`, et
`modinfo nf_tables_bridge` répond « Module not found » ; seuls les anciens
modules `ebt_*` sont là. Une table `bridge` passe l'analyseur de `nft` puis est
refusée par le noyau au chargement.

Équivalent implémenté, dans `codespace.nft` : `br_netfilter` fait traverser les
paquets IP pontés par les hooks IP ordinaires, avec `iifname`/`oifname` égaux
au pont (le port veth n'est visible que par le match `physdev`). La règle
`iifname "cs0" oifname "cs0" drop` en `inet`/`forward` est exactement le
mécanisme de `docker --icc=false`. `setup.sh` charge le module et force
`net.bridge.bridge-nf-call-iptables=1` et `-ip6tables=1`, sans quoi la règle
serait silencieusement inopérante. `codespace-bridge.nft` garde la variante
famille `bridge` : `setup.sh` la charge en plus si le noyau la supporte (une VM
Ubuntu ordinaire), et se contente de la table `inet` sinon. Elle n'est jamais
nécessaire pour que le test soit vert.

Le trafic hôte ↔ conteneur ne passe pas par `forward` (l'adresse `10.77.0.254`
est portée par `cs0`, donc c'est de l'input/output local) : la règle ICC ne
coupe pas le proxy du portail vers code-server. `test.sh` le vérifie
explicitement.

### IPv6 lien-local : trou réel, couvert par la même règle

Les conteneurs reçoivent une adresse `fe80::/64` même sur un réseau sans IPv6.
Vérifié le 2026-09-17 : `wget http://[fe80::…%eth0]:8080/` d'un conteneur vers
l'autre **réussit** tant que la règle ICC n'est pas posée. La famille `inet`
couvre IPv4 et IPv6, donc la règle unique suffit — à condition que
`bridge-nf-call-ip6tables` vaille 1, ce que `setup.sh` impose. `test.sh` a une
assertion supplémentaire pour ça, hors liste jalon-0.

## Repli si la règle ICC se révèle inopérante

jalon-0 P2 autorise un repli et fixe le budget : pas plus d'une demi-journée sur
la règle. Repli : **un réseau Podman `internal` par session**, c'est-à-dire
`podman network create --internal --disable-dns --subnet 10.77.<n>.0/24
--gateway 10.77.<n>.254 --interface-name cs<n> codespace-<sessionId>`, créé au
démarrage de la session et détruit à son arrêt. Deux étudiants ne sont alors
jamais sur le même pont et l'isolation ne dépend plus d'aucune règle de
filtrage. Ce que ça coûte : la règle `input` reste indispensable et devient
dépendante de la session (un `iifname` par pont), ce qui viole « aucune règle
par session » de l'invariant 2 — il faudrait la réécrire en `iifname "cs*"`
(joker de nom d'interface, supporté par nftables) pour rester fixe ; il faut un
plan d'adressage `/24` par session et donc un plafond de sessions simultanées ;
la création/destruction de réseau s'ajoute au temps de démarrage d'une session
et à la réconciliation après un crash du portail ; et le conteneur d'ancrage
devient inutile pour les sessions mais reste nécessaire pour le pont sur lequel
le portail écoute. Une variante intermédiaire, non retenue faute de pouvoir la
tester sans root, serait l'isolation de port du pont Linux lui-même
(`bridge link set dev <veth> isolated on`), qui bloque le trafic entre ports
isolés sans nftables — mais elle est par définition posée par session, sur un
nom de veth instable, et demanderait un greffon netavark.

## État : exécuté / reste à exécuter

Exécuté sans root le 2026-09-17, sur ce poste :

- réseau `codespace` créé conforme : `--internal --disable-dns --subnet
  10.77.0.0/24 --gateway 10.77.0.254 --interface-name cs0` (l'option
  `--interface-name` existe bien dans Podman 5.7) ;
- ancrage `codespace-anchor` démarré, `cs0` porte `10.77.0.254` en permanence ;
- `test.sh` : 6 `PASS`, 0 `FAIL`, 5 `BLOQUÉ`. Les six assertions qui ne
  dépendent pas de nftables sont vertes.

Reste à exécuter, une seule fois, par quelqu'un qui a le mot de passe :

```bash
sudo /home/ycr/heig-codespace/infra/net/setup.sh
sudo /home/ycr/heig-codespace/infra/net/test.sh
```

`test.sh` lancé sans root ne peut pas lire le ruleset nftables ; il ne prétend
donc pas connaître l'état de la table et marque `BLOQUÉ` (jamais `FAIL`) les
assertions qui en dépendent. Une assertion qui **passe** reste une preuve : le
comportement observé suffit. Seules les deux régressions (retirer chaque règle
et vérifier que l'assertion correspondante tombe) exigent root de bout en bout,
puisqu'elles rechargent la table.

Le fichier `codespace.nft` a été validé par `nft -c -f` au sens de l'analyse
lexicale et grammaticale seulement : sur ce poste `nft -c` initialise quand même
le cache netlink et échoue avec « Operation not permitted » avant de contacter
le noyau. Un fichier fautif donne en plus une erreur de syntaxe, un fichier
correct donne uniquement l'erreur netlink — c'est ce qu'on observe.
TODO(verify) nftables 1.1.6 : refaire `sudo nft -c -f infra/nft/codespace.nft`
pour une validation complète, et `sudo nft list ruleset` pour l'inspection.
