function normalizeText(value, fallback = '—') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function previewText(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || '—';
}

function formatRelativeTime(epochSeconds, nowMs = Date.now()) {
  const tsMs = Number(epochSeconds || 0) * 1000;
  if (!Number.isFinite(tsMs) || tsMs <= 0) return '—';

  const diffMs = Math.max(0, nowMs - tsMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return 'just now';
  if (diffMs < hour) {
    const mins = Math.floor(diffMs / minute);
    return `${mins}m ago`;
  }
  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    return `${hours}h ago`;
  }
  if (diffMs < day * 2) return 'yesterday';
  const days = Math.floor(diffMs / day);
  return `${days}d ago`;
}

function parseHermesSessionsList(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);

  // Detect header format: "Title Preview Last Active ID" vs "Preview Last Active Src ID"
  let hasTitleCol = false;
  for (const line of lines) {
    if (/^Title\s+Preview\s+Last Active\s+ID/i.test(line)) { hasTitleCol = true; break; }
  }

  const dataLines = lines.filter((line) =>
    !/^Title\s+Preview\s+Last Active\s+ID$/i.test(line) &&
    !/^[─\-]+$/.test(line) &&
    !/^(Preview|Title|Last Active|Src)\s+(Preview|Title|Last Active|Src)/i.test(line)
  );

  return dataLines.map((line) => {
    // Split on 2+ spaces — safe for first 2-3 columns
    const parts = line.trim().split(/\s{2,}/);

    let title, preview, lastActive, source, id;

    if (hasTitleCol) {
      // Format: Title | Preview | Last Active | ID (no Source)
      if (parts.length < 3) return null;
      if (parts.length === 4) {
        [title, preview, lastActive, id] = parts;
      } else if (parts.length === 3) {
        // Cramped: "title preview" | lastActive | id
        const lastTokens = parts[2].trim().split(/\s+/);
        if (lastTokens.length >= 2) {
          title = parts[0];
          preview = parts[1];
          lastActive = lastTokens.slice(0, -1).join(' ');
          id = lastTokens[lastTokens.length - 1];
        } else {
          [title, preview, lastActive] = parts;
          id = lastTokens[0];
        }
      }
      source = null;
    } else {
      // Format: Preview | Last Active | Src | ID
      if (parts.length < 3) return null;
      const lastPart = parts[parts.length - 1];
      const lastTokens = lastPart.trim().split(/\s+/);

      if (parts.length === 4) {
        [preview, lastActive, source, id] = parts;
      } else if (parts.length === 3 && lastTokens.length >= 2) {
        // Cramped: preview | lastActive | "source id"
        [preview, lastActive] = parts;
        source = lastTokens.slice(0, -1).join(' ');
        id = lastTokens[lastTokens.length - 1];
      } else {
        return null;
      }
      title = preview;
    }

    return {
      id: String(id || '').trim(),
      title: normalizeText(title),
      preview: previewText(preview),
      lastActive: normalizeText(lastActive),
      source: source || null,
    };
  }).filter(Boolean);
}

function mergeSessionsFromSources({ cliSessions = [], dbSessions = [], previewBySessionId = {}, lastActivityBySessionId = {}, nowMs = Date.now() }) {
  const merged = new Map();

  for (const session of cliSessions) {
    if (!session?.id) continue;
    merged.set(session.id, {
      id: String(session.id),
      title: normalizeText(session.title),
      preview: previewText(session.preview),
      lastActive: normalizeText(session.lastActive),
      messageCount: Number(session.messageCount || 0),
      parentSessionId: session.parentSessionId || null,
      source: session.source || null,
      sortTimestamp: Number(session.sortTimestamp || 0),
    });
  }

  for (const row of dbSessions) {
    if (!row?.id) continue;
    const existing = merged.get(row.id) || {};
    const lastActivity = Number(lastActivityBySessionId[row.id] || 0);
    const fallbackTimestamp = Number(row.ended_at || row.started_at || existing.sortTimestamp || 0);
    // Use last activity as primary sort key, fallback to ended_at/started_at
    const sortTimestamp = lastActivity > 0 ? lastActivity : fallbackTimestamp;
    merged.set(row.id, {
      ...existing,
      id: String(row.id),
      title: normalizeText(row.title, existing.title || '—'),
      preview: previewText(previewBySessionId[row.id] || existing.preview),
      lastActive: sortTimestamp ? formatRelativeTime(sortTimestamp, nowMs) : normalizeText(existing.lastActive),
      messageCount: Number(row.message_count || existing.messageCount || 0),
      parentSessionId: row.parent_session_id || existing.parentSessionId || null,
      source: row.source || existing.source || null,
      sortTimestamp,
    });
  }

  return Array.from(merged.values())
    .sort((a, b) => {
      if (b.sortTimestamp !== a.sortTimestamp) return b.sortTimestamp - a.sortTimestamp;
      return String(b.id).localeCompare(String(a.id));
    })
    .map(({ sortTimestamp, ...session }) => session);
}

module.exports = {
  formatRelativeTime,
  mergeSessionsFromSources,
  parseHermesSessionsList,
};
