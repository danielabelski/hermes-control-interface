export function resolveSessionDisplayTitle({ sessionId, data }) {
  const persistedTitle = data?.session?.title;

  if (persistedTitle && persistedTitle !== '—') {
    return persistedTitle;
  }

  return sessionId;
}
