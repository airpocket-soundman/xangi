export function requireWorkspaceTestAgyVersion(output: string): string {
  const version = output.trim();
  // Agy 1.4.3 emits "1.4.3\n" (captured in fixtures). Only stable releases are supported;
  // even a newer prerelease is not evidence that the production fix is present.
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) {
    throw new Error(`Cannot verify Agy version for workspace tests: ${JSON.stringify(version)}`);
  }
  if (match[4]) {
    throw new Error(`Workspace tests require a stable Agy release; found ${version}`);
  }
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (major < 1 || (major === 1 && (minor < 4 || (minor === 4 && patch < 3)))) {
    throw new Error(`Workspace tests require Agy >= 1.4.3; found ${version}`);
  }
  return version;
}

export function hasWorkspaceWriteRecovery(warnings: readonly (readonly unknown[])[]): boolean {
  return warnings.some((args) =>
    args.some(
      (value) =>
        typeof value === 'string' &&
        value.includes('failed workspace write without ArtifactMetadata')
    )
  );
}
