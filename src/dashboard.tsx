import { ArrowDownRight, ArrowRight, BookOpen, CalendarCheck, CalendarDays, Check, Clock3, FilePlus2, ListChecks, Play, Target } from 'lucide-react';
import { useState } from 'react';
import { api, daysBetween, displayDay, kindLabel, studyChapters, type Context, type Task } from './model';
import { Empty, ErrorBox, Heading, TextLink, useAction } from './ui';

function CoverIllustration() {
  return <svg className="cover-illustration" viewBox="0 0 385 260" aria-hidden="true">
    <defs><pattern id="study-grid" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M18 0H0v18" fill="none" stroke="#aac1a1" strokeOpacity=".16" /></pattern></defs>
    <rect x="38" y="2" width="338" height="251" fill="url(#study-grid)" />
    <circle cx="225" cy="122" r="99" fill="none" stroke="#9cb89c" strokeOpacity=".36" strokeDasharray="3 6" />
    <circle cx="225" cy="122" r="78" fill="#b9ca9c" fillOpacity=".08" stroke="#9cb89c" strokeOpacity=".22" />
    <path d="M70 192h280M225 18v218" stroke="#b9ca9c" strokeOpacity=".3" strokeDasharray="2 5" />
    <ellipse cx="222" cy="191" rx="104" ry="17" fill="#0e3329" fillOpacity=".62" />
    <path d="M111 89q48-16 109 21 56-42 111-21v88q-53-12-111 19-60-30-109-18Z" fill="#2b7057" stroke="#a6c4a6" strokeWidth="1.6" />
    <path d="M121 77q48-13 99 31 49-43 101-31v89q-57-9-101 22-48-32-99-22Z" fill="#f5edd3" stroke="#d9ddae" strokeWidth="1.8" />
    <path d="M220 108v80M132 95q43 0 76 24m-76-11q43 0 76 24m-76-11q43 0 76 24m-76-11q43 0 76 24m24-39q41-25 77-24m-77 37q41-25 77-24m-77 37q41-25 77-24m-77 37q41-25 77-24" stroke="#769482" strokeWidth="1.25" strokeLinecap="round" fill="none" />
    <path d="M274 89v51l-9-4-8 10V95Z" fill="#d5a75b" />
    <path d="M148 43v23m-11-11h22m168-20v18m-9-9h18m17 87v13m-7-6h14M89 127v17m-8-8h16" stroke="#efcc8c" strokeWidth="1.7" strokeLinecap="round" />
    <circle cx="291" cy="43" r="3" fill="#efcc8c" /><circle cx="109" cy="158" r="2.5" fill="#efcc8c" />
    <text x="319" y="227" fill="#cbd6b7" fontSize="8" letterSpacing="2.2">FIG. 01</text>
  </svg>;
}

export function Dashboard({ ctx }: { ctx: Context }) {
  const { data, go } = ctx;
  const mainChapters = studyChapters(data);
  const learned = mainChapters.filter((chapter) => chapter.learned_at).length;
  const practiced = mainChapters.filter((chapter) => chapter.practiced_at).length;
  const percentage = mainChapters.length ? Math.round(learned / mainChapters.length * 100) : 0;
  const next = mainChapters.filter((chapter) => chapter.visited_at).sort((a, b) => (b.visited_at || '').localeCompare(a.visited_at || ''))[0]
    || mainChapters.find((chapter) => !chapter.learned_at || !chapter.practiced_at) || mainChapters[0];
  const days = daysBetween(data.today, data.certificate.examDate);
  const tasks = data.tasks.filter((task) => task.day === data.today);
  const pending = tasks.filter((task) => !task.completed_at).length;
  return <div className="screen dashboard">
    <Heading kicker="STUDY DESK / 学习工作区" title="学习概览" note="安排今天的学习，稳步推进备考。"
      action={<div className="date-chip"><CalendarDays size={17} />{displayDay(data.today)}</div>} />
    <section className="cover" aria-label="考试倒计时">
      <div className="cover-content"><div className="cover-kicker"><span />{days < 0 ? '考试日期已过' : days === 0 ? '今天考试' : '考试倒计时'}</div>
        <div className="cover-number">{Math.abs(days)}<small>天</small></div>
        <h2>{data.certificate.name}</h2><p>考试日期 · {displayDay(data.certificate.examDate, true)}</p>
        <button className="btn cover-button" onClick={() => next ? go('chapter', next.id) : go('materials')}>
          {next ? <Play size={16} /> : <FilePlus2 size={16} />}{next ? '继续学习' : '导入第一份资料'}<ArrowRight size={16} />
        </button>
      </div><CoverIllustration />
    </section>
    <section className="metrics" aria-label="备考数据">
      <Metric icon={<BookOpen size={19} />} label="已学章节" value={learned} suffix={`/ ${mainChapters.length} 章`} color="mint" action={() => go('chapters')} />
      <Metric icon={<Target size={19} />} label="已完成练习" value={practiced} suffix="章" color="sand" action={() => go('chapters')} />
      <Metric icon={<ListChecks size={19} />} label="待复习错题" value={data.mistakes.pending} suffix="道" color="rose" action={() => go('mistakes')} />
    </section>
    <div className="dashboard-bottom">
      <section className="card panel"><div className="panel-head"><div><h2>今日任务</h2><p>{pending ? `还有 ${pending} 项任务待完成` : tasks.length ? '今天的任务已完成' : '今天暂无计划任务'}</p></div><TextLink onClick={() => go('plan')}>学习计划</TextLink></div>
        {tasks.length ? <TaskRows ctx={ctx} tasks={tasks} /> : <Empty icon={<CalendarCheck size={23} />} title="安排下一步" note="设置学习日与每日时长后，就能查看每日任务。" />}
      </section>
      <section className="card panel progress-panel"><div className="panel-head"><div><h2>章节进度</h2><p>按科目查看学习完成情况</p></div><span className="percent">{percentage}%</span></div>
        <progress value={percentage} max={100} aria-label="章节总体进度" />
        <div className="course-progress">{data.courses.map((course) => {
          const chapters = mainChapters.filter((chapter) => chapter.course_id === course.id);
          const done = chapters.filter((chapter) => chapter.learned_at).length;
          return <button key={course.id} onClick={() => go('chapters', course.id)}><span><BookOpen size={15} />{course.name}</span><small>{done}/{chapters.length} 章</small></button>;
        })}</div>
      </section>
    </div>
  </div>;
}

function Metric({ icon, label, value, suffix, color, action }: { icon: React.ReactNode; label: string; value: number; suffix: string; color: string; action: () => void }) {
  return <button className="card metric" onClick={action}><div className={`metric-icon ${color}`}>{icon}</div><div><div className="metric-label">{label}</div><strong>{value}</strong><small>{suffix}</small></div><ArrowDownRight className="metric-arrow" size={16} /></button>;
}

export function TaskRows({ ctx, tasks }: { ctx: Context; tasks: Task[] }) {
  const action = useAction();
  return <><ErrorBox message={action.error} /><ul className="task-list">{tasks.map((task) => <li className="task-row" key={task.id}>
    <button className={`task-check ${task.completed_at ? 'checked' : ''}`} aria-label={task.completed_at ? '已完成' : `完成 ${task.title || kindLabel[task.kind]}`}
      title={task.completed_at ? '已完成' : '标记完成'} disabled={!!task.completed_at || action.busy} onClick={() => void action.run(async () => {
        await api(`${ctx.base}/plan/tasks/${task.id}`, 'PATCH'); await ctx.refresh(); ctx.notify('任务已完成');
      })}>{task.completed_at ? <Check size={15} /> : <span />}</button>
    <button className="task-link" onClick={() => task.chapter_id ? ctx.go('chapter', task.chapter_id) : ctx.go('mistakes')}>
      <span>{task.title || '复习重点与错题'}</span><small>{kindLabel[task.kind]}</small></button><div className="task-duration"><Clock3 size={14} />{task.minutes} 分钟</div>
  </li>)}</ul></>;
}

const daysOfWeek = [{ id: 1, label: '周一' }, { id: 2, label: '周二' }, { id: 3, label: '周三' }, { id: 4, label: '周四' },
  { id: 5, label: '周五' }, { id: 6, label: '周六' }, { id: 0, label: '周日' }];

export function PlanPage({ ctx, editExam }: { ctx: Context; editExam: () => void }) {
  const { certificate, tasks, today } = ctx.data;
  const action = useAction();
  const [minutes, setMinutes] = useState(certificate.plan?.minutes ?? 45);
  const [weekdays, setWeekdays] = useState(certificate.plan?.weekdays ?? [0, 1, 2, 3, 4, 5, 6]);
  const [filter, setFilter] = useState('pending');
  const selected = tasks.filter((task) => filter === 'completed' ? task.completed_at : !task.completed_at);
  const days = [...new Set(selected.map((task) => task.day))];
  const overdue = tasks.filter((task) => !task.completed_at && task.day < today).length;
  return <div className="screen"><Heading kicker="SCHEDULE / 备考日程" title="学习计划" note="根据考试日期、章节顺序和可用时间分配学习与练习。"
    action={<button className="btn secondary" onClick={editExam}><CalendarDays size={17} /> 编辑考试日期</button>} />
    <div className="split-layout"><section className="card panel plan-settings"><div className="panel-head"><div><h2>排程设置</h2><p>考试日期 · {displayDay(certificate.examDate, true)}</p></div></div>
      <form className="stack" onSubmit={(event) => { event.preventDefault(); void action.run(async () => {
        await api(`${ctx.base}/plan`, 'POST', { weekdays, minutes }); await ctx.refresh(); ctx.notify('学习计划已更新');
      }); }}>
        <label>每日学习分钟数<input type="number" min={5} max={720} required value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label>
        <fieldset><legend>每周可学习日</legend><div className="weekdays">{daysOfWeek.map((day) => <label className="weekday" key={day.id}>
          <input type="checkbox" checked={weekdays.includes(day.id)} onChange={() => setWeekdays((value) => value.includes(day.id)
            ? value.filter((id) => id !== day.id) : [...value, day.id])} /><span>{day.label}</span></label>)}</div></fieldset>
        <ErrorBox message={action.error} />
        <button className="btn primary" disabled={action.busy || !weekdays.length}>{action.busy ? '正在排程…' : certificate.plan ? '重新排程 / 补排' : '生成学习计划'}</button>
        <p className="muted">按学习清单排程，同名笔记不重复安排。重新排程会保留已完成的任务。</p>
      </form>
    </section>
    <section className="card panel"><div className="panel-head"><div><h2>任务日历</h2><p>{certificate.plan ? `${certificate.plan.studyDays} 个可用学习日 · ${certificate.plan.reviewDays} 天考前复习` : '生成计划后可查看逐日任务'}</p></div>
      <select aria-label="筛选学习任务" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="pending">待完成</option><option value="completed">已完成</option></select></div>
      {overdue > 0 && <div className="callout warning">有 {overdue} 项逾期任务，可通过重新排程补排。</div>}
      {days.length ? days.map((day) => <div className="plan-day" key={day}><h3>{displayDay(day)}{day === today && <span className="pill green">今天</span>}</h3><TaskRows ctx={ctx} tasks={selected.filter((task) => task.day === day)} /></div>)
        : <Empty icon={<CalendarCheck size={24} />} title={filter === 'pending' ? '暂无待完成任务' : '暂无已完成任务'} note="可在章节详情调整预计学习和练习时长。" />}
      {!!certificate.plan?.unscheduled.length && <div className="unscheduled"><h3>尚未排入的任务</h3><p>可增加学习时间或调整可学习日。</p><ul>{certificate.plan.unscheduled.map((item) => <li key={`${item.chapterId}:${item.kind}`}>
        {item.title} · {kindLabel[item.kind]} · {item.minutes} 分钟</li>)}</ul></div>}
    </section></div>
  </div>;
}
