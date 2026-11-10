import { ExternalLink } from 'lucide-react';
import { Fragment, useId, useMemo, useState, type ReactNode } from 'react';
import { fileURL, type Unit, type UnitVisual } from './model';
import { buildReadingFlow, type ReadingPart } from './reading-flow';

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

function UnitFigure({ unit, visual, index, base, materialId }: { unit: Unit; visual: UnitVisual; index: number; base: string; materialId: string }) {
  const src = `${base}/materials/${materialId}/units/${unit.position}/visuals/${index}`;
  return <figure className="unit-visual">
      <a href={fileURL(base, materialId, unit.page)} target="_blank" rel="noreferrer">
        <img src={src} loading="lazy" decoding="async" alt={`第 ${unit.page} 页${visualLabel[visual.kind]}`} />
      </a>
      <figcaption>{visualLabel[visual.kind]} · PDF 第 {unit.page} 页</figcaption>
  </figure>;
}

export function focusReaderItem(id: string) {
  const target = document.getElementById(id);
  target?.scrollIntoView({ block: 'start' });
  target?.focus({ preventScroll: true });
}

export function ReadingFlow({ units, base, materialId, chapterTitle, activeUnit }: {
  units: Unit[]; base: string; materialId: string; chapterTitle?: string; activeUnit?: number;
}) {
  const id = useId();
  const [section, setSection] = useState('');
  const blocks = useMemo(() => buildReadingFlow(units, chapterTitle), [units, chapterTitle]);
  const headings = blocks.flatMap((block, index) => block.kind === 'heading' ? [{ index, title: block.title, page: block.part.unit.page, local: block.local }] : []);
  const sectionId = (index: number | string) => `${id}-section-${index}`;
  const anchor = (part: ReadingPart) => part.first ? `unit-${part.unit.position}` : undefined;
  const renderPart = (part: ReadingPart) => <Fragment key={`${part.unit.position}:${part.start}`}>{part.gap}
    <span id={anchor(part)} tabIndex={part.first ? -1 : undefined} className={part.unit.position === activeUnit ? 'reader-highlight' : undefined}>
      {markedText(part.unit, part.start, part.end)}
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
    <div className="reader-body">{blocks.map((block, index) => {
      if (block.kind === 'paragraph') return <p key={index}>{block.parts.map(renderPart)}</p>;
      const unit = block.part.unit;
      if (block.kind === 'visual') return <div key={index} id={anchor(block.part)} tabIndex={block.part.first ? -1 : undefined}>
        <UnitFigure unit={unit} visual={block.visual} index={block.index} base={base} materialId={materialId} />
      </div>;
      const Title = block.depth <= 2 ? 'h3' : block.depth === 3 ? 'h4' : 'h5';
      return <div className={`reader-heading reader-heading-${block.depth}${block.local ? ' reader-local-heading' : ''}`} id={sectionId(index)} tabIndex={-1} key={index}>
        <Title>{renderPart(block.part)}</Title>
        {unit.page && <a className="mini-link" href={fileURL(base, materialId, unit.page)} target="_blank" rel="noreferrer">原页 {unit.page} <ExternalLink size={13} /></a>}
      </div>;
    })}</div>
  </div>;
}
