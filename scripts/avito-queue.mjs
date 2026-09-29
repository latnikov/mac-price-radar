// This file stores scheduling metadata only. A previous visit never becomes a
// new price observation; each snapshot still requires a new detail response.
export function createAvitoDetailQueue(items, { previous, searchUrl, startedAt }) {
  const start = Date.parse(startedAt);
  const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= start;
  const saved = previous?.schemaVersion === 1 && previous.searchUrl === searchUrl && Array.isArray(previous.entries)
    ? new Map(previous.entries.slice(0, 3000).filter(entry => entry && typeof entry.id === 'string').map(entry => [entry.id, entry])) : new Map();
  const entries = new Map(items.map(item => {
    const prior = saved.get(item.id);
    return [item.id, { id: item.id,
      lastAttemptAt: validTime(prior?.lastAttemptAt) ? prior.lastAttemptAt : null,
      lastObservedAt: validTime(prior?.lastObservedAt) ? prior.lastObservedAt : null }];
  }));
  // Unvisited cards first, then the least recently attempted. Keep search order
  // for ties so Avito's local-priority order is retained among new cards.
  const ordered = [...items].sort((a, b) => (Date.parse(entries.get(a.id).lastAttemptAt) || 0) - (Date.parse(entries.get(b.id).lastAttemptAt) || 0));
  return {
    ordered,
    attempted(id, at, observedAt) {
      const entry = entries.get(id);
      entry.lastAttemptAt = at;
      if (observedAt) entry.lastObservedAt = observedAt;
    },
    serialize(updatedAt) { return { schemaVersion: 1, searchUrl, updatedAt, entries: [...entries.values()] }; },
  };
}
