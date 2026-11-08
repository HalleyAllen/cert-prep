import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createApp } from '../server/main.mjs';
import { localDay, shiftDay } from '../server/planner.mjs';
import { createServices } from '../server/services.mjs';

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
  const upload = async (name, body) => {
    const form = new FormData(); form.set('file', new Blob([body]), name);
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
});
