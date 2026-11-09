export function sliceMarks(marks, start, end) {
  if (end <= start) return [];
  return marks.filter((mark) => mark.end > start && mark.start < end).map((mark) => ({
    ...mark, start: Math.max(mark.start, start) - start, end: Math.min(mark.end, end) - start,
  }));
}

export function joinMarked(parts, separator = '') {
  const marks = [];
  let offset = 0;
  for (const { text, marks: current = [] } of parts) {
    for (const mark of current) {
      const next = { ...mark, start: mark.start + offset, end: mark.end + offset };
      const last = marks.at(-1);
      if (last && last.end === next.start && last.color === next.color && last.background === next.background
        && last.underline === next.underline) last.end = next.end;
      else marks.push(next);
    }
    offset += text.length + separator.length;
  }
  return { text: parts.map((part) => part.text).join(separator), marks };
}

export function trimMarked({ text, marks = [] }, preserveIndent = false) {
  const fromStart = preserveIndent ? text.replace(/^[ \t\r\n]+/u, '') : text.trimStart();
  const value = preserveIndent ? fromStart.replace(/[ \t\r\n]+$/u, '') : fromStart.trimEnd();
  const start = text.length - fromStart.length;
  return { text: value, marks: sliceMarks(marks, start, start + value.length) };
}

export function editMarks(marks, start, end, length) {
  const shift = length - (end - start);
  return marks.flatMap((mark) => {
    if (mark.end <= start) return [mark];
    if (mark.start >= end) return [{ ...mark, start: mark.start + shift, end: mark.end + shift }];
    if (mark.start <= start && mark.end >= end) {
      return mark.end + shift > mark.start ? [{ ...mark, end: mark.end + shift }] : [];
    }
    if (mark.start < start) return [{ ...mark, end: start }];
    if (mark.end > end) return [{ ...mark, start: start + length, end: mark.end + shift }];
    return [];
  });
}

export function correctMarks(marks, previous, next) {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1;
  let oldEnd = previous.length;
  let newEnd = next.length;
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return editMarks(marks, start, oldEnd, newEnd - start);
}

export const rgbHex = (r, g, b) => '#' + [r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('');
