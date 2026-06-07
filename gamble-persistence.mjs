// Write coordinator for gambling balance + event persistence. Returns a small
// facade (saveBalance / saveBalanceAndEvent / recordEvent / flush) that serializes
// all writes through a single promise chain, debounces standalone balance saves,
// swallows+reports errors so the UI never breaks, and refreshes stats only after
// the latest queued write. Dependencies (persist/insert/refresh, timers) are
// injected so it stays framework- and DOM-agnostic and unit-testable.

export function createGamblingPersistence({
  getUsername,
  persistBalance,
  insertEvent,
  refreshStats,
  delayMs = 250,
  setTimeoutFn = globalThis.setTimeout.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout.bind(globalThis),
  onError = console.warn
}) {
  let writeChain = Promise.resolve();
  let writeVersion = 0;
  let balanceTimer = null;
  let balanceTimerResolve = null;

  function username() {
    return typeof getUsername === 'function' ? getUsername() : getUsername;
  }

  function clearBalanceTimer() {
    if (balanceTimer) {
      clearTimeoutFn(balanceTimer);
      balanceTimer = null;
      balanceTimerResolve?.(writeChain);
      balanceTimerResolve = null;
    }
  }

  function enqueue(label, task) {
    const operationVersion = ++writeVersion;
    writeChain = writeChain
      .then(async () => {
        await task();
        if (operationVersion === writeVersion && refreshStats) {
          await refreshStats();
        }
      })
      .catch((error) => {
        onError(`${label} failed:`, error?.message || error);
      });
    return writeChain;
  }

  function saveBalance(credits) {
    const name = username();
    if (!name) {
      return Promise.resolve();
    }

    clearBalanceTimer();
    return new Promise((resolve) => {
      balanceTimerResolve = resolve;
      balanceTimer = setTimeoutFn(() => {
        balanceTimer = null;
        balanceTimerResolve = null;
        resolve(enqueue('Balance save', () => persistBalance(name, credits)));
      }, delayMs);
    });
  }

  function saveBalanceAndEvent(event) {
    if (!event?.username) {
      return Promise.resolve();
    }

    clearBalanceTimer();
    return enqueue('Balance/event save', async () => {
      await persistBalance(event.username, event.balance_after);
      await insertEvent(event);
    });
  }

  function recordEvent(event) {
    if (!event?.username) {
      return Promise.resolve();
    }

    clearBalanceTimer();
    return enqueue('Gambling event save', () => insertEvent(event));
  }

  function flush() {
    return writeChain;
  }

  return {
    saveBalance,
    saveBalanceAndEvent,
    recordEvent,
    flush
  };
}
