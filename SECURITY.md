# Security

## Reporting a problem

Please report security problems privately, not in a public issue. Use GitHub's private vulnerability reporting for this repository (Security, then "Report a vulnerability"), or contact [@ForgeyClap](https://github.com/ForgeyClap) through GitHub and ask for a private channel.

Include what you can: what the problem is and what it allows, steps to reproduce, the affected files, and how you installed (plugin or installer). Leave out real secrets, tokens and personal data.

You will get a reply within a few days. Please allow time for a fix before you publish details.

Fixes go to the `main` branch. There are no separately maintained older releases.

## How keys are handled

- `.env` and its variants are gitignored. `.env.example` contains names only.
- `/setup-forge` writes a temporary fill-in file that is gitignored from the start, moves the values into `.env` when you are done, and deletes the temporary file.
- Forge reports a saved key by its name and never prints the value.
- If `.env` is tracked by git, setup stops, untracks it with `git rm --cached -- .env` (the file on disk stays) and tells you to rotate the keys that were exposed.
- On macOS and Linux, `.env` is created with `0600` permissions where the file system allows it.
- `.claude/settings.json` stops Claude Code's file reader from opening `.env` files, `secrets/` folders, private keys and Claude Code's credentials file. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

If you find a secret committed to this repository, report it as described above.
