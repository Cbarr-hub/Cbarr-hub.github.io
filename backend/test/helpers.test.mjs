import assert from 'node:assert/strict';
import test from 'node:test';

import { validateLiveCommand } from '../src/servers/rcon-tcp.js';
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

test('errors factories set the right .code (and message for notSupported)', () => {
  assert.equal(badSetting('x').code, 'BAD_SETTING');
  assert.equal(notFound('x not found').code, 'NOT_FOUND');
  assert.equal(notSupported('profiles').code, 'NOT_SUPPORTED');
  assert.equal(notSupported('profiles').message, 'this server has no profiles');
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
