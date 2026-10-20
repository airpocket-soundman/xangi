import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  hasWorkspaceWriteRecovery,
  requireWorkspaceTestAgyVersion,
} from './helpers/antigravity-workspace.js';

describe('live Agy workspace test guards', () => {
  it.each(['\n', '\r\n'])('accepts the captured Agy version with line ending %j', (lineEnding) => {
    const stdout = readFileSync(
      new URL('./fixtures/antigravity-version-1.4.3.txt', import.meta.url),
      'utf8'
    );
    const normalized = stdout.replace(/\r\n/g, '\n');
    expect(normalized).toBe('1.4.3\n');
    expect(requireWorkspaceTestAgyVersion(stdout)).toBe('1.4.3');
    expect(requireWorkspaceTestAgyVersion(normalized.replace(/\n/g, lineEnding))).toBe('1.4.3');
  });

  it.each(['1.4.3', 'v1.4.3\n', '1.4.10', '1.5.0', '2.0.0', '1.4.3+build.1', '1.4.3+build-beta'])(
    'accepts supported version %s',
    (version) => {
      expect(requireWorkspaceTestAgyVersion(version)).toBe(version.trim());
    }
  );

  it.each(['0.9.0', '1.3.99', '1.4.2'])(
    'rejects old version %s before starting a model turn',
    (version) => {
      expect(() => requireWorkspaceTestAgyVersion(version)).toThrow('require Agy >= 1.4.3');
    }
  );

  it.each(['', 'unknown', '1.4'])(
    'fails clearly when version cannot be verified: %s',
    (version) => {
      expect(() => requireWorkspaceTestAgyVersion(version)).toThrow('Cannot verify Agy version');
    }
  );

  it.each(['1.4.3-beta.1', '1.5.0-beta', '2.0.0-rc.1', 'v1.5.0-beta+build.1'])(
    'intentionally rejects prereleases, including newer release lines: %s',
    (version) => {
      expect(() => requireWorkspaceTestAgyVersion(version)).toThrow(
        `Workspace tests require a stable Agy release; found ${version}`
      );
    }
  );

  it.each(['Retrying', 'Continuing'])(
    'detects the %s workspace-write recovery warning',
    (action) => {
      expect(
        hasWorkspaceWriteRecovery([
          [
            `[antigravity] ${action} failed workspace write without ArtifactMetadata in conversation abc...`,
          ],
        ])
      ).toBe(true);
    }
  );

  it('does not mistake unrelated retry warnings for write recovery', () => {
    expect(hasWorkspaceWriteRecovery([['Retrying agy --help once'], ['other warning']])).toBe(
      false
    );
    expect(hasWorkspaceWriteRecovery([])).toBe(false);
  });
});
