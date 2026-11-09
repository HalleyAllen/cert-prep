import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { localDay, saveSchedule, shiftDay, validDay } from './planner.mjs';
import { now, owner, parse } from './store.mjs';
import { correctMarks } from './rich-text.mjs';
import { renderPdfVisual } from './pdf-visual.mjs';
import { deleteMaterial } from './material-deletion.mjs';
import { selectStudyChapters } from './study-chapters.mjs';
import { Problem, publicLink, questionInput, validated } from './services.mjs';
import { chapterUnits, completeKind, insertQuestion, openAttempt, questionView, submitAttempt, withoutAnswer } from './study.mjs';

const str = (max) => z.string().trim().min(1, '请填写必填内容。').max(max, `最多 ${max} 个字符。`);
const date = z.string().refine(validDay, '请填写有效的考试日期。');
const editableDate = date.refine((day) => day <= shiftDay(localDay(), 3650), '考试日期需在未来十年内。');
const settingsShape = z.object({ minutes: z.number().int().min(5).max(720),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7) });
const chapterInput = z.object({ title: str(140), start: z.number().int().positive(), end: z.number().int().positive(),
  studyMinutes: z.number().int().min(5).max(720), practiceMinutes: z.number().int().min(5).max(720) });
const searchSource = z.object({ url: str(2000).refine((url) => !!publicLink(url), '请填写有效的网页链接。'),
  title: str(300), snippet: z.string().max(1600).default(''), official: z.boolean().default(false) });
export const materialUploadLimitMB = 500;
const materialUploadLimitBytes = materialUploadLimitMB * 1024 * 1024;
const materialCategory = z.enum(['textbook', 'supplement']);
const supported = new Set(['.pdf', '.docx', '.txt', '.png', '.jpg', '.jpeg']);
const toCertificate = ({ id, name, exam_date, demo, plan_settings }) => ({ id, name, examDate: exam_date, demo: !!demo,
  plan: plan_settings ? parse(plan_settings) : null });
const jobFields = 'id, kind, target_id, status, progress, message, created_at';
const chapterFields = `ch.id, ch.course_id, ch.material_id, ch.title, ch.start_unit, ch.end_unit, ch.study_minutes,
  ch.practice_minutes, ch.learned_at, ch.practiced_at, ch.visited_at, ma.name AS material_name, ma.category AS material_category,
  (SELECT COUNT(*) FROM questions q WHERE q.chapter_id=ch.id AND q.approved=1) AS question_count`;

function find(store, sql, params, label) {
  const row = store.get(sql, ...params);
  if (!row) throw new Problem(404, `找不到${label}。`);
  return row;
}

function cleanFilename(raw) {
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  const filename = decoded.includes('\ufffd') ? raw : decoded;
  return filename.replace(/[\x00-\x1f\x7f/\\]/g, '_').trim();
}

export function createApi(store, root, services, jobs) {
  const api = express.Router();
  const owned = express.Router({ mergeParams: true });
  const upload = multer({
    storage: multer.diskStorage({ destination: join(root, 'uploads'), filename: (_req, _file, cb) => cb(null, randomUUID()) }),
    // The multipart parser rejects files that reach its limit, so allow the exact maximum.
    limits: { fileSize: materialUploadLimitBytes + 1, files: 1, fields: 2, fieldSize: 16 },
    fileFilter: (_req, file, cb) => cb(supported.has(extname(file.originalname).toLowerCase()) ? null
      : new Problem(400, '请选择 PDF、DOCX、TXT、JPG 或 PNG 文件。'), true),
  });
  const cert = (req) => req.certificate;
  const course = (req) => find(store, 'SELECT * FROM courses WHERE id=? AND certificate_id=?', [req.params.courseId, cert(req).id], '科目');
  const chapter = (req) => find(store, `SELECT ch.* FROM chapters ch JOIN courses co ON co.id=ch.course_id
    WHERE ch.id=? AND co.certificate_id=?`, [req.params.chapterId, cert(req).id], '章节');
  const material = (req) => find(store, `SELECT ma.* FROM materials ma JOIN courses co ON co.id=ma.course_id
    WHERE ma.id=? AND co.certificate_id=?`, [req.params.materialId, cert(req).id], '资料');
  const question = (req) => find(store, `SELECT q.* FROM questions q JOIN chapters ch ON ch.id=q.chapter_id
    JOIN courses co ON co.id=ch.course_id WHERE q.id=? AND co.certificate_id=?`, [req.params.questionId, cert(req).id], '题目');
  const nextPosition = (table, key, id) => store.get(`SELECT COALESCE(MAX(position), 0) + 1 AS next FROM ${table} WHERE ${key}=?`, id).next;
  const requireAI = () => {
    if (!services.aiReady) throw new Problem(503, '请在 .env 配置模型地址、名称和密钥后重启服务。');
  };
  const runJob = (res, certificate, kind, target, input) => {
    const jobId = jobs.enqueue(certificate.id, kind, target, input);
    jobs.kick();
    res.status(202).json({ jobId });
  };

  api.get('/workspace', (_req, res) => res.json({ today: localDay(), aiReady: services.aiReady, searchReady: services.searchReady,
    certificates: store.all('SELECT * FROM certificates WHERE owner=? ORDER BY demo ASC, updated_at DESC, id', owner).map(toCertificate) }));

  api.post('/certificates', (req, res) => {
    const data = validated(z.object({ name: str(100), course: str(100).default('默认科目'), examDate: editableDate }), req.body);
    if (data.examDate < localDay()) throw new Problem(400, '新证书的考试日期不能早于今天。');
    const id = randomUUID();
    store.transaction(() => {
      store.run('INSERT INTO certificates(id, owner, name, exam_date, updated_at) VALUES (?, ?, ?, ?, ?)', id, owner, data.name, data.examDate, now());
      store.run('INSERT INTO courses VALUES (?, ?, ?, 1)', randomUUID(), id, data.course);
    });
    res.status(201).json({ id });
  });

  api.use('/certificates/:certId', owned);
  owned.use((req, _res, next) => {
    req.certificate = find(store, 'SELECT * FROM certificates WHERE id=? AND owner=?', [req.params.certId, owner], '证书');
    next();
  });

  owned.get('/', (req, res) => {
    const id = cert(req).id;
    const chapters = store.all(`SELECT ${chapterFields} FROM chapters ch JOIN courses co ON co.id=ch.course_id
      JOIN materials ma ON ma.id=ch.material_id WHERE co.certificate_id=?
      ORDER BY co.position, (ma.category='textbook') DESC, ma.created_at, ma.id, ch.start_unit, ch.position`, id);
    const materials = store.all(`SELECT ma.id, ma.course_id, ma.name, ma.extension, ma.extracted, ma.created_at, ma.category,
      (SELECT COUNT(*) FROM units un WHERE un.material_id=ma.id) AS unit_count,
      (SELECT j.id FROM jobs j WHERE j.kind='import' AND j.target_id=ma.id ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1) AS job_id
      FROM materials ma JOIN courses co ON co.id=ma.course_id WHERE co.certificate_id=? ORDER BY ma.created_at DESC`, id);
    const tasks = store.all(`SELECT t.*, ch.title FROM plan_tasks t LEFT JOIN chapters ch ON ch.id=t.chapter_id
      WHERE t.certificate_id=? ORDER BY t.day, t.position`, id);
    const summary = store.get(`SELECT COUNT(*) AS total, COUNT(*) FILTER(WHERE m.mastered=0) AS pending FROM mistakes m
      JOIN questions q ON q.id=m.question_id JOIN chapters ch ON ch.id=q.chapter_id JOIN courses co ON co.id=ch.course_id
      WHERE co.certificate_id=?`, id);
    res.json({ certificate: toCertificate(cert(req)), today: localDay(), chapters, materials, tasks, mistakes: summary,
      study_chapter_ids: selectStudyChapters(chapters).map(({ id }) => id),
      courses: store.all('SELECT * FROM courses WHERE certificate_id=? ORDER BY position', id),
      jobs: store.all(`SELECT ${jobFields} FROM jobs WHERE certificate_id=?
        AND (status IN ('queued', 'running') OR id IN (SELECT id FROM jobs WHERE certificate_id=? ORDER BY created_at DESC, rowid DESC LIMIT 35))
        ORDER BY created_at DESC, rowid DESC`, id, id) });
  });

  owned.patch('/', (req, res) => {
    const data = validated(z.object({ name: str(100), examDate: editableDate }), req.body);
    const current = cert(req);
    store.transaction(() => {
      store.run('UPDATE certificates SET name=?, exam_date=?, updated_at=? WHERE id=?', data.name, data.examDate, now(), current.id);
      if (data.examDate !== current.exam_date && current.plan_settings) {
        saveSchedule(store, { ...current, exam_date: data.examDate }, parse(current.plan_settings), localDay());
      }
    });
    res.json({ ok: true });
  });

  owned.post('/courses', (req, res) => {
    const { name } = validated(z.object({ name: str(100) }), req.body);
    const id = randomUUID();
    store.run('INSERT INTO courses VALUES (?, ?, ?, ?)', id, cert(req).id, name, nextPosition('courses', 'certificate_id', cert(req).id));
    res.status(201).json({ id });
  });

  owned.post('/courses/:courseId/materials', (req, _res, next) => { req.course = course(req); next(); }, upload.single('file'), (req, res) => {
    if (!req.file) throw new Problem(400, '请先选择一个资料文件。');
    const name = cleanFilename(req.file.originalname);
    const extension = extname(name).toLowerCase();
    const id = randomUUID();
    let jobId;
    try {
      if (!req.file.size || !supported.has(extension) || name.length > 240) throw new Problem(400, '文件为空、文件名过长或格式不支持。');
      const category = validated(materialCategory.default('supplement'), req.body.category);
      store.transaction(() => {
        store.run(`INSERT INTO materials (id, course_id, name, extension, file_key, created_at, category)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, id, req.course.id, name, extension, req.file.filename, now(), category);
        jobId = jobs.enqueue(cert(req).id, 'import', id, { forceOcr: req.body.forceOcr === 'true' });
      });
    } catch (error) {
      unlinkSync(req.file.path);
      throw error;
    }
    jobs.kick();
    res.status(202).json({ id, jobId });
  });

  owned.get('/materials/:materialId', (req, res) => {
    const row = material(req);
    res.json({ id: row.id, name: row.name, extension: row.extension, course_id: row.course_id, extracted: row.extracted, category: row.category,
      units: store.all('SELECT position, page, text, method, marks, visuals FROM units WHERE material_id=? ORDER BY position', row.id)
        .map((unit) => ({ ...unit, marks: parse(unit.marks), visuals: parse(unit.visuals) })),
      job: store.get(`SELECT ${jobFields} FROM jobs WHERE kind='import' AND target_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`, row.id) || null });
  });

  owned.patch('/materials/:materialId', (req, res) => {
    const row = material(req);
    const { category } = validated(z.object({ category: materialCategory }), req.body);
    store.run('UPDATE materials SET category=? WHERE id=?', category, row.id);
    res.json({ ok: true });
  });

  owned.delete('/materials/:materialId', (req, res) => {
    res.json(deleteMaterial(store, root, cert(req), material(req)));
  });

  owned.get('/materials/:materialId/file', (req, res) => {
    const row = material(req);
    const file = join(root, 'uploads', row.file_key);
    if (row.extension === '.docx' || req.query.download === '1' || !row.extracted) return res.download(file, row.name);
    res.type(row.extension).sendFile(file);
  });

  owned.get('/materials/:materialId/units/:position/visuals/:index', async (req, res) => {
    const row = material(req);
    const position = Number(req.params.position);
    const index = Number(req.params.index);
    if (row.extension !== '.pdf' || !Number.isSafeInteger(position) || position < 1 || !Number.isSafeInteger(index) || index < 0) {
      throw new Problem(404, '找不到原页图像。');
    }
    const unit = find(store, 'SELECT page, visuals FROM units WHERE material_id=? AND position=?', [row.id, position], '原文片段');
    const visual = parse(unit.visuals)[index];
    if (!unit.page || !visual) throw new Problem(404, '找不到原页图像。');
    const image = await renderPdfVisual(join(root, 'uploads', row.file_key), unit.page, visual.bounds);
    res.type('png').send(image);
  });

  owned.patch('/materials/:materialId/units/:position', (req, res) => {
    const row = material(req);
    const position = Number(req.params.position);
    if (!Number.isSafeInteger(position)) throw new Problem(400, '原文片段编号无效。');
    const { text } = validated(z.object({ text: str(20000) }), req.body);
    store.transaction(() => {
      const unit = find(store, 'SELECT * FROM units WHERE material_id=? AND position=?', [row.id, position], '原文片段');
      if (unit.text === text) return;
      const marks = correctMarks(parse(unit.marks), unit.text, text);
      const visuals = parse(unit.visuals).filter(({ anchor }) => text.includes(anchor));
      store.run('UPDATE units SET text=?, marks=?, visuals=? WHERE material_id=? AND position=?',
        text, JSON.stringify(marks), JSON.stringify(visuals), row.id, position);
      store.run('UPDATE chapters SET analysis=NULL, analysis_hash=NULL WHERE material_id=? AND ? BETWEEN start_unit AND end_unit', row.id, position);
    });
    res.json({ ok: true });
  });

  owned.delete('/materials/:materialId/units/:position', (req, res) => {
    const row = material(req);
    const position = Number(req.params.position);
    if (!Number.isSafeInteger(position) || position < 1) throw new Problem(400, '原文片段编号无效。');
    store.transaction(() => {
      const result = store.run('DELETE FROM units WHERE material_id=? AND position=?', row.id, position);
      if (!result.changes) throw new Problem(404, '找不到原文片段。');
      const affected = store.all('SELECT id, start_unit, end_unit FROM chapters WHERE material_id=? AND ? BETWEEN start_unit AND end_unit', row.id, position);
      for (const item of affected) {
        const bounds = store.get(`SELECT MIN(position) AS first, MAX(position) AS last FROM units
          WHERE material_id=? AND position BETWEEN ? AND ?`, row.id, item.start_unit, item.end_unit);
        store.run('UPDATE chapters SET start_unit=?, end_unit=?, analysis=NULL, analysis_hash=NULL WHERE id=?',
          bounds.first ?? item.start_unit, bounds.last ?? item.end_unit, item.id);
      }
    });
    res.json({ ok: true });
  });

  function validateRange(materialId, { start, end }) {
    const { count } = store.get('SELECT COUNT(*) AS count FROM units WHERE material_id=? AND position IN (?,?)', materialId, start, end);
    if (end < start || count !== (start === end ? 1 : 2)) throw new Problem(400, '请选择仍然存在的起始和结束片段。');
  }

  function requireChapterSource(row) {
    if (!store.get('SELECT 1 FROM units WHERE material_id=? AND position BETWEEN ? AND ? LIMIT 1', row.material_id, row.start_unit, row.end_unit)) {
      throw new Problem(422, '本章没有原文片段，请先调整章节范围。');
    }
  }

  owned.post('/materials/:materialId/chapters', (req, res) => {
    const row = material(req);
    const data = validated(chapterInput, req.body);
    validateRange(row.id, data);
    const id = randomUUID();
    store.run(`INSERT INTO chapters (id, course_id, material_id, title, start_unit, end_unit, position, study_minutes, practice_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, row.course_id, row.id, data.title, data.start, data.end,
    nextPosition('chapters', 'course_id', row.course_id), data.studyMinutes, data.practiceMinutes);
    res.status(201).json({ id });
  });

  owned.get('/chapters/:chapterId', (req, res) => {
    const row = chapter(req);
    const source = store.get('SELECT name, extension, category FROM materials WHERE id=?', row.material_id);
    const bounds = store.get('SELECT COUNT(*) AS count, MIN(position) AS first, MAX(position) AS last FROM units WHERE material_id=?', row.material_id);
    const units = chapterUnits(store, row, true);
    const drafts = store.all('SELECT * FROM questions WHERE chapter_id=? AND approved=0 ORDER BY created_at DESC', row.id).map(questionView);
    const questionCount = store.get('SELECT COUNT(*) AS count FROM questions WHERE chapter_id=? AND approved=1', row.id).count;
    res.json({ ...row, analysis: row.analysis ? parse(row.analysis) : null, units, drafts, question_count: questionCount,
      material_name: source.name, material_category: source.category, extension: source.extension,
      unit_count: bounds.count, unit_min: bounds.first, unit_max: bounds.last });
  });

  owned.patch('/chapters/:chapterId', (req, res) => {
    const row = chapter(req);
    const data = validated(chapterInput, req.body);
    const rangeChanged = row.start_unit !== data.start || row.end_unit !== data.end;
    if (rangeChanged) validateRange(row.material_id, data);
    const stale = row.title !== data.title || rangeChanged;
    store.run(`UPDATE chapters SET title=?, start_unit=?, end_unit=?, study_minutes=?, practice_minutes=?, analysis=?, analysis_hash=? WHERE id=?`,
      data.title, data.start, data.end, data.studyMinutes, data.practiceMinutes, stale ? null : row.analysis, stale ? null : row.analysis_hash, row.id);
    res.json({ ok: true });
  });

  owned.post('/chapters/:chapterId/visit', (req, res) => {
    store.run('UPDATE chapters SET visited_at=? WHERE id=?', now(), chapter(req).id);
    res.json({ ok: true });
  });

  owned.post('/chapters/:chapterId/learn', (req, res) => {
    const row = chapter(req);
    const at = now();
    store.transaction(() => {
      store.run('UPDATE chapters SET learned_at=COALESCE(learned_at, ?), visited_at=? WHERE id=?', at, at, row.id);
      completeKind(store, cert(req).id, row.id, 'study', at);
    });
    res.json({ ok: true });
  });

  owned.post('/chapters/:chapterId/analyze', (req, res) => {
    const row = chapter(req);
    requireChapterSource(row);
    requireAI();
    runJob(res, cert(req), 'analyze', row.id, {});
  });

  owned.post('/chapters/:chapterId/generate', (req, res) => {
    const row = chapter(req);
    requireChapterSource(row);
    requireAI();
    const input = validated(z.object({ count: z.number().int().min(1).max(12) }), req.body);
    runJob(res, cert(req), 'generate', row.id, input);
  });

  owned.post('/jobs/:jobId/cancel', (req, res) => {
    const job = find(store, 'SELECT * FROM jobs WHERE id=? AND certificate_id=?', [req.params.jobId, cert(req).id], '任务');
    if (job.status !== 'cancelled' && !jobs.cancelImport(job.id)) {
      throw new Problem(409, '只有等待或识别中的资料可以取消。');
    }
    res.json({ ok: true });
  });

  owned.post('/jobs/:jobId/retry', (req, res) => {
    const job = find(store, 'SELECT * FROM jobs WHERE id=? AND certificate_id=?', [req.params.jobId, cert(req).id], '任务');
    if (!['failed', 'cancelled'].includes(job.status)) throw new Problem(409, '只有失败或已取消的任务可以重试。');
    if (job.kind !== 'import') {
      requireChapterSource(find(store, 'SELECT * FROM chapters WHERE id=?', [job.target_id], '章节'));
      requireAI();
    }
    if (job.kind === 'import' && store.get('SELECT extracted FROM materials WHERE id=?', job.target_id)?.extracted) {
      throw new Problem(409, '这份资料已成功导入。');
    }
    runJob(res, cert(req), job.kind, job.target_id, parse(job.input));
  });

  owned.post('/search', async (req, res) => {
    const { query } = validated(z.object({ query: str(400) }), req.body);
    res.json({ results: await services.search(query) });
  });

  owned.post('/chapters/:chapterId/suggest-draft', async (req, res) => {
    chapter(req);
    requireAI();
    const source = validated(searchSource, req.body);
    res.json(await services.draft(source));
  });

  owned.post('/chapters/:chapterId/drafts', (req, res) => {
    const row = chapter(req);
    const { source, data } = validated(z.object({ source: searchSource, data: questionInput }), req.body);
    const id = insertQuestion(store, row.id, data, { type: source.official ? 'official' : 'web', url: publicLink(source.url), title: source.title }, false);
    res.status(201).json({ id });
  });

  owned.patch('/questions/:questionId', (req, res) => {
    const row = question(req);
    if (row.approved) throw new Problem(409, '这道题已经审核。');
    const { data, approve, source } = validated(z.object({ data: questionInput, approve: z.boolean(), source: searchSource }), req.body);
    store.run('UPDATE questions SET kind=?, stem=?, options=?, answer=?, explanation=?, source=?, approved=? WHERE id=?',
      data.kind, data.stem, JSON.stringify(data.options), JSON.stringify(data.answer), data.explanation,
      JSON.stringify({ type: source.official ? 'official' : 'web', url: publicLink(source.url), title: source.title }), approve ? 1 : 0, row.id);
    res.json({ ok: true });
  });

  owned.delete('/questions/:questionId', (req, res) => {
    const row = question(req);
    if (row.approved) throw new Problem(409, '只能删除未审核的草稿。');
    store.run('DELETE FROM questions WHERE id=?', row.id);
    res.json({ ok: true });
  });

  owned.post('/chapters/:chapterId/attempts', (req, res) => {
    const row = chapter(req);
    if (!row.learned_at) throw new Problem(422, '请先将本章标记为学完。');
    res.status(201).json(openAttempt(store, cert(req), row, 'chapter'));
  });
  owned.post('/mistake-attempts', (req, res) => {
    const { ids } = validated(z.object({ ids: z.array(str(100)).min(1).max(100) }), req.body);
    res.status(201).json(openAttempt(store, cert(req), null, 'mistake', [...new Set(ids)]));
  });
  owned.get('/attempts/:attemptId', (req, res) => {
    const attempt = find(store, 'SELECT * FROM attempts WHERE id=? AND certificate_id=?', [req.params.attemptId, cert(req).id], '练习');
    res.json({ id: attempt.id, mode: attempt.mode, chapterId: attempt.chapter_id, questions: parse(attempt.questions).map(withoutAnswer),
      result: attempt.result ? parse(attempt.result) : null });
  });
  owned.post('/attempts/:attemptId/submit', (req, res) => {
    const answers = validated(z.record(str(100), z.array(z.number().int().min(0).max(5)).min(1).max(6)), req.body);
    res.json(submitAttempt(store, cert(req).id, req.params.attemptId, answers));
  });

  owned.get('/mistakes', (req, res) => {
    const rows = store.all(`SELECT q.*, m.wrong_count, m.mastered, m.history, m.updated_at, ch.title AS chapter_title,
      co.name AS course_name, co.id AS course_id FROM mistakes m JOIN questions q ON q.id=m.question_id
      JOIN chapters ch ON ch.id=q.chapter_id JOIN courses co ON co.id=ch.course_id WHERE co.certificate_id=?
      ORDER BY m.mastered ASC, m.updated_at DESC`, cert(req).id);
    res.json(rows.map((row) => ({ ...questionView(row), history: parse(row.history) })));
  });

  owned.post('/plan', (req, res) => {
    const settings = validated(settingsShape, req.body);
    settings.weekdays = [...new Set(settings.weekdays)];
    store.transaction(() => saveSchedule(store, cert(req), settings, localDay()));
    res.json({ ok: true });
  });

  owned.patch('/plan/tasks/:taskId', (req, res) => {
    const task = find(store, 'SELECT * FROM plan_tasks WHERE id=? AND certificate_id=?', [req.params.taskId, cert(req).id], '学习任务');
    if (!task.completed_at) store.run('UPDATE plan_tasks SET completed_at=? WHERE id=?', now(), task.id);
    res.json({ ok: true });
  });

  return api;
}
