// Parametrized golden suite — asserts every Docker game connector against its
// GOLDENS table (goldens.mjs). ONE suite covers, for all five games:
//   - getLive(): exact advertised action/control key inventory (in order),
//     the changeMap flag, and the credentials gate (reason + NO_RCON fast-fail);
//   - every advertised live action -> its exact RCON command (loopback capture);
//   - every live control sample (in-range + both clamps) -> its exact command;
//   - change_map samples -> exact commands; invalid map + unknown action reject
//     BAD_SETTING;
//   - sendCommand: trim/forward sample + the validation trio (empty / newline /
//     >512 chars -> BAD_SETTING);
//   - defaultProfileSettings() deepEqual the golden profile doc;
//   - profileSchema(): group keys in order, field keys per group, basic flags
//     (structure only — discovered-map/save option lists stay dynamic);
//   - the config-file whitelist, exactly;
//   - update(): the exact in-container argv (exec-kind) or container reboot.
//
// The goldens are the canon the declarative-engine swap must reproduce
// byte-identically. If a golden disagrees with a connector, the CODE is canon —
// fix the golden, never the connector.

import assert from 'node:assert/strict';
import test from 'node:test';

import { fakeDockerClient, withRconCapture, withEnvMany } from './harness.mjs';
import { GOLDENS } from './goldens.mjs';

// ── credential plumbing (per golden) ──────────────────────────────────────────
// Env-password games get the var set/unset via withEnvMany; the file-password
// game (Factorio) gets its rconpw seeded into the fake client's file map.
const credEnv   = (g) => (g.rcon.passwordSource.env ? { [g.rcon.passwordSource.env]: 'secret' } : {});
const noCredEnv = (g) => (g.rcon.passwordSource.env ? { [g.rcon.passwordSource.env]: undefined } : {});
const credFiles = (g) => (g.rcon.passwordSource.file ? { [g.rcon.passwordSource.file]: 'secret\n' } : {});

// Loopback-capture the RCON commands `run(conn)` issues. The connector reaches
// RCON at server.container:<port-field>, so the row points container at
// 127.0.0.1 and the golden's rcon.port names which field carries the port.
function capture(g, run) {
  return withEnvMany(credEnv(g), () =>
    withRconCapture({ responder: () => '' }, async ({ port }) => {
      const row = { ...g.serverRow, container: '127.0.0.1' };
      if (g.rcon.port === 'server.port') row.port = port;
      else row.rconPort = port;
      const conn = g.build(row, fakeDockerClient(credFiles(g)));
      await run(conn);
    })).then((r) => r.commands);
}

for (const g of GOLDENS) {
  test(`goldens/${g.id}: getLive advertises exactly the golden actions + controls`, async () => {
    await withEnvMany(credEnv(g), async () => {
      const conn = g.build(g.serverRow, fakeDockerClient(credFiles(g)));
      const live = await conn.getLive();
      assert.equal(live.available, true);
      assert.deepEqual(live.actions.map((a) => a.key), g.liveActions.map((a) => a.key));
      assert.deepEqual(live.controls.map((c) => c.key), g.liveControls.map((c) => c.key));
      if (g.changeMap) assert.equal(live.changeMap, true);
      else assert.equal(live.changeMap, undefined);
    });
  });

  test(`goldens/${g.id}: getLive gates on missing credentials (reason + NO_RCON fast-fail)`, async () => {
    await withEnvMany(noCredEnv(g), async () => {
      // No env password AND no rconpw file -> unavailable, and sendCommand
      // fails fast with NO_RCON (no socket is ever opened).
      const conn = g.build(g.serverRow, fakeDockerClient());
      const live = await conn.getLive();
      assert.equal(live.available, false);
      assert.equal(live.reason, g.getLiveGate.reason);
      await assert.rejects(() => conn.sendCommand('status'), (e) => e.code === 'NO_RCON');
    });
  });

  test(`goldens/${g.id}: every advertised live action sends its exact RCON command`, async () => {
    const commands = await capture(g, async (conn) => {
      for (const a of g.liveActions) await conn.runLiveAction(a.key);
    });
    assert.deepEqual(commands, g.liveActions.map((a) => a.cmd));
  });

  test(`goldens/${g.id}: every live control sample (incl. clamps) sends its exact RCON command`, async () => {
    const samples = g.liveControls.flatMap((c) => c.samples.map((s) => ({ key: c.key, ...s })));
    const commands = await capture(g, async (conn) => {
      for (const s of samples) await conn.runLiveAction(s.key, s.value);
    });
    assert.deepEqual(commands, samples.map((s) => s.cmd));
  });

  if (g.changeMap) {
    test(`goldens/${g.id}: change_map samples send exact commands; invalid map rejects`, async () => {
      const commands = await capture(g, async (conn) => {
        for (const s of g.changeMap) await conn.runLiveAction('change_map', s.value);
      });
      assert.deepEqual(commands, g.changeMap.map((s) => s.cmd));

      // The map-name guard throws before any RCON I/O.
      const conn = g.build(g.serverRow, fakeDockerClient(credFiles(g)));
      await assert.rejects(() => conn.runLiveAction('change_map', 'bad map!'), (e) => e.code === 'BAD_SETTING');
    });
  }

  test(`goldens/${g.id}: unknown live action rejects BAD_SETTING before any RCON I/O`, async () => {
    const conn = g.build(g.serverRow, fakeDockerClient(credFiles(g)));
    await assert.rejects(() => conn.runLiveAction('bogus_action'), (e) => e.code === 'BAD_SETTING');
  });

  test(`goldens/${g.id}: sendCommand trims + forwards, and rejects bad console input`, async () => {
    const commands = await capture(g, (conn) => conn.sendCommand(g.sendCommand.input));
    assert.deepEqual(commands, [g.sendCommand.cmd]);

    // Validation trio: empty / newline / >512 chars all reject before RCON.
    const conn = g.build(g.serverRow, fakeDockerClient(credFiles(g)));
    for (const bad of ['', 'status\nquit', 'x'.repeat(513)]) {
      await assert.rejects(() => conn.sendCommand(bad), (e) => e.code === 'BAD_SETTING');
    }
  });

  test(`goldens/${g.id}: defaultProfileSettings matches the golden profile doc`, () => {
    const conn = g.build(g.serverRow, fakeDockerClient());
    assert.deepEqual(conn.defaultProfileSettings(), g.profileDefaults);
  });

  test(`goldens/${g.id}: profileSchema groups, field keys, and basic flags match`, async () => {
    const conn = g.build(g.serverRow, fakeDockerClient());
    const schema = await conn.profileSchema();
    assert.deepEqual(schema.groups.map((x) => x.key), g.schemaGroups.map((x) => x.key));
    for (const [i, gg] of g.schemaGroups.entries()) {
      const fields = schema.groups[i].fields;
      assert.deepEqual(fields.map((f) => f.key), gg.fieldKeys, gg.key);
      assert.deepEqual(fields.filter((f) => f.basic === true).map((f) => f.key), gg.basicKeys, gg.key);
    }
  });

  test(`goldens/${g.id}: config-file whitelist matches exactly`, () => {
    const conn = g.build(g.serverRow, fakeDockerClient());
    assert.deepEqual({ ...conn.configFiles }, g.configFiles);
    assert.deepEqual(conn.listConfigFiles(), Object.keys(g.configFiles));
  });

  test(`goldens/${g.id}: update() runs the exact golden recipe`, async () => {
    const client = fakeDockerClient();
    const conn = g.build(g.serverRow, client);
    const res = await conn.update();
    assert.equal(res.ok, true);
    if (g.update.kind === 'exec') {
      assert.deepEqual(client.powerCalls, []);
      const call = client.execCalls.at(-1);
      assert.deepEqual(call.command, g.update.argv);
      assert.equal(call.container, g.serverRow.container);
      assert.equal(call.timeoutMs, g.update.timeoutMs);
    } else {
      assert.deepEqual(client.powerCalls, [['reboot', g.serverRow.container]]);
      assert.deepEqual(client.execCalls, []);
    }
  });
}
