import { isChapterHeading } from './text-cleanup.mjs';
import { editMarks, joinMarked, trimMarked } from './rich-text.mjs';
import { normalizeNumberedHeading } from '../shared/numbered-heading.mjs';

const han = /\p{Script=Han}/u;
const section = /^(?:\d+(?:\s*\.\s*\d+)+\s*(?=[\p{L}])|\d+[.、]\s*(?=\p{Script=Han}))/u;
const list = /^(?:[●•▪◆]|[(（]\s*\d+\s*[)）]|\d+[)）])/u;
const caption = /^(图|表|figure|table)\s*\d+(?:\s*[-–—－.．]\s*\d+)+\s*\p{L}/iu;
const equation = /^(?:[A-Za-z\u0370-\u03ff][A-Za-z0-9_\s()]{0,20})\s*[=≈≠≤≥]\s*\S/u;
const endsSentence = /[。！？；.!?;][」』”’）)]*$/u;

const clamp = (number) => Math.max(0, Math.min(1, number));
const midpoint = ({ bounds }) => (bounds.y0 + bounds.y1) / 2;
const widthOf = ({ bounds }) => bounds.x1 - bounds.x0;
const quantile = (values, at) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * at)];
};

export function normalizedPdfBounds(bounds, width, height) {
  return { x0: clamp(bounds.x0 / width), x1: clamp(bounds.x1 / width), y0: clamp(bounds.y0 / height), y1: clamp(bounds.y1 / height) };
}

function cleanSpacing(line) {
  let { text, marks } = trimMarked(line);
  const spaces = [...text.matchAll(/(?<=\p{Script=Han})[ \t]+(?=[\p{Script=Han}，。！？；、：）】])/gu)];
  for (const match of spaces.reverse()) {
    const end = match.index + match[0].length;
    text = text.slice(0, match.index) + text.slice(end);
    marks = editMarks(marks, match.index, end, 0);
  }
  return { ...line, text: normalizeNumberedHeading(text), marks };
}

export function pdfTableRules(canvas, lines) {
  if (!lines.some((line) => /^(表|table)$/iu.test(caption.exec(line.text.trim())?.[1] ?? ''))) return [];
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
  const first = Math.floor(width * 0.09);
  const last = Math.ceil(width * 0.91);
  const rules = [];
  let start = -1;
  for (let y = 0; y < height; y += 1) {
    let dark = 0;
    for (let x = first; x < last; x += 2) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 160 && Math.max(data[i], data[i + 1], data[i + 2]) < 175) dark += 1;
    }
    if (dark > (last - first) * 0.24) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      rules.push((start + y - 1) / (2 * height));
      start = -1;
    }
  }
  return rules;
}

function figureColumn(nearby, label, left, right) {
  const center = (label.bounds.x0 + label.bounds.x1) / 2;
  const relativeCenter = (center - left) / (right - left);
  const figureOnRight = relativeCenter > 0.63;
  if (!figureOnRight && relativeCenter >= 0.37) return null;

  const before = Math.max(label.bounds.y0 - 0.56, ...nearby
    .filter((line) => widthOf(line) > 0.48 && line.text.length >= 20)
    .map((line) => line.bounds.y1));
  const side = nearby.filter((line) => {
    const { x0, x1, y0 } = line.bounds;
    return !line.edge && y0 >= before && widthOf(line) >= 0.22 && line.text.length >= 12
      && !caption.test(line.text)
      && (figureOnRight ? x0 < left + 0.08 && x1 < label.bounds.x0 - 0.02
        : x1 > right - 0.08 && x0 > label.bounds.x1 + 0.02);
  });
  const edges = side.map(({ bounds }) => figureOnRight ? bounds.x1 : bounds.x0);
  if (edges.length < 3 || label.bounds.y0 - Math.max(...side.map(({ bounds }) => bounds.y1)) > 0.08) return null;
  const typicalEdge = quantile(edges, 0.5);
  if (edges.filter((edge) => Math.abs(edge - typicalEdge) < 0.025).length < 3) return null;
  return figureOnRight ? { x0: Math.max(...edges) + 0.008, x1: right + 0.04 }
    : { x0: left - 0.04, x1: Math.min(...edges) - 0.008 };
}

function readVisuals(lines, left, right, rules) {
  const visuals = [];
  const additions = new Map();
  const omitted = new Set();
  const insert = (at, kind, bounds, after = false) => {
    const anchor = '【原页' + ({ formula: '公式', figure: '插图', table: '表格' })[kind] + ' ' + (visuals.length + 1) + '】';
    const visual = { kind, anchor, bounds: Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, clamp(value)])) };
    visuals.push(visual);
    const target = additions.get(at) ?? { before: [], after: [] };
    target[after ? 'after' : 'before'].push({ text: anchor, special: true });
    additions.set(at, target);
  };
  const geometry = lines.filter((line) => line.bounds && (!line.edge || caption.test(line.text)));
  const isProse = (line) => widthOf(line) > 0.48 && line.text.length >= 20
    || line.bounds.x0 < left + 0.12 && line.text.length >= 7 && (endsSentence.test(line.text) || /所示[。.]?$/u.test(line.text));
  for (const line of geometry) {
    const label = caption.exec(line.text);
    if (!label || line.text.length > 110 || widthOf(line) > 0.60 && endsSentence.test(line.text)) continue;
    const table = /^(表|table)$/iu.test(label[1]);
    if (table) {
      const nextCaption = Math.min(0.96, ...geometry.filter((item) => item.bounds.y0 > line.bounds.y1 && caption.test(item.text))
        .map((item) => item.bounds.y0));
      const tableRules = rules.filter((y) => y >= line.bounds.y1 - 0.012 && y < nextCaption);
      let last = 0;
      while (last + 1 < tableRules.length && tableRules[last + 1] - tableRules[last] < 0.14) last += 1;
      if (last < 1 || tableRules[0] - line.bounds.y1 > 0.055 || tableRules[last] - tableRules[0] < 0.035) {
        insert(line, 'table', { x0: 0, x1: 1, y0: 0, y1: 1 }, true);
        continue;
      }
      const y0 = tableRules[0] - 0.005;
      const y1 = tableRules[last] + 0.006;
      insert(line, 'table', { x0: left - 0.04, x1: right + 0.04, y0, y1 }, true);
      for (const item of lines) {
        if (item !== line && item.bounds && midpoint(item) > y0 && midpoint(item) < y1 && !caption.test(item.text)) omitted.add(item);
      }
      continue;
    }
    const nearby = lines.filter((item) => item.bounds && item !== line && item.bounds.y1 < line.bounds.y0);
    const column = figureColumn(nearby, line, left, right);
    const horizontal = column ?? { x0: left - 0.04, x1: right + 0.04 };
    const inColumn = ({ bounds }) => (bounds.x0 + bounds.x1) / 2 > horizontal.x0
      && (bounds.x0 + bounds.x1) / 2 < horizontal.x1;
    const prose = nearby.filter((item) => !item.edge && isProse(item)
      && (!column || (item.bounds.x1 > column.x0 && item.bounds.x0 < column.x1)));
    const y0 = Math.max(0.04, ...prose.map((item) => item.bounds.y1)) + (column ? 0.008 : 0.004);
    const y1 = line.bounds.y0 - 0.004;
    if (y1 - y0 < 0.04 || y1 - y0 > 0.56 || !prose.length) continue;
    const contained = nearby.filter((item) => midpoint(item) > y0 && midpoint(item) < y1
      && (!column || inColumn(item)) && !isChapterHeading(item.text));
    if (contained.some((item) => caption.test(item.text))) continue;
    insert(line, 'figure', { ...horizontal, y0, y1 });
    for (const item of contained) omitted.add(item);
  }
  for (const line of geometry) {
    if (line.edge || omitted.has(line) || !equation.test(line.text) || line.text.length > 100
      || Array.from(line.text).filter((char) => han.test(char)).length > 3) continue;
    const { x0, x1, y0, y1 } = line.bounds;
    const nearbyProse = geometry.filter((item) => item !== line && isProse(item));
    const before = Math.max(0, ...nearbyProse.filter((item) => item.bounds.y1 <= y0).map((item) => item.bounds.y1));
    const after = Math.min(1, ...nearbyProse.filter((item) => item.bounds.y0 > y0 + 0.018).map((item) => item.bounds.y0));
    const top = Math.max(y0 - 0.012, before + 0.001);
    const bottom = Math.min(y1 + 0.018, after - 0.002);
    if (bottom - top < 0.012) continue;
    insert(line, 'formula', { x0: x0 - 0.04, x1: x1 + 0.05, y0: top, y1: bottom });
    omitted.add(line);
  }
  return { visuals, lines: lines.flatMap((line) => {
    const extra = additions.get(line);
    return [...(extra?.before ?? []), ...(omitted.has(line) ? [] : [line]), ...(extra?.after ?? [])];
  }) };
}

function joinGap(left, right) {
  if (/[-‐‑]$/u.test(left) || han.test(left.at(-1) ?? '') || han.test(right[0] ?? '') || /^[，。！？、；：）】]/u.test(right)) return '';
  return ' ';
}

export function reflowPdfPage(input, { tableRules = [] } = {}) {
  const lines = input.filter((line) => line.text.trim()).map(cleanSpacing);
  const body = lines.filter((line) => line.bounds && widthOf(line) > 0.53 && line.text.length > 22);
  if (body.length < 2) return readVisuals(lines, 0.1, 0.9, tableRules);
  const left = quantile(body.map((line) => line.bounds.x0), 0.25);
  const right = quantile(body.map((line) => line.bounds.x1), 0.75);
  const gaps = body.slice(1).map((line, index) => midpoint(line) - midpoint(body[index])).filter((gap) => gap > 0.008 && gap < 0.046);
  const lineGap = quantile(gaps, 0.5) ?? 0.024;
  const arranged = readVisuals(lines, left, right, tableRules);
  const paragraphs = [];
  let paragraph = [];
  let previous;
  const flush = () => {
    if (paragraph.length) paragraphs.push(joinMarked(paragraph));
    paragraph = [];
    previous = undefined;
  };
  for (const line of arranged.lines) {
    const isCaption = caption.test(line.text);
    const heading = isChapterHeading(line.text) || (line.text.length < 48 && section.test(line.text) && !endsSentence.test(line.text));
    if (line.special || isCaption || heading || !line.bounds || line.edge && widthOf(line) < 0.48) {
      flush();
      paragraphs.push(line);
      continue;
    }
    const { x0 } = line.bounds;
    const indent = x0 > left + 0.021 && x0 < left + 0.14 && widthOf(line) > 0.30 && !list.test(line.text);
    const space = previous ? midpoint(line) - midpoint(previous) : 0;
    const previousShort = previous && previous.bounds.x1 < right - 0.065;
    if (indent || list.test(line.text) || space > lineGap * 1.50 || space < -0.012
      || (previousShort && endsSentence.test(previous.text) && x0 < left + 0.03)) flush();
    if (!paragraph.length && indent) paragraph.push({ text: '\u3000\u3000' });
    else if (previous) paragraph.push({ text: joinGap(previous.text, line.text) });
    paragraph.push(line);
    previous = line;
  }
  flush();
  return { lines: paragraphs.flatMap((line, index) => index ? [{ text: '' }, line] : [line]), visuals: arranged.visuals };
}
