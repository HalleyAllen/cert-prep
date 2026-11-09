const chineseDigits = '零一二三四五六七八九';
const ordinalPattern = /^(?:第\s*([一二三四五六七八九十百千零〇两\d]+)\s*([章篇部])|(?:chapter|unit)\s+(\d+)\b)/iu;
const chapterPrefix = /(?:第\s*[一二三四五六七八九十百千零〇两\d]+\s*章|chapter\s+\d+\b)/giu;
const trailingReferences = /^(?:参考文献|参考资料|后记|索引|bibliography|references|index)$/iu;

function ordinalValue(text) {
  if (/^\d+$/u.test(text)) return Number(text);
  const normalized = text.replaceAll('两', '二').replaceAll('〇', '零');
  if (!/[十百千]/u.test(normalized)) return Number(Array.from(normalized, (char) => chineseDigits.indexOf(char)).join(''));
  let value = 0;
  let digit = 0;
  for (const char of normalized) {
    const unit = { 十: 10, 百: 100, 千: 1000 }[char];
    if (unit) {
      value += (digit || 1) * unit;
      digit = 0;
    } else digit = chineseDigits.indexOf(char);
  }
  return value + digit;
}

export function chapterLabel(text) {
  const title = text.normalize('NFKC').trim().replace(/^#{1,6}\s+/u, '');
  const match = ordinalPattern.exec(title);
  if (!match) return null;
  const ordinal = ordinalValue(match[1] ?? match[3]);
  const kind = match[2] === '章' || /^chapter/iu.test(title) ? 'chapter' : match[2] ?? 'unit';
  const name = title.slice(match[0].length).trim();
  return { ordinal, kind, name, title: [match[0].replace(/\s+/gu, match[3] ? ' ' : ''), name].filter(Boolean).join(' ') };
}

export function isContentsEntry(text) {
  return /(?:[.．…·]\s*){3,}\d{1,5}\s*$/u.test(text) || [...text.matchAll(chapterPrefix)].length > 1;
}

export function isReferenceHeading(text) {
  return trailingReferences.test(text.replace(/[\s：:]/gu, ''));
}

async function destinationPage(pdf, destination) {
  try {
    const dest = typeof destination === 'string' ? await pdf.getDestination(destination) : destination;
    if (!Array.isArray(dest) || !dest[0] && dest[0] !== 0) return null;
    const ref = dest[0];
    const page = (typeof ref === 'number' ? ref : await pdf.getPageIndex(ref)) + 1;
    return Number.isInteger(page) && page >= 1 && page <= pdf.numPages ? page : null;
  } catch {
    return null;
  }
}

export async function pdfChapterOutline(pdf, firstLines) {
  const outline = await pdf.getOutline().catch(() => null);
  if (!outline?.length) return [];
  const stack = [...outline].reverse().map((item) => ({ item, depth: 0 }));
  const candidates = [];
  for (let visited = 0; stack.length && visited < 5000; visited += 1) {
    const { item, depth } = stack.pop();
    const label = chapterLabel(item.title ?? '');
    if (label?.kind === 'chapter' && label.ordinal > 0 && label.name && !isContentsEntry(label.title)) {
      const page = await destinationPage(pdf, item.dest);
      if (page) candidates.push({ ...label, page, depth });
    } else {
      for (const child of [...(item.items ?? [])].reverse()) stack.push({ item: child, depth: depth + 1 });
    }
  }
  if (!candidates.length) return [];
  const depth = Math.min(...candidates.map((item) => item.depth));
  const chapters = candidates.filter((item) => item.depth === depth);
  if (chapters.some((item, index) => index > 0
    && (item.ordinal <= chapters[index - 1].ordinal || item.page <= chapters[index - 1].page))) return [];

  const result = [];
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    let page = chapter.page;
    let title = chapter.title;
    for (const offset of [0, 1, -1, 2]) {
      const candidatePage = chapter.page + offset;
      if (candidatePage <= (result.at(-1)?.page ?? 0) || candidatePage >= (chapters[index + 1]?.page ?? pdf.numPages + 1)) continue;
      const lines = await firstLines(candidatePage);
      const line = lines.find((text) => {
        const candidate = chapterLabel(text);
        const expected = chapter.name.replace(/\s+/gu, '');
        return candidate?.kind === 'chapter' && candidate.ordinal === chapter.ordinal
          && candidate.name.replace(/\s+/gu, '').startsWith(expected);
      });
      if (!line) continue;
      page = candidatePage;
      const label = chapterLabel(line);
      if (label.name.length <= chapter.name.length + 4 && !/[。；！？]/u.test(label.name)) title = label.title;
      break;
    }
    result.push({ page, title });
  }
  return result;
}

export function applyPdfOutline(units, outline) {
  if (!outline.length) return;
  let index = 0;
  for (let i = 0; i < outline.length; i += 1) {
    const chapter = outline[i];
    while (index < units.length && units[index].page < chapter.page) index += 1;
    if (index < units.length && units[index].page < (outline[i + 1]?.page ?? Infinity)) {
      units[index].heading = chapter.title;
    }
  }
}
