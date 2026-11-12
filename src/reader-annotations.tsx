import { Highlighter, NotebookPen, Trash2, Underline } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { api, type Unit } from './model';
import { ErrorBox, Modal, useAction, useResource } from './ui';

type SourceRange = { position: number; start: number; quote: string };
type Selection = { source: SourceRange[]; range: Range };
type OpenMark = { ids: string[]; range: Range; element: HTMLElement };
type Style = 'underline' | 'highlight';
type Annotation = { id: string; position: number; ranges: SourceRange[]; style: Style; note: string };
export type ReaderMark = { id: string; start: number; end: number; style: Style };

function selectedRanges(body: HTMLElement, units: Map<number, Unit>, range: Range): SourceRange[] {
  if (range.collapsed || !body.contains(range.startContainer) || !body.contains(range.endContainer)) return [];
  const bounds = new Map<number, { start: number; end: number }>();
  for (const span of body.querySelectorAll<HTMLElement>('[data-reader-offset]')) {
    if (!range.intersectsNode(span)) continue;
    const position = Number(span.dataset.readerPosition);
    const offset = Number(span.dataset.readerOffset);
    const prefix = document.createRange();
    prefix.selectNodeContents(span);
    const length = (node: Node, at: number, fallback: number) => {
      if (!span.contains(node)) return fallback;
      prefix.setEnd(node, at);
      return prefix.toString().length;
    };
    const start = offset + length(range.startContainer, range.startOffset, 0);
    const end = offset + length(range.endContainer, range.endOffset, span.textContent.length);
    if (start >= end) continue;
    const previous = bounds.get(position);
    bounds.set(position, { start: previous?.start ?? start, end });
  }
  return Array.from(bounds, ([position, { start, end }]) => ({
    position, start, quote: units.get(position)?.text.slice(start, end) ?? '',
  })).filter(({ quote }) => quote.trim()).sort((a, b) => a.position - b.position);
}

function positionBubble(bubble: HTMLDivElement, range: Range) {
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  const lines = Array.from(range.getClientRects()).filter((rect) => rect.width && rect.height && rect.right > 0
    && rect.left < width && rect.bottom > 0 && rect.top < height);
  const first = lines[0];
  const last = lines.at(-1);
  bubble.style.visibility = first ? 'visible' : 'hidden';
  if (!first || !last) return;
  const margin = 8;
  const gap = 10;
  const above = first.top >= bubble.offsetHeight + gap + margin;
  const anchor = above ? first : last;
  const center = (Math.max(0, anchor.left) + Math.min(width, anchor.right)) / 2;
  const left = Math.max(margin, Math.min(center - bubble.offsetWidth / 2, width - bubble.offsetWidth - margin));
  const top = above ? anchor.top - bubble.offsetHeight - gap : anchor.bottom + gap;
  bubble.style.left = left + 'px';
  bubble.style.top = Math.max(margin, Math.min(top, height - bubble.offsetHeight - margin)) + 'px';
  bubble.style.setProperty('--selection-tip', Math.max(12, Math.min(center - left, bubble.offsetWidth - 12)) + 'px');
  bubble.dataset.placement = above ? 'above' : 'below';
}

export function ReadingAnnotations({ units, path, body, children }: {
  units: Unit[]; path: string; body: RefObject<HTMLDivElement | null>;
  children: (marks: Map<number, ReaderMark[]>, clearSelection: () => void, openMark: (element: HTMLElement, keyboard?: boolean) => void) => ReactNode;
}) {
  const byPosition = useMemo(() => new Map(units.map((unit) => [unit.position, unit])), [units]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [openMark, setOpenMark] = useState<OpenMark | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Annotation>();
  const [draftRanges, setDraftRanges] = useState<SourceRange[]>([]);
  const [draftNote, setDraftNote] = useState('');
  const bubble = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<'list' | 'new' | Annotation>();
  const [notice, setNotice] = useState('');
  const { value, error, reload } = useResource<Annotation[]>(path);
  const action = useAction();
  const visible = useMemo(() => (value ?? []).filter((item) => byPosition.has(item.position)
    || item.ranges.some((range) => byPosition.has(range.position))), [value, byPosition]);
  const markedItems = openMark ? visible.filter((item) => openMark.ids.includes(item.id)) : [];
  const bubbleRange = selection?.range ?? (markedItems.length ? openMark?.range : undefined);
  const marks = useMemo(() => {
    const result = new Map<number, ReaderMark[]>();
    for (const item of visible) for (const { position, start, quote } of item.ranges) {
      const end = start + quote.length;
      if (byPosition.get(position)?.text.slice(start, end) !== quote) continue;
      const mark = { id: item.id, start, end, style: item.style };
      const existing = result.get(position);
      if (existing) existing.push(mark);
      else result.set(position, [mark]);
    }
    return result;
  }, [visible, byPosition]);

  useEffect(() => {
    const capture = () => {
      if (!body.current || dialog || deleteTarget) return;
      const current = document.getSelection();
      const range = current?.rangeCount ? current.getRangeAt(0) : undefined;
      const source = range ? selectedRanges(body.current, byPosition, range) : [];
      if (range && source.length) {
        setOpenMark(null);
        setSelection({ source, range: range.cloneRange() });
      }
      else if (!bubble.current?.contains(document.activeElement)) setSelection(null);
    };
    document.addEventListener('selectionchange', capture);
    return () => document.removeEventListener('selectionchange', capture);
  }, [body, byPosition, dialog, deleteTarget]);

  useLayoutEffect(() => {
    const element = bubble.current;
    if (!bubbleRange || !element || dialog || deleteTarget) return;
    const update = () => positionBubble(element, bubbleRange);
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [bubbleRange, dialog, deleteTarget, action.error]);

  const reset = () => {
    setSelection(null);
    setOpenMark(null);
    const current = document.getSelection();
    if (current && body.current?.contains(current.anchorNode)) current.removeAllRanges();
  };
  useEffect(() => {
    if (!bubbleRange || dialog || deleteTarget) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (bubble.current?.contains(document.activeElement)) openMark?.element.focus({ preventScroll: true });
      setSelection(null);
      setOpenMark(null);
      if (body.current?.contains(document.getSelection()?.anchorNode ?? null)) document.getSelection()?.removeAllRanges();
    };
    const clickOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !bubble.current?.contains(event.target)) setOpenMark(null);
    };
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', clickOutside);
    return () => {
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('pointerdown', clickOutside);
    };
  }, [body, dialog, deleteTarget, bubbleRange, openMark]);
  const showMark = (element: HTMLElement, keyboard = false) => {
    const current = document.getSelection();
    if (current && !current.isCollapsed && body.current?.contains(current.anchorNode)) {
      if (!keyboard) return;
      current.removeAllRanges();
    }
    const range = document.createRange();
    range.selectNodeContents(element);
    setSelection(null);
    setOpenMark({ ids: (element.dataset.annotationIds ?? '').split(' '), range, element });
    action.setError('');
    if (keyboard) requestAnimationFrame(() => bubble.current?.querySelector('button')?.focus({ preventScroll: true }));
  };
  const openEditor = (ranges: SourceRange[]) => {
    setDraftRanges(ranges);
    setDraftNote('');
    action.setError('');
    reset();
    setDialog('new');
  };
  const editNote = (item: Annotation) => {
    setOpenMark(null);
    action.setError('');
    setDraftNote(item.note);
    setDialog(item);
  };
  const create = async (style: Style, note: string, ranges: SourceRange[]) => {
    await api(path, 'POST', { position: ranges[0]?.position ?? units[0]?.position, ranges, style, note });
    reset();
    reload();
    setNotice(note ? '笔记已保存' : style === 'underline' ? '已添加划线' : '已添加高亮');
  };
  const jump = (item: Annotation) => {
    const position = [item.position, ...item.ranges.map((range) => range.position)].find((value) => byPosition.has(value));
    const target = body.current?.querySelector<HTMLElement>('[data-annotation-ids~="' + item.id + '"]')
      ?? (position !== undefined ? body.current?.querySelector<HTMLElement>('#unit-' + position) : null);
    if (!target) return;
    setDialog(undefined);
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'center' });
      target.focus({ preventScroll: true });
    });
  };
  const close = () => {
    if (action.busy) return;
    action.setError('');
    if (deleteTarget) setDeleteTarget(undefined);
    else setDialog(undefined);
  };
  const requestDelete = (item: Annotation) => { action.setError(''); setDeleteTarget(item); };
  const remove = (item: Annotation) => void action.run(async () => {
    await api(path + '/' + item.id, 'DELETE');
    setDeleteTarget(undefined);
    reset();
    if (typeof dialog === 'object') setDialog('list');
    setNotice(item.note ? '笔记已删除' : '标记已删除');
    reload();
  });
  const editing = typeof dialog === 'object' ? dialog : undefined;
  const quote = (ranges: SourceRange[]) => ranges.map((range) => range.quote).join(' ').slice(0, 220);
  return <>
    <div className="reader-annotation-bar" role="group" aria-label="原文笔记">
      <div className="button-group">
        <button type="button" className="btn secondary" disabled={action.busy}
          onClick={() => openEditor([])}><NotebookPen size={16} />写笔记</button>
        <button type="button" className="btn secondary" onClick={() => { action.setError(''); reset(); setDialog('list'); }}>
          笔记与标记{value ? '（' + visible.length + '）' : ''}
        </button>
      </div>
      <p className="reader-annotation-hint" role="status">{notice || '选中文字添加标记，点击已有标记查看笔记。'}</p>
    </div>
    {children(marks, () => { setSelection(null); setNotice(''); action.setError(''); }, showMark)}
    {selection && !dialog && !deleteTarget && <div ref={bubble} className="reader-selection-bubble" role="group" aria-label="选中文字的操作">
      <div className="button-group" onMouseDown={(event) => event.preventDefault()}>
        <button type="button" className="btn" disabled={action.busy}
          onClick={() => void action.run(() => create('underline', '', selection.source))}><Underline size={16} />划线</button>
        <button type="button" className="btn" disabled={action.busy}
          onClick={() => void action.run(() => create('highlight', '', selection.source))}><Highlighter size={16} />高亮</button>
        <button type="button" className="btn" disabled={action.busy}
          onClick={() => openEditor(selection.source)}><NotebookPen size={16} />写笔记</button>
      </div>
      <ErrorBox message={action.error} />
    </div>}
    {!!markedItems.length && !selection && !dialog && !deleteTarget &&
      <div ref={bubble} className="reader-selection-bubble reader-existing-mark" role="group" aria-label="已有笔记与标记">
        <div className="reader-existing-mark-list">
          {markedItems.map((item) => <article className="reader-annotation-entry" key={item.id}>
            <strong>{item.note ? '笔记' : item.style === 'underline' ? '划线' : '高亮'}</strong>
            {item.note && <p>{item.note}</p>}
            <div className="button-group">
              <button type="button" className="btn" disabled={action.busy} onClick={() => editNote(item)}>
                {item.note ? '编辑笔记' : '添加笔记'}
              </button>
              <button type="button" className="btn reader-delete-mark" disabled={action.busy} onClick={() => requestDelete(item)}>
                <Trash2 size={16} />{item.note ? '删除笔记' : '删除标记'}
              </button>
            </div>
          </article>)}
        </div>
      </div>}
    {(dialog || deleteTarget) && <Modal title={deleteTarget ? (deleteTarget.note ? '删除笔记' : '删除标记')
      : dialog === 'list' ? '笔记与标记' : editing ? '编辑笔记' : '写笔记'} onClose={close}>
      {deleteTarget ? <div className="stack">
        <p>{deleteTarget.note
          ? deleteTarget.ranges.length ? '删除后，这条笔记及其原文标记会一并移除。' : '确定删除这条笔记？'
          : '确定移除这处原文标记？'}</p>
        <ErrorBox message={action.error} />
        <div className="form-actions">
          <button type="button" className="btn secondary" disabled={action.busy} onClick={close}>取消</button>
          <button type="button" className="btn danger" disabled={action.busy} onClick={() => remove(deleteTarget)}>
            {action.busy ? '正在删除…' : '确认删除'}
          </button>
        </div>
      </div> : dialog === 'list' ? <div className="stack">
        <ErrorBox message={error} retry={reload} />
        <ErrorBox message={action.error} />
        {value ? !visible.length && <p>这一节还没有笔记或标记。</p> : !error && <p role="status">正在读取笔记…</p>}
        {visible.map((item) => <article className="reader-annotation-entry" key={item.id}>
          <strong>{item.note ? '笔记' : item.style === 'underline' ? '划线' : '高亮'}</strong>
          {!!item.ranges.length && <blockquote>{quote(item.ranges)}</blockquote>}
          {item.note && <p>{item.note}</p>}
          <div className="button-group">
            <button type="button" className="btn secondary" onClick={() => jump(item)}>定位原文</button>
            <button type="button" className="btn secondary" disabled={action.busy} onClick={() => editNote(item)}>{item.note ? '编辑' : '添加笔记'}</button>
            <button type="button" className="btn secondary reader-delete-mark" disabled={action.busy} onClick={() => requestDelete(item)}>
              {item.note ? '删除笔记' : '删除标记'}
            </button>
          </div>
        </article>)}
      </div> : <form className="stack" onSubmit={(event) => {
        event.preventDefault();
        const note = String(new FormData(event.currentTarget).get('note') ?? '').trim();
        if (!note) { action.setError('请填写笔记内容。'); return; }
        void action.run(async () => {
          if (editing) {
            await api(path + '/' + editing.id, 'PATCH', { note });
            reload();
            setDialog('list');
          } else {
            await create('highlight', note, draftRanges);
            setDialog(undefined);
          }
        });
      }}>
        {!!(editing?.ranges ?? draftRanges).length && <blockquote className="reader-note-quote">{quote(editing?.ranges ?? draftRanges)}</blockquote>}
        <label>笔记内容<textarea name="note" rows={4} maxLength={4000} required value={draftNote}
          onChange={(event) => setDraftNote(event.target.value)} /></label>
        <ErrorBox message={action.error} />
        <div className="form-actions">
          {editing && <button type="button" className="btn secondary reader-delete-mark" disabled={action.busy}
            onClick={() => requestDelete(editing)}>{editing.note ? '删除笔记' : '删除标记'}</button>}
          <button type="button" className="btn secondary" disabled={action.busy}
            onClick={() => { action.setError(''); setDialog(editing ? 'list' : undefined); }}>取消</button>
          <button className="btn primary" disabled={action.busy}>{action.busy ? '正在保存…' : '保存笔记'}</button>
        </div>
      </form>}
    </Modal>}
  </>;
}
