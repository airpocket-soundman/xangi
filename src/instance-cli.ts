import { fileURLToPath } from 'node:url';

/** Shell-quoted CLI belonging to this running checkout, independent of PATH. */
export const instanceCliCommand =
  "'" + fileURLToPath(new URL('../bin/xangi', import.meta.url)).replaceAll("'", "'\\''") + "'";

/** Normalize only our quoted executable for command inspection, never execution. */
export function normalizeInstanceCliCommand(command: string): string {
  return command.startsWith(instanceCliCommand) &&
    /^\s/.test(command.slice(instanceCliCommand.length))
    ? `xangi${command.slice(instanceCliCommand.length)}`
    : command;
}
