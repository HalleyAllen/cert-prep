import { ExternalLink } from 'lucide-react';
import { Fragment, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { fileURL, type Unit, type UnitVisual } from './model';
import { buildReadingFlow, type ReadingPart } from './reading-flow';
import { ReadingAnnotations, type ReaderMark } from './reader-annotations';
import { useReadingPosition } from './reading-progress';

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

export function UnitText({ unit, base, materialId }: { unit: Unit; base: string; materialId: string }) {
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
    parts.push(<UnitFigure key={visual.index} unit={unit} visual={visual} index={visual.index} base={base} materialId={materialId} />);
    start = visual.offset + visual.anchor.length;
  }
  addText(unit.text.length);
  return <div className="unit-content">{parts}</div>;
}

function UnitFigure({ unit, visual, index, base, materialId, caption }: {
  unit: Unit; visual: UnitVisual; index: number; base: string; materialId: string; caption?: ReactNode;
}) {
  const src = `${base}/materials/${materialId}/units/${unit.position}/visuals/${index}`;
  return <figure className="unit-visual">
      <a href={fileURL(base, materialId, unit.page)} target="_blank" rel="noreferrer">
        <img src={src} loading="lazy" decoding="async" alt={`第 ${unit.page} 页${visualLabel[visual.kind]}`} />
      </a>
      <figcaption>
        {caption && <span className="unit-figure-title">{caption}</span>}
        {visualLabel[visual.kind]} · PDF 第 {unit.page} 页
      </figcaption>
  </figure>;
}

export function focusReaderItem(id: string) {
  const target = document.getElementById(id);
  target?.scrollIntoView({ block: 'start' });
  target?.focus({ preventScroll: true });
}

function annotatedText({ unit, start, end }: ReadingPart, marks: ReaderMark[] = []) {
  const overlaps = marks.filter((mark) => mark.start < end && mark.end > start);
  if (!overlaps.length) return markedText(unit, start, end);
  const boundaries = [...new Set([start, end, ...overlaps.flatMap((mark) => [Math.max(start, mark.start), Math.min(end, mark.end)])])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((from, index) => {
    const to = boundaries[index + 1];
    const items = overlaps.filter((mark) => mark.start < to && mark.end > from);
    return items.length
      ? <span key={from} role="button" tabIndex={0} data-annotation-ids={items.map((mark) => mark.id).join(' ')}
          className={items.map((mark) => 'reader-mark-' + mark.style).join(' ')}>{markedText(unit, from, to)}</span>
      : <Fragment key={from}>{markedText(unit, from, to)}</Fragment>;
  });
}

export function ReadingFlow({ units, base, materialId, chapterTitle, activeUnit, progressKey }: {
  units: Unit[]; base: string; materialId: string; chapterTitle?: string; activeUnit?: number; progressKey: string;
}) {
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  useReadingPosition(body, base + progressKey, base);
  const [section, setSection] = useState('');
  const blocks = useMemo(() => buildReadingFlow(units, chapterTitle), [units, chapterTitle]);
  const headings = blocks.flatMap((block, index) => block.kind === 'heading' ? [{ index, title: block.title, page: block.part.unit.page, local: block.local }] : []);
  const sectionId = (index: number | string) => `${id}-section-${index}`;
  const anchor = (part: ReadingPart) => part.first ? `unit-${part.unit.position}` : undefined;
  const renderPart = (part: ReadingPart, marks: Map<number, ReaderMark[]>) => <Fragment key={`${part.unit.position}:${part.start}`}>{part.gap}
    <span id={anchor(part)} tabIndex={part.first ? -1 : undefined} className={part.unit.position === activeUnit ? 'reader-highlight' : undefined}
      data-reader-offset={part.start} data-reader-position={part.unit.position}>
      {annotatedText(part, marks.get(part.unit.position))}
    </span>
  </Fragment>;
  return <div className="reader">
    {!!headings.length && <form className="reader-jump" onSubmit={(event) => {
      event.preventDefault();
      if (section) focusReaderItem(sectionId(section));
    }}>
      <label>小节目次<select value={section} onChange={(event) => setSection(event.target.value)}>
        <option value="">选择小节</option>
        {headings.map((item) => <option key={item.index} value={item.index}>{item.local && '　　'}{item.title}{item.page ? ` · 第 ${item.page} 页` : ''}</option>)}
      </select></label>
      <button type="submit" className="btn secondary" disabled={!section}>跳转</button>
    </form>}
    <ReadingAnnotations key={materialId} units={units} path={base + '/materials/' + materialId + '/annotations'} body={body}>
      {(marks, clearSelection, openMark) => <div className="reader-body" ref={body} onPointerDown={clearSelection} onClick={(event) => {
        const marked = (event.target as HTMLElement).closest<HTMLElement>('[data-annotation-ids]');
        if (marked) openMark(marked);
      }} onKeyDown={(event) => {
        const marked = (event.target as HTMLElement).closest<HTMLElement>('[data-annotation-ids]');
        if (marked && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          openMark(marked, true);
        }
      }}>{blocks.map((block, index) => {
      const start = block.kind === 'paragraph' ? block.parts[0] : block.part;
      const readingBlock = start.unit.position + ':' + start.start;
      if (block.kind === 'paragraph') return <p key={index} data-reading-block={readingBlock} className={block.indent ? 'reader-indented-item' : undefined}>
        {block.parts.map((part) => renderPart(part, marks))}
      </p>;
      const unit = block.part.unit;
      if (block.kind === 'visual') return <div key={index} id={anchor(block.part)} data-reading-block={readingBlock} tabIndex={block.part.first ? -1 : undefined}>
        <UnitFigure unit={unit} visual={block.visual} index={block.index} base={base} materialId={materialId}
          caption={block.caption && renderPart(block.caption, marks)} />
      </div>;
      const Title = block.depth <= 2 ? 'h3' : block.depth === 3 ? 'h4' : 'h5';
      return <div className={`reader-heading reader-heading-${block.depth}${block.local ? ' reader-local-heading' : ''}`} id={sectionId(index)} data-reading-block={readingBlock} tabIndex={-1} key={index}>
        <Title>{renderPart(block.part, marks)}</Title>
        {unit.page && <a className="mini-link" href={fileURL(base, materialId, unit.page)} target="_blank" rel="noreferrer">原页 {unit.page} <ExternalLink size={13} /></a>}
      </div>;
    })}</div>}
    </ReadingAnnotations>
  </div>;
}
