import { joinMarked, rgbHex } from './rich-text.mjs';

function annotationAreas(annotations, viewport) {
  return annotations.flatMap((item) => {
    const underline = item.subtype === 'Underline';
    if ((!underline && item.subtype !== 'Highlight') || !item.quadPoints?.length) return [];
    const style = underline ? { underline: true } : { background: item.color ? rgbHex(...item.color) : '#ffff00' };
    const areas = [];
    for (let i = 0; i + 7 < item.quadPoints.length; i += 8) {
      const points = [];
      for (let n = i; n < i + 8; n += 2) points.push(viewport.convertToViewportPoint(item.quadPoints[n], item.quadPoints[n + 1]));
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      areas.push({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), style });
    }
    return areas;
  });
}

const strongest = (colors) => {
  let best;
  for (const entry of colors.values()) if (!best || entry.count > best.count) best = entry;
  return best;
};

export function createPageSampler(canvas, annotations = [], viewport) {
  const { width, height } = canvas;
  const context = canvas.getContext('2d');
  const { data } = context.getImageData(0, 0, width, height);
  const areas = viewport ? annotationAreas(annotations, viewport) : [];
  const measured = new Map();
  function sample(box, underline = false) {
    const x0 = Math.max(0, Math.floor(box.x0));
    const y0 = Math.max(0, Math.floor(box.y0));
    const x1 = Math.min(width, Math.ceil(box.x1));
    const y1 = Math.min(height, Math.ceil(box.y1));
    if (x1 <= x0 || y1 <= y0) return { style: {}, colored: false };
    const colors = new Map();
    let ink = 0;
    let count = 0;
    const step = Math.max(1, Math.floor(Math.sqrt((x1 - x0) * (y1 - y0) / 4000)));
    for (let y = y0; y < y1; y += step) {
      for (let x = x0; x < x1; x += step) {
        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const low = Math.min(r, g, b);
        const high = Math.max(r, g, b);
        count += 1;
        if (high <= 175) ink += 1;
        if (high - low < 42 || low >= 215) continue;
        if (high > 175) ink += 1;
        const key = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
        const entry = colors.get(key);
        if (entry) entry.count += 1;
        else colors.set(key, { r, g, b, count: 1 });
      }
    }
    const style = {};
    const fill = strongest(colors);
    if (fill && fill.count >= count * 0.37 && Math.max(fill.r, fill.g, fill.b) >= 140) {
      style.background = rgbHex(fill.r, fill.g, fill.b);
      ink -= fill.count;
      for (const [key, value] of colors) {
        if (Math.max(Math.abs(value.r - fill.r), Math.abs(value.g - fill.g), Math.abs(value.b - fill.b)) < 45) colors.delete(key);
      }
    }
    const color = strongest(colors);
    if (color && color.count >= Math.max(3, ink * 0.43)) style.color = rgbHex(color.r, color.g, color.b);
    if (underline && x1 - x0 >= 13 && ink >= 6) {
      const depth = Math.max(2, Math.ceil((y1 - y0) * 0.25));
      for (let y = y1; y < Math.min(height, y1 + depth); y += 1) {
        let dark = 0;
        for (let x = x0; x < x1; x += 1) {
          const i = (y * width + x) * 4;
          if (Math.max(data[i], data[i + 1], data[i + 2]) < 185) dark += 1;
        }
        if (dark >= (x1 - x0) * 0.8) {
          style.underline = true;
          break;
        }
      }
    }
    const middle = (box.x0 + box.x1) / 2;
    let annotated = false;
    for (const area of areas) {
      const overlap = Math.min(area.y1, box.y1) - Math.max(area.y0, box.y0);
      if (overlap <= (box.y1 - box.y0) * 0.2 || area.x1 <= box.x0 || area.x0 >= box.x1) continue;
      annotated = true;
      if (middle >= area.x0 && middle <= area.x1) Object.assign(style, area.style);
    }
    return { style, colored: Boolean(fill?.count >= 3 || annotated) };
  }

  return (text, box, split) => {
    if (!text.trim()) return [];
    const { style, colored } = sample(box, true);
    const chars = Array.from(text);
    if (!split || chars.length < 2 || !colored) {
      return Object.keys(style).length ? [{ ...style, start: 0, end: text.length }] : [];
    }
    const widths = chars.map((char) => {
      if (!measured.has(char)) measured.set(char, context.measureText(char).width || 1);
      return measured.get(char);
    });
    const ratio = (box.x1 - box.x0) / widths.reduce((sum, value) => sum + value, 0);
    let left = box.x0;
    return joinMarked(chars.map((char, index) => {
      const right = left + widths[index] * ratio;
      const mark = sample({ ...box, x0: left, x1: right }).style;
      if (style.underline) mark.underline = true;
      left = right;
      return { text: char, marks: Object.keys(mark).length ? [{ ...mark, start: 0, end: char.length }] : [] };
    })).marks;
  };
}
