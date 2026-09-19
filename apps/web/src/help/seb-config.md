# Exam configuration (.seb)

## What the file is

An assignment in **SEB exam mode** only opens from Safe Exam Browser. The workspace portal generates one `.seb` configuration per assignment: it names the start page, locks the browser down and carries a salt unique to this exam.

## Download it over HTTPS, not through `sebs://`

**Download .seb** gives you the plain file. Save it, do not open it.

The students get a different link on their own page, `sebs://…`, which hands the file straight to Safe Exam Browser: it starts in kiosk mode and you never get to inspect anything. That link is for them, this button is for you.

## Never save the file again

Open it in the SEB configuration tool (`File → Open`, tab **Exam**) to read the **Browser Exam Key** of that machine — one key per platform and per version of SEB in your exam room. Paste the keys into the assignment form, one per line.

Clicking **Save** in the tool regenerates the salt: the Config Key changes, every key you already collected becomes wrong, and every file already distributed stops working. There is no undo.

## Config Key

The fingerprint the portal computed for the file it serves. The configuration tool shows its own; the two must be identical, character for character. If they differ, the exam start will be refused and no Browser Exam Key will help — report it before the exam.

The key appears here only after the assignment has reached the portal. Press **Resync** if it says otherwise.

The whole protocol, including the refusals to test before an exam, is `apps/codespace/docs/preuve-b-manuelle.md`.
