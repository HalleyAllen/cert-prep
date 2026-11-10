import type { Unit, UnitVisual } from './model';

export type ReadingPart = { unit: Unit; start: number; end: number; gap: string; first: boolean };
export type ReadingBlock =
  | { kind: 'paragraph'; parts: ReadingPart[] }
  | { kind: 'heading'; part: ReadingPart; title: string; depth: number; local?: boolean }
  | { kind: 'visual'; part: ReadingPart; visual: UnitVisual; index: number };

const chineseChapter = /^第\s*([一二三四五六七八九十百零〇两\d]+)\s*章/u;
const englishChapter = /^chapter\s+(\d+)\b/iu;
const listStart = /^(?:[●•▪◆]|[（(]\s*\d+\s*[）)]|\d+[.、)]\s*(?!\d))/u;
const stops = /[。！？；.!?;：:][」』”’）)]*$/u;
const hasHan = /\p{Script=Han}/u;

function chapterNumber(title: string) {
  const ordinal = (chineseChapter.exec(title.normalize('NFKC').trim()) ?? englishChapter.exec(title.trim()))?.[1];
  if (!ordinal) return undefined;
  if (/^\d+$/u.test(ordinal)) return Number(ordinal);
  const digits = '零一二三四五六七八九';
  const value = (char: string) => digits.indexOf(char === '两' ? '二' : char === '〇' ? '零' : char);
  let sum = 0;
  let last = 0;
  for (const char of ordinal) {
    if (char === '十' || char === '百') { sum += (last || 1) * (char === '十' ? 10 : 100); last = 0; }
    else last = value(char);
  }
  return sum + last;
}

function sourceHeading(line: string, chapter?: number) {
  const title = line.normalize('NFKC').trim();
  if (title.length > 72 || /[。！？；!?;]/u.test(title)) return null;
  if (chineseChapter.test(title) || englishChapter.test(title)) return { title: line.trim(), depth: 1 };
  const match = /^(\d{1,3}(?:\s*\.\s*\d{1,3}){1,4})\s*[.、]?\s*(\p{L}.*)$/u.exec(title);
  if (!match) return null;
  const number = match[1].split('.').map((part) => Number(part.trim()));
  if (number.some((part) => part < 1) || (chapter !== undefined && number[0] !== chapter)) return null;
  return { title: number.join('.') + ' ' + match[2].trim(), depth: number.length };
}

function localHeading(line: string, parentDepth: number, before: string, after: string) {
  if (parentDepth < 2 || before.trim() || (before && !/\n\s*\n/u.test(before))) return null;
  if (after.trim() && !/^[ \t\r]*\n[ \t\r]*\n/u.test(after)) return null;
  const match = /^([1-9]\d?)\s*[.、]\s*(\p{L}[^。！？；，、：!?;,:]{0,31})$/u.exec(line.normalize('NFKC').trim());
  if (!match) return null;
  return { title: match[1] + '. ' + match[2], depth: parentDepth + 1, local: true };
}

function pageJoin(previous: string, next: string) {
  return hasHan.test(previous.at(-1) ?? '') || hasHan.test(next[0] ?? '') || /^[，。！？；、：）】,.)]/u.test(next) ? '' : ' ';
}

export function buildReadingFlow(units: Unit[], chapterTitle = ''): ReadingBlock[] {
  const blocks: ReadingBlock[] = [];
  const selectedNumber = chapterNumber(chapterTitle);
  let currentNumber = selectedNumber;
  let parentDepth = 0;
  for (const unit of units) {
    let first = true;
    let previousLineEnd = 0;
    const visuals = new Map((unit.visuals ?? []).map((visual, index) => [visual.anchor, { visual, index }]));
    for (const match of unit.text.matchAll(/[^\n]+/gu)) {
      const line = match[0];
      const title = line.trim();
      if (!title) continue;
      const start = match.index;
      const end = start + line.trimEnd().length;
      const part: ReadingPart = { unit, start, end, gap: '', first };
      const embedded = visuals.get(title);
      const heading = sourceHeading(line, currentNumber);
      const subheading = heading ? null : localHeading(line, parentDepth, unit.text.slice(previousLineEnd, start), unit.text.slice(end));
      if (embedded) {
        blocks.push({ kind: 'visual', part, ...embedded });
      } else if (heading) {
        if (heading.depth === 1 && selectedNumber === undefined) currentNumber = chapterNumber(heading.title);
        parentDepth = heading.depth;
        blocks.push({ kind: 'heading', part, ...heading });
      } else if (subheading) {
        blocks.push({ kind: 'heading', part, ...subheading });
      } else {
        const previous = blocks.at(-1);
        const last = previous?.kind === 'paragraph' ? previous.parts.at(-1) : undefined;
        const newItem = /^\u3000{1,2}\S/u.test(line) || listStart.test(title);
        if (previous?.kind === 'paragraph' && last && !newItem) {
          const lastText = last.unit.text.slice(last.start, last.end).trimEnd();
          if (last.unit === unit && !/\n\s*\n/u.test(unit.text.slice(last.end, start))) {
            part.gap = '\n';
            previous.parts.push(part);
          } else if (last.unit !== unit && first && !stops.test(lastText)) {
            part.gap = pageJoin(lastText, title);
            previous.parts.push(part);
          } else blocks.push({ kind: 'paragraph', parts: [part] });
        } else blocks.push({ kind: 'paragraph', parts: [part] });
      }
      first = false;
      previousLineEnd = end;
    }
  }
  return blocks;
}
