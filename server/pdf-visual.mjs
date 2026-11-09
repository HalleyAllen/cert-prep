import { createCanvas } from '@napi-rs/canvas';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const pdfRoot = dirname(require.resolve('pdfjs-dist/package.json'));

export async function renderPdfVisual(file, number, bounds) {
  const { x0, x1, y0, y1 } = bounds;
  if (![x0, x1, y0, y1].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
    || x1 <= x0 || y1 <= y0) throw new RangeError('Invalid visual region.');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    url: pathToFileURL(file).href, disableAutoFetch: true, disableStream: true, isEvalSupported: false,
    cMapUrl: join(pdfRoot, 'cmaps') + '/', cMapPacked: true, standardFontDataUrl: join(pdfRoot, 'standard_fonts') + '/',
    wasmUrl: join(pdfRoot, 'wasm') + '/',
  });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(number);
    const original = page.getViewport({ scale: 1 });
    const cropWidth = original.width * (x1 - x0);
    const cropHeight = original.height * (y1 - y0);
    const scale = Math.min(3, 1200 / Math.max(cropWidth, cropHeight));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.max(1, Math.ceil(cropWidth * scale)), Math.max(1, Math.ceil(cropHeight * scale)));
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, annotationMode: pdfjs.AnnotationMode.DISABLE,
      transform: [1, 0, 0, 1, -x0 * viewport.width, -y0 * viewport.height] }).promise;
    return canvas.toBuffer('image/png');
  } finally {
    await task.destroy();
  }
}
