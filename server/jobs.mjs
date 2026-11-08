import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { suggestedChapters } from './importer.mjs';
import { now, parse } from './store.mjs';
import { chapterUnits, insertQuestion } from './study.mjs';

const hashUnits = (units) => createHash('sha256').update(JSON.stringify(units)).digest('hex');

function extractInWorker(input, progress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./importer.mjs', import.meta.url), { workerData: input });
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      void worker.terminate();
      reject(new Error('识别时间过长。请将资料拆成较小的文件再导入。'));
    }, 45 * 60 * 1000);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    worker.on('message', (event) => {
      if (event.error) finish(reject, new Error(event.error));
      else if (event.units) finish(resolve, event.units);
      else progress(event.progress, event.message);
    });
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', () => finish(reject, new Error('资料解析提前结束，请重试。')));
  });
}

export function createJobs(store, dataRoot, services) {
  let active = false;
  let stopped = false;
  const enqueue = (certId, kind, targetId, input = {}) => {
    const activeJob = store.get("SELECT id FROM jobs WHERE kind=? AND target_id=? AND status IN ('queued','running')", kind, targetId);
    if (activeJob) return activeJob.id;
    const id = randomUUID();
    store.run(`INSERT INTO jobs(id, certificate_id, kind, target_id, input, status, message, created_at)
      VALUES (?, ?, ?, ?, ?, 'queued', '等待处理', ?)`, id, certId, kind, targetId, JSON.stringify(input), now());
    return id;
  };

  async function execute(job) {
    const input = parse(job.input);
    const progress = (value, message) => store.run('UPDATE jobs SET progress=?, message=? WHERE id=?', value, message, job.id);
    const finish = (message) => store.run("UPDATE jobs SET status='succeeded', progress=100, message=? WHERE id=?", message, job.id);
    store.run("UPDATE jobs SET status='running', progress=2, message='正在准备' WHERE id=?", job.id);
    if (job.kind === 'import') {
      const material = store.get('SELECT * FROM materials WHERE id=?', job.target_id);
      const units = await extractInWorker({ filePath: join(dataRoot, 'uploads', material.file_key), extension: material.extension,
        forceOcr: input.forceOcr }, progress);
      store.transaction(() => {
        const start = store.get('SELECT COALESCE(MAX(position), 0) AS count FROM chapters WHERE course_id=?', material.course_id).count;
        units.forEach((unit, index) => store.run('INSERT INTO units VALUES (?, ?, ?, ?, ?, ?)',
          material.id, index + 1, unit.page, unit.text, unit.method, unit.heading));
        const chapters = suggestedChapters(units, material.name);
        chapters.forEach((chapter, index) => store.run(`INSERT INTO chapters
          (id, course_id, material_id, title, start_unit, end_unit, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(), material.course_id, material.id, chapter.title, chapter.start, chapter.end, start + index + 1));
        store.run('UPDATE materials SET extracted=1 WHERE id=?', material.id);
        finish(`已提取 ${units.length} 个原文片段，建议 ${chapters.length} 章`);
      });
      return;
    }
    const chapter = store.get('SELECT * FROM chapters WHERE id=?', job.target_id);
    const units = chapterUnits(store, chapter);
    const hash = hashUnits(units);
    if (job.kind === 'analyze') {
      const result = await services.analyze(chapter.title, units, progress);
      store.transaction(() => {
        ensureCurrent(chapter, hash);
        store.run('UPDATE chapters SET analysis=?, analysis_hash=? WHERE id=?', JSON.stringify(result), hash, chapter.id);
        finish('章节分析已更新');
      });
    } else {
      progress(10, '正在根据原文生成题目');
      const questions = await services.questions(chapter.title, units, input.count);
      store.transaction(() => {
        ensureCurrent(chapter, hash);
        const stems = new Set(store.all('SELECT stem FROM questions WHERE chapter_id=? AND approved=1', chapter.id)
          .map((row) => row.stem.normalize('NFKC').replace(/\s/g, '')));
        let count = 0;
        for (const question of questions) {
          const key = question.stem.normalize('NFKC').replace(/\s/g, '');
          if (stems.has(key)) continue;
          insertQuestion(store, chapter.id, question, { type: 'ai' }, true);
          stems.add(key);
          count += 1;
        }
        finish(count ? `已加入 ${count} 道 AI 练习题` : '生成结果与现有题目重复');
      });
    }
  }

  function ensureCurrent(chapter, hash) {
    const latest = store.get('SELECT * FROM chapters WHERE id=?', chapter.id);
    if (!latest || latest.title !== chapter.title || hashUnits(chapterUnits(store, latest)) !== hash) {
      throw new Error('分析期间章节原文或标题已更新，请对最新内容重试。');
    }
  }

  function kick() {
    if (active || stopped) return;
    active = true;
    setImmediate(async () => {
      try {
        while (!stopped) {
          const job = store.get("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at, rowid LIMIT 1");
          if (!job) break;
          try { await execute(job); }
          catch (error) {
            store.run("UPDATE jobs SET status='failed', message=? WHERE id=?", String(error.message).slice(0, 450), job.id);
          }
        }
      } finally { active = false; }
    });
  }
  store.run("UPDATE jobs SET status='queued', progress=0, message='服务重启，等待处理' WHERE status='running'");
  kick();
  return { enqueue, kick, isActive: () => active, stop: () => { stopped = true; } };
}
