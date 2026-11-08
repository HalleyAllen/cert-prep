import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import mammoth from 'mammoth';
import { createWorker } from 'tesseract.js';

const require = createRequire(import.meta.url);
const headingPattern = /^(?:第\s*[一二三四五六七八九十百零〇两\d]+\s*[章节篇部]|chapter\s+\d+\b|unit\s+\d+\b|#{1,3}\s+)/iu;

export function splitUnits(text, page, method) {
  const blocks = [];
  let lines = [];
  let heading = null;
  const flush = () => {
    let body = lines.join('\n').trim();
    while (body.length > 2200) {
      const newline = body.lastIndexOf('\n', 2200);
      const end = newline > 1000 ? newline : 2200;
      blocks.push({ page, method, heading, text: body.slice(0, end) });
      heading = null;
      body = body.slice(end).trimStart();
    }
    if (body) blocks.push({ page, method, heading, text: body });
    lines = [];
    heading = null;
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line.length < 150 && headingPattern.test(line)) {
      flush();
      heading = line.replace(/^#+\s*/, '');
    }
    lines.push(line);
  }
  flush();
  return blocks;
}

export function suggestedChapters(units, filename) {
  const headings = units.flatMap((unit, index) => unit.heading ? [{ title: unit.heading, start: index + 1 }] : []);
  if (headings.length === 0) return [{ title: filename.replace(/\.[^.]+$/, '').slice(0, 140), start: 1, end: units.length }];
  if (headings[0].start > 1) headings.unshift({ title: '导言', start: 1 });
  return headings.map((heading, index) => ({ ...heading, title: heading.title.slice(0, 140),
    end: (headings[index + 1]?.start ?? units.length + 1) - 1 }));
}

export async function extractMaterial({ filePath, extension, forceOcr = false }, progress = () => {}) {
  const buffer = await readFile(filePath);
  let ocr;
  let langPath;
  const recognize = async (image) => {
    if (!ocr) {
      langPath = await mkdtemp(join(tmpdir(), 'cert-prep-ocr-'));
      for (const lang of ['chi_sim', 'eng']) {
        const languageRoot = dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
        const filename = `${lang}.traineddata.gz`;
        await copyFile(join(languageRoot, '4.0.0_best_int', filename), join(langPath, filename));
      }
      ocr = await createWorker('eng+chi_sim', 1, { langPath, cacheMethod: 'none' });
    }
    const { data } = await ocr.recognize(image);
    return data.text.replace(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, '').trim();
  };
  try {
    let units = [];
    if (extension === '.pdf') {
      if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('文件内容不是有效的 PDF。');
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'));
      const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false,
        cMapUrl: join(pdfRoot, 'cmaps') + '/', cMapPacked: true,
        standardFontDataUrl: join(pdfRoot, 'standard_fonts') + '/',
        wasmUrl: join(pdfRoot, 'wasm') + '/' });
      try {
        const pdf = await task.promise;
        if (pdf.numPages > 500) throw new Error('PDF 超过 500 页，请拆分后导入。');
        for (let number = 1; number <= pdf.numPages; number += 1) {
          progress(Math.round((number - 1) / pdf.numPages * 90) + 5, `正在处理第 ${number} / ${pdf.numPages} 页`);
          const page = await pdf.getPage(number);
          const { items } = await page.getTextContent();
          let text = items.map((item) => item.str === undefined ? '' : item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
          const shouldOcr = forceOcr || (!/\p{L}/u.test(text) && text.replace(/\s/g, '').length < 16);
          if (shouldOcr) {
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: Math.min(2.5, 2700 / Math.max(base.width, base.height)) });
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
            const recognized = await recognize(canvas.toBuffer('image/png'));
            text = recognized || text;
          }
          units.push(...splitUnits(text, number, shouldOcr ? 'ocr' : 'text'));
          page.cleanup();
        }
      } finally {
        await task.destroy();
      }
    } else if (extension === '.docx') {
      if (buffer.subarray(0, 2).toString() !== 'PK') throw new Error('文件内容不是有效的 DOCX。');
      progress(35, '正在读取 Word 正文');
      const { value } = await mammoth.extractRawText({ buffer });
      units = splitUnits(value, null, 'text');
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
      units = splitUnits(await recognize(canvas.toBuffer('image/png')), 1, 'ocr');
    }
    if (!units.length) throw new Error('没有识别到文字。请检查清晰度，或在导入时启用整份 PDF OCR。');
    if (units.length > 5000) throw new Error('资料文字量过大，请拆成多份导入。');
    return units;
  } finally {
    if (ocr) await ocr.terminate();
    if (langPath) await rm(langPath, { recursive: true, force: true });
  }
}

if (parentPort && workerData) {
  try {
    const units = await extractMaterial(workerData, (progress, message) => parentPort.postMessage({ progress, message }));
    parentPort.postMessage({ units });
  } catch (error) {
    const message = error.name === 'PasswordException' ? 'PDF 已加密，请先另存为无需密码的版本。' : error.message;
    parentPort.postMessage({ error: message });
  }
}
