import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import mammoth from 'mammoth';
import { createOcrPool, defaultOcrConcurrency } from './ocr-pool.mjs';
import { cleanPageText, isChapterHeading, isFrontMatter, pageEdge } from './text-cleanup.mjs';
import { editMarks, joinMarked, sliceMarks, trimMarked } from './rich-text.mjs';
import { createPageSampler } from './page-marks.mjs';
import { normalizedPdfBounds, pdfTableRules, reflowPdfPage } from './pdf-layout.mjs';
import { readWordMarks } from './word-marks.mjs';
import { applyPdfOutline, chapterLabel, isContentsEntry, isReferenceHeading, pdfChapterOutline } from './pdf-structure.mjs';

const require = createRequire(import.meta.url);

export function splitUnits(text, page, method, marks = [], detectHeadings = true, visuals = null) {
  const blocks = [];
  let lines = [];
  let heading = null;
  const flush = () => {
    let body = trimMarked(joinMarked(lines, '\n'), Boolean(visuals));
    while (body.text.length > 2200) {
      const newline = body.text.lastIndexOf('\n', 2200);
      const marker = visuals?.find(({ anchor }) => {
        const start = body.text.indexOf(anchor);
        return start >= 0 && start < 2200 && start + anchor.length > 2200;
      });
      const end = newline > 1000 ? newline : marker ? body.text.indexOf(marker.anchor) : 2200;
      const text = body.text.slice(0, end);
      blocks.push({ page, method, heading, text, marks: sliceMarks(body.marks, 0, end), visuals: visuals?.filter(({ anchor }) => text.includes(anchor)) });
      heading = null;
      body = trimMarked({ text: body.text.slice(end), marks: sliceMarks(body.marks, end, body.text.length) }, Boolean(visuals));
    }
    if (body.text) blocks.push({ page, method, heading, ...body, visuals: visuals?.filter(({ anchor }) => body.text.includes(anchor)) });
    lines = [];
    heading = null;
  };
  let offset = 0;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = trimMarked({ text: raw, marks: sliceMarks(marks, offset, offset + raw.length) }, Boolean(visuals));
    if (detectHeadings && isChapterHeading(line.text) && !isContentsEntry(line.text)) {
      flush();
      heading = line.text.replace(/^#+\s*/, '');
    }
    lines.push(line);
    offset += raw.length + 1;
  }
  flush();
  return blocks;
}

export function suggestedChapters(units, filename) {
  const seen = new Set();
  const headings = units.flatMap((unit, index) => {
    if (!unit.heading || isFrontMatter(unit.heading) || isContentsEntry(unit.heading) || isReferenceHeading(unit.heading)) return [];
    const label = chapterLabel(unit.heading);
    const key = label ? label.kind + ':' + label.ordinal : unit.heading.replace(/\s+/gu, '');
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ title: unit.heading, start: index + 1 }];
  });
  if (headings.length === 0) {
    if (units.some((unit) => unit.heading && isFrontMatter(unit.heading))) return [];
    return [{ title: filename.replace(/\.[^.]+$/, '').slice(0, 140), start: 1, end: units.length }];
  }
  return headings.map((heading, index) => ({ ...heading, title: heading.title.slice(0, 140),
    end: (headings[index + 1]?.start ?? units.length + 1) - 1 }));
}

function pdfLines(items, viewport) {
  const lines = [];
  let text = '';
  let boxes = [];
  let bounds;
  let baseline;
  const flush = (keepBlank = false) => {
    if (text.trim()) lines.push({ text, boxes, bounds: bounds && normalizedPdfBounds(bounds, viewport.width, viewport.height),
      edge: bounds ? pageEdge(bounds, viewport.width, viewport.height) : null });
    else if (keepBlank) lines.push({ text: '', edge: null });
    text = '';
    boxes = [];
    bounds = undefined;
    baseline = undefined;
  };
  for (const item of items) {
    if (item.str === undefined) continue;
    if (item.str.trim()) {
      const [a, b, c, d, x, y] = item.transform;
      const angle = Math.atan2(b, a);
      let dx = Math.cos(angle);
      let dy = Math.sin(angle);
      let fontHeight = Math.hypot(c, d) || Math.abs(item.height);
      let runWidth = Math.abs(item.width);
      const origin = viewport.convertToViewportPoint(x, y);
      let next = viewport.convertToViewportPoint(x + dx, y + dy);
      if (Math.abs(next[1] - origin[1]) > Math.abs(next[0] - origin[0])
        && item.str.length > 3 && item.height > runWidth * 2.5 && Math.hypot(c, d)) {
        dx = c / Math.hypot(c, d);
        dy = d / Math.hypot(c, d);
        next = viewport.convertToViewportPoint(x + dx, y + dy);
        fontHeight = runWidth;
        runWidth = Math.abs(item.height);
      }
      const horizontal = Math.abs(next[1] - origin[1]) < Math.abs(next[0] - origin[0]) / 3;
      if (horizontal && baseline?.horizontal && Math.abs(origin[1] - baseline.y) > Math.max(4, Math.max(fontHeight, baseline.height) * 0.65)) flush();
      baseline = { y: origin[1], height: fontHeight, horizontal };
      const start = text.length;
      const corners = [0, runWidth].flatMap((width) => [0, fontHeight].map((height) =>
        viewport.convertToViewportPoint(x + dx * width - dy * height, y + dy * width + dx * height)));
      const xs = corners.map(([left]) => left);
      const ys = corners.map(([, top]) => top);
      const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      boxes.push({ start, end: start + item.str.length, box, horizontal: box.x1 - box.x0 >= box.y1 - box.y0 });
      bounds = { x0: Math.min(bounds?.x0 ?? Infinity, box.x0), y0: Math.min(bounds?.y0 ?? Infinity, box.y0),
        x1: Math.max(bounds?.x1 ?? -Infinity, box.x1), y1: Math.max(bounds?.y1 ?? -Infinity, box.y1) };
    }
    text += item.str + (item.hasEOL ? '' : ' ');
    if (item.hasEOL) flush(true);
  }
  flush();
  return lines;
}

function markPdfLines(lines, sample, scale) {
  return lines.map(({ text, edge, bounds, boxes }) => ({
    text, edge, bounds, marks: (boxes ?? []).flatMap(({ start, end, box, horizontal }) => {
      const scaled = { x0: box.x0 * scale, x1: box.x1 * scale, y0: box.y0 * scale, y1: box.y1 * scale };
      return sample(text.slice(start, end), scaled, horizontal).map((mark) => ({
        ...mark, start: mark.start + start, end: mark.end + start,
      }));
    }),
  }));
}

function compactHan({ text, marks = [] }) {
  const spaces = [...text.matchAll(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu)];
  for (const match of spaces.reverse()) {
    const end = match.index + match[0].length;
    text = text.slice(0, match.index) + text.slice(end);
    marks = editMarks(marks, match.index, end, 0);
  }
  return trimMarked({ text, marks });
}

export async function extractMaterial({ filePath, extension, forceOcr = false, textOnly = false, ocrConcurrency = defaultOcrConcurrency() }, progress = () => {}, signal) {
  signal?.throwIfAborted();
  const buffer = await readFile(filePath);
  const limit = Number.isInteger(ocrConcurrency) ? Math.max(1, Math.min(4, ocrConcurrency)) : defaultOcrConcurrency();
  const ocr = createOcrPool(signal);
  const recognize = async (canvas, sample = createPageSampler(canvas)) => {
    const { data } = await ocr.recognize(canvas.toBuffer('image/png'));
    const paragraphs = data.blocks?.flatMap((block) => block.paragraphs) ?? [];
    const lines = paragraphs.flatMap((paragraph) => [
      ...paragraph.lines.map((line) => {
        let offset = 0;
        const marks = line.words.flatMap((word) => {
          const start = line.text.indexOf(word.text, offset);
          if (start < 0) return [];
          offset = start + word.text.length;
          return sample(word.text, word.bbox, false).map((mark) => ({ ...mark, start: mark.start + start, end: mark.end + start }));
        });
        return { ...compactHan({ text: line.text, marks }), edge: pageEdge(line.bbox, canvas.width, canvas.height), bounds: normalizedPdfBounds(line.bbox, canvas.width, canvas.height) };
      }),
      { text: '', edge: null },
    ]);
    return lines.some((line) => line.text) ? lines : data.text.split(/\r?\n/u).map((text) => ({ ...compactHan({ text }), edge: null }));
  };
  try {
    let units = [];
    if (extension === '.pdf') {
      if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('文件内容不是有效的 PDF。');
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'));
      const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const task = pdfjs.getDocument({ data, isEvalSupported: false,
        cMapUrl: join(pdfRoot, 'cmaps') + '/', cMapPacked: true,
        standardFontDataUrl: join(pdfRoot, 'standard_fonts') + '/',
        wasmUrl: join(pdfRoot, 'wasm') + '/' });
      try {
        const pdf = await task.promise;
        if (pdf.numPages > 1000) throw new Error('PDF 超过 1000 页，请拆分后导入。');
        const outline = await pdfChapterOutline(pdf, async (number) => {
          signal?.throwIfAborted();
          try {
            const page = await pdf.getPage(number);
            const { items } = await page.getTextContent();
            const firstItems = items.filter((item) => item.str?.trim()).slice(0, 3).map((item) => item.str.trim());
            const lines = pdfLines(items, page.getViewport({ scale: 1 })).filter((line) => line.text.trim()).slice(0, 3);
            return [...firstItems, ...lines.map((line) => line.text)];
          } catch { return []; }
        });
        const pages = [];
        const firstPage = outline[0]?.page ?? 1;
        const chapterStarts = new Set(outline.map((item) => item.page));
        const pending = new Set();
        progress(5, '正在读取页面并准备本机识别');
        const total = pdf.numPages - firstPage + 1;
        let completed = 0;
        let failure;
        const onPageDone = () => {
          completed += 1;
          progress(Math.round(completed / total * 90) + 5, `已处理 ${completed} / ${total} 页`);
        };
        const check = () => {
          signal?.throwIfAborted();
          if (failure) throw failure;
        };
        try {
          for (let number = firstPage; number <= pdf.numPages; number += 1) {
            if (pending.size >= limit) await Promise.race(pending);
            check();
            const page = await pdf.getPage(number);
            const { items } = await page.getTextContent();
            const base = page.getViewport({ scale: 1 });
            let lines = pdfLines(items, base);
            if (outline.length && number > outline.at(-1).page && pdf.numPages - number < Math.max(4, pdf.numPages * 0.03)
              && isReferenceHeading(lines.find((line) => line.text.trim())?.text ?? '')) break;
            const body = lines.filter((line) => !line.edge || isChapterHeading(line.text.trim())).map((line) => line.text).join(' ');
            const shouldOcr = !textOnly && (forceOcr || (!/\p{L}/u.test(body) && body.replace(/\s/g, '').length < 16));
            if (!shouldOcr && !lines.some((line) => line.text.trim())) {
              onPageDone();
              page.cleanup();
              continue;
            }
            const maxDimension = Math.max(base.width, base.height);
            const scale = shouldOcr ? Math.min(2.5, 2700 / maxDimension) : Math.min(1.6, 1400 / maxDimension);
            const viewport = page.getViewport({ scale });
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            let sample;
            try {
              const annotations = await page.getAnnotations({ intent: 'display' }).catch(() => []);
              await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, annotationMode: pdfjs.AnnotationMode.DISABLE }).promise;
              sample = createPageSampler(canvas, annotations, viewport);
            } catch (error) {
              if (shouldOcr) throw error;
            }
            const save = (result, method) => {
              pages[number - firstPage] = { page: number, method, lines: result, tableRules: pdfTableRules(canvas, result) };
              onPageDone();
            };
            const release = () => { canvas.width = 1; canvas.height = 1; };
            const textResult = () => sample ? markPdfLines(lines, sample, scale) : lines.map(({ text, edge, bounds }) => ({ text, edge, bounds }));
            page.cleanup();
            if (shouldOcr) {
              const job = recognize(canvas, sample).then((recognized) => {
                if (!signal?.aborted) {
                  if (recognized.some((line) => line.text)) save(recognized, 'ocr');
                  else save(textResult(), 'text');
                }
              }).catch((error) => { failure ??= error; }).finally(() => {
                release();
                pending.delete(job);
              });
              pending.add(job);
            } else {
              save(textResult(), 'text');
              release();
            }
          }
        } finally {
          await Promise.all(pending);
        }
        check();
        progress(96, '正在清理页码、水印和括号');
        units = cleanPageText(pages.filter(Boolean), chapterStarts, reflowPdfPage)
          .flatMap(({ text, page, method, marks, visuals }) => splitUnits(text, page, method, marks, !outline.length, visuals));
        applyPdfOutline(units, outline);
      } finally {
        await task.destroy();
      }
    } else if (extension === '.docx') {
      if (buffer.subarray(0, 2).toString() !== 'PK') throw new Error('文件内容不是有效的 DOCX。');
      progress(35, '正在读取 Word 正文');
      const marked = await readWordMarks(buffer).catch(() => null);
      if (marked?.marks.length) units = splitUnits(marked.text, null, 'text', marked.marks);
      else {
        const { value } = await mammoth.extractRawText({ buffer });
        units = splitUnits(value, null, 'text');
      }
    } else if (extension === '.txt') {
      if (buffer.includes(0) && !['fffe', 'feff'].includes(buffer.subarray(0, 2).toString('hex'))) {
        throw new Error('TXT 包含二进制数据，请另存为 UTF-8 文本。');
      }
      let value;
      if (buffer[0] === 0xff && buffer[1] === 0xfe) value = new TextDecoder('utf-16le').decode(buffer);
      else if (buffer[0] === 0xfe && buffer[1] === 0xff) value = new TextDecoder('utf-16be').decode(buffer);
      else {
        try { value = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
        catch { value = new TextDecoder('gb18030').decode(buffer); }
      }
      units = splitUnits(value, null, 'text');
    } else {
      const png = buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
      const jpg = buffer.subarray(0, 3).toString('hex') === 'ffd8ff';
      if (extension === '.png' ? !png : !jpg) throw new Error('文件内容与图片格式不匹配。');
      progress(20, '正在初始化本机中文与英文 OCR');
      const image = await loadImage(buffer);
      const scale = Math.min(1, 3200 / Math.max(image.width, image.height));
      const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const [page] = cleanPageText([{ page: 1, method: 'ocr', lines: await recognize(canvas) }]);
      units = splitUnits(page.text, page.page, page.method, page.marks);
    }
    signal?.throwIfAborted();
    if (!units.length) throw new Error('没有识别到文字。请检查清晰度，或在导入时启用整份 PDF OCR。');
    if (units.length > 5000) throw new Error('资料文字量过大，请拆成多份导入。');
    return units;
  } finally {
    await ocr.close();
  }
}

if (parentPort && workerData) {
  const controller = new AbortController();
  const onMessage = (message) => { if (message === 'cancel') controller.abort(); };
  parentPort.on('message', onMessage);
  try {
    const units = await extractMaterial(workerData, (progress, message) => parentPort.postMessage({ progress, message }), controller.signal);
    parentPort.postMessage({ units });
  } catch (error) {
    const message = error.name === 'PasswordException' ? 'PDF 已加密，请先另存为无需密码的版本。' : error.message;
    parentPort.postMessage({ error: message });
  } finally {
    parentPort.off('message', onMessage);
  }
}
