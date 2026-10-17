import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { isImageFile, getMimeType, extractAttachmentPaths } from '../src/local-llm/image-utils.js';

describe('isImageFile', () => {
  it('should return true for supported image extensions', () => {
    expect(isImageFile('/tmp/photo.jpg')).toBe(true);
    expect(isImageFile('/tmp/photo.jpeg')).toBe(true);
    expect(isImageFile('/tmp/photo.png')).toBe(true);
    expect(isImageFile('/tmp/photo.gif')).toBe(true);
    expect(isImageFile('/tmp/photo.webp')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(isImageFile('/tmp/photo.JPG')).toBe(true);
    expect(isImageFile('/tmp/photo.PNG')).toBe(true);
    expect(isImageFile('/tmp/photo.WebP')).toBe(true);
  });

  it('should return false for non-image files', () => {
    expect(isImageFile('/tmp/document.pdf')).toBe(false);
    expect(isImageFile('/tmp/script.py')).toBe(false);
    expect(isImageFile('/tmp/data.json')).toBe(false);
    expect(isImageFile('/tmp/archive.zip')).toBe(false);
    expect(isImageFile('/tmp/noext')).toBe(false);
  });
});

describe('getMimeType', () => {
  it('should return correct MIME type for image extensions', () => {
    expect(getMimeType('/tmp/photo.jpg')).toBe('image/jpeg');
    expect(getMimeType('/tmp/photo.jpeg')).toBe('image/jpeg');
    expect(getMimeType('/tmp/photo.png')).toBe('image/png');
    expect(getMimeType('/tmp/photo.gif')).toBe('image/gif');
    expect(getMimeType('/tmp/photo.webp')).toBe('image/webp');
  });

  it('should return application/octet-stream for unknown extensions', () => {
    expect(getMimeType('/tmp/file.xyz')).toBe('application/octet-stream');
  });
});

describe('extractAttachmentPaths', () => {
  let testDir: string;
  let allowedRoot: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'xangi-image-utils-'));
    allowedRoot = join(testDir, 'allowed');
    mkdirSync(allowedRoot);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const createAllowedFile = (name: string): string => {
    const filePath = join(allowedRoot, name);
    writeFileSync(filePath, name);
    return filePath;
  };

  it.each(['Attachment', '添付ファイル'])(
    'supports %s markers without changing the message or paths',
    (marker) => {
      const image = createAllowedFile('cat.jpg');
      const document = createAllowedFile('document.pdf');
      const result = extractAttachmentPaths(
        `確認して\n\n[${marker}]\n  - ${image}\n  - ${document}`,
        [allowedRoot]
      );
      expect(result).toEqual({
        imagePaths: [image],
        otherPaths: [document],
        cleanPrompt: `確認して\n\n[${marker}]\n  - ${document}`,
      });
    }
  );

  it('should return empty arrays when no attachments', () => {
    const result = extractAttachmentPaths('Hello, world!', [allowedRoot]);
    expect(result.imagePaths).toEqual([]);
    expect(result.otherPaths).toEqual([]);
    expect(result.cleanPrompt).toBe('Hello, world!');
  });

  it('should extract image paths from attachment section', () => {
    const photo = createAllowedFile('photo.jpg');
    const screenshot = createAllowedFile('screenshot.png');
    const prompt = `この画像を分析して\n\n[添付ファイル]\n  - ${photo}\n  - ${screenshot}`;
    const result = extractAttachmentPaths(prompt, [allowedRoot]);
    expect(result.imagePaths).toEqual([photo, screenshot]);
    expect(result.otherPaths).toEqual([]);
    expect(result.cleanPrompt).toBe('この画像を分析して');
  });

  it('should separate image and non-image paths', () => {
    const photo = createAllowedFile('photo.jpg');
    const data = createAllowedFile('data.csv');
    const image = createAllowedFile('image.png');
    const prompt = `ファイルを確認して\n\n[添付ファイル]\n  - ${photo}\n  - ${data}\n  - ${image}`;
    const result = extractAttachmentPaths(prompt, [allowedRoot]);
    expect(result.imagePaths).toEqual([photo, image]);
    expect(result.otherPaths).toEqual([data]);
    expect(result.cleanPrompt).toBe(`ファイルを確認して\n\n[添付ファイル]\n  - ${data}`);
  });

  it('should handle only non-image attachments', () => {
    const data = createAllowedFile('data.json');
    const script = createAllowedFile('script.py');
    const prompt = `ファイルを読んで\n\n[添付ファイル]\n  - ${data}\n  - ${script}`;
    const result = extractAttachmentPaths(prompt, [allowedRoot]);
    expect(result.imagePaths).toEqual([]);
    expect(result.otherPaths).toEqual([data, script]);
    expect(result.cleanPrompt).toBe(prompt);
  });

  it('should handle prompt with no text before attachments', () => {
    const photo = createAllowedFile('photo.jpg');
    const prompt = `添付ファイルを確認してください\n\n[添付ファイル]\n  - ${photo}`;
    const result = extractAttachmentPaths(prompt, [allowedRoot]);
    expect(result.imagePaths).toEqual([photo]);
    expect(result.cleanPrompt).toBe('添付ファイルを確認してください');
  });

  it('should extract a same-line image attachment', () => {
    const photo = createAllowedFile('photo.png');
    expect(extractAttachmentPaths(`画像を確認して\n[Attachment] ${photo}`, [allowedRoot])).toEqual({
      imagePaths: [photo],
      otherPaths: [],
      cleanPrompt: '画像を確認して',
    });
  });

  it('should extract consecutive same-line attachments and remove duplicates', () => {
    const photo = createAllowedFile('photo.png');
    const document = createAllowedFile('report.pdf');
    const result = extractAttachmentPaths(
      `ファイルを確認して\n[Attachment] ${photo}\n[Attachment] ${document}\n[Attachment] ${photo}`,
      [allowedRoot]
    );
    expect(result).toEqual({
      imagePaths: [photo],
      otherPaths: [document],
      cleanPrompt: `ファイルを確認して\n[Attachment] ${document}`,
    });
  });

  it('should preserve system context after a same-line attachment', () => {
    const photo = createAllowedFile('photo.png');
    const prompt = `画像を確認して\n[Attachment] ${photo}\n\n[system-context]\n返信候補を生成してください`;
    const result = extractAttachmentPaths(prompt, [allowedRoot]);
    expect(result.imagePaths).toEqual([photo]);
    expect(result.cleanPrompt).toBe(
      '画像を確認して\n\n[system-context]\n返信候補を生成してください'
    );
  });

  it('should preserve text after an unindented attachment list', () => {
    const photo = createAllowedFile('photo.png');
    const document = createAllowedFile('report.pdf');
    const prompt = `[Attachment]\n- ${photo}\n- ${document}\nこの本文は残してください`;
    expect(extractAttachmentPaths(prompt, [allowedRoot])).toEqual({
      imagePaths: [photo],
      otherPaths: [document],
      cleanPrompt: `[Attachment]\n- ${document}\nこの本文は残してください`,
    });
  });

  it('should keep supporting indented attachment lists', () => {
    const photo = createAllowedFile('photo.png');
    const document = createAllowedFile('report.pdf');
    expect(
      extractAttachmentPaths(`確認して\n\n[Attachment]\n  - ${photo}\n  - ${document}`, [
        allowedRoot,
      ])
    ).toEqual({
      imagePaths: [photo],
      otherPaths: [document],
      cleanPrompt: `確認して\n\n[Attachment]\n  - ${document}`,
    });
  });

  it('should leave ordinary bullet lists unchanged', () => {
    const prompt = '  確認事項\n- foo\n- bar\n  ';
    expect(extractAttachmentPaths(prompt, [allowedRoot])).toEqual({
      imagePaths: [],
      otherPaths: [],
      cleanPrompt: prompt,
    });
  });

  it('should extract a same-line attachment with the legacy marker', () => {
    const photo = createAllowedFile('photo.webp');
    expect(
      extractAttachmentPaths(`画像を確認して\n[添付ファイル] ${photo}`, [allowedRoot])
    ).toEqual({
      imagePaths: [photo],
      otherPaths: [],
      cleanPrompt: '画像を確認して',
    });
  });

  it('should not re-extract attachments from prefetched Web history', () => {
    const oldPhoto = createAllowedFile('old.png');
    const currentPhoto = createAllowedFile('current.png');
    const prompt = [
      '<prefetched-history platform="Web">',
      'xangi has prefetched recent history for initial context.',
      `[2026/10/16 10:00:00] (ID:old-message) ユーザー: [Attachment] ${oldPhoto}`,
      '</prefetched-history>',
      'Do not run a history command again solely for initial context.',
      '',
      '今回の画像を確認して',
      `[Attachment] ${currentPhoto}`,
    ].join('\n');
    const result = extractAttachmentPaths(prompt, [allowedRoot]);
    expect(result.imagePaths).toEqual([currentPhoto]);
    expect(result.cleanPrompt).toContain(`ユーザー: [Attachment] ${oldPhoto}`);
    expect(result.cleanPrompt).not.toContain(`[Attachment] ${currentPhoto}`);
  });

  it('should stop an unindented attachment list before ordinary bullet text', () => {
    const photo = createAllowedFile('photo.png');
    const prompt = `[Attachment]\n- ${photo}\n- 項目1\n本文`;
    expect(extractAttachmentPaths(prompt, [allowedRoot])).toEqual({
      imagePaths: [photo],
      otherPaths: [],
      cleanPrompt: '- 項目1\n本文',
    });
  });

  it('should collect an existing bullet image after a same-line attachment', () => {
    const first = createAllowedFile('first.png');
    const second = createAllowedFile('second.png');
    const prompt = `[Attachment] ${first}\n- ${second}\n- 項目1`;
    expect(extractAttachmentPaths(prompt, [allowedRoot])).toEqual({
      imagePaths: [first, second],
      otherPaths: [],
      cleanPrompt: '- 項目1',
    });
  });

  it('should preserve a same-line marker whose value is not a path', () => {
    const example = createAllowedFile('example.png');
    const prompt = `[Attachment] see the spec below\n- ${example}`;
    expect(extractAttachmentPaths(prompt, [allowedRoot])).toEqual({
      imagePaths: [],
      otherPaths: [],
      cleanPrompt: prompt,
    });
  });

  it('should preserve runs of blank lines outside the removed attachment', () => {
    const photo = createAllowedFile('photo.png');
    const prompt = `前の本文\n\n[Attachment] ${photo}\n\n後ろの本文\n\n\nコード例`;
    expect(extractAttachmentPaths(prompt, [allowedRoot]).cleanPrompt).toBe(
      '前の本文\n\n後ろの本文\n\n\nコード例'
    );
  });

  it('should recognize a same-line attachment in a CRLF prompt without changing other line endings', () => {
    const photo = createAllowedFile('photo.png');
    const prompt = `画像を確認して\r\n[Attachment] ${photo}\r\n後続本文`;
    expect(extractAttachmentPaths(prompt, [allowedRoot])).toEqual({
      imagePaths: [photo],
      otherPaths: [],
      cleanPrompt: '画像を確認して\r\n後続本文',
    });
  });

  it('should preserve a non-image attachment at its original position', () => {
    const document = createAllowedFile('report.pdf');
    const prompt = `前の本文\n[Attachment] ${document}\n後ろの本文`;
    expect(extractAttachmentPaths(prompt, [allowedRoot])).toEqual({
      imagePaths: [],
      otherPaths: [document],
      cleanPrompt: prompt,
    });
  });

  it('should preserve the marker and non-image items in a mixed attachment list', () => {
    const photo = createAllowedFile('photo.png');
    const document = createAllowedFile('report.pdf');
    const diagram = createAllowedFile('diagram.jpg');
    const prompt = `確認して\n\n[Attachment]\n  - ${photo}\n  - ${document}\n  - ${diagram}\n\n後続本文`;
    expect(extractAttachmentPaths(prompt, [allowedRoot])).toEqual({
      imagePaths: [photo, diagram],
      otherPaths: [document],
      cleanPrompt: `確認して\n\n[Attachment]\n  - ${document}\n\n後続本文`,
    });
  });

  it('should reject an existing image outside the allowed roots', () => {
    const outside = join(testDir, 'outside.png');
    writeFileSync(outside, 'outside');
    const prompt = `[Attachment] ${outside}`;
    expect(extractAttachmentPaths(prompt, [allowedRoot])).toEqual({
      imagePaths: [],
      otherPaths: [],
      cleanPrompt: prompt,
    });
  });

  it('should preserve a nonexistent absolute image path', () => {
    const missing = join(allowedRoot, 'missing.png');
    const prompt = `[Attachment] ${missing}`;
    expect(extractAttachmentPaths(prompt, [allowedRoot])).toEqual({
      imagePaths: [],
      otherPaths: [],
      cleanPrompt: prompt,
    });
  });

  it.each(['~/x.png', './x.png', '../x.png', 'x.png'])(
    'should reject non-absolute path %s',
    (filePath) => {
      const prompt = `[Attachment] ${filePath}`;
      expect(extractAttachmentPaths(prompt, [allowedRoot])).toEqual({
        imagePaths: [],
        otherPaths: [],
        cleanPrompt: prompt,
      });
    }
  );

  it('should reject a real path with a trailing annotation', () => {
    const photo = createAllowedFile('photo.png');
    const prompt = `[Attachment] ${photo} (screenshot)`;
    expect(extractAttachmentPaths(prompt, [allowedRoot])).toEqual({
      imagePaths: [],
      otherPaths: [],
      cleanPrompt: prompt,
    });
  });
  it.each(['missing', 'outside'])('keeps valid images after a %s attachment', (kind) => {
    const good = createAllowedFile('good.png');
    const rejected =
      kind === 'missing' ? join(allowedRoot, 'missing.png') : join(testDir, 'outside.png');
    if (kind === 'outside') writeFileSync(rejected, 'outside');
    const prompt = `確認して\n\n[Attachment]\n  - ${rejected}\n  - ${good}`;
    expect(extractAttachmentPaths(prompt, [allowedRoot])).toEqual({
      imagePaths: [good],
      otherPaths: [],
      cleanPrompt: `確認して\n\n[Attachment]\n  - ${rejected}`,
    });
  });

  it('keeps an invalid inline attachment while extracting a later valid image', () => {
    const good = createAllowedFile('good.png');
    const missing = join(allowedRoot, 'missing.png');
    const prompt = `[Attachment] ${missing}\n- ${good}`;
    expect(extractAttachmentPaths(prompt, [allowedRoot])).toEqual({
      imagePaths: [good],
      otherPaths: [],
      cleanPrompt: `[Attachment] ${missing}`,
    });
  });

  it('does not extract a path after ordinary bullet text', () => {
    const good = createAllowedFile('good.png');
    const prompt = `[Attachment]\n- 項目1\n- ${good}`;
    expect(extractAttachmentPaths(prompt, [allowedRoot]).imagePaths).toEqual([]);
    expect(extractAttachmentPaths(prompt, [allowedRoot]).cleanPrompt).toBe(prompt);
  });

  it('preserves the marker for a document after an inline image', () => {
    const good = createAllowedFile('good.png');
    const doc = createAllowedFile('report.pdf');
    expect(extractAttachmentPaths(`[Attachment] ${good}\n- ${doc}`, [allowedRoot])).toEqual({
      imagePaths: [good],
      otherPaths: [doc],
      cleanPrompt: `[Attachment]\n- ${doc}`,
    });
  });
});
