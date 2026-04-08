# Hermes Control Interface

A self-hosted web dashboard for the Hermes AI agent stack. Provides a browser-based terminal, file explorer, session overview, cron management, system metrics, and an agent status panel — all behind a single password gate.

**Designed for:** Single-user local networks or reverse-proxied VPS deployments. Not a multi-tenant product.

---

## Features

- **Terminal** — Real PTY shell (node-pty) in the browser via xterm.js. Full ANSI colour, persistent session.
- **File Explorer** — Browse and edit files across configurable root directories. No upload/download friction.
- **Session Monitor** — Live view of Hermes sessions and cron jobs.
- **System Metrics** — CPU, memory, uptime, refreshed every 2 seconds over WebSocket.
- **Rate-Limited Auth** — 5 failed login attempts in 15 minutes → 15-minute lockout. Timing-safe password comparison. HMAC-signed session cookies.
- **Layout Persistence** — Dashboard panel arrangement saved to `~/.hermes/control-interface-layout.json`.

---

## Requirements

- **Node.js 20+**
- **npm**
- A Hermes installation on the same machine (optional — the dashboard works without it, some panels just show placeholder data)
- `hermes` on PATH (optional, for in-terminal command shortcuts)

---

## Quick Start

```bash
git clone <repo-url> hermes-control-interface
cd hermes-control-interface
npm install          # or: bash install.sh (interactive setup)
cp .env.example .env
# Edit .env — set HERMES_CONTROL_PASSWORD and HERMES_CONTROL_SECRET
npm start
```

Open `http://localhost:10272`.

---

## First-Run Setup

Run the interactive setup script for guided configuration:

```bash
bash install.sh
```

This will:
1. Check Node.js version
2. Install npm dependencies
3. Generate a random password and secret (or reuse existing `.env`)
4. Optionally configure nginx HTTPS reverse-proxy
5. Optionally install a systemd service for auto-start

---

## Configuration

All settings are environment variables. See [docs/CONFIG.md](docs/CONFIG.md) for the full reference.

**Required:**
| Variable | Description |
|---|---|
| `HERMES_CONTROL_PASSWORD` | Login password |
| `HERMES_CONTROL_SECRET` | HMAC secret for auth tokens (generate with `openssl rand -hex 32`) |

**Optional:**
| Variable | Default | Description |
|---|---|---|
| `PORT` | `10272` | HTTP listen port |
| `HERMES_HOME` | `~/.hermes` | Hermes state directory |
| `HERMES_PROJECTS_ROOT` | parent of repo | Explorer projects root |
| `HERMES_CONTROL_ROOTS` | `HERMES_PROJECTS_ROOT` + `HERMES_HOME` | Explorer root overrides |

---

## Deployment

### Option A — Behind nginx reverse-proxy (recommended for VPS)

```bash
# In install.sh, answer Yes to the nginx prompt, or create manually:
# Proxy to http://127.0.0.1:10272 from your HTTPS server block.
# See docs/DEPLOY.md for a full example nginx config.
```

The dashboard must be served over HTTPS. The `Secure` cookie flag is always set.

### Option B — Direct on LAN (home network only)

Bind to `0.0.0.0` (default) and password-protect. Do not expose directly to the public internet without a reverse-proxy and TLS.

### Option C — systemd service

```bash
# After running install.sh:
sudo systemctl start hermes-control
sudo systemctl status hermes-control  # verify it's running
```

Auto-start on boot is enabled automatically if you installed via `install.sh`.

---

## Security Notes

- The password is compared using `crypto.timingSafeEqual` — no timing oracle.
- Auth cookies are HMAC-signed with a per-deployment secret. They expire after 24 hours.
- Rate limiting blocks an IP after 5 failed attempts in 15 minutes.
- The `Secure` cookie flag is always set. Access over HTTP only works on `localhost` — use HTTPS in production.
- File operations are scoped to configured explorer roots — path traversal out of allowed directories is blocked.
- No multi-user support. All browser sessions share the same password.

See [docs/SECURITY.md](docs/SECURITY.md) for the full security analysis.

---

## API Reference

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/health` | No | Health check |
| `GET` | `/api/session` | No | Auth status |
| `POST` | `/api/login` | No | Login (rate-limited) |
| `POST` | `/api/logout` | No | Clear session |
| `GET` | `/api/dashboard-state` | Yes | Full dashboard snapshot |
| `GET` | `/api/explorer` | Yes | Directory tree |
| `GET` | `/api/file` | Yes | Read file |
| `POST` | `/api/file` | Yes | Write file |
| `POST` | `/api/terminal/exec` | Yes | Run terminal command |
| `POST` | `/api/cron/:action` | Yes | Manage cron jobs |
| `GET` | `/api/usage` | Yes | System metrics |
| `GET` | `/api/layout` | Yes | Get layout |
| `POST` | `/api/layout` | Yes | Save layout |
| `GET` | `/api/avatar` | Yes | Get avatar |
| `POST` | `/api/avatar` | Yes | Upload avatar |
| `DELETE` | `/api/avatar` | Yes | Reset avatar |
| `WS` | `/ws` | Yes | Live dashboard updates + terminal I/O |

All authenticated endpoints require a valid session cookie (`hermes...auth`).

Internal endpoints (`/internal/cron/:action`) require the `x-hermes-control-secret` header matching `HERMES_CONTROL_SECRET`.

---

## Repo Layout

```
hermes-control-interface/
├── server.js          # Express server, auth, PTY, WebSocket, APIs
├── website/           # Frontend (vanilla JS, xterm.js)
├── docs/              # Detailed documentation
│   ├── CONFIG.md       # Environment variable reference
│   ├── SECURITY.md    # Security analysis
│   ├── DEPLOY.md      # Production deployment guide
│   └── API.md         # API endpoint details
├── .env.example       # Template — copy to .env
├── .env               # Runtime config (gitignored)
├── install.sh         # Interactive first-run setup
└── package.json
```

---

## Troubleshooting

**502 Bad Gateway**
The Node.js process isn't running. Check that `.env` exists and has valid `HERMES_CONTROL_PASSWORD` / `HERMES_CONTROL_SECRET` values.

```bash
cd hermes-control-interface
node server.js
# Look for startup errors
```

**"authentication required" after login**
The cookie wasn't accepted. Check that you're accessing the dashboard over HTTPS (required for `Secure` cookies), or that your reverse-proxy is forwarding cookies correctly.

**Port already in use**
Change the port: `PORT=10702 npm start` or set `PORT=10702` in `.env`.

**Terminal not connecting**
Make sure `node-pty` compiled successfully. On some systems you may need `make` and a C++ compiler.

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for more.
