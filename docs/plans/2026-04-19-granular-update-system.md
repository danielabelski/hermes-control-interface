# Granular Update System — Implementation Plan

> **For David:** Implement this plan task-by-task. All changes are in `/root/projects/hci-staging/`.

**Goal:** Replace the all-or-nothing update mechanism with a granular system: check updates, view commit list, update to specific commit, view diff, rollback.

**Architecture:** SSE streaming for progress + REST endpoints for metadata. Branch-aware (staging = `dev`, prod = `main`). All endpoints reuse existing patterns (`shell()`, `requireRole('admin')`, themed `showModal()`).

**Tech Stack:** Node.js, Express, Git CLI, SSE (text/event-stream), Chart.js (existing)

---

## Task 1: Add `GET /api/hci/check-update` endpoint

**Objective:** Fetch remote, return current vs remote commit info + commits-behind list.

**File:** `server.js` — insert after line ~2633 (after existing `/api/hci/update`)

**Step 1: Add the endpoint**

```javascript
// HCI Check Updates — git fetch + compare local vs remote
app.get('/api/hci/check-update', requireRole('admin'), async (req, res) => {
  try {
    const HCI_DIR = __dirname;
    // Get current branch
    const branch = (await shell(`cd ${HCI_DIR} && git branch --show-current`, '5s')).trim();
    // Fetch latest without modifying working tree
    await shell(`cd ${HCI_DIR} && git fetch origin ${branch}`, '30s');
    // Get local commit
    const localHash = (await shell(`cd ${HCI_DIR} && git rev-parse --short HEAD`, '5s')).trim();
    const localMsg = (await shell(`cd ${HCI_DIR} && git log -1 --pretty=format:"%s"`, '5s')).trim();
    const localDate = (await shell(`cd ${HCI_DIR} && git log -1 --format="%ci"`, '5s')).trim();
    // Get remote commit
    const remoteHash = (await shell(`cd ${HCI_DIR} && git rev-parse --short origin/${branch}`, '5s')).trim();
    // Count commits behind
    const behindStr = (await shell(`cd ${HCI_DIR} && git rev-list HEAD..origin/${branch} --count`, '5s')).trim();
    const behind = parseInt(behindStr, 10) || 0;
    // List commits ahead on remote (newest first)
    let commits = [];
    if (behind > 0) {
      const logRaw = await shell(
        `cd ${HCI_DIR} && git log --oneline --format="%H|%h|%s|%an|%ci" HEAD..origin/${branch}`,
        '10s'
      );
      commits = logRaw.trim().split('\n').filter(Boolean).map(line => {
        const [hash, shortHash, msg, author, date] = line.split('|');
        return { hash, shortHash, msg, author, date };
      });
    }
    // Get package.json version
    let pkgVersion = '';
    try { pkgVersion = JSON.parse(fs.readFileSync(path.join(HCI_DIR, 'package.json'), 'utf8')).version; } catch {}

    res.json({
      ok: true,
      branch,
      local: { hash: localHash, msg: localMsg, date: localDate, version: pkgVersion },
      remote: { hash: remoteHash },
      behind,
      commits,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
```

**Step 2: Test**

```bash
curl -s -c /tmp/hci-cookies -X POST http://localhost:10274/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"bayendor","password":"pxnji2727"}' \
&& curl -s -b /tmp/hci-cookies http://localhost:10274/api/hci/check-update | python3 -m json.tool
```

Expected: JSON with `branch`, `local`, `remote`, `behind`, `commits[]`

**Step 3: Commit**

```bash
cd /root/projects/hci-staging && node -c server.js && git add -A && git commit -m "feat(update): add check-update endpoint — local vs remote diff"
```

---

## Task 2: Add `GET /api/hci/commit/:hash/diff` endpoint

**Objective:** Return summary diff for a specific commit (files changed, additions, deletions).

**File:** `server.js` — insert after the check-update endpoint

**Step 1: Add the endpoint**

```javascript
// HCI Commit Diff — summary of changes for a specific commit
app.get('/api/hci/commit/:hash/diff', requireRole('admin'), async (req, res) => {
  try {
    const HCI_DIR = __dirname;
    const hash = req.params.hash.replace(/[^a-f0-9]/g, ''); // sanitize
    // Get commit metadata
    const metaRaw = await shell(
      `cd ${HCI_DIR} && git log -1 --format="%H|%h|%s|%an|%ci|%b" ${hash}`, '5s'
    );
    const [fullHash, shortHash, msg, author, date, body] = metaRaw.trim().split('|');
    // Get diffstat (summary only, no raw diff)
    const stat = await shell(`cd ${HCI_DIR} && git diff --stat ${hash}~1..${hash} 2>&1`, '10s');
    // Get numstat for structured data
    const numstat = await shell(`cd ${HCI_DIR} && git diff --numstat ${hash}~1..${hash} 2>&1`, '10s');
    const files = numstat.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      return { added: parseInt(parts[0], 10) || 0, removed: parseInt(parts[1], 10) || 0, file: parts[2] };
    });
    // Summary line from git diff --shortstat
    const shortstat = (await shell(`cd ${HCI_DIR} && git diff --shortstat ${hash}~1..${hash}`, '5s')).trim();

    res.json({
      ok: true,
      commit: { hash: fullHash, shortHash, msg, author, date, body: body || '' },
      files,
      shortstat,
      statText: stat.trim(),
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
```

**Step 2: Test**

```bash
curl -s -b /tmp/hci-cookies http://localhost:10274/api/hci/commit/4594a2a/diff | python3 -m json.tool
```

Expected: JSON with `commit`, `files[]`, `shortstat`, `statText`

**Step 3: Commit**

```bash
node -c server.js && git add -A && git commit -m "feat(update): add commit diff endpoint — files/adds/dels summary"
```

---

## Task 3: Add `POST /api/hci/update/commit/:hash` endpoint

**Objective:** Checkout to a specific commit, npm install, build, auto-restart. SSE streaming for progress.

**File:** `server.js` — insert after existing `/api/hci/update` endpoint (replaces or supplements it)

**Step 1: Add the endpoint**

```javascript
// HCI Update to specific commit — git checkout + npm install + build + auto-restart
app.post('/api/hci/update/commit/:hash', requireRole('admin'), (req, res) => {
  const HCI_DIR = __dirname;
  const hash = req.params.hash.replace(/[^a-f0-9]/g, ''); // sanitize

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'progress', line: `Checking out commit ${hash}...` })}\n\n`);

  const steps = [
    { name: 'fetch', cmd: `cd ${HCI_DIR} && git fetch origin`, timeout: '30s' },
    { name: 'checkout', cmd: `cd ${HCI_DIR} && git checkout ${hash} 2>&1`, timeout: '15s' },
    { name: 'npm install', cmd: `cd ${HCI_DIR} && npm install 2>&1`, timeout: '120s' },
    { name: 'build', cmd: `cd ${HCI_DIR} && npm run build 2>&1`, timeout: '120s' },
  ];

  (async () => {
    for (const step of steps) {
      res.write(`data: ${JSON.stringify({ type: 'progress', line: `▸ ${step.name}...` })}\n\n`);
      try {
        const out = await shell(step.cmd, step.timeout || '60s');
        const text = out.trim() || '(no output)';
        text.split('\n').filter(l => l.trim()).forEach(line => {
          res.write(`data: ${JSON.stringify({ type: 'progress', line: '  ' + line.trim() })}\n\n`);
        });
        if (out.includes('error') || out.includes('ERROR') || out.includes('fatal')) {
          // Don't abort on git checkout "error" — it might be a warning
          if (step.name === 'checkout') {
            res.write(`data: ${JSON.stringify({ type: 'warning', line: 'Checkout had warnings but continuing' })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ type: 'error', message: `${step.name} failed` })}\n\n`);
            return res.end();
          }
        }
      } catch (e) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: `${step.name} failed: ${e.message}` })}\n\n`);
        return res.end();
      }
    }
    // Get commit info for confirmation
    const currentHash = (await shell(`cd ${HCI_DIR} && git rev-parse --short HEAD`, '5s')).trim();
    const currentMsg = (await shell(`cd ${HCI_DIR} && git log -1 --pretty=format:"%s"`, '5s')).trim();
    res.write(`data: ${JSON.stringify({ type: 'progress', line: `▸ Now at ${currentHash}: ${currentMsg}` })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'progress', line: '▸ Update complete. Restarting in 3s...' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', message: 'Update complete', hash: currentHash, msg: currentMsg })}\n\n`);
    res.end();

    // Spawn restart script (same pattern as existing /api/hci/update)
    const PORT = process.env.PORT || 10274;
    const restartScript = `sleep 3 && fuser -k ${PORT}/tcp 2>/dev/null; sleep 1 && cd ${HCI_DIR} && nohup node server.js &>/tmp/hci-staging.log &`;
    spawn('sh', ['-c', restartScript], { detached: true, stdio: 'ignore' }).unref();
  })();
});
```

**Step 2: Commit**

```bash
node -c server.js && git add -A && git commit -m "feat(update): add per-commit checkout endpoint with SSE progress"
```

---

## Task 4: Add `POST /api/hci/rollback` endpoint

**Objective:** Rollback to previous commit (HEAD~1). Same pattern as checkout but defaults to HEAD~1.

**File:** `server.js` — insert after the per-commit checkout endpoint

**Step 1: Add the endpoint**

```javascript
// HCI Rollback — checkout previous commit (HEAD~1)
app.post('/api/hci/rollback', requireRole('admin'), (req, res) => {
  const HCI_DIR = __dirname;
  const steps = req.body?.steps || 1; // how many commits back, default 1

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'progress', line: `Rolling back ${steps} commit(s)...` })}\n\n`);

  const rollbackSteps = [
    { name: 'checkout', cmd: `cd ${HCI_DIR} && git checkout HEAD~${steps} 2>&1`, timeout: '15s' },
    { name: 'npm install', cmd: `cd ${HCI_DIR} && npm install 2>&1`, timeout: '120s' },
    { name: 'build', cmd: `cd ${HCI_DIR} && npm run build 2>&1`, timeout: '120s' },
  ];

  (async () => {
    for (const step of rollbackSteps) {
      res.write(`data: ${JSON.stringify({ type: 'progress', line: `▸ ${step.name}...` })}\n\n`);
      try {
        const out = await shell(step.cmd, step.timeout);
        const text = out.trim() || '(no output)';
        text.split('\n').filter(l => l.trim()).forEach(line => {
          res.write(`data: ${JSON.stringify({ type: 'progress', line: '  ' + line.trim() })}\n\n`);
        });
      } catch (e) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: `${step.name} failed: ${e.message}` })}\n\n`);
        return res.end();
      }
    }
    const currentHash = (await shell(`cd ${HCI_DIR} && git rev-parse --short HEAD`, '5s')).trim();
    res.write(`data: ${JSON.stringify({ type: 'progress', line: `▸ Rolled back to ${currentHash}` })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done', message: 'Rollback complete', hash: currentHash })}\n\n`);
    res.end();

    const PORT = process.env.PORT || 10274;
    const restartScript = `sleep 3 && fuser -k ${PORT}/tcp 2>/dev/null; sleep 1 && cd ${HCI_DIR} && nohup node server.js &>/tmp/hci-staging.log &`;
    spawn('sh', ['-c', restartScript], { detached: true, stdio: 'ignore' }).unref();
  })();
});
```

**Step 2: Commit**

```bash
node -c server.js && git add -A && git commit -m "feat(update): add rollback endpoint — HEAD~N with SSE progress"
```

---

## Task 5: Update Maintenance page — add version/commit info + "View Commits" button

**Objective:** Show current commit hash, commits-behind badge, "View Commits" button, and commit list modal on the Maintenance page.

**File:** `src/js/main.js` — find the `loadMaintenance()` function and update the HCI Update section

**Step 1: Add check-update function**

Add these functions near the existing `runHCIUpdate()` function:

```javascript
async function checkHCIUpdates() {
  const res = await api('/api/hci/check-update');
  if (!res.ok) { showModal({ title: 'Error', message: res.error || 'Failed to check updates', buttons: [{ text: 'OK', value: true }] }); return; }
  // Update version display
  const versionEl = document.getElementById('hci-current-version');
  if (versionEl) versionEl.textContent = res.local.version || '—';
  const hashEl = document.getElementById('hci-current-commit');
  if (hashEl) hashEl.textContent = res.local.hash || '—';
  const branchEl = document.getElementById('hci-current-branch');
  if (branchEl) branchEl.textContent = res.branch || '—';
  const behindEl = document.getElementById('hci-commits-behind');
  if (behindEl) behindEl.textContent = res.behind;
  const behindBadge = document.getElementById('hci-behind-badge');
  if (behindBadge) behindBadge.style.display = res.behind > 0 ? '' : 'none';

  // Show commit list modal if there are updates
  if (res.behind > 0) {
    showCommitListModal(res);
  } else {
    showModal({
      title: 'Up to Date',
      message: `Already at latest commit on ${res.branch}.`,
      buttons: [{ text: 'OK', value: true }],
    });
  }
}

function showCommitListModal(data) {
  const commitsHtml = data.commits.map((c, i) => `
    <div class="commit-card" data-hash="${c.hash}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <code class="commit-hash">${c.shortHash}</code>
        <span style="flex:1;font-weight:600;font-size:13px;">${escapeHtml(c.msg)}</span>
        <button class="btn btn-xs btn-outline" onclick="showCommitDiff('${c.shortHash}')">Diff</button>
        <button class="btn btn-xs btn-primary" onclick="checkoutCommit('${c.shortHash}')">Checkout</button>
      </div>
      <div style="font-size:11px;color:var(--fg-muted);">
        ${escapeHtml(c.author)} · ${formatRelativeTime(c.date)}
      </div>
    </div>
  `).join('');

  showModal({
    title: `${data.behind} commit(s) behind on ${data.branch}`,
    message: `<div class="commit-list-container">${commitsHtml}</div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);">
        <button class="btn btn-primary" onclick="runHCIUpdate(); closeModal();">Update All (pull latest)</button>
      </div>`,
    buttons: [{ text: 'Close', value: false }],
  });
}

async function showCommitDiff(hash) {
  const res = await api(`/api/hci/commit/${hash}/diff`);
  if (!res.ok) { showModal({ title: 'Error', message: res.error, buttons: [{ text: 'OK', value: true }] }); return; }
  showModal({
    title: `${res.commit.shortHash}: ${res.commit.msg}`,
    message: `
      <div style="margin-bottom:8px;font-size:12px;color:var(--fg-muted);">${escapeHtml(res.commit.author)} · ${formatRelativeTime(res.commit.date)}</div>
      <div style="margin-bottom:8px;font-weight:600;font-size:12px;">${escapeHtml(res.shortstat)}</div>
      <div class="diff-files-list">${res.files.map(f => `
        <div style="display:flex;gap:8px;font-size:12px;padding:2px 0;">
          <span style="color:var(--green);">+${f.added}</span>
          <span style="color:var(--coral);">-${f.removed}</span>
          <span style="flex:1;font-family:monospace;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(f.file)}</span>
        </div>
      `).join('')}</div>`,
    buttons: [{ text: 'Close', value: true }],
  });
}

async function checkoutCommit(hash) {
  const confirmed = await showModal({
    title: 'Checkout Commit',
    message: `Checkout to <code>${hash}</code>? This will run npm install and rebuild.<br><br><strong>The server will restart.</strong>`,
    buttons: [
      { text: 'Cancel', value: false },
      { text: 'Checkout', value: true, primary: true },
    ],
  });
  if (!confirmed?.action) return;
  runUpdateStream(`/api/hci/update/commit/${hash}`);
}

// Reusable SSE stream handler for update endpoints
async function runUpdateStream(endpoint) {
  // Show progress modal
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'hci-update-progress';
  overlay.innerHTML = `<div class="modal-card" style="max-width:600px;">
    <div class="modal-header"><h3>HCI Update</h3>
      <button class="btn btn-xs btn-ghost" onclick="this.closest('.modal-overlay').remove()">✕</button>
    </div>
    <div class="modal-body">
      <pre id="hci-update-log" style="max-height:400px;overflow-y:auto;font-size:12px;font-family:var(--font-mono);background:var(--bg-input);padding:12px;border-radius:8px;white-space:pre-wrap;"></pre>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const logEl = document.getElementById('hci-update-log');
  let completed = false;

  // Safety timeout — 120s
  const safetyTimeout = setTimeout(() => {
    if (!completed) {
      logEl.textContent += '\n⚠ Update timed out. You may need to restart manually.';
    }
  }, 120000);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
    const res = await fetch(endpoint, { method: 'POST', headers, body: '{}' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'progress') logEl.textContent += evt.line + '\n';
          if (evt.type === 'warning') logEl.textContent += '⚠ ' + evt.line + '\n';
          if (evt.type === 'error') logEl.textContent += '❌ ' + evt.message + '\n';
          if (evt.type === 'done') {
            completed = true;
            logEl.textContent += '\n✅ ' + evt.message;
            setTimeout(() => location.reload(), 2000);
          }
          logEl.scrollTop = logEl.scrollHeight;
        } catch {}
      }
    }
  } catch (e) {
    logEl.textContent += '\n❌ Connection error: ' + e.message;
  }
  clearTimeout(safetyTimeout);
}
```

**Step 2: Update the Maintenance page HTML to show version info + View Commits button**

In `loadMaintenance()`, find the HCI Update section and replace with:

```html
<div class="section-card" id="hci-update-card">
  <h3>🎯 HCI Update</h3>
  <div class="hci-version-info" style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
    <div class="stat-item">
      <span class="stat-label">Version</span>
      <span class="stat-value" id="hci-current-version">—</span>
    </div>
    <div class="stat-item">
      <span class="stat-label">Commit</span>
      <span class="stat-value"><code id="hci-current-commit">—</code></span>
    </div>
    <div class="stat-item">
      <span class="stat-label">Branch</span>
      <span class="stat-value"><code id="hci-current-branch">—</code></span>
    </div>
    <div class="stat-item" id="hci-behind-badge" style="display:none;">
      <span class="stat-label">Behind</span>
      <span class="stat-value"><span class="badge badge-warning" id="hci-commits-behind">0</span></span>
    </div>
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;">
    <button class="btn btn-primary" onclick="checkHCIUpdates()">Check Updates</button>
    <button class="btn btn-outline" onclick="runUpdateStream('/api/hci/update')">Update All</button>
    <button class="btn btn-ghost" onclick="runUpdateStream('/api/hci/rollback')">⟲ Rollback</button>
  </div>
</div>
```

**Step 3: Add CSS for commit cards (in components.css or inline)**

```css
.commit-card {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 6px;
  background: var(--bg-card);
  transition: border-color 0.2s;
}
.commit-card:hover { border-color: var(--gold); }
.commit-hash {
  font-size: 11px;
  background: var(--bg-input);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--gold);
}
.commit-list-container {
  max-height: 400px;
  overflow-y: auto;
  margin: 8px 0;
}
```

**Step 4: Export window functions**

```javascript
window.checkHCIUpdates = checkHCIUpdates;
window.showCommitDiff = showCommitDiff;
window.checkoutCommit = checkoutCommit;
window.runUpdateStream = runUpdateStream;
```

**Step 5: Commit**

```bash
node -c src/js/main.js && npm run build && git add -A && git commit -m "feat(update): granular update UI — check updates, commit list, diff preview, per-commit checkout, rollback"
```

---

## Task 6: Auto-check on Maintenance page load

**Objective:** Automatically call checkHCIUpdates() when the Maintenance page is loaded, so user sees version info + commits-behind immediately.

**File:** `src/js/main.js` — in `loadMaintenance()`, add at the end of the function body:

```javascript
// Auto-check HCI updates on page load
checkHCIUpdates();
```

**Step 2: Commit**

```bash
node -c src/js/main.js && npm run build && git add -A && git commit -m "feat(update): auto-check updates on Maintenance page load"
```

---

## Task 7: Build, test, deploy to staging

**Objective:** Full build + restart staging + verify

**Step 1: Build**

```bash
cd /root/projects/hci-staging && npm run build
```

**Step 2: Commit all**

```bash
git add -A && git commit -m "feat(update): v3.4.0 — granular update system with commit checkout, diff preview, rollback"
```

**Step 3: Restart staging (King executes)**

```bash
curl -s -c /tmp/hci-cookies -X POST https://agent2.panji.me/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"bayendor","password":"pxnji2727"}' \
&& curl -s -b /tmp/hci-cookies -X POST https://agent2.panji.me/api/hci-restart
```

**Step 4: Hard refresh browser**

`Ctrl+Shift+R` on https://agent2.panji.me

**Step 5: Test**

1. Go to Maintenance page → should auto-show version, commit, branch
2. Click "Check Updates" → should show commits list if behind
3. Click "Diff" on any commit → should show files/adds/dels
4. Click "Checkout" → confirm modal → SSE progress → auto-reload
5. Click "Rollback" → SSE progress → auto-reload
6. Click "Update All" → SSE progress → auto-reload

---

## Notes

- **Branch-aware:** check-update uses `git branch --show-current` — works for both `dev` (staging) and `main` (prod)
- **Safe rollback:** uses `git checkout HEAD~N`, NOT `git reset --hard`. npm install handles dependency changes.
- **No destructive actions:** all operations are reversible via "Update All" (pulls latest)
- **SSE reuse:** `runUpdateStream()` is reusable for all 3 update endpoints (update all, per-commit, rollback)
- **Sanitized hashes:** all hash params are sanitized to `[a-f0-9]` only
- **Diff shows summary only** — no raw code diff. Shows files changed, additions, deletions. Good enough for non-developer review.
