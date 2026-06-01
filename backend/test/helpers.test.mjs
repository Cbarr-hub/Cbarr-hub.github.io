import assert from 'node:assert/strict';
import test from 'node:test';

import { validateLiveCommand } from '../src/servers/rcon.js';
import { timestamp, safeBase, NAME_RE, r2Path, r2Dir } from '../src/servers/backups.js';
import {
  badSetting, notFound, notSupported, duplicateError, MAP_NAME_RE, SAFE_NAME_RE,
} from '../src/servers/errors.js';

test('validateLiveCommand trims and returns a normal command', () => {
  assert.equal(validateLiveCommand('  status  '), 'status');
});

test('validateLiveCommand rejects empty, too-long, and multiline input', () => {
  assert.throws(() => validateLiveCommand(''), (e) => e.code === 'BAD_SETTING');
  assert.throws(() => validateLiveCommand('   '), (e) => e.code === 'BAD_SETTING');
  assert.throws(() => validateLiveCommand('a'.repeat(513)), (e) => e.code === 'BAD_SETTING');
  assert.throws(() => validateLiveCommand('changelevel x\nrcon_password y'), (e) => e.code === 'BAD_SETTING');
});

test('backups.timestamp renders UTC YYYYMMDD_HHMMSS', () => {
  assert.equal(timestamp(new Date('2026-01-02T03:04:05Z')), '20260102_030405');
});

test('backups.safeBase keeps valid names, falls back otherwise', () => {
  assert.equal(safeBase('my_save-1', 'fallback'), 'my_save-1');
  assert.equal(safeBase('has spaces!', 'fallback'), 'fallback');
  assert.equal(safeBase('', 'fallback'), 'fallback');
});

test('backups NAME_RE + R2 path builders', () => {
  assert.ok(NAME_RE.test('world_20260102_030405'));
  assert.ok(!NAME_RE.test('bad name'));
  assert.equal(r2Dir('factorio'), 'r2:gamertown-backups/factorio/');
  assert.equal(r2Path('minecraft', 'w1', '.tar.gz'), 'r2:gamertown-backups/minecraft/w1.tar.gz');
});

test('errors factories set the right .code (and message for notSupported)', () => {
  assert.equal(badSetting('x').code, 'BAD_SETTING');
  assert.equal(notFound('x not found').code, 'NOT_FOUND');
  assert.equal(notSupported('backups').code, 'NOT_SUPPORTED');
  assert.equal(notSupported('backups').message, 'this server has no backups');
});

test('duplicateError maps UNIQUE violations to BAD_SETTING, passes others through', () => {
  const uniq = new Error('UNIQUE constraint failed: configs.name');
  const mapped = duplicateError(uniq, 'main', 'config');
  assert.equal(mapped.code, 'BAD_SETTING');
  assert.match(mapped.message, /a config named "main" already exists/);

  const other = new Error('disk full');
  assert.equal(duplicateError(other, 'main', 'config'), other); // unchanged
});

test('shared name regexes accept/reject as documented', () => {
  assert.ok(MAP_NAME_RE.test('ttt_clue_se'));
  assert.ok(!MAP_NAME_RE.test('Bad Map!'));
  assert.ok(SAFE_NAME_RE.test('My-World_1'));
  assert.ok(!SAFE_NAME_RE.test('bad/name'));
});
