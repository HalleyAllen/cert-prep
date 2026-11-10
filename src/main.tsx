import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BookOpen, CalendarDays, Check, ChevronDown, CircleHelp, Files, GraduationCap, House, ListChecks, Plus, Search, Settings2, X } from 'lucide-react';
import { api, isActive, type Context, type Navigate, type Screen, type Snapshot, type Workspace } from './model';
import { ErrorBox, Loading, Modal, useAction } from './ui';
import { Dashboard, PlanPage } from './dashboard';
import { ChapterPage, ChaptersPage, MaterialPage, MaterialsPage } from './library';
import { MistakesPage, QuizPage, SearchPage } from './practice';
import { ServiceSettingsDialog } from './service-settings';
import './styles.css';

const nav = [
  { page: 'home', label: '学习概览', icon: House }, { page: 'materials', label: '资料库', icon: Files },
  { page: 'chapters', label: '章节学习', icon: BookOpen }, { page: 'search', label: '联网搜题', icon: Search },
  { page: 'mistakes', label: '错题本', icon: ListChecks }, { page: 'plan', label: '学习计划', icon: CalendarDays },
] as const;
const labels: Record<Screen, string> = { home: '学习概览', materials: '资料库', chapters: '章节学习', search: '联网搜题',
  mistakes: '错题本', plan: '学习计划', material: '校对资料', chapter: '章节详情', quiz: '练习答题' };

function getRoute() {
  const [page, id] = location.hash.slice(1).split('/');
  return { page: Object.hasOwn(labels, page) ? page as Screen : 'home' as Screen, id };
}

function App() {
  const [route, setRoute] = useState(getRoute);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [certId, setCertId] = useState(() => localStorage.getItem('cert-prep:last') || '');
  const [data, setData] = useState<Snapshot>();
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<'new' | 'edit' | 'settings' | null>(null);
  const main = useRef<HTMLElement>(null);
  const requestVersion = useRef(0);
  const lastId = useRef(certId);
  lastId.current = certId;
  const go: Navigate = (page, id) => {
    location.hash = `${page}${id ? `/${id}` : ''}`;
  };

  useEffect(() => {
    const change = () => { setRoute(getRoute()); window.scrollTo(0, 0); main.current?.focus({ preventScroll: true }); };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const loadWorkspace = useCallback(async () => {
    const result = await api<Workspace>('/api/workspace');
    setWorkspace(result);
    setCertId((current) => result.certificates.some((item) => item.id === current) ? current : result.certificates[0]?.id || '');
    setLoadError('');
  }, []);
  useEffect(() => { void loadWorkspace().catch((error: Error) => setLoadError(error.message)); }, [loadWorkspace]);
  const refresh = useCallback(async () => {
    if (!certId) return;
    const version = ++requestVersion.current;
    const result = await api<Snapshot>(`/api/certificates/${certId}`);
    if (lastId.current === certId && version === requestVersion.current) {
      setData(result);
      setLoadError('');
    }
  }, [certId]);
  useEffect(() => {
    if (!certId || !workspace?.certificates.some((item) => item.id === certId)) return;
    localStorage.setItem('cert-prep:last', certId);
    void refresh().catch((error: Error) => setLoadError(error.message));
  }, [certId, refresh, workspace]);
  const running = data?.jobs.some(isActive);
  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); }
      catch (error) { if (!cancelled) setLoadError((error as Error).message); }
      if (!cancelled) timer = setTimeout(poll, 1300);
    };
    timer = setTimeout(poll, 900);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [running, refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const active = route.page === 'material' ? 'materials' : ['chapter', 'quiz'].includes(route.page) ? 'chapters' : route.page;
  const cert = data?.certificate.id === certId ? data.certificate : undefined;
  const ctx: Context | undefined = data && cert && workspace ? { data, go, refresh, base: `/api/certificates/${certId}`,
    aiReady: workspace.aiReady, searchReady: workspace.searchReady, notify: setNotice } : undefined;
  const navItems = nav.map(({ page, icon: Icon, label }) => <a key={page} href={`#${page}`} aria-current={active === page ? 'page' : undefined}
    aria-description={page === 'mistakes' && data?.mistakes.pending ? `${data.mistakes.pending} 道待复习` : undefined}
    className={active === page ? 'current' : ''}><Icon size={19} aria-hidden="true" /><span>{label}</span>{page === 'mistakes' && !!data?.mistakes.pending && <small aria-hidden="true">{data.mistakes.pending}</small>}</a>);
  const retry = () => void Promise.all([loadWorkspace(), refresh()]).catch((error: Error) => setLoadError(error.message));
  const screen = ctx && (() => {
    switch (route.page) {
      case 'home': return <Dashboard ctx={ctx} />;
      case 'materials': return <MaterialsPage ctx={ctx} />;
      case 'chapters': return <ChaptersPage ctx={ctx} initialCourse={route.id} />;
      case 'material': return <MaterialPage ctx={ctx} id={route.id} />;
      case 'chapter': return <ChapterPage ctx={ctx} id={route.id} />;
      case 'search': return <SearchPage ctx={ctx} initialChapter={route.id} />;
      case 'mistakes': return <MistakesPage ctx={ctx} />;
      case 'plan': return <PlanPage ctx={ctx} editExam={() => setDialog('edit')} />;
      case 'quiz': return <QuizPage ctx={ctx} id={route.id} />;
    }
  })();

  return <div className="app-shell">
    <a className="skip" href="#main-content" onClick={(event) => { event.preventDefault(); main.current?.focus(); }}>跳到主要内容</a>
    <aside className="sidebar">
      <a className="brand" href="#home"><img src="/mark.svg" alt="" width="40" height="40" /><span>备考台<small>个人学习工作区</small></span></a>
      <div className="workspace-label">当前备考</div>
      <div className="cert-select"><GraduationCap size={18} /><select aria-label="切换证书" value={certId} onChange={(event) => { setCertId(event.target.value); go('home'); }}>
        {workspace?.certificates.map((item) => <option value={item.id} key={item.id}>{item.name}{item.demo ? ' · 示例' : ''}</option>)}
      </select><ChevronDown size={14} /></div>
      <button className="new-cert" onClick={() => setDialog('new')}><Plus size={16} /> 新建证书</button>
      <div className="workspace-label nav-label">工作区</div>
      <nav className="main-nav" aria-label="工作区导航">{navItems}</nav>
      <button className="settings-btn" onClick={() => setDialog('settings')}><Settings2 size={18} /><span>服务配置</span></button>
      <div className="sidebar-foot"><span className="status-dot" /> 本机工作区</div>
    </aside>
    <div className="body-shell">
      <header className="topbar"><div className="crumb"><span>工作区</span><span>/</span><strong>{labels[route.page]}</strong></div>
        <div className="top-actions">{cert?.demo && <span className="pill demo-pill">示例工作区</span>}
          <button className="icon-button top-help" aria-label="打开服务配置" onClick={() => setDialog('settings')}><CircleHelp size={19} /></button></div>
      </header>
      <main id="main-content" tabIndex={-1} className="main-content" ref={main}>
        <ErrorBox message={loadError} retry={retry} />
        <div key={`${certId}:${route.page}:${route.id || ''}`}>{screen || (!loadError && <Loading />)}</div>
      </main>
    </div>
    {notice && <div className="toast" role="status"><Check size={18} />{notice}<button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={16} /></button></div>}
    {dialog === 'settings' && <ServiceSettingsDialog close={() => setDialog(null)} onSaved={(settings) => {
      setWorkspace((current) => current && { ...current, ...settings });
      setDialog(null);
      setNotice('服务配置已保存');
    }} />}
    {(dialog === 'new' || (dialog === 'edit' && cert)) && <CertificateForm current={dialog === 'edit' ? cert : undefined}
      today={workspace?.today || ''} close={() => setDialog(null)} onSaved={async (id) => {
        await loadWorkspace();
        if (id) { setCertId(id); go('home'); }
        else await refresh();
        setDialog(null);
        setNotice(id ? '新证书已创建' : '证书信息已保存');
      }} />}
  </div>;
}

function CertificateForm({ current, today, close, onSaved }: { current?: Snapshot['certificate']; today: string; close: () => void; onSaved: (id?: string) => Promise<void> }) {
  const action = useAction();
  return <Modal title={current ? '编辑证书与考试日期' : '新建备考证书'} onClose={close}>
    <form className="stack" onSubmit={(event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(event.currentTarget));
      void action.run(async () => {
        if (current) { await api(`/api/certificates/${current.id}`, 'PATCH', values); await onSaved(); }
        else { const result = await api<{ id: string }>('/api/certificates', 'POST', values); await onSaved(result.id); }
      });
    }}>
      <label>证书名称<input name="name" required maxLength={100} defaultValue={current?.name} placeholder="例如：信息系统项目管理师" /></label>
      <label>考试日期<input name="examDate" type="date" required min={current ? undefined : today} defaultValue={current?.examDate} /></label>
      {current?.plan && <p className="muted">改期会重新安排待完成任务，保留已完成记录。</p>}
      <ErrorBox message={action.error} />
      <div className="form-actions"><button type="button" className="btn secondary" onClick={close}>取消</button><button className="btn primary" disabled={action.busy}>{action.busy ? '正在保存…' : '保存'}</button></div>
    </form>
  </Modal>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
