import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type FavoriteAction = 'add' | 'remove' | 'up' | 'down' | 'rename';

export function parseFavoriteAction(input: unknown): {
  id: string;
  action: FavoriteAction;
  displayName?: string;
} {
  if (!input || typeof input !== 'object') throw new Error('操作を指定してください');
  const { id, action, displayName } = input as Record<string, unknown>;
  if (
    typeof id !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) ||
    typeof action !== 'string' ||
    !['add', 'remove', 'up', 'down', 'rename'].includes(action)
  ) {
    throw new Error('お気に入りの操作が不正です');
  }
  if (action === 'rename') {
    if (
      typeof displayName !== 'string' ||
      displayName.length > 80 ||
      [...displayName].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw new Error('表示名は80文字以内の1行で入力してください');
    return { id, action, displayName: displayName.trim() };
  }
  return { id, action: action as FavoriteAction };
}

export interface FavoriteEntry {
  id: string;
  displayName?: string;
}

export function defaultExtensionName(name: string): string {
  return name.replace(/^xangi-/i, '') || name;
}

export class ExtensionFavorites {
  constructor(private readonly filePath: string) {}

  entries(): FavoriteEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 100)
      throw new Error('お気に入り設定を読み込めません');
    const entries = value.map((item: unknown) => {
      if (typeof item === 'string') {
        parseFavoriteAction({ id: item, action: 'add' });
        return { id: item };
      }
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new Error('お気に入り設定を読み込めません');
      const entry = item as FavoriteEntry;
      parseFavoriteAction({ id: entry.id, action: 'add' });
      if (entry.displayName !== undefined) parseFavoriteAction({ ...entry, action: 'rename' });
      return { id: entry.id, ...(entry.displayName ? { displayName: entry.displayName } : {}) };
    });
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
      throw new Error('お気に入り設定を読み込めません');
    return entries;
  }

  list(): string[] {
    return this.entries().map((entry) => entry.id);
  }

  update(id: string, action: FavoriteAction, displayName?: string): string[] {
    const parsed = parseFavoriteAction({ id, action, displayName });
    const ids = this.entries();
    const index = ids.findIndex((entry) => entry.id === id);
    if (action === 'add' && index < 0) {
      if (ids.length >= 100) throw new Error('お気に入りは100件まで登録できます');
      ids.push({ id });
    }
    if (action === 'rename') {
      if (index < 0) throw new Error('お気に入りが見つかりません');
      ids[index] = { id, ...(parsed.displayName ? { displayName: parsed.displayName } : {}) };
    }
    if (action === 'remove' && index >= 0) ids.splice(index, 1);
    const next = index + (action === 'up' ? -1 : 1);
    if ((action === 'up' || action === 'down') && index >= 0 && next >= 0 && next < ids.length) {
      [ids[index], ids[next]] = [ids[next], ids[index]];
    }
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(ids) + '\n', { mode: 0o600 });
    renameSync(temporary, this.filePath);
    return ids.map((entry) => entry.id);
  }
}
