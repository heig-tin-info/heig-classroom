# heig.codespace-statusbar

Extension baked into the `codespace/c-dev` student image of the heig-codespace
project. It adds, at the right of the status bar, the time left until the
assignment deadline and a « Fermer » button that takes the student back to the
portal.

Everything comes from the container environment (`CODESPACE_DEADLINE`,
`CODESPACE_RETURN_URL`, `CODESPACE_ASSIGNMENT_NAME`), set by the portal's
`podman run`. No network access, no telemetry, no dependency.

Full documentation: `images/c-dev/README.md` of the heig-classroom repository.
