import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPlist,
  computeKickTimes,
  normalizeTime,
  parsePmsetRepeatOutput,
  parseJitterMinutes,
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
    const plist = buildPlist({
      time: '08:30',
      nodePath: '/opt/homebrew/bin/node',
      scriptPath: '/usr/local/lib/node_modules/@yesongh/quota-beat/bin/qbeat.mjs',
      logDir: '/tmp/quota-beat-logs',
      envPath: '/opt/homebrew/bin',
    });

    assert.match(plist, /<string>\/opt\/homebrew\/bin\/node<\/string>/);
    assert.match(plist, /<string>\/usr\/local\/lib\/node_modules\/@yesongh\/quota-beat\/bin\/qbeat\.mjs<\/string>/);
    assert.match(plist, /<key>PATH<\/key>/);
    assert.doesNotMatch(plist, /<key>RunAtLoad<\/key>/);
    assert.match(plist, /\/opt\/homebrew\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/);
    assert.equal(parseScheduledTime(plist), '08:30');

    // StartCalendarInterval must be an array with 3 entries
    assert.match(plist, /<key>StartCalendarInterval<\/key>\s*<array>/s);
    const dictMatches = [...plist.matchAll(/<dict>\s*<key>Hour<\/key>/g)];
    assert.equal(dictMatches.length, 3, 'plist must have 3 StartCalendarInterval entries');
  });

  it('uses default jitter of 1 minute', () => {
    const plist = buildPlist({
      time: '08:30',
      nodePath: '/usr/local/bin/node',
      scriptPath: '/usr/local/bin/qbeat.mjs',
      logDir: '/tmp/logs',
      envPath: '/usr/local/bin',
    });
    assert.equal(parseJitterMinutes(plist), 1);
  });

  it('embeds custom jitter in plist and round-trips through parseJitterMinutes', () => {
    const plist = buildPlist({
      time: '07:00',
      nodePath: '/usr/local/bin/node',
      scriptPath: '/usr/local/bin/qbeat.mjs',
      logDir: '/tmp/logs',
      envPath: '/usr/local/bin',
      jitterMinutes: 5,
    });
    assert.equal(parseJitterMinutes(plist), 5);
  });

  it('fails when the plist is missing the calendar interval', () => {
    assert.throws(() => parseScheduledTime('<plist></plist>'), /Could not parse Hour\/Minute/);
  });

  it('computeKickTimes returns 3 times spaced 5h apart with jitter offsets', () => {
    // jitter=1: kicks at T, T+301min, T+602min
    const kicks = computeKickTimes('07:00', 1);
    assert.equal(kicks[0], '07:00');
    assert.equal(kicks[1], '12:01');  // 7*60 + 301 = 421 min = 7h1m -> no, 301min from 07:00 = 12:01
    assert.equal(kicks[2], '17:02');  // 602min from 07:00 = 17:02
  });

  it('computeKickTimes wraps around midnight correctly', () => {
    const kicks = computeKickTimes('20:00', 1);
    assert.equal(kicks[0], '20:00');
    assert.equal(kicks[1], '01:01');  // 20:00 + 301min = 25:01 -> 01:01
    assert.equal(kicks[2], '06:02');  // 20:00 + 602min = 30:02 -> 06:02
  });

  it('parses pmset repeat output with a single entry', () => {
    const output = `Scheduled power events:
 Repeating:
  wakeorpoweron at 06:58:00
`;
    assert.deepEqual(parsePmsetRepeatOutput(output), ['06:58:00']);
  });

  it('parses pmset repeat output with multiple entries', () => {
    const output = `Scheduled power events:
 Repeating:
  wakeorpoweron at 06:58:00
  wakeorpoweron at 11:59:00
  wakeorpoweron at 17:00:00
`;
    assert.deepEqual(parsePmsetRepeatOutput(output), ['06:58:00', '11:59:00', '17:00:00']);
  });

  it('returns null when no repeat is configured', () => {
    const output = `Scheduled power events:\n`;
    assert.equal(parsePmsetRepeatOutput(output), null);
  });

  it('computeKickEntries and buildPlist produce consistent kick times', () => {
    const jitter = 3;
    const kicksFromCompute = computeKickTimes('07:00', jitter);
    const plist = buildPlist({
      time: '07:00',
      nodePath: '/usr/local/bin/node',
      scriptPath: '/usr/local/bin/qbeat.mjs',
      logDir: '/tmp/logs',
      envPath: '/usr/local/bin',
      jitterMinutes: jitter,
    });
    const hourMatches = [...plist.matchAll(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g)];
    const kicksFromPlist = hourMatches.map(m => `${m[1].padStart(2, '0')}:${m[2].padStart(2, '0')}`);
    assert.deepEqual(kicksFromPlist, kicksFromCompute);
  });
});
