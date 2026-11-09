import { editMarks, joinMarked } from './rich-text.mjs';
import { chapterLabel } from './pdf-structure.mjs';

const headingPattern = /^(?:第\s*[一二三四五六七八九十百零〇两\d]+\s*[章节篇部]|chapter\s+\d+\b|unit\s+\d+\b|#{1,3}\s+)/iu;
export const isFrontMatter = (text) => /^(?:导言|序言|前言|引言|目录|目次|封面|扉页|版权页|出版说明|编写说明|preface|foreword|introduction|table of contents|contents)$/iu.test(
  text.replace(/^#{1,6}\s+/u, '').replace(/[：:]\s*$/u, '').trim(),
);
export const isChapterHeading = (text) => text.length < 150 && (headingPattern.test(text) || isFrontMatter(text));

export function pageEdge({ x0, y0, x1, y1 }, width, height) {
  if (y1 <= height * 0.12) return 'top';
  if (y0 >= height * 0.88) return 'bottom';
  if (x1 <= width * 0.10) return 'left';
  if (x0 >= width * 0.90) return 'right';
  return null;
}

const explicitPageNumber = /^(?:第\s*\d{1,5}\s*页(?:\s*[/／]?\s*共\s*\d{1,5}\s*页)?|page\s+\d{1,5}(?:\s*(?:of|\/)\s*\d{1,5})?)$/iu;
const barePageNumber = /^(?:[-–—·]\s*)?(\d{1,5})(?:\s*\/\s*\d{1,5}|\s*[-–—·])?$/u;
const advertisement = /(?:最新|全套|考证|备考|网课|课程|资料).{0,26}(?:联系微信|添加微信|微信号)\s*[:：]?\s*[\w-]{4,}/iu;
const watermarkHint = /水印|仅供.{0,8}(?:学习|交流)|公众号|扫描全能王|联系微信|添加微信|微信号|camscanner|https?:\/\/|www\./iu;

function marginCandidate(line, page, hasBody) {
  if (!line.edge) return {};
  const text = line.text.normalize('NFKC').trim();
  if (explicitPageNumber.test(text)) return { pageNumber: true };
  if (advertisement.test(text.replace(/\s+/gu, ''))) return { promotion: true };
  if (!hasBody) return {};
  if (line.edge === 'top' || line.edge === 'bottom') {
    const match = barePageNumber.exec(text);
    if (match) return { numberKey: line.edge + ':' + (Number(match[1]) - page) };
  }
  const compact = text.replace(/\s+/gu, '').replace(/^\d{1,5}(?=\p{L})|\d{1,5}$/gu, '');
  if (compact.length < 4 || compact.length > 120 || !/\p{L}/u.test(compact) || isChapterHeading(text)) return {};
  return { watermarkKey: line.edge + ':' + compact.toLowerCase(), marked: watermarkHint.test(compact) };
}

const closeFor = new Map([['(', ')'], ['（', '）'], ['[', ']'], ['［', '］'], ['【', '】'], ['{', '}'], ['｛', '｝']]);
const closeBrackets = new Set(closeFor.values());
const annotation = String.raw`(?:(?:参见|详见|见)[图表]\s*[0-9０-９]+(?:[.．－-][0-9０-９]+)*|(?:以下简称|简称为?)\s*[\p{Script=Han}A-Za-z0-9]{1,16})`;

function repairBrackets({ text, marks }) {
  const characters = text.split('');
  const insertions = [];
  const stack = [];
  const unclosed = new Set();
  const orphaned = new Set();
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (closeFor.has(char)) {
      stack.push(index);
      unclosed.add(index);
    } else if (closeBrackets.has(char)) {
      const opening = stack.at(-1);
      if (opening === undefined) {
        orphaned.add(index);
        continue;
      }
      const expected = closeFor.get(text[opening]);
      if (expected.normalize('NFKC') === char.normalize('NFKC')) {
        characters[index] = expected;
        unclosed.delete(stack.pop());
      } else {
        // Mixed bracket families can be intentional, for example a math interval.
        unclosed.delete(opening);
        stack.length = 0;
      }
    }
  }
  const missingClose = new RegExp('([（(])' + annotation + '(?=[，。！？；、,.!?;]|$)', 'gu');
  for (const match of text.matchAll(missingClose)) {
    if (!unclosed.has(match.index)) continue;
    const end = match.index + match[0].length;
    characters[end] = closeFor.get(match[1]) + (characters[end] ?? '');
    insertions.push(end);
  }
  const missingOpen = new RegExp(annotation + '([）)])(?=[，。！？；、,.!?;]|$)', 'gu');
  for (const match of text.matchAll(missingOpen)) {
    if (orphaned.has(match.index + match[0].length - 1)) {
      characters[match.index] = (match[1] === '）' ? '（' : '(') + characters[match.index];
      insertions.push(match.index);
    }
  }
  for (const index of insertions.sort((a, b) => b - a)) marks = editMarks(marks, index, index, 1);
  return { text: characters.join(''), marks };
}

export function cleanPageText(pages, chapterStarts = new Set(), layout) {
  const watermarkPages = new Map();
  const numberPages = new Map();
  const indexed = pages.map(({ page, lines, method, tableRules }) => {
    const hasBody = lines.some((line) => !line.edge && line.text.trim());
    const candidates = lines.map((line) => ({ ...line, ...marginCandidate(line, page, hasBody) }));
    for (const [field, counts] of [['watermarkKey', watermarkPages], ['numberKey', numberPages]]) {
      const keys = new Set(candidates.map((line) => line[field]).filter(Boolean));
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return { page, method, candidates, tableRules };
  });
  const commonMargin = Math.ceil(pages.length / 5);
  return indexed.map(({ page, method, candidates, tableRules }) => {
    const lines = candidates.filter((line) => {
      if (chapterStarts.size && !chapterStarts.has(page) && (line.edge === 'top' || line.edge === 'bottom')
        && chapterLabel(line.text)?.kind === 'chapter') return false;
      if (line.promotion || line.pageNumber || (numberPages.get(line.numberKey) ?? 0) >= 2) return false;
      return (watermarkPages.get(line.watermarkKey) ?? 0) < (line.marked ? 2 : Math.max(3, commonMargin));
    });
    const arranged = layout ? layout(lines, { tableRules }) : { lines, visuals: [] };
    return { page, method, ...repairBrackets(joinMarked(arranged.lines, '\n')), visuals: arranged.visuals };
  });
}
