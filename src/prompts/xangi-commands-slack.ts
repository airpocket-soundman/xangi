import { instanceCliCommand } from '../instance-cli.js';

export const XANGI_COMMANDS_SLACK = `## Slack rules

- For Slack operations, read ${instanceCliCommand} tool help slack or ${instanceCliCommand} tool help <command> when needed.
- Do not pass Slack channel IDs to discord_* tools.
- Identify Slack messages by ts, not Discord message IDs.`;
