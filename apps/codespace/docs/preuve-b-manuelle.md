# Proof B, manual part: a real Safe Exam Browser

The automated part of proof B is in
[`src/seb/`](../src/seb/README.md): it proves that the
portal computes the same Config Key as the reference implementation and that it
refuses anything that is not a valid SEB request. It cannot prove
that a **real** SEB accepts the generated configuration and sends the expected
headers: no SEB binary runs on Linux.

This procedure fills that hole. It takes about thirty minutes, a
Windows or macOS machine, and a single run per version of SEB deployed in the exam room.

It also clears the `TODO(verify)` items listed in the module README: take the opportunity
to note what SEB actually does with `browserViewMode`, with `browserURLSalt`
and with an empty `browserExamKey`.

## 0. What is needed before starting

- The portal reachable from the test machine **at its public URL over
  HTTPS**, the one that will be used in the exam room. Not `localhost`, not an IP
  address: the Config Key and the request hash are computed over the absolute URL, and a
  `sebs://` on `localhost` proves nothing about the real installation.
- Safe Exam Browser installed on the machine, in the exact version of the fleet.
  <https://safeexambrowser.org/download_en.html>
- The configuration tool: on Windows, **SEB Configuration Tool**, installed
  together with SEB; on macOS, **SEB → Preferences**, a window that must have been
  allowed (`allowPreferencesWindow`) — which the exam configuration
  forbids, hence step 2, which opens the file in the tool and **not** in
  SEB in exam mode.
- An assignment in exam mode, with an **empty** list of BEKs for now. Two
  paths lead there: an assignment in `seed/assignments.yaml` for the
  standalone portal, or — the real case — an assignment of **classroom** in
  `online_seb` mode, synchronised with the portal. The procedure below starts
  from the second one; the standalone variant is noted where it differs.
- The portal in `SEB_VERIFIER=real`. In `simulated`, everything passes and the proof is
  worthless.
- `TRUSTED_PROXY_IPS` set on the portal (`127.0.0.1` behind Caddy). Without it
  `request.ip` is the front end's address for everyone and **step 5 cannot
  fail**, which would make the most important part of this proof pass for the
  wrong reason. The portal refuses to start without it in production, so in
  practice: if the portal is up, it is set (docs/deploy.md § 6).

## 1. Retrieve the configuration file of the assignment

**From classroom**, signed in as the teacher who owns the assignment. Open the
assignment page; the online-workspace banner carries, under it, a
**Download .seb** button and the **Config Key** the portal recorded for this
assignment. Write that Config Key down — step 2 compares against it.

The button is a plain `https://<portal>/exam/<assignment>.seb` with a
`download` attribute. Do **not** use the student's `sebs://` link here: that
scheme hands the file to Safe Exam Browser, which starts in kiosk mode and
never lets you open it in the configuration tool.

If the button is absent, the banner says why, and neither case is worth
working around:

| What the banner says | Meaning |
| --- | --- |
| no banner at all | the assignment is not in `online_seb` mode |
| « No workspace portal is configured on this server. » | `CODESPACE_URL` is empty on classroom |
| « Synchronise this assignment with the portal… » | the assignment has never reached the portal; press **Resync** and reload |
| the key replaced by « Known after the next successful sync… » | the assignment was synchronised before classroom stored the Config Key; press **Resync** |

**Standalone portal**, without classroom: fetch the same URL directly from an
ordinary browser on the test machine, and read the Config Key from the portal
logs instead.

```
https://<portal>/exam/<assignment>.seb
```

The portal answers with `application/seb`, filename `config.seb`. Save the file
without opening it. Check, in a text editor, that it begins with
`<?xml version="1.0"`: an unencrypted `.seb` is bare XML plist.

Also check that it contains **no** Browser Exam Key: the
`browserExamKey` field must be an empty string. If you find a key in it, stop:
the shared secret is being handed to the student.

## 2. Read the Browser Exam Key in the configuration tool

> **Do not save the file again.** This is the main trap. Opening the
> configuration in the tool and clicking "Save" regenerates `examKeySalt`,
> which changes the Config Key *and* all the BEKs of the other platforms. You
> would then have to start over on every machine.

**Windows.** Launch *SEB Configuration Tool*, `File → Open`, choose the
`config.seb` you downloaded. Tab **Exam**. The **Browser Exam Key** field displays
a string of 64 hexadecimal characters. Copy it. The tab also displays the
**Config Key**: compare it, character by character, with the one classroom
shows beside the download button (step 1). If the two differ, everything else
will fail; it is the sign that the normalisation or the file generation
diverges — note the value displayed and open a ticket before continuing.

**macOS.** Launch SEB, `SEB → Preferences`, `File → Open Settings`,
choose the same `config.seb`. Tab **Exam**, same **Browser Exam
Key** field. Copy it.

**The BEK differs per platform and per version.** That is its very purpose: it
attests to the binary as much as to the configuration. A BEK read on Windows will
not be valid on macOS, and a BEK read on version 3.7 will not be valid on 3.8.
Repeat step 2 on **every** (platform, version) pair of the fleet, starting
from the **same** downloaded file, without ever saving it.

## 3. Record the BEKs in the assignment

**From classroom** (the real case): the assignment form has a Browser Exam
Keys field, one key per line. Save, then check on the assignment page that the
banner says « Synced with portal at … » — the keys only reach the portal
through that synchronisation, and an exam assignment with an empty list is
refused by the `PUT` (`missing_browser_exam_keys`).

The **Config Key does not change** when the BEKs change: it is computed over
the `.seb` file, which carries no BEK. No need to redistribute anything.

**Standalone portal**: in `seed/assignments.yaml`, on the assignment
concerned:

```yaml
  beks:
    - "…64 hex characters, Windows machine 3.8…"
    - "…64 hex characters, macOS machine 3.4…"
```

It is a **list**, one entry per (platform, version) pair: analyse.md
§ 4.4. Restart the portal.

The BEK is a shared secret: it does not go into a public repository, it does not appear
in the teacher interface, it does not go into the logs (a test
asserts it), and it is changed for every exam session (project.md § 9).

## 4. The nominal path: the student's `sebs://` link

Sign in on the test machine as a **student** enrolled in the classroom, who
has accepted the assignment. On their home page, the exam row carries the
`sebs://` link (`Open in Safe Exam Browser`):

```
sebs://<portal>/exam/<assignment>.seb
```

Expected, in this order:

1. the browser asks to open Safe Exam Browser; accept;
2. SEB starts, switches to kiosk mode, downloads the configuration;
3. SEB opens `startURL`. For an assignment coming from classroom that is
   **classroom's** page `https://<classroom>/app/codespace/start/<assignment>`
   (invariant 11), which authenticates the student and 303s to
   `https://<portal>/launch?token=…`. For a standalone assignment it is the
   portal's own `https://<portal>/exam/<assignment>/start`;
4. the portal checks the two headers **once**, on whichever of those two
   routes SEB landed, sets the `exam_session` cookie and redirects to
   `/s/<session>/`;
5. **the code-server editor appears**, and the terminal works.

This is also where the `TODO(verify)` of `classroom/routes.ts` gets settled:
does SEB add its two headers to the request that lands on `/launch`, **after
the redirect to another host**, and does it hash them over the portal's URL
*with its query string*? Record the answer in § 7 — it is the one thing the
simulated verifier cannot prove.

Note here what you observe about the `TODO(verify)` items: is SEB full
screen (`browserViewMode: 1`)? Is the browser toolbar
hidden? Is the clipboard isolated?

**If step 4 fails with a 403**, the cause is almost always one of three:

- **URL wrongly reconstructed behind the front end.** The portal hashed
  `http://127.0.0.1:3100/exam/…` where SEB hashed
  `https://<portal>/exam/…`. Fix it by pinning `publicOrigin` to the
  public origin of the portal rather than trusting `Host`. The logging
  of the refusal prints the URL that was used: compare it with what SEB's address bar
  shows.
- **Different Config Key.** The file was saved again between step 1 and
  step 4, or the assignment has been modified since. Download it again, start over at
  step 2.
- **BEK from another version.** The machine does not have the version the BEK
  was read for. The logged reason is `browser-exam-key-mismatch`.

Check in the portal logs that no BEK, and no received hash,
appears, including on refusals.

## 5. The paths that must break

This is the proof that the arrangement holds, and it is the part of the
procedure worth the most: a nominal path that works proves comfort, a refused
path proves the exam. In SEB, note the session URL displayed at step 4 — of
the form `https://<portal>/s/<session>/`.

Quit SEB (`quitURL`, or the exit button if `allowQuit` permits it).

Every line below must be checked, and every one of them must be refused. The
"page" column is the title the student actually reads; the "logged reason" is
what to grep for in `journalctl -u codespace`.

| # | Manipulation | Expected code and page | Logged reason |
| --- | --- | --- | --- |
| 5.1 | paste the session URL into **Microsoft Edge** (or any ordinary browser) on the same machine | 403, « Session hors Safe Exam Browser » | `missing` |
| 5.2 | paste `https://<portal>/exam/<assignment>/start` into Edge | 403, « Session hors Safe Exam Browser », body « La requête ne vient pas de Safe Exam Browser. » | `missing-config-key-header` |
| 5.3 | from classroom, in Edge, press **Start** on the exam assignment (a real launch token, no SEB) | 403, « Session hors Safe Exam Browser », body « Cette épreuve ne s'ouvre que depuis Safe Exam Browser. » | `exam launch refused` on `/launch` |
| 5.4 | copy the `exam_session` cookie from the SEB machine onto **another machine**, on another address, and open the session URL | 403, « Session hors Safe Exam Browser », body « Cette session a été ouverte depuis un autre poste. » | `address-mismatch` |
| 5.5 | copy **both** cookies (`exam_session` and `cs_session`) to the other machine, then go back to the SEB machine and **relaunch** the exam from classroom; retry the other machine | 403, « Session non autorisée » | `proxy access refused: session cookie missing or invalid` |
| 5.6 | replay the launch link of 5.3 (same `?token=…`) a second time | 403, « Lancement refusé », « Ce lien de lancement a déjà servi. » | `jti-replayed` |

**5.3 is the one the audit added**, and it is the cheapest to run: it needs no
cookie surgery, only an ordinary browser and the teacher's word that the
assignment is in exam mode. Outside SEB there is no `X-SafeExamBrowser-*`
header, and `/launch` refuses before the session is created — note that the
launch token is **burnt** all the same (invariant 9), so the student has to go
back to classroom and press Start again.

**5.4 is the one that matters most**: it proves the binding to the client
address (analyse.md D5). It is also the one that silently passed for the wrong
reason before 2026-09-19 — behind Caddy, `request.ip` was `127.0.0.1` for
everyone and the comparison was always true. If 5.4 does **not** give a 403,
do not blame the cookie: check `TRUSTED_PROXY_IPS` on the portal and read
`clientAddress` in the logs (docs/deploy.md § 6). A run of this procedure
whose 5.4 passes with `clientAddress: 127.0.0.1` in the logs proves nothing
and must be recorded as failed.

**5.5 covers the rotation of the proxy cookie** (audit L3): `cs_session`
carries a token that changes at every opening, resumption and close of the
session, so a copy taken at one moment stops working as soon as the student
launches again. On the SEB machine itself nothing breaks — the relaunch sets
the new cookie for the whole browser, and a second tab resumes the session as
before.

On the same machine and in the same browser, the `exam_session` cookie of 5.4
**will** work: that is intended, it is the second tab of the student.

## 6. What this procedure does not prove

- It proves nothing against a student who **obtains the BEK**. project.md § 9
  accepts it: "a student who obtains the Browser Exam Key can forge the
  headers from an ordinary browser". Hence the rotation for every session.
- It proves nothing on Linux: SEB has no official version there.
  A heterogeneous exam room fleet mechanically weakens the arrangement.
- It says nothing about a second device or about the neighbour. That falls under
  human invigilation.

## 7. Trail

Record in this file, at the end of the section, the date, the version of SEB,
the platform, the Config Key displayed by the tool and the one classroom
showed, and the result of step 4 and of **each** line of step 5. One line per
run, and it must exist: it is the only proof that proof B was carried out.

`5.1`…`5.6` take `ok` (refused as expected), `KO` (went through) or `—` (not
run). A run whose 5.4 is `ok` but whose logs show
`clientAddress: 127.0.0.1` is **not** an `ok`: write `KO`.

| Date | Platform and SEB version | Config Key (tool) | Config Key (classroom) | Step 4 | 5.1 | 5.2 | 5.3 | 5.4 | 5.5 | 5.6 | `clientAddress` seen |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | | |

Also note, in prose under the table, what SEB did with the cross-host
redirect of step 4 — that is the `TODO(verify)` of `classroom/routes.ts` and
of integration-classroom.md § 9, and this procedure is the only thing that
can close it.
