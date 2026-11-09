import assert from 'node:assert/strict';
import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractMaterial, splitUnits, suggestedChapters } from '../server/importer.mjs';
import { cleanPageText } from '../server/text-cleanup.mjs';
import { reflowPdfPage } from '../server/pdf-layout.mjs';
import { renderPdfVisual } from '../server/pdf-visual.mjs';
import { applyPdfOutline, pdfChapterOutline } from '../server/pdf-structure.mjs';
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
    if (name === 'text.pdf') {
      const marks = units.flatMap((unit) => unit.marks);
      assert.doesNotMatch(units.map((unit) => unit.text).join('\n'), /Page 1/i);
      assert.ok(marks.some((mark) => mark.color && mark.background === '#ffff00'));
      assert.ok(marks.some((mark) => mark.underline));
      const preview = await renderPdfVisual(path, 1, { x0: 0.05, x1: 0.95, y0: 0.1, y1: 0.55 });
      assert.equal(preview.subarray(1, 4).toString(), 'PNG');
    }
    if (name === 'handout.docx') {
      const unit = units.find((item) => item.text.includes('验收依据'));
      const mark = unit.marks.find((item) => unit.text.slice(item.start, item.end).includes('验收依据'));
      assert.deepEqual({ color: mark.color, background: mark.background, underline: mark.underline },
        { color: '#c00000', background: '#ffff00', underline: true });
    }
    if (name === 'handout.txt') assert.equal(suggestedChapters(units, name).length, 2);
  }
  const bad = join(directory, 'bad.pdf');
  await writeFile(bad, 'broken');
  await assert.rejects(() => extractMaterial({ filePath: bad, extension: '.pdf' }), /有效的 PDF/);
});

test('parallel OCR preserves source order and stops when cancelled', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-prep-ocr-test-'));
  const filePath = join(dir, 'scan.pdf');
  t.after(async () => {
    await rm(filePath, { force: true });
    await rmdir(dir);
  });
  await writeFile(filePath, pdfFixture(true, 4));
  const progress = [];
  const units = await extractMaterial({ filePath, extension: '.pdf', ocrConcurrency: 2 }, (value) => progress.push(value));
  assert.deepEqual(units.map((unit) => unit.page), [1, 2, 3, 4]);
  assert.ok(units.every((unit) => unit.method === 'ocr' && /PROJECT STUDY GUIDE/i.test(unit.text)));
  assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));

  const controller = new AbortController();
  await assert.rejects(() => extractMaterial({ filePath, extension: '.pdf', ocrConcurrency: 2 }, (value) => {
    if (value > 5 && value < 96) controller.abort();
  }, controller.signal), { name: 'AbortError' });
});

test('page cleanup removes recurring margins and preserves body text and page references', () => {
  const pages = [4, 5, 6].map((page) => ({
    page,
    method: 'ocr',
    lines: [
      { text: '第一章 项目范围', edge: 'top' },
      { text: '学习资料 水印', edge: 'right' },
      { text: '学习资料 水印', edge: null },
      { text: '100', edge: null },
      { text: '范围（交付成果)。交付见表2-3）。范围（见图1-2。', edge: null },
      { text: '数学区间 (0, 1]。还有（断句', edge: null },
      { text: String(page - 3), edge: 'bottom' },
    ],
  }));
  const result = cleanPageText(pages);
  assert.deepEqual(result.map(({ page, method }) => [page, method]), [[4, 'ocr'], [5, 'ocr'], [6, 'ocr']]);
  for (const { text } of result) {
    assert.equal(text, '第一章 项目范围\n学习资料 水印\n100\n范围（交付成果）。交付（见表2-3）。范围（见图1-2）。\n数学区间 (0, 1]。还有（断句');
  }
  assert.equal(cleanPageText([{ page: 1, method: 'ocr', lines: [
    { text: '单次出现的边角文字', edge: 'top' },
    { text: '正文', edge: null },
    { text: '第 10 页', edge: 'bottom' },
  ] }])[0].text, '单次出现的边角文字\n正文');
});

test('chapter suggestions skip front matter while keeping its original text', () => {
  const units = splitUnits('封面\n前言\n作者说明。\n第一章 项目范围\n交付成果。\n第二章 项目进度\n关键路径。', 1, 'text');
  assert.equal(units[1].heading, '前言');
  assert.match(units[1].text, /作者说明/);
  assert.deepEqual(suggestedChapters(units, '课本.txt'), [
    { title: '第一章 项目范围', start: 3, end: 3 }, { title: '第二章 项目进度', start: 4, end: 4 },
  ]);
});

test('PDF outlines use real chapter starts and suppress repeated margin headings', async () => {
  const pdf = { numPages: 9, getOutline: async () => [
    { title: '目录', dest: [0] },
    { title: '第一章 范围', dest: [2] },
    { title: '第2章进度', dest: [5] },
  ] };
  const outline = await pdfChapterOutline(pdf, async (page) => ({
    3: ['第一章 范围'], 6: ['第一章 范围', '本章练习'], 7: ['第2章 进度'],
  })[page] ?? []);
  assert.deepEqual(outline, [{ title: '第一章 范围', page: 3 }, { title: '第2章 进度', page: 7 }]);
  const pages = cleanPageText([
    { page: 3, method: 'text', lines: [{ text: '第一章 范围', edge: 'top' }, { text: '交付成果', edge: null }] },
    { page: 4, method: 'text', lines: [{ text: '第1章 范围 2', edge: 'top' }, { text: '正文', edge: null }] },
    { page: 7, method: 'text', lines: [{ text: '第2章 进度', edge: null }] },
  ], new Set(outline.map((item) => item.page)));
  assert.equal(pages[1].text, '正文');
  const units = pages.flatMap(({ text, page, method, marks }) => splitUnits(text, page, method, marks, false));
  applyPdfOutline(units, outline);
  assert.deepEqual(suggestedChapters(units, '教材.pdf'), [
    { title: '第一章 范围', start: 1, end: 2 }, { title: '第2章 进度', start: 3, end: 3 },
  ]);

  const unbookmarked = splitUnits('第一章 范围\n正文。\n第1章 范围 页眉\n更多正文。\n第二章 进度\n关键路径。', 1, 'text');
  assert.deepEqual(suggestedChapters(unbookmarked, '无书签.pdf').map((item) => item.title), ['第一章 范围', '第二章 进度']);
});

test('PDF layout restores paragraphs and preserves non-text page regions', () => {
  const line = (text, y, x0 = 0.1, x1 = 0.9, edge = null) => ({
    text, edge, bounds: { x0, x1, y0: y - 0.015, y1: y },
  });
  const page = { page: 14, method: 'text', lines: [
    line('第1章 项目范围', 0.12, 0.3, 0.7),
    line('第一段从缩进的位置开始，正文太长在原书里需要换', 0.20, 0.14),
    line('行，继续说明章节的内容和范围，应该放在同一个段落。', 0.224),
    line('第二段也应该缩进，这一段说明项目范围和交付成果。', 0.248, 0.14),
    line('H=-2n(?)og,pc)', 0.30, 0.35, 0.55),
    line('最后一段介绍系统的实施过程，包括关键环节与交付成果。', 0.40),
    line('系统实施', 0.54, 0.35, 0.49),
    line('验收', 0.62, 0.48, 0.55),
    line('图1-3 信息系统全生命周期示意图', 0.90, 0.3, 0.75, 'bottom'),
    line('最新全套考证网课，联系微信：testaccount', 0.98, 0.2, 0.8, 'bottom'),
  ] };
  const [cleaned] = cleanPageText([page], new Set(), reflowPdfPage);
  assert.match(cleaned.text, /\n\n　　第一段.*需要换行/u);
  assert.match(cleaned.text, /\n\n　　第二段/u);
  assert.doesNotMatch(cleaned.text, /H=-2|联系微信|\n系统实施/u);
  assert.deepEqual(cleaned.visuals.map(({ kind }) => kind).sort(), ['figure', 'formula']);
  const [unit] = splitUnits(cleaned.text, 14, 'text', cleaned.marks, false, cleaned.visuals);
  assert.match(unit.text, /\n\n　　第一段/u);
  assert.equal(unit.visuals.length, 2);

  const table = reflowPdfPage([
    line('表1-2 实施方案对比', 0.38, 0.28, 0.72),
    line('方案甲', 0.42, 0.16, 0.35),
    line('方案乙', 0.49, 0.16, 0.35),
    line('以下是保留的正文内容。这一行不属于表格中的数据。', 0.55),
  ], { tableRules: [0.39, 0.43, 0.47, 0.51, 0.72] });
  assert.equal(table.visuals[0].kind, 'table');
  assert.ok(table.visuals[0].bounds.y1 > 0.51 && table.visuals[0].bounds.y1 < 0.55);
  assert.ok(table.lines.some((item) => item.text.startsWith('以下是保留')));
  assert.ok(!table.lines.some((item) => item.text === '方案甲' || item.text === '方案乙'));
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
