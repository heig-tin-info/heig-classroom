# `seb/` — exam side: Config Key, Browser Exam Key, `.seb` file

Task P4 of [docs/jalon-0.md](../../../../docs/jalon-0.md). This module depends
on nothing else in `src/`: the assignments, the verifier and the session
creation are injected into it.

| File | Role |
| --- | --- |
| `plist.ts` | reading and writing the plist subset a `.seb` uses, keeping the **declared type** of every leaf |
| `configKey.ts` | "SEB-JSON" normalisation then SHA-256: the Config Key |
| `verify.ts` | `SebVerifier`, the `real` and `simulated` implementations, `createSebVerifier` |
| `examSession.ts` | the signed (HMAC) `exam_session` cookie and its verification |
| `sebFile.ts` | generation of the `.seb` of an assignment, its Config Key, the `sebs://` link |
| `routes.ts` | the `sebRoutes` Fastify plugin: `GET /exam/:a.seb` and `GET /exam/:a/start` |
| `fixtures/` | test vectors copied from the Moodle plugin, see `fixtures/PROVENANCE.md` |

## Sources

- Specification of the Config Key computation:
  <https://safeexambrowser.org/developer/seb-config-key.html>
- Integration and Browser Exam Key (one BEK per version and per platform):
  <https://safeexambrowser.org/developer/seb-integration.html>
- Reference implementation, Moodle plugin `quizaccess_seb`, branch
  `MOODLE_405_STABLE`:
  - `classes/config_key.php` — removal of `originatorVersion`, then SHA-256:
    <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/config_key.php>
  - `classes/property_list.php` — `to_json()`, `array_sort()`,
    `prepare_plist_for_json_encoding()`; this is the file that really carries
    the algorithm:
    <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/property_list.php>
  - `classes/seb_access_manager.php` — `check_key()` and
    `check_browser_exam_keys()`, the formula of the two headers:
    <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/seb_access_manager.php>
  - `classes/link_generator.php` — the `sebs://` scheme:
    <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/link_generator.php>
  - `classes/helper.php` — `Content-Type: application/seb`, `filename=config.seb`:
    <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/helper.php>
  - `classes/seb_quiz_settings.php` — `process_seb_config_manually()`, which
    shows that a **partial** configuration is legitimate:
    <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/seb_quiz_settings.php>
  - `tests/config_key_test.php` — the three Config Key vectors:
    <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/tests/config_key_test.php>
- Unencrypted `.seb` configuration published by the SEB project itself, where
  the shape of the URL filter rules and the confirmation that the file is bare
  XML plist come from:
  <https://github.com/SafeExamBrowser/SafeExamBrowser-Website/blob/master/exams/MoodleDemoEduhubDaysFilterUC.seb>

## Algorithm of the Config Key

Ported from `property_list::to_json()`. Every rule is commented in
`configKey.ts` with its reference line.

0. **Remove `originatorVersion`** (`config_key::generate`). It is metadata:
   "which SEB version saved the config file". The removal is recursive, like
   `plist_map`.
1. **No whitespace, no newline.**
2. **No character escaping**, in particular **not** the backslashes of the URL
   filter rules. PHP cannot turn off backslash escaping in `json_encode`; the
   reference works around it by replacing every `\` with a sentinel string
   before encoding, then back again. The port emits the raw backslash directly.
   Consequence: **the SEB-JSON string is not valid JSON** as soon as a string
   contains a backslash. That is what the specification wants.
3. **Sorting the keys of every `<dict>`**, recursively, including inside
   arrays. Order: Unicode collation algorithm, root locale, default strength —
   so case is a *tertiary* difference and lower case comes first: `allowWlan`
   before `allowWLAN`. This is **not** an ASCII sort, nor a `localeCompare` on
   the current locale.
4. **Removal of empty `<dict>`s**, cascading from the bottom up: a dictionary
   that contains nothing but empty dictionaries disappears as well. Empty
   **arrays**, on the other hand, are kept (`"additionalResources":[]` in the
   mac vector).
5. Strings in UTF-8, left literal (`JSON_UNESCAPED_UNICODE`).
6. Lower-case base16.
7. `<data>` → its base64 string, as written in the plist.
8. `<date>` → ISO 8601.

Then SHA-256 of that string, in lower-case hexadecimal.

### Three traps, and what this port does

- **The empty configuration gives `[]`, not `{}`.** The reference serialises
  the plist as a PHP array, and `json_encode` of an empty PHP array gives `[]`.
  Hence the key `4f53cda1…` of the "empty configuration" vector, which really
  is `sha256("[]")`. `serialiseDict` reproduces that behaviour.
- **The sort depends on the locale of the engine.** `new Intl.Collator('root')`
  is rejected by Node, and `'und'` falls back to the default locale of the
  machine (`en-US` here): the result would depend on the workstation. The port
  pins `'en'`, which carries no collation tailoring in CLDR and therefore
  amounts to the root order. What *proves* the order is right is not that
  reasoning but the `JSON_unencrypted_mac_001.txt` vector: 239 keys, several of
  which differ only by case, compared character by character.
- **A partial configuration is legitimate.** SEB computes the Config Key over
  the content of the file, not over its settings once the defaults have been
  applied. `seb_quiz_settings::process_seb_config_manually()` starts from an
  empty `property_list` and only puts the settings of the form in it.
  `sebFile.ts` does the same: it only writes about thirty keys.

## Verification of the start

`seb_access_manager::check_key()`:
`hash('sha256', $url . $validkey) === $header`. So, on
`GET /exam/<assignment>/start`:

- `X-SafeExamBrowser-ConfigKeyHash` must be `sha256(url + configKey)`;
- `X-SafeExamBrowser-RequestHash` must be `sha256(url + bek)` for **at least
  one** of the accepted BEKs of the assignment (`check_browser_exam_keys` loops
  over the list).

`url` is the **absolute URL as the browser asked for it, without the
fragment**. Both comparisons go through `hashesEqual`, which compares the
SHA-256 digests of the two strings with `crypto.timingSafeEqual` — lengths
always equal, hence no short circuit. The loop over the BEKs does not stop on
the first success, so that the duration does not tell *which* BEK matched.

### Reconstructing the URL behind a front end

`absoluteRequestUrl(req, options)`, three modes, from the safest to the least
safe:

| Setting | Behaviour | When |
| --- | --- | --- |
| `publicOrigin: "https://codespace.heig-vd.ch"` | fixed origin, nothing the client sends enters the computation | **production** |
| `trustForwarded: true` | reads `X-Forwarded-Proto` and `X-Forwarded-Host` (first element of a list) | a front end that rewrites those headers systematically |
| neither of the two | `Host` plus `defaultProtocol` | cleartext development |

The trap is real: a TLS front end terminates HTTPS, the portal sees
`http://127.0.0.1:3100/...`, and the hash never matches. The safe setting is
`publicOrigin`, because a `Host` or an `X-Forwarded-Host` that can be tampered
with would let the student choose the URL the hash is computed over.

### The two implementations

- `real`: everything above.
- `simulated`: accepts `X-Dev-SEB: ok`, refuses everything else.
  `createSebVerifier` **throws** when `mode === "simulated"` and
  `NODE_ENV === "production"` (invariant 8 of `CLAUDE.md`, asserted by
  `verify.test.ts`). The refusal is an exception at startup, not a silent
  fallback: a misconfigured production must not start.

The set of refusal cases is run against **both** implementations in
`verify.test.ts` and `routes.test.ts`: no request that is not explicitly
allowed goes through, whatever the mode.

## The cookie, and why the proxy reads no SEB header

Invariant 5 of `CLAUDE.md`, motivated by analyse.md § 4.5: nothing guarantees
that SEB adds its headers to websocket upgrades nor to service-worker requests.
A proxy that demanded them would break the editor, and a proxy that demanded
them "when they are there" would guarantee nothing.

Hence: verification **once**, on `/exam/<assignment>/start`, then the issuing
of an `exam_session` cookie signed with HMAC-SHA256 carrying `assignmentId`,
`sessionId`, the client address and the timestamp. `checkExamRequest(request,
…)` is the only thing `proxy/` will ever call; it touches no SEB header. An
address different from the one of the initial verification → an
`address-mismatch` refusal (analyse.md D5).

The cookie is not encrypted: everything it carries is already known to the
client, and it **never** contains a BEK.

## The `.seb` file

An **unencrypted** XML plist, served as `application/seb` under the name
`config.seb`. That is the shape `quizaccess_seb` serves and the one of the
examples published by the SEB project: no gzip, no four-byte prefix.
Encryption only concerns password-protected files, ruled out by analyse.md
§ 4.4 ("encrypting the `.seb` file brings nothing to integrity; the Config Key
guarantees it").

Settings written, all taken from real SEB configurations
(`fixtures/unencrypted_win_223.seb` and the SEB project example): `startURL`,
`quitURL`, `URLFilterEnable`/`URLFilterRules` (a single "allow" rule on the
portal domain), `allowDownUploads: false`, `enablePrivateClipboard: true`,
kiosk, `sendBrowserExamKey: true`, `examKeySalt`, an empty `browserExamKey`.

**`browserExamKey` stays empty, on purpose.** With an `examKeySalt` of its own
per assignment, SEB computes the BEK from the salt *and from its own binary*:
one BEK per platform and per version, whence the list on the assignment side
(analyse.md § 4.4). Writing a BEK into the file would give the same BEK
everywhere — and would hand the shared secret to the student, which
project.md § 9 forbids.

The link handed to the student is `sebs://<host>/exam/<assignment>.seb`: the
same URL as the `https://` one, with the scheme swapped, like
`link_generator::get_link()`.

## Decisions

1. **Port, do not reinvent.** The port follows `property_list.php` line by
   line, quirks included (`[]` for an empty configuration, backslashes left
   unescaped in values but escaped in keys). A key that "would look cleaner"
   would be a wrong key.
2. **The plist type is kept** all the way to serialisation (`SebValue`),
   instead of falling back on the JavaScript primitives: an `<integer>` and a
   `<real>` do not serialise the same way, and neither does a `<data>`.
3. **An assignment without a BEK is refused**, where Moodle lets the request
   through when the list is empty (`is_allowed_browser_examkeys_configured`).
   In exam mode, an empty list is a configuration error, not a dispensation.
4. **No `@fastify/cookie`** in `routes.ts`: the plugin has to be registrable in
   an instance that already has it, or does not have it yet. The value is
   base64url, with no character that needs escaping.
5. **The refusal is logged, the secret never is.** The log carries the
   identifier of the assignment, the reason, the address and the URL. Neither
   the list of BEKs, nor the hashes received, which are functions of the shared
   secret. A test asserts it.
6. **Sourced vectors only.** No expected value comes out of this code. The
   three Config Key vectors and the intermediate SEB-JSON string come from the
   test suite of `quizaccess_seb`; the tests that cannot come from there
   (sensitivity to a changed setting, idempotence) are properties, not values.

## `TODO(verify)`

Nothing has been checked against a SEB binary: none is installed on this
workstation. The manual proof B,
[docs/preuve-b-manuelle.md](../../../../docs/preuve-b-manuelle.md), exists to
clear these points.

- **`configKey.ts`, `isoDate()`** — format of the `<date>`s. The reference
  reads a Unix timestamp and formats it with PHP's `'c'`, that is
  `1940-10-09T22:13:56+00:00`, an explicit offset and not `Z`. No published
  vector exercises that path: the only Moodle test that touches a date asserts
  that two fixtures carrying the same date have the same key, which does not
  pin the format. The configurations this portal generates contain no `<date>`
  at all, so the path is written after the reference and not proven.
- **`configKey.ts`, `jsonNumber()`** — very large floats. PHP writes
  `1.0e+30`, JavaScript `1e+30`. The only `<real>`s of a `.seb` are the battery
  thresholds, in `[0,1]`: the divergence is left unhandled and untested.
- **`sebFile.ts`, `browserViewMode: 1`** — both reference configurations have
  `0`. The value `1` (full screen) has not been checked against a pinned
  version of SEB.
- **`sebFile.ts`, `browserURLSalt: true`** — value carried over from both
  reference configurations; its exact semantics has not been checked against a
  pinned version.
- **`sebFile.ts`, `browserExamKey: ""`** — both reference configurations leave
  it empty, which supports the choice, but the semantics of a **non**-empty
  `browserExamKey` (a BEK imposed on the client) has not been checked.
- **SEB version** — no setting has been confronted with a pinned version of the
  client. The names and types come from configurations saved by SEB Windows
  2.2.3 and macOS 2.1.4, which are old.
- **Removal of an empty `<dict>` contained in an `<array>`** — the reference
  deletes during the iteration (`$parent->del($key)` on a `CFArray`), which can
  shift the indices. This port deletes cleanly. No known `.seb` contains an
  empty dictionary inside an array; the divergence is theoretical and untested.

## Tests

```bash
pnpm --filter @hgc/codespace test
```

`configKey.test.ts` (vectors and normalisation rules), `verify.test.ts`
(formula, refusal cases, invariant 8, URL reconstruction),
`examSession.test.ts` (cookie), `sebFile.test.ts` (generation, idempotence,
`sebs://` link), `routes.test.ts` (both routes, both implementations, the proxy
path).
