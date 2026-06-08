const BILLION = 1_000_000_000;

function boolValue(value, def = true) {
  if (value === undefined || value === null || value === '') return def;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function numValue(value, def) {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
}

function clampCpus(value, hostCpus) {
  const n = Math.max(1, Math.floor(Number(value) || 1));
  return hostCpus > 0 ? Math.min(n, hostCpus) : n;
}

export function targetBlueMapCpus({
  onlineCount = 0,
  hostCpus = 1,
  activeCpus = 2,
  idleCpus = 0,
  reservedCpus = 4,
} = {}) {
  const host = Math.max(1, Math.floor(Number(hostCpus) || 1));
  if (onlineCount > 0) return clampCpus(activeCpus, host);
  const idle = Number(idleCpus) > 0
    ? idleCpus
    : Math.max(1, host - Math.max(0, Math.floor(Number(reservedCpus) || 0)));
  return clampCpus(idle, host);
}

export function blueMapResourceOptions(env = {}) {
  return {
    enabled: boolValue(env.BLUEMAP_RESOURCE_AUTOTUNE, true),
    container: String(env.BLUEMAP_CONTAINER || 'bluemap'),
    pollMs: Math.max(10, numValue(env.BLUEMAP_RESOURCE_POLL_SECONDS, 60)) * 1000,
    idleDelayMs: Math.max(0, numValue(env.BLUEMAP_IDLE_DELAY_SECONDS, 300)) * 1000,
    activeCpus: numValue(env.BLUEMAP_ACTIVE_CPUS, 2),
    idleCpus: numValue(env.BLUEMAP_IDLE_CPUS, 0),
    reservedCpus: numValue(env.BLUEMAP_RESERVED_CPUS, 4),
  };
}

export function createBlueMapResourceController({
  dockerClient,
  serverService,
  logger = console,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  const opts = blueMapResourceOptions(env);
  let timer = null;
  let inFlight = false;
  let lastApplied = null;
  let lastMode = null;
  let idleSince = null;

  async function tick() {
    if (!opts.enabled || !dockerClient || !serverService) return null;
    if (inFlight) return null;
    inFlight = true;
    try {
      const online = await serverService.listOnline();
      const onlineCount = Array.isArray(online) ? online.length : 0;
      const host = await dockerClient.nodeStatus().catch(() => ({}));
      const hostCpus = host?.ncpu ?? 1;

      let mode = onlineCount > 0 ? 'active' : 'idle';
      if (onlineCount > 0) {
        idleSince = null;
      } else {
        if (idleSince == null) idleSince = now();
        const idleReady = lastMode == null || lastMode === 'idle' || now() - idleSince >= opts.idleDelayMs;
        if (!idleReady) mode = 'active';
      }

      const cpus = targetBlueMapCpus({
        onlineCount: mode === 'active' ? Math.max(1, onlineCount) : 0,
        hostCpus,
        activeCpus: opts.activeCpus,
        idleCpus: opts.idleCpus,
        reservedCpus: opts.reservedCpus,
      });
      const nanoCpus = cpus * BILLION;

      if (lastApplied !== nanoCpus) {
        await dockerClient.setNanoCpus(opts.container, nanoCpus);
        lastApplied = nanoCpus;
        logger.info?.({ container: opts.container, mode, onlineCount, cpus, hostCpus }, 'updated BlueMap cpu cap');
      }
      lastMode = mode;
      return { container: opts.container, mode, onlineCount, cpus, hostCpus };
    } catch (err) {
      logger.error?.({ err }, 'BlueMap cpu tuning failed');
      return { error: err };
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (!opts.enabled || !dockerClient || timer) return false;
    tick();
    timer = setInterval(tick, opts.pollMs);
    timer.unref?.();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, options: opts };
}
