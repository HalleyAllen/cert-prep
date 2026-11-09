import { copyFile, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { availableParallelism, freemem, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createWorker } from 'tesseract.js';

const require = createRequire(import.meta.url);
const languages = ['chi_sim', 'eng'];
const filename = (lang) => lang + '.traineddata.gz';

export function defaultOcrConcurrency() {
  const cpuLimit = Math.max(1, Math.floor(availableParallelism() / 3));
  const memoryLimit = Math.max(1, Math.floor(freemem() / (2 * 1024 ** 3)));
  return Math.min(4, cpuLimit, memoryLimit);
}

function waitForRecognition(recognition, signal) {
  if (!signal) return recognition;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    recognition.then(
      (value) => { signal.removeEventListener('abort', cancel); resolve(value); },
      (error) => { signal.removeEventListener('abort', cancel); reject(error); },
    );
    if (signal.aborted) cancel();
  });
}

export function createOcrPool(signal) {
  const workers = new Set();
  const idle = [];
  let langPath;
  let setup;

  async function newWorker() {
    setup ??= (async () => {
      langPath = await mkdtemp(join(tmpdir(), 'cert-prep-ocr-'));
      for (const lang of languages) {
        const languageRoot = dirname(require.resolve('@tesseract.js-data/' + lang + '/package.json'));
        await copyFile(join(languageRoot, '4.0.0_best_int', filename(lang)), join(langPath, filename(lang)));
      }
    })();
    await setup;
    signal?.throwIfAborted();
    const worker = await createWorker('eng+chi_sim', 1, { langPath, cacheMethod: 'none' });
    workers.add(worker);
    return worker;
  }

  return {
    async recognize(image) {
      signal?.throwIfAborted();
      const worker = idle.pop() ?? await newWorker();
      try {
        signal?.throwIfAborted();
        return await waitForRecognition(worker.recognize(image, {}, { text: true, blocks: true }), signal);
      } finally {
        idle.push(worker);
      }
    },
    async close() {
      await Promise.allSettled([...workers].map((worker) => worker.terminate()));
      if (langPath) {
        await Promise.all(languages.map((lang) => rm(join(langPath, filename(lang)), { force: true })));
        await rmdir(langPath);
      }
    },
  };
}
