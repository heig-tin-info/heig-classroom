# Dépendances et le piège du lockfile Dependabot

## Pourquoi les pull requests npm de Dependabot échouent en intégration continue

Chaque pull request npm de Dependabot arrive rouge dans ce dépôt, et toujours
sur la même erreur, quel que soit le paquet qu'elle met à jour :

```
ERR_PNPM_MISSING_TARBALL_INTEGRITY  Cannot install package
"xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz":
its lockfile entry has no "integrity" field, so pnpm cannot verify the
downloaded tarball.
```

`apps/web` dépend de SheetJS par URL, et non par version :

```json
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

SheetJS a cessé de publier `xlsx` sur le registre npm après la 0.18.5 : le CDN
de l'éditeur est donc la distribution officielle. Ce spécificateur n'a rien
d'anormal — le problème est ce qu'il devient en passant par Dependabot.

pnpm ne peut inscrire l'`integrity` d'une archive servie par URL que s'il la
**télécharge** et la hache. Résoudre ne suffit pas : `pnpm install
--lockfile-only` écrit lui aussi l'entrée sans `integrity`, si bien qu'il s'agit
moins d'un défaut de Dependabot que d'une conséquence de sa façon de régénérer
le lockfile. L'entrée correcte, celle de `main`, ressemble à ceci :

```yaml
xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz:
  resolution: {integrity: sha512-oLDq3jw7…, tarball: https://cdn.sheetjs.com/…}
```

et ce qui revient de Dependabot a perdu le premier champ.

Cet échec fait son travail. pnpm refuse d'installer une archive non vérifiée
provenant d'un hôte extérieur au registre, ce qui est exactement ce que l'on
attend d'un gestionnaire de paquets. Ne le faites pas taire, et ne cédez pas à
la tentation du `--no-frozen-lockfile` en intégration continue : tout l'intérêt
du lockfile épinglé est que l'image de production installe les octets qui ont
été testés.

## Réparer une mise à jour Dependabot

Ne réparez pas le lockfile de Dependabot. Jetez-le et refaites la mise à jour
par-dessus celui dont on sait qu'il est sain, ce qui conserve à l'identique
chaque entrée intacte — `integrity` comprise :

```bash
git checkout -b chore/<ce-que-vous-mettez-a-jour> origin/main
# modifier les versions à la main dans les fichiers package.json
pnpm install                      # PAS --lockfile-only : il doit télécharger pour hacher
grep -A1 '^  xlsx@https' pnpm-lock.yaml     # l'integrity doit toujours être là
pnpm install --frozen-lockfile    # ce que fait l'intégration continue ; doit passer
pnpm build && pnpm typecheck && pnpm test
```

Fermez ensuite la pull request de Dependabot comme remplacée, pour qu'elle ne
traîne pas et ne soit pas fusionnée par erreur plus tard.

S'il vous faut un jour recalculer l'`integrity` de zéro, c'est le SHA-512 de
l'archive en base64, et vous pouvez le confronter au lockfile sans faire
confiance à personne :

```bash
curl -sSL https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz \
  | openssl dgst -sha512 -binary | openssl base64 -A
```

## Avant de fusionner une dépendance du serveur

Une suite verte ne suffit pas, à elle seule, à valider la mise à jour d'un
composant qui sert du trafic de production. Vérifiez ce que les tests
atteignent réellement : `STATIC_DIR` est vide par défaut, si bien que pendant
longtemps rien n'a exercé `@fastify/static` ni le repli vers la SPA, alors que
la production le renseigne à chaque démarrage. Ce trou est comblé aujourd'hui
(`app.test.ts`, « app (serving the built SPA) »), mais la leçon se généralise :
quand le seul point de risque d'une mise à jour est un chemin de code
conditionné par la configuration, assurez-vous qu'un test pose cette
configuration avant de vous fier à la pastille verte.
