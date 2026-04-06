import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isNewerVersion } from '../src/update.mjs';

describe('update helpers', () => {
  it('detects newer numeric versions', () => {
    assert.equal(isNewerVersion('0.1.0', '0.1.1'), true);
    assert.equal(isNewerVersion('0.1.0', '0.2.0'), true);
    assert.equal(isNewerVersion('1.9.9', '2.0.0'), true);
  });

  it('does not flag equal or older versions as newer', () => {
    assert.equal(isNewerVersion('0.1.0', '0.1.0'), false);
    assert.equal(isNewerVersion('0.2.0', '0.1.9'), false);
  });

  it('treats a stable release as newer than the same prerelease', () => {
    assert.equal(isNewerVersion('0.1.0-beta.1', '0.1.0'), true);
    assert.equal(isNewerVersion('0.1.0', '0.1.0-beta.1'), false);
  });

  it('returns false for malformed versions', () => {
    assert.equal(isNewerVersion('0.1.0', 'latest'), false);
    assert.equal(isNewerVersion('dev', '0.2.0'), false);
  });
});
