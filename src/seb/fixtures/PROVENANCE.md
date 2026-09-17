# Provenance des vecteurs de test

Ces fichiers sont copiés **tels quels** depuis le jeu de tests du greffon Moodle
`quizaccess_seb`, branche `MOODLE_405_STABLE`, répertoire
`mod/quiz/accessrule/seb/tests/fixtures/` :

<https://github.com/moodle/moodle/tree/MOODLE_405_STABLE/mod/quiz/accessrule/seb/tests/fixtures>

Moodle est distribué sous GNU GPL v3 ou ultérieure ; ces fichiers le sont donc
aussi. Ils ne sont ici que comme vecteurs de test, pour vérifier que le portage
TypeScript de `config_key.php` donne les mêmes clés que l'implémentation de
référence.

| Fichier | Rôle | Clé attendue, et d'où elle vient |
| --- | --- | --- |
| `unencrypted_mac_001.seb` | configuration enregistrée par SEB macOS 2.1.4 | `4fa9af8ec8759eb7c680752ef4ee5eaf1a860628608fccae2715d519849f9292`, jeu de données `config_key_test::real_ck_hash_provider()` |
| `unencrypted_win_223.seb` | configuration enregistrée par SEB Windows 2.2.3 | `2534e4e9f3188f9f9133bf7cf7b4c5d898292bbd7e8d0230f39d1176636a1431`, même source |
| `JSON_unencrypted_mac_001.txt` | **chaîne SEB-JSON** attendue pour le fichier mac | fixture Moodle ; son SHA-256 vaut bien la clé ci-dessus, ce qui en fait un vecteur intermédiaire vérifiable |
| `simpleunencrypted.seb` | configuration minimale **avec** `originatorVersion` | `config_key_test::test_presence_of_originator_version_does_not_effect_hash()` |
| `simpleunencryptedwithoutoriginator.seb` | la même **sans** `originatorVersion` | idem : les deux doivent donner la même clé |

Le troisième vecteur, la configuration vide, n'a pas de fichier : c'est
`config_key::generate('')`, dont
`config_key_test::test_config_key_hash_generated_with_empty_string()` affirme la
clé `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.

Source des deux fichiers de test cités :

- <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/tests/config_key_test.php>
- <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/property_list.php>
