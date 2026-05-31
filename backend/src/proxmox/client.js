// Pure transport layer for the Proxmox VE REST API.
//
// This module knows ONLY how to talk HTTP to Proxmox with an API token. It has
// no concept of "games", VMIDs-as-identity, Fastify, users, or auth — those
// live in higher layers (registry → service → routes). Keeping it pure makes it
// trivially mockable in tests and means the Proxmox surface is defined in exactly
// one place.
//
// Auth uses an API token (Datacenter → Permissions → API Tokens), sent as:
//   Authorization: PVEAPIToken=USER@REALM!TOKENID=SECRET
// Token auth needs no login/ticket and is revocable independently of any user.

import { Agent } from 'undici';

export class ProxmoxError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = 'ProxmoxError';
    this.status = status;
    if (cause) this.cause = cause;
  }
}

export class ProxmoxClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiUrl    e.g. "https://192.168.1.109:8006"
   * @param {string} opts.node      Proxmox node name, e.g. "pve"
   * @param {string} opts.tokenId   "user@realm!tokenname"
   * @param {string} opts.tokenSecret
   * @param {boolean} [opts.rejectUnauthorized=false]  verify the TLS cert
   * @param {typeof fetch} [opts.fetchImpl]  injectable for tests
   */
  constructor({ apiUrl, node, tokenId, tokenSecret, rejectUnauthorized = false, fetchImpl } = {}) {
    if (!apiUrl) throw new Error('ProxmoxClient: apiUrl is required');
    if (!node) throw new Error('ProxmoxClient: node is required');
    if (!tokenId || !tokenSecret) throw new Error('ProxmoxClient: token id + secret are required');

    this.base = `${apiUrl.replace(/\/+$/, '')}/api2/json`;
    this.node = node;
    this.authHeader = `PVEAPIToken=${tokenId}=${tokenSecret}`;
    this.fetch = fetchImpl ?? globalThis.fetch;

    // Proxmox ships a self-signed cert by default. We scope the relaxed TLS
    // verification to THIS client via a per-request undici dispatcher rather
    // than mutating global TLS state. (Pinning the cert fingerprint is a future
    // hardening step.) Tests inject fetchImpl and never hit this path.
    this.dispatcher = (!rejectUnauthorized && !fetchImpl)
      ? new Agent({ connect: { rejectUnauthorized: false } })
      : undefined;
  }

  // ── low-level request ─────────────────────────────────────────────────────
  async #request(method, path, body) {
    const headers = { Authorization: this.authHeader, Accept: 'application/json' };
    const init = { method, headers };
    if (this.dispatcher) init.dispatcher = this.dispatcher;
    if (body !== undefined) {
      // Proxmox expects form-encoded bodies, not JSON. Array params (e.g. the
      // agent-exec `command` argv) are sent as repeated keys, which is how the
      // PVE API expects list types.
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          for (const item of v) form.append(k, String(item));
        } else {
          form.set(k, String(v));
        }
      }
      init.body = form.toString();
    }

    let res;
    try {
      res = await this.fetch(`${this.base}${path}`, init);
    } catch (err) {
      throw new ProxmoxError(`proxmox request failed: ${err.message}`, { cause: err });
    }

    const text = await res.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { /* non-JSON error body */ }
    }

    if (!res.ok) {
      const detail = parsed?.errors ? JSON.stringify(parsed.errors) : (text || res.statusText);
      throw new ProxmoxError(`proxmox ${method} ${path} -> ${res.status}: ${detail}`, {
        status: res.status,
      });
    }
    return parsed?.data ?? null;
  }

  #qemu(vmid, suffix) {
    return `/nodes/${encodeURIComponent(this.node)}/qemu/${encodeURIComponent(vmid)}${suffix}`;
  }

  // ── status + power ────────────────────────────────────────────────────────
  statusCurrent(vmid) {
    return this.#request('GET', this.#qemu(vmid, '/status/current'));
  }
  start(vmid)    { return this.#request('POST', this.#qemu(vmid, '/status/start')); }
  stop(vmid)     { return this.#request('POST', this.#qemu(vmid, '/status/stop')); }     // hard power-off
  shutdown(vmid) { return this.#request('POST', this.#qemu(vmid, '/status/shutdown')); } // graceful ACPI
  reboot(vmid)   { return this.#request('POST', this.#qemu(vmid, '/status/reboot')); }   // graceful reboot

  // ── guest agent: command execution (Phase 2/3) ────────────────────────────
  // Returns { pid }. Poll agentExecStatus until { exited: 1 }.
  agentExec(vmid, { command, input } = {}) {
    if (!command) throw new Error('agentExec: command is required');
    const body = { command }; // string or argv array; URLSearchParams JSON-encodes arrays
    if (input !== undefined) body['input-data'] = input;
    return this.#request('POST', this.#qemu(vmid, '/agent/exec'), body);
  }
  agentExecStatus(vmid, pid) {
    return this.#request('GET', this.#qemu(vmid, `/agent/exec-status?pid=${encodeURIComponent(pid)}`));
  }

  // ── guest agent: config files (Phase 3) ───────────────────────────────────
  // agentFileRead returns { content, truncated }.
  agentFileRead(vmid, file) {
    return this.#request('GET', this.#qemu(vmid, `/agent/file-read?file=${encodeURIComponent(file)}`));
  }
  agentFileWrite(vmid, file, content) {
    return this.#request('POST', this.#qemu(vmid, '/agent/file-write'), { file, content });
  }
}
