# Provenance of the test vectors

These files are copied **as is** from the test suite of the Moodle plugin
`quizaccess_seb`, branch `MOODLE_405_STABLE`, directory
`mod/quiz/accessrule/seb/tests/fixtures/`:

<https://github.com/moodle/moodle/tree/MOODLE_405_STABLE/mod/quiz/accessrule/seb/tests/fixtures>

Moodle is distributed under the GNU GPL v3 or later; so are these files. They
are here only as test vectors, to check that the TypeScript port of
`config_key.php` yields the same keys as the reference implementation.

| File | Role | Expected key, and where it comes from |
| --- | --- | --- |
| `unencrypted_mac_001.seb` | configuration saved by SEB macOS 2.1.4 | `4fa9af8ec8759eb7c680752ef4ee5eaf1a860628608fccae2715d519849f9292`, data set `config_key_test::real_ck_hash_provider()` |
| `unencrypted_win_223.seb` | configuration saved by SEB Windows 2.2.3 | `2534e4e9f3188f9f9133bf7cf7b4c5d898292bbd7e8d0230f39d1176636a1431`, same source |
| `JSON_unencrypted_mac_001.txt` | the **SEB-JSON string** expected for the mac file | Moodle fixture; its SHA-256 really is the key above, which makes it a verifiable intermediate vector |
| `simpleunencrypted.seb` | minimal configuration **with** `originatorVersion` | `config_key_test::test_presence_of_originator_version_does_not_effect_hash()` |
| `simpleunencryptedwithoutoriginator.seb` | the same one **without** `originatorVersion` | idem: both must yield the same key |

The third vector, the empty configuration, has no file: it is
`config_key::generate('')`, whose key
`4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` is asserted
by `config_key_test::test_config_key_hash_generated_with_empty_string()`.

Source of the two test files quoted above:

- <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/tests/config_key_test.php>
- <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/property_list.php>
