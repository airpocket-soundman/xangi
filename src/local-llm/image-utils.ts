/**
 * 画像処理ユーティリティ（Local LLMマルチモーダル対応）
 */
import fs from 'fs';
import path from 'path';
import { parseAttachmentMarkers, type AttachmentMarkerLine } from '../attachment-markers.js';

/** サポートする画像拡張子 */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** 拡張子→MIMEタイプのマッピング */
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * ファイルパスが画像ファイルかどうかを判定
 */
export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * ファイル拡張子からMIMEタイプを取得
 */
export function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * 画像ファイルをbase64エンコードして読み込む
 * @returns base64エンコードされた画像データ、またはファイルが存在しない/読めない場合はnull
 */
export function encodeImageToBase64(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[local-llm] Image file not found: ${filePath}`);
      return null;
    }

    const buffer = fs.readFileSync(filePath);
    return buffer.toString('base64');
  } catch (err) {
    console.warn(
      `[local-llm] Failed to read image file: ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * プロンプトから「[Attachment]」（旧ラベルも対応）のファイルパスを抽出
 * @returns { imagePaths: 画像ファイルパス[], otherPaths: 非画像ファイルパス[], cleanPrompt: 画像の添付行を除去したプロンプト }
 */
export function extractAttachmentPaths(
  prompt: string,
  allowedRoots: string[]
): {
  imagePaths: string[];
  otherPaths: string[];
  cleanPrompt: string;
} {
  const imagePaths: string[] = [];
  const otherPaths: string[] = [];
  const parsed = parseAttachmentMarkers(prompt, allowedRoots);
  const lines = parsed.lines.map((line) => ({ ...line, removed: false }));

  const addPath = (filePath: string): void => {
    const target = isImageFile(filePath) ? imagePaths : otherPaths;
    if (!target.includes(filePath)) target.push(filePath);
  };

  for (const marker of parsed.markers) {
    let hasNonImage = false;
    for (const candidate of marker.acceptedCandidates) {
      const filePath = candidate.realPath;
      if (!filePath) continue;
      addPath(filePath);
      if (isImageFile(filePath)) {
        lines[candidate.lineIndex].removed = true;
      } else {
        hasNonImage = true;
      }
    }
    if (marker.acceptedCandidates.length > 0 && !hasNonImage) {
      lines[marker.markerLineIndex].removed = true;
    }
  }

  if (!lines.some((line) => line.removed)) {
    return { imagePaths, otherPaths, cleanPrompt: prompt };
  }

  collapseBlankLinesAcrossRemoval(lines);

  return {
    imagePaths,
    otherPaths,
    cleanPrompt: lines
      .filter((line) => !line.removed)
      .map((line) => line.raw)
      .join('')
      .trim(),
  };
}

function collapseBlankLinesAcrossRemoval(
  lines: Array<AttachmentMarkerLine & { removed: boolean }>
): void {
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].removed) continue;

    let end = index;
    while (end + 1 < lines.length && lines[end + 1].removed) end += 1;

    let previous = index - 1;
    while (previous >= 0 && lines[previous].removed) previous -= 1;
    if (previous >= 0 && /^[ \t]*$/.test(lines[previous].text)) {
      let next = end + 1;
      while (next < lines.length && !lines[next].removed && /^[ \t]*$/.test(lines[next].text)) {
        lines[next].removed = true;
        next += 1;
      }
    }

    index = end;
  }
}
