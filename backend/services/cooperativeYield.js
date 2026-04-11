/**
 * Helpers so background jobs return control to Node's event loop between chunks of work.
 */

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Invoke `fn(slice, startIndex)` for each contiguous slice of `items` with length `chunkSize`,
 * awaiting `yieldToEventLoop()` between slices (not after the final slice).
 * @template T
 * @param {T[]} items
 * @param {number} chunkSize
 * @param {(slice: T[], startIndex: number) => void | Promise<void>} fn
 */
async function forEachChunkWithYield(items, chunkSize, fn) {
  const n = items.length;
  if (n === 0) {
    return;
  }
  const size = Math.max(1, Math.floor(Number(chunkSize)) || 1);
  for (let i = 0; i < n; i += size) {
    const slice = items.slice(i, i + size);
    await fn(slice, i);
    if (i + size < n) {
      await yieldToEventLoop();
    }
  }
}

module.exports = {
  yieldToEventLoop,
  forEachChunkWithYield,
};
