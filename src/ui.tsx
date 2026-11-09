import { ArrowRight, CircleAlert, LoaderCircle, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, isActive, type Job } from './model';

export function useResource<T>(url: string, revision = '') {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    setError('');
    api<T>(url).then((data) => { if (current) setValue(data); }, (err: Error) => { if (current) setError(err.message); });
    return () => { current = false; };
  }, [url, revision, reload]);
  return { value, error, reload: () => setReload((number) => number + 1) };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  async function run(task: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try { await task(); }
    catch (err) { setError(err instanceof Error ? err.message : '操作失败，请重试。'); }
    finally { locked.current = false; setBusy(false); }
  }
  return { busy, error, run, setError };
}

export function Heading({ kicker, title, note, action }: { kicker: string; title: string; note: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{kicker}</div><h1>{title}</h1><p>{note}</p></div>{action}</div>;
}

export function Loading() { return <div className="loading" role="status"><LoaderCircle size={20} className="spin" /> 正在读取本机数据…</div>; }

export function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  if (!message) return null;
  return <div className="error-box" role="alert"><CircleAlert size={18} /><span>{message}</span>{retry && <button className="btn small secondary" onClick={retry}>重试</button>}</div>;
}

export function Empty({ icon, title, note, action }: { icon: ReactNode; title: string; note: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{note}</p>{action}</div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);
  return <dialog className="modal" ref={ref} aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="modal-head"><h2>{title}</h2><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={20} /></button></div>
    {children}
  </dialog>;
}

export function JobLine({ job, retry, cancel }: { job: Job; retry: () => void; cancel?: () => void }) {
  return <div className={`job ${job.status === 'failed' ? 'job-error' : ''}`} role="status">
    <div>{isActive(job) && <LoaderCircle size={16} className="spin" />}<span>{job.message}</span>{isActive(job) && <span>{job.progress}%</span>}
      {(job.status === 'failed' || job.status === 'cancelled') && <button className="btn small secondary" onClick={retry}>重试</button>}
      {cancel && isActive(job) && <button className="btn small secondary" onClick={cancel}>取消导入</button>}</div>
    {isActive(job) && <progress value={job.progress} max={100} aria-label="任务进度" />}
  </div>;
}

export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button type="button" className="text-link" onClick={onClick}>{children}<ArrowRight size={15} /></button>;
}
