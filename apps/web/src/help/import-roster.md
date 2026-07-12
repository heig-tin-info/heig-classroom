# Import roster

## What this does

Fills the classroom roster from a file — students then claim their seat automatically at first sign-in (matching e-mail).

## How to import

Drop an **Excel or CSV** export. Name, first name and e-mail columns are detected permissively (French headers work). You can also add students one by one, or paste CSV lines directly.

## What happens on re-import

The import is idempotent: existing entries are matched by e-mail and keep their claim status; only names are refreshed. Nothing is deleted implicitly.
