import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractMaterial, suggestedChapters } from '../server/importer.mjs';
import { schedule } from '../server/planner.mjs';
import { createServices } from '../server/services.mjs';
import { docxFixture, imageFixture, pdfFixture } from './fixtures.mjs';

test('PDF text, scanned PDF, DOCX, TXT, PNG and JPG import with source locations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cert-prep-formats-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixtures = [
    ['text.pdf', pdfFixture(), /Project Scope/i, 1, 'text'],
    ['scan.pdf', pdfFixture(true), /PROJECT STUDY GUIDE/i, 1, 'ocr'],
    ['handout.docx', docxFixture(), /质量管理/, null, 'text'],
    ['handout.txt', Buffer.from('第一章 范围\n范围说明交付内容。\n第二章 进度\n工期由关键路径决定。'), /交付内容/, null, 'text'],
    ['phone.png', imageFixture(), /项目管理/, 1, 'ocr'],
    ['phone.jpg', imageFixture('image/jpeg'), /PROJECT STUDY GUIDE/i, 1, 'ocr'],
  ];
  for (const [name, data, pattern, page, method] of fixtures) {
    const path = join(directory, name);
    await writeFile(path, data);
    const units = await extractMaterial({ filePath: path, extension: name.slice(name.lastIndexOf('.')) });
    assert.match(units.map((unit) => unit.text).join('\n').replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, '$1'), pattern, name);
    assert.ok(units.every((unit) => unit.page === page && unit.method === method), name);
    if (name === 'handout.txt') assert.equal(suggestedChapters(units, name).length, 2);
  }
  const bad = join(directory, 'bad.pdf');
  await writeFile(bad, 'broken');
  await assert.rejects(() => extractMaterial({ filePath: bad, extension: '.pdf' }), /有效的 PDF/);
});

test('schedule preserves completed minutes, keeps daily capacity and leaves an overflow list', () => {
  const settings = { minutes: 25, weekdays: [0, 1, 2, 3, 4, 5, 6] };
  const chapters = [{ id: 'a', title: '第一章', study_minutes: 30, practice_minutes: 10 },
    { id: 'b', title: '第二章', study_minutes: 30, practice_minutes: 10 }];
  const result = schedule({ today: '2026-11-08', examDate: '2026-11-11', settings, chapters,
    completed: [{ chapter_id: 'a', kind: 'study', day: '2026-11-07', minutes: 20 }] });
  assert.deepEqual(result.tasks.map(({ kind, minutes }) => [kind, minutes]), [['study', 10], ['practice', 10], ['study', 5], ['study', 25], ['review', 25]]);
  assert.deepEqual(result.unscheduled.map(({ kind, minutes }) => [kind, minutes]), [['practice', 10]]);
  const soon = schedule({ today: '2026-11-08', examDate: '2026-11-08', settings, chapters, completed: [] });
  assert.equal(soon.tasks.length, 0);
  assert.equal(soon.unscheduled.length, 4);
});

test('provider sanitizes citations, excludes material from search, and surfaces configuration and timeout errors', async () => {
  const env = { AI_BASE_URL: 'https://model.example/v1', AI_MODEL: 'test-model', AI_API_KEY: 'test', TAVILY_API_KEY: 'test' };
  const response = (value) => Response.json(value);
  const services = createServices(env, async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    if (String(url).includes('tavily')) {
      const body = JSON.parse(options.body);
      assert.equal(body.query, '项目管理 试题');
      assert.equal(body.include_raw_content, false);
      return response({ results: [{ title: '公开题', url: 'https://exam.example/paper', content: '摘要' }, { title: '不安全', url: 'javascript:alert(1)' }] });
    }
    assert.equal(String(url), 'https://model.example/v1/chat/completions');
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.ok(input.units.every((unit) => unit.text.length <= 4200));
    return response({ choices: [{ message: { content: JSON.stringify({ summary: '章节摘要',
      points: [{ kind: 'key', title: '重要概念', explanation: '定义', units: [7, 999, 7] }] }) } }] });
  });
  const result = await services.analyze('范围', [{ position: 7, text: '原文。'.repeat(4000) }], () => {});
  assert.equal(result.sections.length, 2);
  assert.deepEqual(result.sections[0].points[0].units, [7]);
  assert.equal((await services.search('项目管理 试题')).length, 1);
  await assert.rejects(() => createServices({}).search('题'), /配置/);
  await assert.rejects(() => createServices(env, async () => { throw new DOMException('timeout', 'TimeoutError'); }).search('题'), /超时/);
  await assert.rejects(() => createServices(env, async () => response({ choices: [{ message: { content: 'bad' } }] }))
    .analyze('范围', [{ position: 1, text: '正文' }], () => {}), /格式/);
});
