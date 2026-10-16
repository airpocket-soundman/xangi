import { fileURLToPath } from 'node:url';

/** Shell-quoted CLI belonging to this running checkout, independent of PATH. */
export const instanceCliCommand =
  "'" + fileURLToPath(new URL('../bin/xangi', import.meta.url)).replaceAll("'", "'\\''") + "'";
