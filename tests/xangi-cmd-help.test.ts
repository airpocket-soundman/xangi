import { afterEach, describe, expect, it } from 'vitest';
import { XANGI_CMD_HELP_ENTRIES, formatXangiCmdHelp } from '../src/cli/xangi-cmd-help.js';
import { parseScheduleInput } from '../src/scheduler.js';

describe('xangi tool help', () => {
  it.each(['workspace', 'agent', 'team'])('管理helpは正規形式だけを案内する: %s', (name) => {
    const help = formatXangiCmdHelp(name);
    expect(help).toContain(`xangi ${name} `);
    expect(help).not.toContain(`xangi tool ${name}`);
    expect(help).not.toContain('--action');
  });

  it('コマンド名を重複させない', () => {
    const names = XANGI_CMD_HELP_ENTRIES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('一覧、topic、command詳細を表示する', () => {
    expect(formatXangiCmdHelp()).toContain('xangi tool help <topic|command>');
    expect(formatXangiCmdHelp('extension_request')).toContain('--query-json <json-object>');
    expect(formatXangiCmdHelp('extension_request')).toContain('--query-json-stdin');
    expect(formatXangiCmdHelp('extension_uninstall')).toContain('--id <extension-id>');
    expect(formatXangiCmdHelp('schedule')).toContain('xangi tool schedule_add');
    expect(formatXangiCmdHelp('schedule_add')).toContain(
      'Usage: xangi tool schedule_add --input <schedule-and-message>'
    );
    expect(formatXangiCmdHelp('schedule')).toContain('xangi tool schedule_update');
    expect(formatXangiCmdHelp('schedule_update')).toContain(
      'Usage: xangi tool schedule_update --id <schedule-id>'
    );
    expect(formatXangiCmdHelp('settings')).toContain('xangi tool runtime_settings');
    expect(formatXangiCmdHelp('models')).toContain('exact returned IDs');
    expect(formatXangiCmdHelp('runtime_settings')).toContain('explicitly requests');
    expect(formatXangiCmdHelp('runtime_settings')).toContain('--scope <channel|global>');
    expect(formatXangiCmdHelp('trigger')).toContain('Use schedule for timed checks');
    expect(formatXangiCmdHelp('system_restart')).toContain('After recovery, verify status');
    expect(formatXangiCmdHelp('progress')).toContain('xangi tool progress_card');
    expect(formatXangiCmdHelp('progress_card')).toContain('--plan-json');
    expect(formatXangiCmdHelp('remote_worker')).toContain('executionPolicy');
    expect(formatXangiCmdHelp('inter_chat_ask')).toContain('--to <instance_id>');
    expect(formatXangiCmdHelp('inter_chat_ask')).toContain('not user approval');
  });

  it('未知のtopicやcommandを拒否する', () => {
    expect(() => formatXangiCmdHelp('missing')).toThrow('Unknown help topic or command');
  });
  describe('schedule_add の書き方の例', () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it('helpに載っている書き方はすべて予定として受け付けられる', () => {
      process.env.TZ = 'Asia/Tokyo';
      const examples = [...formatXangiCmdHelp('schedule_add').matchAll(/--input "([^"]+)"/g)].map(
        (m) => m[1].replace('<message>', 'Send a reminder')
      );

      // 実行時刻に依存しない形へ縮めて比べる
      const summary = Object.fromEntries(
        examples.map((input) => {
          const parsed = parseScheduleInput(input);
          if (!parsed) return [input, null];
          if (parsed.type === 'cron')
            return [input, { type: 'cron', expression: parsed.expression }];
          return [
            input,
            input.startsWith('2026-') ? { type: 'once', runAt: parsed.runAt } : { type: 'once' },
          ];
        })
      );
      expect(summary).toEqual({
        '30分後 Send a reminder': { type: 'once' },
        '15:30 Send a reminder': { type: 'once' },
        '2026-10-20 09:00 Send a reminder': { type: 'once', runAt: '2026-10-20T00:00:00.000Z' },
        '毎日 9:00 Send a reminder': { type: 'cron', expression: '0 9 * * *' },
        '毎週月曜 10:00 Send a reminder': { type: 'cron', expression: '0 10 * * 1' },
        '毎時 Send a reminder': { type: 'cron', expression: '0 * * * *' },
        'cron 0 9 * * * Send a reminder': { type: 'cron', expression: '0 9 * * *' },
      });
    });
  });
});
