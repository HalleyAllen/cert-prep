import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleCheck, ExternalLink, ListChecks, PenLine, Plus, RotateCcw, Search, Sparkles, Target, X } from 'lucide-react';
import { useState } from 'react';
import { api, choiceText, materialLabels, questionLabel, sourceLabel, studyChapters, type Attempt, type Context, type Draft, type Grade, type Mistake, type QuestionData,
  type QuestionKind, type SearchResult, type Source } from './model';
import { Empty, ErrorBox, Heading, Loading, Modal, useAction, useResource } from './ui';

const emptyQuestion: QuestionData = { kind: 'single', stem: '', options: ['', '', '', ''], answer: [], explanation: '' };

function SourcePill({ source }: { source: Source }) {
  return source.url ? <a className="pill source" href={source.url} target="_blank" rel="noreferrer" title={source.title}>{sourceLabel[source.type]} <ExternalLink size={12} /></a>
    : <span className="pill">{sourceLabel[source.type]}</span>;
}

export function SearchPage({ ctx, initialChapter }: { ctx: Context; initialChapter?: string }) {
  const first = ctx.data.chapters.find((chapter) => chapter.id === initialChapter) || studyChapters(ctx.data)[0];
  const queryFor = (id: string) => {
    const chapter = ctx.data.chapters.find((item) => item.id === id);
    const course = ctx.data.courses.find((item) => item.id === chapter?.course_id);
    return [ctx.data.certificate.name, course?.name, chapter?.title, '考试 试题'].filter(Boolean).join(' ').slice(0, 400);
  };
  const [chapterId, setChapterId] = useState(first?.id || '');
  const [query, setQuery] = useState(queryFor(first?.id || ''));
  const [results, setResults] = useState<SearchResult[]>();
  const [draft, setDraft] = useState<{ source: SearchResult; data?: QuestionData }>();
  const action = useAction();
  const saved = async () => { await ctx.refresh(); setDraft(undefined); ctx.go('chapter', chapterId); };
  return <div className="screen"><Heading kicker="SEARCH / 题目来源" title="联网搜题" note="查找公开题目与参考来源，核对后加入章节练习。" />
    <section className="card panel"><div className="panel-head"><div><h2>搜索公开网页</h2><p>根据证书、科目和章节填入关键词，可继续编辑。</p></div></div>
      <form className="stack" onSubmit={(event) => { event.preventDefault(); void action.run(async () => {
        const response = await api<{ results: SearchResult[] }>(`${ctx.base}/search`, 'POST', { query }); setResults(response.results);
      }); }}>
        <label>收录章节<select value={chapterId} onChange={(event) => { setChapterId(event.target.value); setQuery(queryFor(event.target.value)); setResults(undefined); }}>
          {!ctx.data.chapters.length && <option value="">先从资料库导入章节</option>}{ctx.data.chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>
            {ctx.data.courses.find((course) => course.id === chapter.course_id)?.name} · {chapter.title} · {materialLabels[chapter.material_category]}</option>)}
        </select></label>
        <label>搜索关键词<input value={query} maxLength={400} onChange={(event) => setQuery(event.target.value)} placeholder="证书 科目 章节 试题" required /></label>
        {!ctx.searchReady && <div className="callout">在「服务配置」填写 Tavily 搜索密钥后即可联网搜索。已有网页链接也可以手动录入。</div>}
        <ErrorBox message={action.error} />
        <div className="button-group"><button className="btn primary" disabled={!ctx.searchReady || action.busy || !query.trim()}><Search size={16} />{action.busy ? '正在处理…' : '联网搜索'}</button>
          <button className="btn secondary" type="button" disabled={!chapterId || action.busy} onClick={() => setDraft({ source: { title: '', url: '', snippet: '' } })}><Plus size={16} /> 手动录入网络题</button>
        </div>
      </form>
    </section>
    <section className="card panel"><div className="panel-head"><div><h2>搜索结果</h2><p>{results ? `${results.length} 个网页结果` : '来自公开网络，由 Tavily 提供检索'}</p></div></div>
      {results?.length ? <div className="search-results">{results.map((item, index) => <article key={`${item.url}:${index}`} className="result-row">
        <div className="result-domain">{new URL(item.url).hostname}</div><h3><a href={item.url} target="_blank" rel="noreferrer">{item.title} <ExternalLink size={16} /></a></h3>
        <p>{item.snippet || '打开来源查看正文。'}</p><div className="button-group">
          <button className="btn secondary small" disabled={!chapterId || action.busy} onClick={() => setDraft({ source: item })}><PenLine size={14} /> 手动整理</button>
          {ctx.aiReady && <button className="btn secondary small" disabled={!chapterId || !item.snippet || action.busy} onClick={() => void action.run(async () => {
            const data = await api<QuestionData>(`${ctx.base}/chapters/${chapterId}/suggest-draft`, 'POST', item); setDraft({ source: item, data });
          })}><Sparkles size={14} /> AI 整理草稿</button>}
        </div>
      </article>)}</div> : <Empty icon={<Search size={24} />} title={results ? '没有找到匹配结果' : '搜索后在这里查看来源'} note={results ? '可换用证书全称、简称或具体知识点再试。' : '题干与答案经核对后才会进入练习。'} />}
    </section>
    {draft && <DraftEditor ctx={ctx} chapterId={chapterId} initial={draft} close={() => setDraft(undefined)} saved={saved} />}
  </div>;
}

export function DraftEditor({ ctx, chapterId, initial, existing, close, saved }: { ctx: Context; chapterId: string;
  initial?: { source: SearchResult; data?: QuestionData }; existing?: Draft; close: () => void; saved: () => Promise<void> }) {
  const [data, setData] = useState<QuestionData>(existing || initial?.data || emptyQuestion);
  const [source, setSource] = useState({ title: existing?.source.title || initial?.source.title || '',
    url: existing?.source.url || initial?.source.url || '', snippet: initial?.source.snippet || '', official: existing?.source.type === 'official' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const action = useAction();
  function submit(approve: boolean) {
    void action.run(async () => {
      const options: string[] = [];
      const answer: number[] = [];
      data.options.forEach((value, index) => {
        if (!value.trim()) return;
        if (data.answer.includes(index)) answer.push(options.length);
        options.push(value);
      });
      const values = { data: { ...data, options, answer }, source };
      if (existing) await api(`${ctx.base}/questions/${existing.id}`, 'PATCH', { ...values, approve });
      else await api(`${ctx.base}/chapters/${chapterId}/drafts`, 'POST', values);
      await saved(); ctx.notify(approve ? '已审核并加入章节练习' : '草稿已保存，可在章节中审核');
    });
  }
  return <Modal title={existing ? '核对题目并审核' : '整理网络题目草稿'} onClose={close}><form className="stack" onSubmit={(event) => {
    event.preventDefault(); submit((event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'approve');
  }}>
    <label>来源标题<input required maxLength={300} value={source.title} onChange={(event) => setSource({ ...source, title: event.target.value })} /></label>
    <label>出处链接<input type="url" required maxLength={2000} value={source.url} onChange={(event) => setSource({ ...source, url: event.target.value })} /></label>
    {/^https?:\/\//i.test(source.url) && <a className="mini-link" href={source.url} target="_blank" rel="noreferrer">打开来源核对 <ExternalLink size={14} /></a>}
    <label className="check-label"><input type="checkbox" checked={source.official} onChange={(event) => setSource({ ...source, official: event.target.checked })} /> 我已确认是考试主办方公开发布的题目</label>
    <label>题型<select value={data.kind} onChange={(event) => {
      const kind = event.target.value as QuestionKind;
      setData({ ...data, kind, answer: [], options: kind === 'boolean' ? ['正确', '错误'] : data.kind === 'boolean' ? ['', '', '', ''] : data.options });
    }}><option value="single">单选题</option><option value="multiple">多选题</option><option value="boolean">判断题</option></select></label>
    <label>题干<textarea required rows={3} maxLength={1600} value={data.stem} onChange={(event) => setData({ ...data, stem: event.target.value })} /></label>
    <fieldset><legend>选项与正确答案</legend><p className="muted">勾选正确选项。留空的选项会被忽略。</p><div className="editor-options">{data.options.map((option, index) => <div key={index}>
      <input type={data.kind === 'multiple' ? 'checkbox' : 'radio'} name="correct-answer" aria-label={`选项 ${String.fromCharCode(65 + index)} 为正确答案`} checked={data.answer.includes(index)} onChange={() => setData({ ...data,
        answer: data.kind !== 'multiple' ? [index] : data.answer.includes(index) ? data.answer.filter((value) => value !== index) : [...data.answer, index] })} />
      <input type="text" value={option} readOnly={data.kind === 'boolean'} maxLength={600} required={index < 2} aria-label={`选项 ${String.fromCharCode(65 + index)}`}
        onChange={(event) => setData({ ...data, options: data.options.map((value, key) => key === index ? event.target.value : value) })} />
    </div>)}</div>{data.kind !== 'boolean' && data.options.length < 6 && <button type="button" className="btn secondary small" onClick={() => setData({ ...data, options: [...data.options, ''] })}><Plus size={14} /> 添加选项</button>}</fieldset>
    <label>解析<textarea required rows={3} maxLength={2400} value={data.explanation} onChange={(event) => setData({ ...data, explanation: event.target.value })} /></label>
    <ErrorBox message={action.error} />
    <div className="form-actions">
      {existing && <button className="btn secondary" type="button" disabled={action.busy} onClick={() => {
        if (!confirmDelete) setConfirmDelete(true);
        else void action.run(async () => { await api(`${ctx.base}/questions/${existing.id}`, 'DELETE'); await saved(); ctx.notify('已移除草稿'); });
      }}>{confirmDelete ? '确认删除草稿' : '删除草稿'}</button>}
      <button className={`btn ${existing ? 'secondary' : 'primary'}`} disabled={action.busy} value="draft">保存草稿</button>
      {existing && <button className="btn primary" disabled={action.busy} value="approve"><Check size={16} /> 审核并收录</button>}
    </div>
  </form></Modal>;
}

export function QuizPage({ ctx, id }: { ctx: Context; id?: string }) {
  const resource = useResource<Attempt>(`${ctx.base}/attempts/${id}`);
  const [index, setIndex] = useState(0);
  const [choices, setChoices] = useState<Record<string, number[]>>({});
  const [grade, setGrade] = useState<Grade>();
  const action = useAction();
  const attempt = resource.value;
  if (resource.error) return <ErrorBox message={resource.error} retry={resource.reload} />;
  if (!attempt) return <Loading />;
  const result = grade || attempt.result;
  const question = attempt.questions[index];
  const current = choices[question.id] || [];
  const answered = attempt.questions.filter((item) => choices[item.id]?.length).length;
  const title = attempt.mode === 'mistake' ? '错题重练' : '章节练习';
  const back = () => attempt.mode === 'mistake' ? ctx.go('mistakes') : ctx.go('chapter', attempt.chapterId || undefined);
  function submit() {
    void action.run(async () => {
      const saved = await api<Grade>(`${ctx.base}/attempts/${attempt!.id}/submit`, 'POST', choices);
      setGrade(saved); window.scrollTo(0, 0); await ctx.refresh();
    });
  }
  return <div className="screen"><button className="back" onClick={back}><ArrowLeft size={17} />{attempt.mode === 'mistake' ? '返回错题本' : '返回章节'}</button>
    <Heading kicker="PRACTICE / 知识巩固" title={result ? `${title}结果` : title} note={result ? '查看正确答案、解析与题目出处。' : '完成所有题目后提交，自动查看答案和解析。'} />
    <ErrorBox message={action.error} />
    {result ? <><div className="card panel grade"><div className="metric-icon mint"><Target size={22} /></div><div><h2>答对 {result.correctCount} / {result.total} 道</h2>
      <p>{result.correctCount === result.total ? '本次全部答对。' : `本次 ${result.total - result.correctCount} 道错题已记录。`}</p></div><button className="btn secondary" onClick={() => ctx.go('mistakes')}>查看错题本 <ArrowRight size={16} /></button></div>
      {result.results.map((item, index) => <article className="card panel answer-review" key={item.id}><div className="pill-row">
        <span className={`pill ${item.correct ? 'green' : 'rose'}`}>{item.correct ? <Check size={14} /> : <X size={14} />}{item.correct ? '正确' : '答错'}</span><SourcePill source={item.source} /></div>
        <h3>{index + 1}. {item.stem}</h3><p>你的答案 · {choiceText(item, item.choice)}</p><p><strong>正确答案 · {choiceText(item, item.answer)}</strong></p><p className="callout">{item.explanation}</p>
      </article>)}
    </> : <div className="card panel quiz-card"><div className="panel-head"><div><h2>第 {index + 1} / {attempt.questions.length} 题</h2><p>已作答 {answered} 题</p></div><SourcePill source={question.source} /></div>
      <progress max={attempt.questions.length} value={answered} aria-label="已作答题目" />
      <fieldset className="quiz-question" key={question.id}><legend><span className="pill green">{questionLabel[question.kind]}</span> {question.stem}</legend>
        <div className="quiz-options">{question.options.map((option, optionIndex) => <label key={optionIndex} className={`quiz-option ${current.includes(optionIndex) ? 'selected' : ''}`}>
          <input type={question.kind === 'multiple' ? 'checkbox' : 'radio'} name={question.id} checked={current.includes(optionIndex)} onChange={() => {
            const value = question.kind !== 'multiple' ? [optionIndex] : current.includes(optionIndex) ? current.filter((item) => item !== optionIndex) : [...current, optionIndex];
            setChoices({ ...choices, [question.id]: value });
          }} /><span>{String.fromCharCode(65 + optionIndex)}. {option}</span></label>)}</div></fieldset>
      <div className="form-actions quiz-actions"><button className="btn secondary" disabled={!index || action.busy} onClick={() => setIndex(index - 1)}><ArrowLeft size={15} /> 上一题</button>
        {index < attempt.questions.length - 1 && <button className="btn secondary" disabled={action.busy} onClick={() => setIndex(index + 1)}>下一题 <ArrowRight size={15} /></button>}
        <button className="btn primary" disabled={answered !== attempt.questions.length || action.busy} onClick={submit}>{action.busy ? '正在评分…' : '提交答卷'}</button></div>
      <div className="quiz-jump" aria-label="跳转到题目">{attempt.questions.map((item, number) => <button key={item.id} className={number === index ? 'active' : choices[item.id]?.length ? 'done' : ''}
        aria-current={number === index ? 'step' : undefined} aria-label={`第 ${number + 1} 题${choices[item.id]?.length ? '，已作答' : ''}`} onClick={() => setIndex(number)}>{number + 1}</button>)}</div>
    </div>}
  </div>;
}

export function MistakesPage({ ctx }: { ctx: Context }) {
  const resource = useResource<Mistake[]>(`${ctx.base}/mistakes`);
  const [course, setCourse] = useState('');
  const [chapter, setChapter] = useState('');
  const [status, setStatus] = useState('pending');
  const action = useAction();
  const items = resource.value?.filter((item) => (!course || item.course_id === course) && (!chapter || item.chapter_id === chapter)
    && (status === 'all' || !!item.mastered === (status === 'mastered'))) || [];
  const retry = (ids: string[]) => void action.run(async () => {
    const attempt = await api<{ id: string }>(`${ctx.base}/mistake-attempts`, 'POST', { ids }); ctx.go('quiz', attempt.id);
  });
  return <div className="screen"><Heading kicker="REVIEW / 薄弱点复盘" title="错题本" note="按科目或章节重练，掌握后仍可查看历史记录。"
    action={<button className="btn primary" disabled={!items.length || action.busy} onClick={() => retry(items.slice(0, 100).map((item) => item.id))}>
      <RotateCcw size={16} />{items.length > 100 ? '重练前 100 题' : '重练当前列表'}</button>} />
    <section className="card panel"><div className="filter-grid">
      <label>科目<select value={course} onChange={(event) => { setCourse(event.target.value); setChapter(''); }}><option value="">全部科目</option>{ctx.data.courses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>章节<select value={chapter} onChange={(event) => setChapter(event.target.value)}><option value="">全部章节</option>{ctx.data.chapters.filter((item) => !course || item.course_id === course).map((item) => <option key={item.id} value={item.id}>{item.title} · {materialLabels[item.material_category]}</option>)}</select></label>
      <label>掌握状态<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="pending">待复习</option><option value="mastered">已掌握</option><option value="all">全部状态</option></select></label>
    </div><ErrorBox message={resource.error || action.error} retry={resource.error ? resource.reload : undefined} />
      {!resource.value && !resource.error && <Loading />}
      {resource.value && (items.length ? <div className="mistakes-list">{items.map((item) => {
        const lastWrong = item.history.findLast((entry) => !entry.correct);
        return <article className="mistake-row" key={item.id}><div className="pill-row"><span className={`pill ${item.mastered ? 'green' : 'rose'}`}>
          {item.mastered ? <CircleCheck size={14} /> : <RotateCcw size={14} />}{item.mastered ? '已掌握' : `答错 ${item.wrong_count} 次`}</span><SourcePill source={item.source} /></div>
          <h3>{item.stem}</h3><p>{item.course_name} · {item.chapter_title} · {questionLabel[item.kind]}</p>
          <div className="button-group"><button className="btn secondary small" disabled={action.busy} onClick={() => retry([item.id])}>重练这道题 <ChevronRight size={15} /></button></div>
          <details><summary>答案、解析与作答历史</summary>{lastWrong && <p>最近错选 · {choiceText(item, lastWrong.choice)}</p>}
            <p><strong>正确答案 · {choiceText(item, item.answer)}</strong></p><p>{item.explanation}</p>
            <ul>{[...item.history].reverse().map((entry, index) => <li key={`${entry.at}:${index}`}>{new Date(entry.at).toLocaleString('zh-CN')} · {entry.mode === 'mistake' ? '重练' : '章节练习'} · {entry.correct ? '答对' : '答错'} · {choiceText(item, entry.choice)}</li>)}</ul>
          </details>
        </article>;
      })}</div> : <Empty icon={<ListChecks size={26} />} title="当前筛选下没有错题" note="章节练习中的错题会自动出现在这里。" />)}
    </section>
  </div>;
}
