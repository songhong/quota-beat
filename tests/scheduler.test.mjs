import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPlist,
  normalizeTime,
  parsePmsetRepeatOutput,
  parseScheduledTime,
} from '../src/scheduler.mjs';

describe('scheduler helpers', () => {
  it('normalizes strict HH:MM input', () => {
    assert.equal(normalizeTime('07:00'), '07:00');
    assert.equal(normalizeTime('00:05'), '00:05');
  });

  it('rejects malformed or out-of-range times', () => {
    assert.throws(() => normalizeTime('7:00'), /HH:MM/);
    assert.throws(() => normalizeTime('24:00'), /between 00:00 and 23:59/);
    assert.throws(() => normalizeTime('08:60'), /between 00:00 and 23:59/);
  });

  it('builds a plist that round-trips through parseScheduledTime', () => {
    const plist = buildPlist(
      '08:30',
      '/opt/homebrew/bin/node',
      '/usr/local/lib/node_modules/quota-beat/bin/qbeat.mjs',
      '/tmp/quota-beat-logs',
      '/opt/homebrew/bin'
    );

    assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
    assert.match(plist, /<string>\/usr\/local\/lib\/node_modules\/quota-beat\/bin\/qbeat\.mjs<\/string>/);
    assert.match(plist, /<key>PATH<\/key>/);
    assert.doesNotMatch(plist, /<key>RunAtLoad<\/key>/);
    assert.match(plist, /\/opt\/homebrew\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/);
    assert.equal(parseScheduledTime(plist), '08:30');
  });

  it('fails when the plist is missing the calendar interval', () => {
    assert.throws(() => parseScheduledTime('<plist></plist>'), /Could not parse Hour\/Minute/);
  });

  it('parses pmset repeat output', () => {
    const output = `Scheduled power events:
 Repeating:
  wakeorpoweron at 06:58:00
`;
    assert.equal(parsePmsetRepeatOutput(output), '06:58:00');
  });

  it('returns null when no repeat is configured', () => {
    const output = `Scheduled power events:\n`;
    assert.equal(parsePmsetRepeatOutput(output), null);
  });
});
