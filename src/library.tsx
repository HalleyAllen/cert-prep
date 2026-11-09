import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, ChevronRight, Download, ExternalLink, FilePlus2, FileText, PenLine, Plus, Search, Sparkles, Trash2, UploadCloud } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, fileURL, isActive, materialLabels, studyChapters, unitLabel, type Chapter, type ChapterDetail, type Context, type Draft, type Job, type MaterialCategory, type MaterialDetail, type Unit } from './model';
import { DraftEditor } from './practice';
import { Empty, ErrorBox, Heading, JobLine, Loading, Modal, useAction, useResource } from './ui';

const materialUploadLimitMB = 500;

function retryJob(ctx: Context, action: ReturnType<typeof useAction>, job: Job) {
  void action.run(async () => { await api(`${ctx.base}/jobs/${job.id}/retry`, 'POST'); await ctx.refresh(); });
}

function cancelImport(ctx: Context, action: ReturnType<typeof useAction>, job: Job) {
  void action.run(async () => {
    await api(`${ctx.base}/jobs/${job.id}/cancel`, 'POST');
    await ctx.refresh();
  });
}

export function MaterialsPage({ ctx }: { ctx: Context }) {
  const { data, go } = ctx;
  const [selectedCourse, setSelectedCourse] = useState('');
  const course = data.courses.find((item) => item.id === selectedCourse)?.id ?? data.courses[0]?.id ?? '';
  const [upload, setUpload] = useState<MaterialCategory>();
  const [addCourse, setAddCourse] = useState(false);
  const action = useAction();
  return <div className="screen"><Heading kicker="LIBRARY / 学习资料" title="资料库" note="分别存放原课本和补充资料，再校对原文和章节。"
    action={<button className="btn secondary" onClick={() => setAddCourse(true)}><Plus size={17} /> 添加科目</button>} />
    <ErrorBox message={action.error} />
    {(['textbook', 'supplement'] as const).map((category) => {
      const materials = data.materials.filter((material) => material.category === category);
      const Icon = category === 'textbook' ? BookOpen : FileText;
      return <section className="card panel" key={category}>
        <div className="panel-head"><div><h2>{materialLabels[category]}</h2><p>{materials.length} 份 · {category === 'textbook' ? '考试教材和课本原文' : '笔记、讲义和复习资料'}</p></div>
          <button className={`btn ${category === 'textbook' ? 'primary' : 'secondary'}`} onClick={() => setUpload(category)}><UploadCloud size={17} /> 上传{materialLabels[category]}</button>
        </div>
        {materials.length > 0 && <ul className="record-list">{materials.map((material) => {
          const job = data.jobs.find((item) => item.id === material.job_id);
          return <li key={material.id}><button className="record-row" onClick={() => go('material', material.id)}>
            <div className="record-icon"><Icon size={20} /></div><div><strong>{material.name}</strong><small>{data.courses.find((item) => item.id === material.course_id)?.name} · {material.extracted ? `${material.unit_count} 个原文片段` : '等待提取'}</small></div>
            <ChevronRight size={18} /></button>
            {job && job.status !== 'succeeded' && <JobLine job={job} retry={() => retryJob(ctx, action, job)} cancel={() => cancelImport(ctx, action, job)} />}
          </li>;
        })}</ul>}
        {category === 'textbook' && materials.length === 0 && data.materials.length > 0 &&
          <p className="muted">已上传过课本？打开对应资料的详情，点击「设为原课本」。</p>}
      </section>;
    })}
    {upload && <UploadMaterial ctx={ctx} category={upload} course={course} selectCourse={setSelectedCourse} close={() => setUpload(undefined)} />}
    {addCourse && <AddCourse ctx={ctx} close={() => setAddCourse(false)} select={setSelectedCourse} />}
  </div>;
}

function DeleteMaterialDialog({ ctx, material, close }: {
  ctx: Context; material: Pick<MaterialDetail, 'id' | 'name'>; close: () => void;
}) {
  const action = useAction();
  const dismiss = () => { if (!action.busy) close(); };
  const chapterCount = ctx.data.chapters.filter((chapter) => chapter.material_id === material.id).length;
  return <Modal title="删除资料" onClose={dismiss}>
    <form className="stack" onSubmit={(event) => {
      event.preventDefault();
      void action.run(async () => {
        const result = await api<{ fileCleanupPending: boolean }>(`${ctx.base}/materials/${material.id}`, 'DELETE');
        const refreshed = await ctx.refresh().then(() => true, () => false);
        close();
        ctx.go('materials');
        ctx.notify(result.fileCleanupPending ? '已删除资料，文件将在下次启动时清理。'
          : refreshed ? '资料已删除。' : '资料已删除，请刷新资料库。');
      });
    }}>
      <p className="delete-description">确定删除「<strong>{material.name}</strong>」？</p>
      <p className="muted">{chapterCount > 0
        ? `会同时删除备考台保存的文件、${chapterCount} 个章节及其练习、错题和计划记录。此操作无法撤销。`
        : '会同时删除备考台保存的文件及导入记录。此操作无法撤销。'}</p>
      <ErrorBox message={action.error} />
      <div className="form-actions">
        <button type="button" className="btn secondary" disabled={action.busy} onClick={dismiss} autoFocus>取消</button>
        <button type="submit" className="btn danger" disabled={action.busy}>{action.busy ? '正在删除…' : '确认删除'}</button>
      </div>
    </form>
  </Modal>;
}

function UploadMaterial({ ctx, category, course, selectCourse, close }: {
  ctx: Context; category: MaterialCategory; course: string; selectCourse: (id: string) => void; close: () => void;
}) {
  const [file, setFile] = useState<File>();
  const request = useRef<AbortController | null>(null);
  const action = useAction();
  useEffect(() => () => request.current?.abort(), []);
  const cancel = () => {
    request.current?.abort();
    close();
    if (request.current) void ctx.refresh().catch(() => {});
  };
  return <Modal title={`上传${materialLabels[category]}`} onClose={cancel}>
    <form className="stack" onSubmit={(event) => {
      event.preventDefault();
      if (!file || !course) return;
      if (file.size > materialUploadLimitMB * 1024 * 1024) {
        action.setError(`文件超过 ${materialUploadLimitMB} MB，请拆分后再上传。`);
        return;
      }
      const body = new FormData(event.currentTarget);
      body.set('file', file);
      body.set('category', category);
      if (body.has('forceOcr')) body.set('forceOcr', 'true');
      void action.run(async () => {
        const controller = new AbortController();
        request.current = controller;
        try {
          await api(`${ctx.base}/courses/${course}/materials`, 'POST', body, controller.signal);
          await ctx.refresh();
          if (!controller.signal.aborted) {
            close();
            ctx.notify(`${materialLabels[category]}已加入导入队列`);
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error;
        } finally {
          request.current = null;
        }
      });
    }}>
      <p className="muted">PDF、DOCX、TXT、JPG 或 PNG · 单个文件最多 {materialUploadLimitMB} MB · PDF 最多 1000 页</p>
      {ctx.data.courses.length > 1 && <label>归属科目<select value={course} onChange={(event) => selectCourse(event.target.value)} required>
        {ctx.data.courses.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select></label>}
      <label className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setFile(event.dataTransfer.files[0]); }}>
        <input type="file" name="file" accept=".pdf,.docx,.txt,.png,.jpg,.jpeg" aria-label="选择资料文件" onChange={(event) => setFile(event.target.files?.[0])} />
        <UploadCloud size={28} /><strong>{file?.name || '点击选择文件，或拖到这里'}</strong><span>扫描页和图片会在本机识别文字</span>
      </label>
      {file?.name.toLowerCase().endsWith('.pdf') && <label className="check-label"><input type="checkbox" name="forceOcr" />对整份 PDF 使用 OCR（适用于文字层异常的扫描件）</label>}
      <ErrorBox message={action.error} />
      <div className="form-actions"><button type="button" className="btn secondary" onClick={cancel}>{action.busy ? '取消上传' : '取消'}</button><button className="btn primary" disabled={action.busy || !file || !course}><FilePlus2 size={16} />{action.busy ? '正在上传…' : '开始导入'}</button></div>
    </form>
  </Modal>;
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

function DeleteUnitDialog({ unit, remove, close }: { unit: Unit; remove: () => Promise<void>; close: () => void }) {
  const action = useAction();
  const dismiss = () => { if (!action.busy) close(); };
  return <Modal title="删除原文片段" onClose={dismiss}>
    <form className="stack" onSubmit={(event) => { event.preventDefault(); void action.run(remove); }}>
      <p>确定删除「{unitLabel(unit)}」？</p>
      <p className="muted">相关章节的 AI 分析会清除，可以重新生成。原文件、已有题目和学习进度会保留。</p>
      <ErrorBox message={action.error} />
      <div className="form-actions">
        <button type="button" className="btn secondary" onClick={dismiss} disabled={action.busy} autoFocus>取消</button>
        <button type="submit" className="btn danger" disabled={action.busy}>{action.busy ? '正在删除…' : '确认删除'}</button>
      </div>
    </form>
  </Modal>;
}

function markedText(unit: Unit, start: number, end: number) {
  const parts: ReactNode[] = [];
  let offset = start;
  for (const mark of unit.marks ?? []) {
    const first = Math.max(mark.start, start);
    const last = Math.min(mark.end, end);
    if (first < offset || last <= first) continue;
    parts.push(unit.text.slice(offset, first));
    parts.push(<span key={first} style={{ color: mark.color, backgroundColor: mark.background,
      textDecoration: mark.underline ? 'underline' : undefined }}>{unit.text.slice(first, last)}</span>);
    offset = last;
  }
  parts.push(unit.text.slice(offset, end));
  return parts;
}

const visualLabel = { figure: '插图', formula: '公式', table: '表格' };

function UnitText({ unit, base, materialId }: { unit: Unit; base: string; materialId: string }) {
  const visuals = (unit.visuals ?? []).map((visual, index) => ({ ...visual, index, offset: unit.text.indexOf(visual.anchor) }))
    .filter((visual) => visual.offset >= 0).sort((a, b) => a.offset - b.offset);
  if (!visuals.length) return <p>{markedText(unit, 0, unit.text.length)}</p>;
  const parts: ReactNode[] = [];
  let start = 0;
  const addText = (end: number) => {
    while (start < end && unit.text[start] === '\n') start += 1;
    while (end > start && unit.text[end - 1] === '\n') end -= 1;
    if (end > start) parts.push(<p key={`text-${start}`}>{markedText(unit, start, end)}</p>);
  };
  for (const visual of visuals) {
    addText(visual.offset);
    const src = `${base}/materials/${materialId}/units/${unit.position}/visuals/${visual.index}`;
    parts.push(<figure className="unit-visual" key={`visual-${visual.index}`}>
      <a href={fileURL(base, materialId, unit.page)} target="_blank" rel="noreferrer">
        <img src={src} loading="lazy" decoding="async" alt={`第 ${unit.page} 页${visualLabel[visual.kind]}`} />
      </a>
      <figcaption>{visualLabel[visual.kind]} · PDF 第 {unit.page} 页</figcaption>
    </figure>);
    start = visual.offset + visual.anchor.length;
  }
  addText(unit.text.length);
  return <div className="unit-content">{parts}</div>;
}

export function MaterialPage({ ctx, id }: { ctx: Context; id?: string }) {
  const latest = ctx.data.jobs.find((item) => item.target_id === id && item.kind === 'import');
  const resource = useResource<MaterialDetail>(`${ctx.base}/materials/${id}`, `${latest?.id}:${latest?.status}`);
  const action = useAction();
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<Unit>();
  const [deletingUnit, setDeletingUnit] = useState<Unit>();
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const material = resource.value;
  if (resource.error) return <ErrorBox message={resource.error} retry={resource.reload} />;
  if (!material) return <Loading />;
  const category = ctx.data.materials.find((item) => item.id === material.id)?.category ?? material.category;
  const job = latest || material.job;
  const chapters = ctx.data.chapters.filter((chapter) => chapter.material_id === material.id);
  const size = 12;
  const visiblePage = Math.min(page, Math.max(0, Math.ceil(material.units.length / size) - 1));
  return <div className="screen"><button className="back" onClick={() => ctx.go('materials')}><ArrowLeft size={17} /> 返回资料库</button>
    <Heading kicker={`${materialLabels[category]} / 原文校对`} title={material.name} note="校对文字并记录原文位置。章节范围用片段编号设置。"
      action={<div className="button-group">
        <button className="btn secondary" disabled={action.busy} onClick={() => void action.run(async () => {
          const next = category === 'textbook' ? 'supplement' : 'textbook';
          await api(`${ctx.base}/materials/${material.id}`, 'PATCH', { category: next });
          await ctx.refresh();
          ctx.notify(`已移到${materialLabels[next]}`);
        })}><BookOpen size={17} />{category === 'textbook' ? '移到补充资料' : '设为原课本'}</button>
        <a className="btn secondary" href={`${fileURL(ctx.base, material.id)}?download=1`}><Download size={17} /> 下载原文件</a>
        <button type="button" className="btn delete-action" onClick={() => setDeleting(true)}><Trash2 size={17} /> 删除资料</button>
      </div>} />
    <ErrorBox message={action.error} />
    {job && <JobLine job={job} retry={() => retryJob(ctx, action, job)} cancel={() => cancelImport(ctx, action, job)} />}
    {!!material.extracted && <div className="split-layout reversed"><section className="card panel"><div className="panel-head"><div><h2>原文片段</h2><p>{material.units.length} 个片段 · 可直接校对识别文字</p></div></div>
      {!material.units.length && <p className="muted">没有剩余的原文片段，可下载原文件查看。</p>}
      <div className="units">{material.units.slice(visiblePage * size, (visiblePage + 1) * size).map((unit) => <div className="unit" key={unit.position}>
        <div className="unit-head"><strong>{unitLabel(unit)}</strong>{unit.method === 'ocr' && <span className="pill">OCR</span>}
          <div className="button-group unit-actions">
            <button type="button" className="btn small secondary" onClick={() => setEditing(unit)}><PenLine size={14} /> 校对</button>
            {unit.page && <a className="mini-link" href={fileURL(ctx.base, material.id, material.extension === '.pdf' ? unit.page : null)} target="_blank" rel="noreferrer">原文件 <ExternalLink size={13} /></a>}
            <button type="button" className="btn small delete-action" aria-label={`删除${unitLabel(unit)}`} onClick={() => setDeletingUnit(unit)}><Trash2 size={15} /> 删除</button>
          </div>
        </div>
        <UnitText unit={unit} base={ctx.base} materialId={material.id} />
      </div>)}</div>
      {material.units.length > size && <div className="pagination"><button className="btn secondary small" disabled={!visiblePage} onClick={() => setPage(visiblePage - 1)}>上一组</button>
        <span>{visiblePage + 1} / {Math.ceil(material.units.length / size)}</span><button className="btn secondary small" disabled={(visiblePage + 1) * size >= material.units.length} onClick={() => setPage(visiblePage + 1)}>下一组</button></div>}
    </section><section className="card panel"><div className="panel-head"><div><h2>资料章节</h2><p>{chapters.length} 章 · 可调整自动建议的范围</p></div></div>
      <ul className="record-list">{chapters.map((chapter) => <li key={chapter.id}><button className="record-row compact" onClick={() => ctx.go('chapter', chapter.id)}>
        <div><strong>{chapter.title}</strong><small>片段 {chapter.start_unit}–{chapter.end_unit}</small></div><ChevronRight size={16} />
      </button></li>)}</ul><button className="btn secondary" disabled={!material.units.length} onClick={() => setAdding(true)}><Plus size={16} /> 新建章节</button>
    </section></div>}
    {deleting && <DeleteMaterialDialog ctx={ctx} material={material} close={() => setDeleting(false)} />}
    {deletingUnit && <DeleteUnitDialog unit={deletingUnit} close={() => setDeletingUnit(undefined)} remove={async () => {
      await api(`${ctx.base}/materials/${material.id}/units/${deletingUnit.position}`, 'DELETE');
      resource.reload();
      setPage(Math.min(visiblePage, Math.max(0, Math.ceil((material.units.length - 1) / size) - 1)));
      setDeletingUnit(undefined);
      ctx.notify('原文片段已删除。');
      await ctx.refresh().catch(() => {});
    }} />}
    {editing && <Modal title={`校对 ${unitLabel(editing)}`} onClose={() => setEditing(undefined)}><form className="stack" onSubmit={(event) => {
      event.preventDefault(); const text = new FormData(event.currentTarget).get('text');
      void action.run(async () => {
        await api(`${ctx.base}/materials/${material.id}/units/${editing.position}`, 'PATCH', { text });
        resource.reload(); setEditing(undefined); ctx.notify('原文已更新，相关章节可重新分析');
      });
    }}><label>原文<textarea name="text" aria-label="原文" defaultValue={editing.text} required maxLength={20000} rows={10} /></label>
      <p className="muted">改动会清除引用此片段的已有分析。</p><ErrorBox message={action.error} /><div className="form-actions"><button className="btn primary" disabled={action.busy}>保存校对</button></div>
    </form></Modal>}
    {adding && <ChapterForm unitMin={material.units[0]?.position ?? null} unitMax={material.units.at(-1)?.position ?? null} close={() => setAdding(false)} save={async (data) => {
      const item = await api<{ id: string }>(`${ctx.base}/materials/${material.id}/chapters`, 'POST', data);
      await ctx.refresh(); ctx.notify('章节已添加'); ctx.go('chapter', item.id);
    }} />}
  </div>;
}

function ChapterForm({ chapter, unitMin, unitMax, close, save }: { chapter?: ChapterDetail; unitMin: number | null; unitMax: number | null; close: () => void;
  save: (data: { title: string; start: number; end: number; studyMinutes: number; practiceMinutes: number }) => Promise<void> }) {
  const action = useAction();
  const [selectRange, setSelectRange] = useState(!chapter || chapter.units.length > 0);
  const hasFragments = unitMin !== null && unitMax !== null;
  return <Modal title={chapter ? '编辑章节范围与时长' : '新建章节'} onClose={close}><form className="stack" onSubmit={(event) => {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    void action.run(async () => save({ title: String(fields.get('title')), start: Number(fields.get('start')), end: Number(fields.get('end')),
      studyMinutes: Number(fields.get('study')), practiceMinutes: Number(fields.get('practice')) }));
  }}>
    <label>章节标题<input name="title" required maxLength={140} defaultValue={chapter?.title} /></label>
    {chapter && !chapter.units.length && hasFragments && <label className="check-label">
      <input type="checkbox" checked={selectRange} onChange={(event) => setSelectRange(event.target.checked)} />为本章重新选择原文范围
    </label>}
    {hasFragments && selectRange ? <div className="field-grid">
      <label>起始片段<input name="start" type="number" min={unitMin} max={unitMax} required defaultValue={chapter?.units.length ? chapter.start_unit : unitMin} /></label>
      <label>结束片段<input name="end" type="number" min={unitMin} max={unitMax} required defaultValue={chapter?.units.length ? chapter.end_unit : unitMax} /></label>
    </div> : <><input type="hidden" name="start" value={chapter?.start_unit} /><input type="hidden" name="end" value={chapter?.end_unit} /></>}
    <div className="field-grid"><label>学习分钟数<input name="study" type="number" min={5} max={720} required defaultValue={chapter?.study_minutes || 30} /></label>
      <label>练习分钟数<input name="practice" type="number" min={5} max={720} required defaultValue={chapter?.practice_minutes || 10} /></label></div>
    {hasFragments && selectRange && <p className="muted">请填写仍存在的片段编号（{unitMin}–{unitMax}）。</p>}<ErrorBox message={action.error} />
    <div className="form-actions"><button className="btn secondary" type="button" onClick={close}>取消</button><button className="btn primary" disabled={action.busy}>保存章节</button></div>
  </form></Modal>;
}

export function ChaptersPage({ ctx, initialCourse }: { ctx: Context; initialCourse?: string }) {
  const { data, go } = ctx;
  const [filter, setFilter] = useState(initialCourse || '');
  const [bySource, setBySource] = useState(false);
  const courses = data.courses.filter((course) => !filter || filter === course.id);
  const displayed = bySource ? data.chapters : studyChapters(data);
  const groups = courses.flatMap((course) => {
    const chapters = displayed.filter((chapter) => chapter.course_id === course.id);
    if (!bySource || !chapters.length) return [{ id: course.id, title: course.name, source: '', chapters }];
    return data.materials.filter((material) => material.course_id === course.id)
      .map((material) => ({
        id: material.id, title: material.name, source: materialLabels[material.category],
        chapters: chapters.filter((chapter) => chapter.material_id === material.id),
      }))
      .filter((group) => group.chapters.length > 0)
      .sort((a, b) => Number(b.source === materialLabels.textbook) - Number(a.source === materialLabels.textbook));
  });
  return <div className="screen"><Heading kicker="CHAPTERS / 学习进度" title="章节学习" note="学习清单优先使用原课本，同名笔记可按资料查阅。"
    action={data.courses.length > 1 && <select aria-label="按科目筛选" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="">全部科目</option>{data.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select>} />
    <div className="button-group" role="group" aria-label="章节查看方式">
      <button type="button" className={`btn ${bySource ? 'secondary' : 'primary'}`} aria-pressed={!bySource} onClick={() => setBySource(false)}>学习清单</button>
      <button type="button" className={`btn ${bySource ? 'primary' : 'secondary'}`} aria-pressed={bySource} onClick={() => setBySource(true)}>按资料查看</button>
    </div>
    {groups.map(({ id, title, source, chapters }) => (
      <section className="card panel" key={id}><div className="panel-head"><div><h2>{title}</h2><p>{source && `${source} · `}{chapters.filter((chapter) => chapter.learned_at).length} / {chapters.length} 章已学</p></div></div>
        {chapters.length ? <ul className="record-list">{chapters.map((chapter, index) => <li key={chapter.id}><button className="record-row" onClick={() => go('chapter', chapter.id)}>
          <div className="record-icon chapter-index">{String(index + 1).padStart(2, '0')}</div><div><strong>{chapter.title}</strong><small>{!bySource && `${materialLabels[chapter.material_category]} · `}{chapter.question_count} 道练习 · 预计 {chapter.study_minutes + chapter.practice_minutes} 分钟</small></div>
          <span className={`pill ${chapter.learned_at ? 'green' : ''}`}>{chapter.practiced_at ? '已练习' : chapter.learned_at ? '已学' : '待学习'}</span><ChevronRight size={18} />
        </button></li>)}</ul> : <Empty icon={<BookOpen size={25} />} title="这个科目还没有章节" note="先导入教材或讲义。" action={<button className="btn secondary" onClick={() => go('materials')}>打开资料库</button>} />}
      </section>
    ))}
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
    <Heading kicker="CHAPTER / 章节工作区" title={chapter.title} note={`${ctx.data.courses.find((course) => course.id === chapter.course_id)?.name || ''} · ${materialLabels[chapter.material_category]} · ${chapter.material_name}`}
      action={<button className="btn secondary" onClick={() => setEditing(true)}><PenLine size={16} /> 编辑章节</button>} />
    <ErrorBox message={action.error} />
    <div className="split-layout reversed"><div className="stack"><section className="card panel">
      <div className="panel-head"><div><h2><Sparkles size={20} /> 章节分析</h2><p>摘要、知识点、复习重点与易混点</p></div>
        <button className="btn secondary small" onClick={() => startAI('analyze')} disabled={!chapter.units.length || !ctx.aiReady || action.busy || isActive(currentJobs[0])}><Sparkles size={15} />{chapter.analysis ? '重新分析' : '分析本章'}</button></div>
      {chapter.units.length > 0 && currentJobs[0] && <JobLine job={currentJobs[0]} retry={() => retryJob(ctx, action, currentJobs[0]!)} />}
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
      </div>)}</div> : <Empty icon={<Sparkles size={24} />} title="等待生成章节分析" note={!chapter.units.length ? '本章没有原文片段，可在「编辑章节」中重新选择。' : ctx.aiReady ? '点击「分析本章」将本章校对后的文字发送至配置的模型。' : '在 .env 配置 AI 模型后，就可以根据原文生成分析。'} />}
    </section><section className="card panel"><div className="panel-head"><div><h2><BookOpen size={19} /> 章节原文</h2><p>{chapter.units.length ? `片段 ${chapter.start_unit}–${chapter.end_unit}` : '暂无原文片段'}</p></div>
      <button className="btn secondary small" onClick={() => ctx.go('material', chapter.material_id)}><PenLine size={14} /> 校对资料</button></div>
      <div className="units">{chapter.units.slice(sourcePage * chunk, (sourcePage + 1) * chunk).map((unit) => <article tabIndex={-1} id={`unit-${unit.position}`} key={unit.position}
        className={`unit ${activeUnit === unit.position ? 'highlight' : ''}`}><div className="unit-head"><strong>{unitLabel(unit)}</strong>
          <a className="mini-link" href={fileURL(base, chapter.material_id, chapter.extension === '.pdf' ? unit.page : null)} target="_blank" rel="noreferrer">原文件 <ExternalLink size={13} /></a></div><UnitText unit={unit} base={base} materialId={chapter.material_id} /></article>)}</div>
      {chapter.units.length > chunk && <div className="pagination"><button className="btn small secondary" disabled={!sourcePage} onClick={() => { setActiveUnit(undefined); setSourcePage(sourcePage - 1); }}>上一组</button>
        <span>{sourcePage + 1} / {Math.ceil(chapter.units.length / chunk)}</span><button className="btn small secondary" disabled={(sourcePage + 1) * chunk >= chapter.units.length} onClick={() => { setActiveUnit(undefined); setSourcePage(sourcePage + 1); }}>下一组</button></div>}
    </section></div><aside className="stack"><section className="card panel stack chapter-tools"><div className="panel-head"><div><h2>本章练习</h2><p>{chapter.question_count} 道已加入的练习题</p></div></div>
      {chapter.learned_at ? <span className="pill green status-self"><Check size={14} /> 本章已学</span> : <button className="btn secondary" disabled={action.busy} onClick={() => void action.run(async () => {
        await api(`${base}/chapters/${chapter.id}/learn`, 'POST'); resource.reload(); await ctx.refresh(); ctx.notify('已标记本章学完');
      })}><Check size={16} /> 标记学完</button>}
      <button className="btn primary" onClick={beginQuiz} disabled={!chapter.question_count || !chapter.learned_at || action.busy}>开始章节练习 <ArrowRight size={16} /></button>
      <hr /><label>生成题量<select value={questionCount} onChange={(event) => setQuestionCount(Number(event.target.value))}><option value={3}>3 道题</option><option value={5}>5 道题</option><option value={8}>8 道题</option><option value={12}>12 道题</option></select></label>
      <button className="btn secondary" onClick={() => startAI('generate')} disabled={!chapter.units.length || !ctx.aiReady || action.busy || isActive(currentJobs[1])}><Sparkles size={16} /> AI 生成练习</button>
      {chapter.units.length > 0 && currentJobs[1] && <JobLine job={currentJobs[1]} retry={() => retryJob(ctx, action, currentJobs[1]!)} />}
      <button className="btn secondary" onClick={() => ctx.go('search', chapter.id)}><Search size={16} /> 为本章搜题</button>
    </section>{chapter.drafts.length > 0 && <section className="card panel"><div className="panel-head"><div><h2>待审核题目</h2><p>{chapter.drafts.length} 道草稿</p></div></div>
      <ul className="record-list">{chapter.drafts.map((item) => <li key={item.id}><button className="record-row compact" onClick={() => setDraft(item)}><div><strong>{item.stem}</strong></div><ChevronDown size={15} /></button></li>)}</ul>
    </section>}</aside></div>
    {editing && <ChapterForm chapter={chapter} unitMin={chapter.unit_min} unitMax={chapter.unit_max} close={() => setEditing(false)} save={async (data) => {
      await api(`${base}/chapters/${chapter.id}`, 'PATCH', data); resource.reload(); await ctx.refresh(); setEditing(false); ctx.notify('章节已更新');
    }} />}
    {draft && <DraftEditor ctx={ctx} chapterId={chapter.id} existing={draft} close={() => setDraft(undefined)} saved={async () => { resource.reload(); await ctx.refresh(); setDraft(undefined); }} />}
  </div>;
}
