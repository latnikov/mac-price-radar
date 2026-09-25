// A completed page immediately frees its slot, including for discovered links.
// On failure drain active work before rejecting so callers can safely close DBs.
export async function crawlQueue(initial, visit, { concurrency = 3 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('Invalid crawl concurrency');
  const queue = [...initial];
  const active = new Set();
  let error;
  const enqueue = item => { if (!error) queue.push(item); };
  while (queue.length || active.size) {
    while (!error && queue.length && active.size < concurrency) {
      const item = queue.shift();
      const task = Promise.resolve().then(() => visit(item, enqueue))
        .catch(reason => { error ||= reason instanceof Error ? reason : new Error(String(reason)); })
        .finally(() => active.delete(task));
      active.add(task);
    }
    if (!active.size) break;
    await Promise.race(active);
  }
  if (error) throw error;
}
