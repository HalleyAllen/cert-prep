import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, Download, ExternalLink, FilePlus2, FileText, Files, PenLine, Plus, Search, Sparkles, UploadCloud } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, fileURL, isActive, unitLabel, type Chapter, type ChapterDetail, type Context, type Draft, type Job, type MaterialDetail, type Unit } from './model';
import { DraftEditor } from './practice';
import { Empty, ErrorBox, Heading, JobLine, Loading, Modal, useAction, useResource } from './ui';

function retryJob(ctx: Context, action: ReturnType<typeof useAction>, job: Job) {
  void action.run(async () => { await api(`${ctx.base}/jobs/${job.id}/retry`, 'POST'); await ctx.refresh(); });
}

export function MaterialsPage({ ctx }: { ctx: Context }) {
  const { data, go, base } = ctx;
  const [course, setCourse] = useState(data.courses[0]?.id || '');
  const [file, setFile] = useState<File>();
  const [addCourse, setAddCourse] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const action = useAction();
  return <div className="screen"><Heading kicker="LIBRARY / 学习资料" title="资料库" note="把教材和讲义导入到对应科目，再校对原文和章节。"
    action={<button className="btn secondary" onClick={() => setAddCourse(true)}><Plus size={17} /> 添加科目</button>} />
    <section className="card panel"><div className="panel-head"><div><h2>导入资料</h2><p>PDF、DOCX、TXT、JPG 或 PNG · 单个文件最多 100 MB</p></div></div>
      <form ref={form} className="stack" onSubmit={(event) => {
        event.preventDefault();
        if (!file) { action.setError('请先选择一份资料。'); return; }
        const body = new FormData(event.currentTarget); body.set('file', file);
        if (body.has('forceOcr')) body.set('forceOcr', 'true');
        void action.run(async () => {
          await api(`${base}/courses/${course}/materials`, 'POST', body);
          form.current?.reset(); setFile(undefined); await ctx.refresh(); ctx.notify('资料已加入导入队列');
        });
      }}>
        <label>归属科目<select value={course} onChange={(event) => setCourse(event.target.value)} required>{data.courses.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
        <label className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setFile(event.dataTransfer.files[0]); }}>
          <input type="file" name="file" accept=".pdf,.docx,.txt,.png,.jpg,.jpeg" aria-label="选择资料文件" onChange={(event) => setFile(event.target.files?.[0])} />
          <UploadCloud size={28} /><strong>{file?.name || '点击选择文件，或拖到这里'}</strong><span>扫描页和图片会在本机识别文字</span>
        </label>
        {file?.name.toLowerCase().endsWith('.pdf') && <label className="check-label"><input type="checkbox" name="forceOcr" />对整份 PDF 使用 OCR（适用于文字层异常的扫描件）</label>}
        <ErrorBox message={action.error} /><div><button className="btn primary" disabled={action.busy || !file || !course}><FilePlus2 size={16} />{action.busy ? '正在上传…' : '开始导入'}</button></div>
      </form>
    </section>
    <section className="card panel"><div className="panel-head"><div><h2>已导入资料</h2><p>{data.materials.length} 份资料</p></div></div>
      {data.materials.length ? <ul className="record-list">{data.materials.map((material) => {
        const job = data.jobs.find((item) => item.id === material.job_id);
        return <li key={material.id}><button className="record-row" onClick={() => go('material', material.id)}>
          <div className="record-icon"><FileText size={20} /></div><div><strong>{material.name}</strong><small>{data.courses.find((item) => item.id === material.course_id)?.name} · {material.extracted ? `${material.unit_count} 个原文片段` : '等待提取'}</small></div>
          <ChevronRight size={18} /></button>
          {job && job.status !== 'succeeded' && <JobLine job={job} retry={() => retryJob(ctx, action, job)} />}
        </li>;
      })}</ul> : <Empty icon={<Files size={25} />} title="资料库还是空的" note="导入第一份教材后，就可以检查识别结果和章节。" />}
    </section>
    {addCourse && <AddCourse ctx={ctx} close={() => setAddCourse(false)} select={setCourse} />}
  </div>;
}

function AddCourse({ ctx, close, select }: { ctx: Context; close: () => void; select: (id: string) => void }) {
  const action = useAction();
  return <Modal title="添加科目" onClose={close}><form className="stack" onSubmit={(event) => {
    event.preventDefault(); const name = new FormData(event.currentTarget).get('name');
    void action.run(async () => {
      const result = await api<{ id: string }>(`${ctx.base}/courses`, 'POST', { name });
      await ctx.refresh(); select(result.id); close(); ctx.notify('科目已添加');
    });
  }}><label>科目名称<input name="name" maxLength={100} required autoFocus /></label><ErrorBox message={action.error} />
    <div className="form-actions"><button className="btn secondary" type="button" onClick={close}>取消</button><button className="btn primary" disabled={action.busy}>保存科目</button></div>
  </form></Modal>;
}

export function MaterialPage({ ctx, id }: { ctx: Context; id?: string }) {
  const latest = ctx.data.jobs.find((item) => item.target_id === id && item.kind === 'import');
  const resource = useResource<MaterialDetail>(`${ctx.base}/materials/${id}`, `${latest?.id}:${latest?.status}`);
  const action = useAction();
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<Unit>();
  const [adding, setAdding] = useState(false);
  const material = resource.value;
  if (resource.error) return <ErrorBox message={resource.error} retry={resource.reload} />;
  if (!material) return <Loading />;
  const job = latest || material.job;
  const chapters = ctx.data.chapters.filter((chapter) => chapter.material_id === material.id);
  const size = 12;
  return <div className="screen"><button className="back" onClick={() => ctx.go('materials')}><ArrowLeft size={17} /> 返回资料库</button>
    <Heading kicker="SOURCE / 原文校对" title={material.name} note="校对文字并记录原文位置。章节范围用片段编号设置。"
      action={<a className="btn secondary" href={`${fileURL(ctx.base, material.id)}?download=1`}><Download size={17} /> 下载原文件</a>} />
    <ErrorBox message={action.error} />
    {job && <JobLine job={job} retry={() => retryJob(ctx, action, job)} />}
    {!!material.extracted && <div className="split-layout reversed"><section className="card panel"><div className="panel-head"><div><h2>原文片段</h2><p>{material.units.length} 个片段 · 可直接校对识别文字</p></div></div>
      <div className="units">{material.units.slice(page * size, (page + 1) * size).map((unit) => <div className="unit" key={unit.position}>
        <div className="unit-head"><strong>{unitLabel(unit)}</strong>{unit.method === 'ocr' && <span className="pill">OCR</span>}<button className="btn small secondary" onClick={() => setEditing(unit)}><PenLine size={14} /> 校对</button>
          {unit.page && <a className="mini-link" href={fileURL(ctx.base, material.id, material.extension === '.pdf' ? unit.page : null)} target="_blank" rel="noreferrer">原文件 <ExternalLink size={13} /></a>}</div>
        <p>{unit.text}</p>
      </div>)}</div>
      {material.units.length > size && <div className="pagination"><button className="btn secondary small" disabled={!page} onClick={() => setPage(page - 1)}>上一组</button>
        <span>{page + 1} / {Math.ceil(material.units.length / size)}</span><button className="btn secondary small" disabled={(page + 1) * size >= material.units.length} onClick={() => setPage(page + 1)}>下一组</button></div>}
    </section><section className="card panel"><div className="panel-head"><div><h2>资料章节</h2><p>{chapters.length} 章 · 可调整自动建议的范围</p></div></div>
      <ul className="record-list">{chapters.map((chapter) => <li key={chapter.id}><button className="record-row compact" onClick={() => ctx.go('chapter', chapter.id)}>
        <div><strong>{chapter.title}</strong><small>片段 {chapter.start_unit}–{chapter.end_unit}</small></div><ChevronRight size={16} />
      </button></li>)}</ul><button className="btn secondary" onClick={() => setAdding(true)}><Plus size={16} /> 新建章节</button>
    </section></div>}
    {editing && <Modal title={`校对 ${unitLabel(editing)}`} onClose={() => setEditing(undefined)}><form className="stack" onSubmit={(event) => {
      event.preventDefault(); const text = new FormData(event.currentTarget).get('text');
      void action.run(async () => {
        await api(`${ctx.base}/materials/${material.id}/units/${editing.position}`, 'PATCH', { text });
        resource.reload(); setEditing(undefined); ctx.notify('原文已更新，相关章节可重新分析');
      });
    }}><label>原文<textarea name="text" aria-label="原文" defaultValue={editing.text} required maxLength={20000} rows={10} /></label>
      <p className="muted">改动会清除引用此片段的已有分析。</p><ErrorBox message={action.error} /><div className="form-actions"><button className="btn primary" disabled={action.busy}>保存校对</button></div>
    </form></Modal>}
    {adding && <ChapterForm unitCount={material.units.length} close={() => setAdding(false)} save={async (data) => {
      const item = await api<{ id: string }>(`${ctx.base}/materials/${material.id}/chapters`, 'POST', data);
      await ctx.refresh(); ctx.notify('章节已添加'); ctx.go('chapter', item.id);
    }} />}
  </div>;
}

function ChapterForm({ chapter, unitCount, close, save }: { chapter?: Chapter; unitCount: number; close: () => void;
  save: (data: { title: string; start: number; end: number; studyMinutes: number; practiceMinutes: number }) => Promise<void> }) {
  const action = useAction();
  return <Modal title={chapter ? '编辑章节范围与时长' : '新建章节'} onClose={close}><form className="stack" onSubmit={(event) => {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    void action.run(async () => save({ title: String(fields.get('title')), start: Number(fields.get('start')), end: Number(fields.get('end')),
      studyMinutes: Number(fields.get('study')), practiceMinutes: Number(fields.get('practice')) }));
  }}>
    <label>章节标题<input name="title" required maxLength={140} defaultValue={chapter?.title} /></label>
    <div className="field-grid"><label>起始片段<input name="start" type="number" min={1} max={unitCount} required defaultValue={chapter?.start_unit || 1} /></label>
      <label>结束片段<input name="end" type="number" min={1} max={unitCount} required defaultValue={chapter?.end_unit || unitCount} /></label></div>
    <div className="field-grid"><label>学习分钟数<input name="study" type="number" min={5} max={720} required defaultValue={chapter?.study_minutes || 30} /></label>
      <label>练习分钟数<input name="practice" type="number" min={5} max={720} required defaultValue={chapter?.practice_minutes || 10} /></label></div>
    <p className="muted">片段范围为 1–{unitCount}。修改预计时长后，可在学习计划中重新排程。</p><ErrorBox message={action.error} />
    <div className="form-actions"><button className="btn secondary" type="button" onClick={close}>取消</button><button className="btn primary" disabled={action.busy}>保存章节</button></div>
  </form></Modal>;
}

export function ChaptersPage({ ctx, initialCourse }: { ctx: Context; initialCourse?: string }) {
  const [filter, setFilter] = useState(initialCourse || '');
  const courses = ctx.data.courses.filter((course) => !filter || filter === course.id);
  return <div className="screen"><Heading kicker="CHAPTERS / 学习进度" title="章节学习" note="按科目阅读教材、复习知识点和完成章节练习。"
    action={<select aria-label="按科目筛选" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">全部科目</option>{ctx.data.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select>} />
    {courses.map((course) => {
      const chapters = ctx.data.chapters.filter((chapter) => chapter.course_id === course.id);
      return <section className="card panel" key={course.id}><div className="panel-head"><div><h2>{course.name}</h2><p>{chapters.filter((chapter) => chapter.learned_at).length} / {chapters.length} 章已学</p></div></div>
        {chapters.length ? <ul className="record-list">{chapters.map((chapter, index) => <li key={chapter.id}><button className="record-row" onClick={() => ctx.go('chapter', chapter.id)}>
          <div className="record-icon chapter-index">{String(index + 1).padStart(2, '0')}</div><div><strong>{chapter.title}</strong><small>{chapter.question_count} 道练习 · 预计 {chapter.study_minutes + chapter.practice_minutes} 分钟</small></div>
          <span className={`pill ${chapter.learned_at ? 'green' : ''}`}>{chapter.practiced_at ? '已练习' : chapter.learned_at ? '已学' : '待学习'}</span><ChevronRight size={18} />
        </button></li>)}</ul> : <Empty icon={<BookOpen size={25} />} title="这个科目还没有章节" note="先导入教材或讲义。" action={<button className="btn secondary" onClick={() => ctx.go('materials')}>打开资料库</button>} />}
      </section>;
    })}
  </div>;
}

export function ChapterPage({ ctx, id }: { ctx: Context; id?: string }) {
  const jobs = ctx.data.jobs.filter((item) => item.target_id === id && item.kind !== 'import');
  const currentJobs = [jobs.find((item) => item.kind === 'analyze'), jobs.find((item) => item.kind === 'generate')];
  const resource = useResource<ChapterDetail>(`${ctx.base}/chapters/${id}`, currentJobs.map((job) => `${job?.id}:${job?.status}`).join(','));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>();
  const [sourcePage, setSourcePage] = useState(0);
  const [activeUnit, setActiveUnit] = useState<number>();
  const [questionCount, setQuestionCount] = useState(5);
  const action = useAction();
  const { base, refresh } = ctx;
  useEffect(() => { if (id) void api(`${base}/chapters/${id}/visit`, 'POST').then(refresh).catch(() => {}); }, [base, id, refresh]);
  useEffect(() => {
    if (activeUnit === undefined) return;
    const element = document.getElementById(`unit-${activeUnit}`);
    element?.scrollIntoView({ block: 'center' }); element?.focus({ preventScroll: true });
  }, [activeUnit, sourcePage]);
  const chapter = resource.value;
  if (resource.error) return <ErrorBox message={resource.error} retry={resource.reload} />;
  if (!chapter) return <Loading />;
  const chunk = 8;
  const startAI = (kind: 'analyze' | 'generate') => void action.run(async () => {
    await api(`${base}/chapters/${chapter.id}/${kind}`, 'POST', kind === 'generate' ? { count: questionCount } : undefined);
    await ctx.refresh(); ctx.notify('AI 任务已加入队列');
  });
  const beginQuiz = () => void action.run(async () => {
    const attempt = await api<{ id: string }>(`${base}/chapters/${chapter.id}/attempts`, 'POST'); ctx.go('quiz', attempt.id);
  });
  return <div className="screen"><button className="back" onClick={() => ctx.go('chapters')}><ArrowLeft size={17} /> 返回章节列表</button>
    <Heading kicker="CHAPTER / 章节工作区" title={chapter.title} note={`${ctx.data.courses.find((course) => course.id === chapter.course_id)?.name || ''} · ${chapter.material_name}`}
      action={<button className="btn secondary" onClick={() => setEditing(true)}><PenLine size={16} /> 编辑章节</button>} />
    <ErrorBox message={action.error} />
    <div className="split-layout reversed"><div className="stack"><section className="card panel">
      <div className="panel-head"><div><h2><Sparkles size={20} /> 章节分析</h2><p>摘要、知识点、复习重点与易混点</p></div>
        <button className="btn secondary small" onClick={() => startAI('analyze')} disabled={!ctx.aiReady || action.busy || isActive(currentJobs[0])}><Sparkles size={15} />{chapter.analysis ? '重新分析' : '分析本章'}</button></div>
      {currentJobs[0] && <JobLine job={currentJobs[0]} retry={() => retryJob(ctx, action, currentJobs[0]!)} />}
      {chapter.analysis ? <div className="analysis-sections">{chapter.analysis.sections.map((section, index) => <div className="analysis-section" key={index}>
        <h3>{chapter.analysis!.sections.length > 1 ? `第 ${index + 1} 段摘要` : '章节摘要'}</h3><p>{section.summary}</p>
        {section.points.map((point, pointIndex) => <article className="point" key={pointIndex}><span className={`pill ${point.kind === 'focus' ? 'amber' : 'green'}`}>
          {({ key: '知识点', focus: '复习重点', confusion: '易混点' })[point.kind]}</span><strong>{point.title}</strong><p>{point.explanation}</p>
          {point.units.length > 0 && <div className="citation-list">{point.units.map((position) => {
            const index = chapter.units.findIndex((unit) => unit.position === position);
            if (index === -1) return null;
            return <button className="citation" key={position} onClick={() => {
              setSourcePage(Math.floor(index / chunk)); setActiveUnit(position);
              const target = document.getElementById(`unit-${position}`); target?.scrollIntoView({ block: 'center' }); target?.focus({ preventScroll: true });
            }}>{unitLabel(chapter.units[index])}</button>;
          })}</div>}</article>)}
      </div>)}</div> : <Empty icon={<Sparkles size={24} />} title="等待生成章节分析" note={ctx.aiReady ? '点击「分析本章」将本章校对后的文字发送至配置的模型。' : '在 .env 配置 AI 模型后，就可以根据原文生成分析。'} />}
    </section><section className="card panel"><div className="panel-head"><div><h2><BookOpen size={19} /> 章节原文</h2><p>片段 {chapter.start_unit}–{chapter.end_unit}</p></div>
      <button className="btn secondary small" onClick={() => ctx.go('material', chapter.material_id)}><PenLine size={14} /> 校对资料</button></div>
      <div className="units">{chapter.units.slice(sourcePage * chunk, (sourcePage + 1) * chunk).map((unit) => <article tabIndex={-1} id={`unit-${unit.position}`} key={unit.position}
        className={`unit ${activeUnit === unit.position ? 'highlight' : ''}`}><div className="unit-head"><strong>{unitLabel(unit)}</strong>
          <a className="mini-link" href={fileURL(base, chapter.material_id, chapter.extension === '.pdf' ? unit.page : null)} target="_blank" rel="noreferrer">原文件 <ExternalLink size={13} /></a></div><p>{unit.text}</p></article>)}</div>
      {chapter.units.length > chunk && <div className="pagination"><button className="btn small secondary" disabled={!sourcePage} onClick={() => { setActiveUnit(undefined); setSourcePage(sourcePage - 1); }}>上一组</button>
        <span>{sourcePage + 1} / {Math.ceil(chapter.units.length / chunk)}</span><button className="btn small secondary" disabled={(sourcePage + 1) * chunk >= chapter.units.length} onClick={() => { setActiveUnit(undefined); setSourcePage(sourcePage + 1); }}>下一组</button></div>}
    </section></div><aside className="stack"><section className="card panel stack chapter-tools"><div className="panel-head"><div><h2>本章练习</h2><p>{chapter.question_count} 道已加入的练习题</p></div></div>
      {chapter.learned_at ? <span className="pill green status-self"><Check size={14} /> 本章已学</span> : <button className="btn secondary" disabled={action.busy} onClick={() => void action.run(async () => {
        await api(`${base}/chapters/${chapter.id}/learn`, 'POST'); resource.reload(); await ctx.refresh(); ctx.notify('已标记本章学完');
      })}><Check size={16} /> 标记学完</button>}
      <button className="btn primary" onClick={beginQuiz} disabled={!chapter.question_count || !chapter.learned_at || action.busy}>开始章节练习 <ArrowRight size={16} /></button>
      <hr /><label>生成题量<select value={questionCount} onChange={(event) => setQuestionCount(Number(event.target.value))}><option value={3}>3 道题</option><option value={5}>5 道题</option><option value={8}>8 道题</option><option value={12}>12 道题</option></select></label>
      <button className="btn secondary" onClick={() => startAI('generate')} disabled={!ctx.aiReady || action.busy || isActive(currentJobs[1])}><Sparkles size={16} /> AI 生成练习</button>
      {currentJobs[1] && <JobLine job={currentJobs[1]} retry={() => retryJob(ctx, action, currentJobs[1]!)} />}
      <button className="btn secondary" onClick={() => ctx.go('search', chapter.id)}><Search size={16} /> 为本章搜题</button>
    </section>{chapter.drafts.length > 0 && <section className="card panel"><div className="panel-head"><div><h2>待审核题目</h2><p>{chapter.drafts.length} 道草稿</p></div></div>
      <ul className="record-list">{chapter.drafts.map((item) => <li key={item.id}><button className="record-row compact" onClick={() => setDraft(item)}><div><strong>{item.stem}</strong></div><ChevronDown size={15} /></button></li>)}</ul>
    </section>}</aside></div>
    {editing && <ChapterForm chapter={chapter} unitCount={chapter.unit_count} close={() => setEditing(false)} save={async (data) => {
      await api(`${base}/chapters/${chapter.id}`, 'PATCH', data); resource.reload(); await ctx.refresh(); setEditing(false); ctx.notify('章节已更新');
    }} />}
    {draft && <DraftEditor ctx={ctx} chapterId={chapter.id} existing={draft} close={() => setDraft(undefined)} saved={async () => { resource.reload(); await ctx.refresh(); setDraft(undefined); }} />}
  </div>;
}
