// Bound simultaneous sources; each adapter retains its own per-site page limit.
// Progress writes are serialized so atomic-file writers cannot race each other.
export async function collectSources(retailers, collect, { concurrency = 3, onProgress = async () => {} } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('Invalid collection concurrency');
  const results = new Array(retailers.length);
  const active = new Set();
  let next = 0, completed = 0, progress = Promise.resolve();
  const report = () => {
    const snapshot = { active: [...active], completed, total: retailers.length };
    progress = progress.then(() => onProgress(snapshot));
    return progress;
  };
  const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, retailers.length) }, async () => {
    while (next < retailers.length) {
      const index = next++, retailer = retailers[index];
      active.add(retailer);
      await report();
      try { results[index] = { retailer, value: await collect(retailer) }; }
      catch (error) { results[index] = { retailer, error }; }
      active.delete(retailer);
      completed++;
      await report();
    }
  }));
  // Even a failed status-file write must drain in-flight requests before the
  // caller releases its collection lock and closes the shared database.
  const failed = workers.find(worker => worker.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}
