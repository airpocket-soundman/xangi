import { isAbsolute } from 'path';
import { parseAttachmentMarkers } from './attachment-markers.js';
import { realFileWithinRoots } from './file-utils.js';

export function isRealFileWithin(root: string, target: string): boolean {
  return isAbsolute(target) && realFileWithinRoots(target, [root]) !== null;
}

export function parseDisplayedUserAttachments(
  content: string,
  allowedRoots: string[]
): { content: string; attachments: string[] } {
  const attachments: string[] = [];
  const parsed = parseAttachmentMarkers(content, allowedRoots);
  const removedLines = new Set<number>();

  for (const marker of parsed.markers) {
    removedLines.add(marker.markerLineIndex);
    for (const candidate of marker.candidates) {
      if (!candidate.inline) removedLines.add(candidate.lineIndex);
    }
    for (const candidate of marker.candidates) {
      if (candidate.realPath && !attachments.includes(candidate.path)) {
        attachments.push(candidate.path);
      }
    }
  }

  return {
    content: parsed.lines
      .filter((line) => !removedLines.has(line.index))
      .map((line) => line.raw)
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    attachments,
  };
}
