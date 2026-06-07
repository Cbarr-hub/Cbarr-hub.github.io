const PROGRESS_RE = /updating map '([^']+)':\s*([0-9]+(?:\.[0-9]+)?)%\s*(?:\(ETA:\s*([^)]+)\))?/i;

function cleanLine(line) {
  return String(line || '').replace(/^\[[^\]]+\]\s*/, '').trim();
}

function percent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function mapName(id) {
  return String(id || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

export function parseBlueMapStatus(logText) {
  const lines = String(logText || '').split(/\r?\n/).map(cleanLine).filter(Boolean);
  if (!lines.length) {
    return { state: 'unknown', message: 'Render status unavailable', percent: null, map: null, eta: null };
  }

  let latestProgress = null;
  let progressIndex = -1;
  let completeIndex = -1;
  let waitingIndex = -1;
  let startingIndex = -1;

  lines.forEach((line, i) => {
    const m = PROGRESS_RE.exec(line);
    if (m) {
      latestProgress = { map: m[1], percent: percent(m[2]), eta: m[3] || null };
      progressIndex = i;
    }
    if (/Your maps are now all up-to-date!/i.test(line)) completeIndex = i;
    if (/Waiting for changes on the world-files/i.test(line)) waitingIndex = i;
    if (/Starting webserver|Loading resources|Start updating \d+ maps?/i.test(line)) startingIndex = i;
  });

  if (completeIndex > progressIndex || waitingIndex > progressIndex) {
    return { state: 'complete', message: 'Render complete', percent: 100, map: null, eta: null };
  }

  if (latestProgress) {
    const eta = latestProgress.eta ? ` - ETA ${latestProgress.eta}` : '';
    return {
      state: 'rendering',
      message: `${mapName(latestProgress.map)} rendering ${latestProgress.percent}%${eta}`,
      ...latestProgress,
    };
  }

  if (startingIndex >= 0) {
    return { state: 'starting', message: 'Render starting', percent: null, map: null, eta: null };
  }

  return { state: 'unknown', message: lines.at(-1), percent: null, map: null, eta: null };
}
