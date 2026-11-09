import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { joinMarked } from './rich-text.mjs';

const highlightColors = {
  black: '#000000', blue: '#0000ff', cyan: '#00ffff', darkBlue: '#000080', darkCyan: '#008080',
  darkGray: '#808080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', green: '#00ff00', lightGray: '#c0c0c0', magenta: '#ff00ff',
  red: '#ff0000', white: '#ffffff', yellow: '#ffff00',
};
const hexColor = (value) => /^[0-9a-f]{6}$/iu.test(value) ? '#' + value.toLowerCase() : undefined;

export async function readWordMarks(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) return null;
  const parser = new DOMParser({ errorHandler: { warning() {}, error() {}, fatalError() {} } });
  const document = parser.parseFromString(await file.async('string'), 'text/xml');
  const ns = document.documentElement?.namespaceURI;
  if (document.documentElement?.localName !== 'document' || !/\/wordprocessingml\/(?:2006\/)?main$/u.test(ns ?? '')) return null;

  const children = (node) => Array.from(node?.childNodes ?? []);
  const child = (node, name) => children(node).find((item) => item.namespaceURI === ns && item.localName === name);
  const attr = (node, name) => node?.getAttributeNS(ns, name) ?? '';
  const styles = new Map();
  const styleFile = zip.file('word/styles.xml');
  if (styleFile) {
    const stylesDoc = parser.parseFromString(await styleFile.async('string'), 'text/xml');
    for (const style of Array.from(stylesDoc.getElementsByTagNameNS(ns, 'style'))) styles.set(attr(style, 'styleId'), style);
  }
  const runStyle = (properties) => {
    const result = {};
    const color = child(properties, 'color');
    if (color) result.color = hexColor(attr(color, 'val'));
    const highlight = child(properties, 'highlight');
    const shading = child(properties, 'shd');
    if (highlight || shading) {
      result.background = Object.hasOwn(highlightColors, attr(highlight, 'val')) ? highlightColors[attr(highlight, 'val')]
        : hexColor(attr(shading, 'fill'));
    }
    const underline = child(properties, 'u');
    if (underline) result.underline = attr(underline, 'val') !== 'none';
    return result;
  };
  const inherited = (id, seen = new Set()) => {
    const style = styles.get(id);
    if (!style || seen.has(id)) return {};
    seen.add(id);
    return { ...inherited(attr(child(style, 'basedOn'), 'val'), seen), ...runStyle(child(style, 'rPr')) };
  };

  const parts = [];
  function visit(node, style = {}) {
    const name = node.namespaceURI === ns ? node.localName : '';
    if (['del', 'moveFrom', 'instrText', 'pPr', 'rPr'].includes(name)) return;
    if (name === 't') {
      const text = node.textContent.replace(/\r\n?/gu, '\n');
      parts.push({ text, marks: text && (style.color || style.background || style.underline)
        ? [{ ...style, start: 0, end: text.length }] : [] });
      return;
    }
    if (name === 'tab' || name === 'br' || name === 'cr') {
      parts.push({ text: name === 'tab' ? '\t' : '\n' });
      return;
    }
    if (name === 'p') style = { ...style, ...inherited(attr(child(child(node, 'pPr'), 'pStyle'), 'val')) };
    if (name === 'r') {
      const properties = child(node, 'rPr');
      style = { ...style, ...inherited(attr(child(properties, 'rStyle'), 'val')), ...runStyle(properties) };
    }
    for (const item of children(node)) visit(item, style);
    if (name === 'p') parts.push({ text: '\n\n' });
  }
  visit(child(document.documentElement, 'body') ?? document.documentElement);
  return joinMarked(parts);
}
