import { isAbsolute } from 'path';
import { realFileWithinRoots } from './file-utils.js';

export interface AttachmentMarkerLine {
  raw: string;
  text: string;
  index: number;
}

export interface AttachmentMarkerCandidate {
  lineIndex: number;
  path: string;
  realPath: string | null;
  inline: boolean;
}

export interface AttachmentMarker {
  markerLineIndex: number;
  candidates: AttachmentMarkerCandidate[];
  acceptedCandidates: AttachmentMarkerCandidate[];
}

export function parseAttachmentMarkers(
  content: string,
  allowedRoots: string[]
): { lines: AttachmentMarkerLine[]; markers: AttachmentMarker[] } {
  const lines = content.split(/(?<=\n)/).map((raw, index) => {
    const withoutLineFeed = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
    return {
      raw,
      text: withoutLineFeed.endsWith('\r') ? withoutLineFeed.slice(0, -1) : withoutLineFeed,
      index,
    };
  });
  const markers: AttachmentMarker[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index].text.match(
      /^\[(?:Attachment|添付ファイル)\](?:[ \t]+(.+?))?[ \t]*$/
    );
    if (!marker) continue;

    const candidates: AttachmentMarkerCandidate[] = [];
    if (marker[1]) candidates.push(candidate(lines[index].index, marker[1], true, allowedRoots));

    let nextIndex = index + 1;
    while (nextIndex < lines.length) {
      const bullet = lines[nextIndex].text.match(/^[ \t]*-[ \t]+(.+?)[ \t]*$/);
      if (!bullet) break;
      candidates.push(candidate(lines[nextIndex].index, bullet[1], false, allowedRoots));
      nextIndex += 1;
    }

    const acceptedCandidates: AttachmentMarkerCandidate[] = [];
    for (const item of candidates) {
      if (!item.realPath) break;
      acceptedCandidates.push(item);
    }
    markers.push({ markerLineIndex: lines[index].index, candidates, acceptedCandidates });
    index = nextIndex - 1;
  }

  return { lines, markers };
}

function candidate(
  lineIndex: number,
  rawPath: string,
  inline: boolean,
  allowedRoots: string[]
): AttachmentMarkerCandidate {
  const path = rawPath.trim();
  return {
    lineIndex,
    path,
    realPath: isAbsolute(path) ? realFileWithinRoots(path, allowedRoots) : null,
    inline,
  };
}
