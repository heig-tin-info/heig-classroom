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
- An assignment in exam mode in `seed/assignments.yaml`, with an **empty**
  list of BEKs for now.
- The portal in `SEB_VERIFIER=real`. In `simulated`, everything passes and the proof is
  worthless.

## 1. Retrieve the configuration file of the assignment

From an ordinary browser on the test machine:

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
**Config Key**: compare it with the one the portal recorded for the
assignment. If the two differ, everything else will fail; it is the sign that the
normalisation or the file generation diverges — note the value displayed and
open a ticket before continuing.

**macOS.** Launch SEB, `SEB → Preferences`, `File → Open Settings`,
choose the same `config.seb`. Tab **Exam**, same **Browser Exam
Key** field. Copy it.

**The BEK differs per platform and per version.** That is its very purpose: it
attests to the binary as much as to the configuration. A BEK read on Windows will
not be valid on macOS, and a BEK read on version 3.7 will not be valid on 3.8.
Repeat step 2 on **every** (platform, version) pair of the fleet, starting
from the **same** downloaded file, without ever saving it.

## 3. Record the BEKs in the assignment

In `seed/assignments.yaml`, on the assignment concerned:

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

## 4. The nominal path: open the `sebs://` link

From an ordinary browser on the machine, open the page of the assignment and click the
link:

```
sebs://<portal>/exam/<assignment>.seb
```

Expected, in this order:

1. the browser asks to open Safe Exam Browser; accept;
2. SEB starts, switches to kiosk mode, downloads the configuration;
3. SEB opens `startURL`, that is to say `https://<portal>/exam/<assignment>/start`;
4. the portal checks the two headers, sets the `exam_session` cookie and
   redirects to `/s/<session>/`;
5. **the code-server editor appears**, and the terminal works.

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

## 5. The path that must break: copy the URL into Edge

This is the proof that the arrangement holds. In SEB, note the session URL
displayed at step 4 — of the form `https://<portal>/s/<session>/`.

Quit SEB (`quitURL`, or the exit button if `allowQuit` permits it).

Open **Microsoft Edge** — or any ordinary browser — and paste
the session URL.

**Expected: 403 and the page « Session hors Safe Exam Browser ».** Edge does not have the
`exam_session` cookie: it never went through the start route.

Three variants to check, all must give a 403:

| Variant | Manipulation | Expected logged reason |
| --- | --- | --- |
| Without cookie | paste the session URL into Edge | `missing` |
| Start URL directly | paste `https://<portal>/exam/<assignment>/start` into Edge | `missing-config-key-header` |
| Stolen cookie | copy the `exam_session` cookie from the SEB machine onto **another machine** (another IP address) and reopen the session URL | `address-mismatch` |

The third variant is the one that matters most: it proves the binding to
the client address (analyse.md D5). On the same machine the cookie will work,
which is intended — a second tab resumes the session.

## 6. What this procedure does not prove

- It proves nothing against a student who **obtains the BEK**. project.md § 9
  accepts it: "a student who obtains the Browser Exam Key can forge the
  headers from an ordinary browser". Hence the rotation for every session.
- It proves nothing on Linux: SEB has no official version there.
  A heterogeneous exam room fleet mechanically weakens the arrangement.
- It says nothing about a second device or about the neighbour. That falls under
  human invigilation.

## 7. Trail

Record in this file, at the end of the section, the date, the version of SEB, the
platform, the Config Key displayed by the tool and the one recorded by the
portal, and the result of steps 4 and 5. A single line per run is enough,
but it must exist: it is the only proof that proof B was carried out.

| Date | Platform and SEB version | Config Key (tool) | Config Key (portal) | Step 4 | Step 5 |
| --- | --- | --- | --- | --- | --- |
| | | | | | |
