import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createApp } from '../server/main.mjs';
import { localDay, shiftDay } from '../server/planner.mjs';
import { createServices } from '../server/services.mjs';

test('service settings take effect immediately and survive restart without returning keys', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cert-prep-settings-'));
  let runtime;
  let server;
  let base;
  async function stop() {
    if (!server) return;
    runtime.jobs.stop();
    await new Promise((resolve) => server.close(resolve));
    runtime.store.close();
    server = undefined;
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  async function start() {
    runtime = createApp({ root, demo: false });
    server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = 'http://127.0.0.1:' + server.address().port;
  }
  const settingsPath = '/api/settings/services';
  const read = async () => (await fetch(base + settingsPath)).json();
  const save = (body, origin = base) => fetch(base + settingsPath, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  });
  const aiBaseUrl = 'https://ai.example/v1';
  const aiModel = 'test-model';
  await start();
  assert.equal((await save({ aiModel }, 'http://127.0.0.1:1')).status, 403);
  assert.equal((await save({ aiBaseUrl: 'file:///settings' })).status, 400);
  const saved = await save({ aiBaseUrl, aiModel, aiKey: 'test-ai-key', tavilyKey: 'test-search-key' });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await saved.json(), { aiBaseUrl, aiModel, hasAiKey: true, hasTavilyKey: true, aiReady: true, searchReady: true });
  const workspace = await (await fetch(base + '/api/workspace')).json();
  assert.equal(workspace.aiReady && workspace.searchReady, true);
  assert.equal((await save({ aiModel: 'new-model', tavilyKey: null })).status, 200);
  await stop();
  await start();
  assert.deepEqual(await read(), { aiBaseUrl, aiModel: 'new-model', hasAiKey: true, hasTavilyKey: false, aiReady: true, searchReady: false });
});

test('real local HTTP workflow survives errors, duplicate submissions and restart', { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cert-prep-workflow-'));
  let runtime;
  let server;
  let invalidResponse = false;
  const generated = { kind: 'single', stem: 'WBS 分解的对象是什么？', options: ['交付成果', '人员假期'], answer: [0], explanation: 'WBS 以交付成果为导向。' };
  const web = { url: 'https://exam.example/paper', title: '公开样题', snippet: '示例题与参考答案。' };
  const services = createServices({ AI_BASE_URL: 'https://ai.example/v1', AI_MODEL: 'test', AI_API_KEY: 'test', TAVILY_API_KEY: 'test' },
    async (url, options) => {
      if (String(url).includes('tavily')) return Response.json({ results: [{ url: web.url, title: web.title, content: web.snippet }] });
      const prompt = JSON.parse(options.body).messages[0].content;
      const content = invalidResponse ? 'not JSON' : JSON.stringify(prompt.includes('提炼摘要') ? { summary: '以成果为导向。',
        points: [{ kind: 'focus', title: '工作分解结构', explanation: '将成果分解为工作包。', units: [1, 999] }] } : { questions: [generated] });
      return Response.json({ choices: [{ message: { content } }] });
    });
  async function stop() {
    if (!server) return;
    runtime.jobs.stop();
    await new Promise((resolve) => server.close(resolve));
    while (runtime.jobs.isActive()) await delay(20);
    runtime.store.close();
    server = undefined;
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  async function start(adapter = services) {
    runtime = createApp({ root, services: adapter });
    server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  async function call(path, method = 'GET', body, expected = 200) {
    const form = body instanceof FormData;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method,
      headers: body && !form ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? (form ? body : JSON.stringify(body)) : undefined });
    const value = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
    return value;
  }
  const today = localDay();
  const future = shiftDay(today, 4);
  await start();
  assert.equal((await call('/workspace')).certificates[0].demo, true);
  const { id } = await call('/certificates', 'POST', { name: '我的备考', course: '综合知识', examDate: future }, 201);
  const base = `/certificates/${id}`;
  const course = (await call(base)).courses[0].id;
  await call(`${base}/chapters/demo-chapter-1`, 'GET', undefined, 404);
  await call(`${base}/courses`, 'POST', { name: '案例分析' }, 201);
  const upload = async (name, body, category) => {
    const form = new FormData(); form.set('file', new Blob([body]), name);
    if (category) form.set('category', category);
    return call(`${base}/courses/${course}/materials`, 'POST', form, 202);
  };
  async function waitJob(jobId) {
    for (let i = 0; i < 140; i += 1) {
      const job = (await call(base)).jobs.find((job) => job.id === jobId);
      if (job && ['failed', 'succeeded'].includes(job.status)) return job;
      await delay(65);
    }
    assert.fail(`Job ${jobId} timed out`);
  }
  const material = await upload('综合知识.txt', '第一章 范围\nWBS 以交付成果为导向。\n第二章 进度\n关键路径决定项目工期。');
  assert.equal((await waitJob(material.jobId)).status, 'succeeded');
  const broken = await upload('损坏.pdf', 'broken');
  assert.match((await waitJob(broken.jobId)).message, /有效的 PDF/);
  const retried = await call(`${base}/jobs/${broken.jobId}/retry`, 'POST', undefined, 202);
  assert.equal((await waitJob(retried.jobId)).status, 'failed');
  const snapshot = await call(base);
  assert.equal(snapshot.chapters.length, 2);
  const first = snapshot.chapters[0];
  const path = `${base}/chapters/${first.id}`;
  assert.equal((await call(`${base}/materials/${material.id}`)).name, '综合知识.txt');
  await call(`${base}/materials/${material.id}/units/1`, 'PATCH', { text: 'WBS 将交付成果分解成工作包。' });
  await call(path, 'PATCH', { title: '范围与 WBS', start: 1, end: 1, studyMinutes: 30, practiceMinutes: 10 });
  assert.equal((await waitJob((await call(`${path}/analyze`, 'POST', undefined, 202)).jobId)).status, 'succeeded');
  assert.deepEqual((await call(path)).analysis.sections[0].points[0].units, [1]);
  invalidResponse = true;
  const invalidJob = await call(`${path}/analyze`, 'POST', undefined, 202);
  assert.equal((await waitJob(invalidJob.jobId)).status, 'failed');
  assert.equal((await call(path)).analysis.sections[0].summary, '以成果为导向。');
  invalidResponse = false;
  const reanalysis = await call(`${base}/jobs/${invalidJob.jobId}/retry`, 'POST', undefined, 202);
  assert.equal((await waitJob(reanalysis.jobId)).status, 'succeeded');
  const generatedJob = await call(`${path}/generate`, 'POST', { count: 1 }, 202);
  assert.equal((await waitJob(generatedJob.jobId)).status, 'succeeded');
  assert.deepEqual((await call(`${base}/search`, 'POST', { query: '我的备考 综合知识 范围 试题' })).results, [web]);
  assert.deepEqual(await call(`${path}/suggest-draft`, 'POST', web), generated);
  const data = { kind: 'multiple', stem: '请选择两个交付物。', options: ['报告', '文档', '颜色偏好'], answer: [0, 1], explanation: '报告和文档均可作为交付物。' };
  const draft = await call(`${path}/drafts`, 'POST', { data, source: web }, 201);
  assert.equal((await call(path)).question_count, 1);
  assert.equal((await call(path)).drafts.length, 1);
  await call(`${base}/questions/${draft.id}`, 'PATCH', { data, source: { ...web, official: true }, approve: true });
  assert.equal((await call(path)).question_count, 2);
  await call(`${base}/plan`, 'POST', { minutes: 15, weekdays: [0, 1, 2, 3, 4, 5, 6] });
  const planned = await call(base);
  assert.ok(planned.certificate.plan.unscheduled.length);
  const task = planned.tasks[0];
  await call(`${base}/plan/tasks/${task.id}`, 'PATCH');
  await call(base, 'PATCH', { name: '我的备考', examDate: shiftDay(today, 6) });
  const rescheduled = await call(base);
  assert.ok(rescheduled.tasks.find((item) => item.id === task.id).completed_at);
  assert.ok(rescheduled.tasks.some((item) => item.kind === 'review'));
  await call(`${path}/learn`, 'POST');
  const attempt = await call(`${path}/attempts`, 'POST', undefined, 201);
  assert.ok(attempt.questions.every((item) => !('answer' in item)));
  const approved = attempt.questions.find((question) => question.id === draft.id);
  assert.equal(approved.source.type, 'official');
  const ai = attempt.questions.find((question) => question.id !== draft.id);
  const answers = { [ai.id]: [1], [approved.id]: [1, 0] };
  const [grade, duplicate] = await Promise.all([1, 2].map(() => call(`${base}/attempts/${attempt.id}/submit`, 'POST', answers)));
  assert.equal(grade.correctCount, 1);
  assert.deepEqual(duplicate, grade);
  let mistakes = await call(`${base}/mistakes`);
  assert.equal(mistakes.length, 1);
  assert.equal(mistakes[0].wrong_count, 1);
  const retake = await call(`${base}/mistake-attempts`, 'POST', { ids: [ai.id] }, 201);
  await call(`${base}/attempts/${retake.id}/submit`, 'POST', { [ai.id]: [0] });
  mistakes = await call(`${base}/mistakes`);
  assert.equal(mistakes[0].mastered, 1);
  assert.equal(mistakes[0].history.length, 2);
  const relapse = await call(`${base}/mistake-attempts`, 'POST', { ids: [ai.id] }, 201);
  await call(`${base}/attempts/${relapse.id}/submit`, 'POST', { [ai.id]: [1] });
  assert.equal((await call(`${base}/mistakes`))[0].mastered, 0);
  await stop();
  await start(createServices({}));
  assert.equal((await call(`${base}/mistakes`))[0].wrong_count, 2);
  assert.ok((await call(path)).practiced_at);
  assert.equal((await call(`${base}/materials/${material.id}`)).units[0].text, 'WBS 将交付成果分解成工作包。');
  await call(`${path}/analyze`, 'POST', undefined, 503);
  await call(`${base}/search`, 'POST', { query: '测试' }, 503);
  assert.equal((await call('/certificates/demo')).chapters.length, 6);

  const kick = runtime.jobs.kick;
  runtime.jobs.kick = () => {};
  const pending = await upload('可取消.txt', '第一章 复习\n检查导入可以取消。\n第二章 重点\n准备重点。\n第三章 练习\n完成练习。');
  await call(`${base}/materials/${pending.id}`, 'DELETE', undefined, 409);
  await call(`${base}/jobs/${pending.jobId}/cancel`, 'POST');
  const cancelled = await call(`${base}/materials/${pending.id}`);
  assert.equal(cancelled.job.status, 'cancelled');
  assert.deepEqual(cancelled.units, []);
  runtime.jobs.kick = kick;
  const resumed = await call(`${base}/jobs/${pending.jobId}/retry`, 'POST', undefined, 202);
  assert.equal((await waitJob(resumed.jobId)).status, 'succeeded');

  const combined = await call(`${base}/materials/${pending.id}/chapters`, 'POST',
    { title: '跨片段复习', start: 1, end: 3, studyMinutes: 30, practiceMinutes: 10 }, 201);
  await call(`${base}/materials/${pending.id}/units/2`, 'DELETE');
  const merged = await call(`${base}/chapters/${combined.id}`);
  assert.deepEqual(merged.units.map((unit) => unit.position), [1, 3]);
  assert.equal(merged.unit_count, 2);
  assert.equal(merged.unit_max, 3);
  await call(`${base}/chapters/${combined.id}`, 'PATCH',
    { title: '跨片段复习', start: 2, end: 3, studyMinutes: 30, practiceMinutes: 10 }, 400);
  await call(`${base}/materials/${pending.id}/units/1`, 'DELETE');
  const narrowed = await call(`${base}/chapters/${combined.id}`);
  assert.deepEqual([narrowed.start_unit, narrowed.end_unit, narrowed.unit_min, narrowed.unit_max], [3, 3, 3, 3]);

  await call(`/certificates/demo/materials/${material.id}/units/1`, 'DELETE', undefined, 404);
  await call(`${base}/materials/${material.id}/units/1`, 'DELETE');
  const empty = await call(path);
  assert.deepEqual(empty.units, []);
  assert.equal(empty.analysis, null);
  assert.ok(empty.practiced_at);
  assert.equal(empty.question_count, 2);
  assert.deepEqual((await call(`${base}/materials/${material.id}`)).units.map((unit) => unit.position), [2]);
  assert.equal((await call(`${base}/mistakes`))[0].wrong_count, 2);
  await call(`${path}/analyze`, 'POST', undefined, 422);

  const original = runtime.store.get('SELECT file_key FROM materials WHERE id=?', material.id);
  const originalPath = join(root, 'uploads', original.file_key);
  assert.equal(existsSync(originalPath), true);
  await call(`/certificates/demo/materials/${material.id}`, 'DELETE', undefined, 404);
  assert.deepEqual(await call(`${base}/materials/${material.id}`, 'DELETE'), { ok: true, fileCleanupPending: false });
  assert.equal(existsSync(originalPath), false);
  await call(`${base}/materials/${material.id}`, 'GET', undefined, 404);
  await call(path, 'GET', undefined, 404);
  await call(`${base}/attempts/${attempt.id}`, 'GET', undefined, 404);
  await call(`${base}/attempts/${retake.id}`, 'GET', undefined, 404);
  assert.deepEqual(await call(`${base}/mistakes`), []);
  const remaining = await call(base);
  const removedChapters = new Set(snapshot.chapters.map((chapter) => chapter.id));
  assert.ok(remaining.tasks.every((task) => !removedChapters.has(task.chapter_id)));
  assert.ok(remaining.certificate.plan.unscheduled.every((task) => !removedChapters.has(task.chapterId)));
  assert.ok(remaining.materials.some((item) => item.id === pending.id));
  assert.ok(remaining.materials.some((item) => item.id === broken.id));
  assert.ok(remaining.jobs.every((job) => job.target_id !== material.id && !removedChapters.has(job.target_id)));

  const textbook = await upload('课本.txt', '第 3 章练习\n教材正文。', 'textbook');
  assert.equal((await waitJob(textbook.jobId)).status, 'succeeded');
  const withTextbook = await call(base);
  const textbookChapter = withTextbook.chapters.find((chapter) => chapter.material_id === textbook.id);
  const noteChapter = withTextbook.chapters.find((chapter) => chapter.material_id === pending.id && chapter.title === '第三章 练习');
  assert.ok(textbookChapter && noteChapter);
  assert.ok(withTextbook.study_chapter_ids.includes(textbookChapter.id));
  assert.ok(!withTextbook.study_chapter_ids.includes(noteChapter.id));
  await call(`${base}/plan`, 'POST', { minutes: 120, weekdays: [0, 1, 2, 3, 4, 5, 6] });
  const dedupedPlan = await call(base);
  const plannedIds = new Set([...dedupedPlan.tasks.map((task) => task.chapter_id), ...dedupedPlan.certificate.plan.unscheduled.map((task) => task.chapterId)]);
  assert.ok(plannedIds.has(textbookChapter.id));
  assert.ok(!plannedIds.has(noteChapter.id));
});
