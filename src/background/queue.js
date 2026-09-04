// Bounded job queue for provider calls, keyed by tab.
//
// Only work the user just asked for goes through here, so it stays in memory.
// The one thing it must do beyond limiting concurrency is let a tab's queued
// jobs be dropped when that tab navigates or closes. A job already in flight
// cannot be recalled: the provider has received it and counted it against the
// user's quota, and aborting the fetch would refund nothing. So dropping is
// exactly as far as quota discipline can reach, and no further.

export function createQueue(maxInflight = 3) {
  const pending = []; // { tabId, job }
  let inflight = 0;

  function drain() {
    while (inflight < maxInflight && pending.length) {
      const { job } = pending.shift();
      inflight++;
      // Promise.resolve().then(job) turns a synchronous throw into a rejection,
      // so a bad job cannot leave `inflight` stuck high and stall the queue.
      Promise.resolve()
        .then(job)
        .catch(() => {})
        .finally(() => {
          inflight--;
          drain();
        });
    }
  }

  function push(tabId, job) {
    pending.push({ tabId, job });
    drain();
  }

  // Removes every queued job for the tab. Returns how many were dropped.
  function drop(tabId) {
    let dropped = 0;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].tabId === tabId) {
        pending.splice(i, 1);
        dropped++;
      }
    }
    return dropped;
  }

  return {
    push,
    drop,
    get size() {
      return pending.length;
    },
    get running() {
      return inflight;
    },
  };
}
