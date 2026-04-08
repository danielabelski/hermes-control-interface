# Configuration Reference

Hermes Control Interface is configured entirely through environment variables.

**Recommended:** use a `.env` file in the repo root for local development. For production, use your hosting platform's environment variable system, systemd `Environment=` directives, or a secret manager.

---

## Required Variables

### `HERMES_CONTROL_PASSWORD`

Login password for the dashboard. There is no default — if this is not set the server refuses to start.

Use a long random string in production:
```bash
openssl rand -hex 32
```

### `HERMES_CONTROL_SECRET`

HMAC secret for signing auth tokens and verifying internal requests. Must be set. Generate with:
```bash
openssl rand -hex 32
```

---

## Optional Variables

### `PORT`

**Default:** `10272`

TCP port the server listens on. The dashboard binds to `0.0.0.0` (all interfaces) by default.

```bash
PORT=10702 npm start
```

### `HERMES_HOME`

**Default:** `~/.hermes` (resolved at runtime via `os.homedir()`)

Path to the Hermes state directory. Used for:
- Avatar image storage (`$HERMES_HOME/control-interface/`)
- Layout persistence (`$HERMES_HOME/control-interface-layout.json`)
- Default explorer root

```bash
HERMES_HOME=/opt/hermes npm start
```

### `HERMES_PROJECTS_ROOT`

**Default:** parent directory of the repo (e.g. `/root/projects` if installed in `/root/projects/hermes-control-interface`)

Root directory shown in the projects explorer panel.

```bash
HERMES_PROJECTS_ROOT=/home/me/code npm start
```

### `HERMES_CONTROL_ROOTS`

Override the explorer root directories. Accepts two formats:

**Comma-separated paths:**
```bash
HERMES_CONTROL_ROOTS=/srv/projects,/var/data,/home/me/.hermes
```

**JSON array:**
```bash
HERMES_CONTROL_ROOTS='[{"key":"projects","label":"/srv/projects","root":"/srv/projects"},{"key":"hermes","label":"Home","root":"/root/.hermes"}]'
```

Each root object:
- `key` — unique identifier for the root
- `label` — display name shown in the UI
- `root` — absolute filesystem path

If not set, defaults to `[HERMES_PROJECTS_ROOT, HERMES_HOME]`.

---

## Verifying Your Config

The server validates required variables on startup. If `HERMES_CONTROL_PASSWORD` or `HERMES_CONTROL_SECRET` is missing, it exits immediately with:

```
Error: Missing HERMES_CONTROL_PASSWORD or HERMES_CONTROL_SECRET environment variables
```

To check if your `.env` is loading correctly, start the server and look for:
```
Hermes Control Interface running on port 10272
Password gate: env-secret only
```

---

## Production Recommendations

- **Never** commit `.env` to version control — it's in `.gitignore` by default
- Use a secret manager (Vault, AWS Secrets Manager, etc.) for production deployments
- Rotate `HERMES_CONTROL_SECRET` regularly — existing sessions will be invalidated
- Set `NODE_ENV=production` in production deployments
