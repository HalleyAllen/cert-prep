import { useLayoutEffect, type RefObject } from 'react';

export function readReadingProgress(key: string) {
  try { return localStorage.getItem('cert-prep:reading:' + key) ?? ''; }
  catch { return ''; }
}

export function writeReadingProgress(key: string, value: string) {
  try { localStorage.setItem('cert-prep:reading:' + key, value); }
  catch { /* Reading remains available when browser storage is disabled. */ }
}

type Position = { scroll: number; block?: string; top?: number };

function readPosition(key: string): Position | undefined {
  try {
    const value = JSON.parse(readReadingProgress(key));
    if (Number.isFinite(value?.scroll) && value.scroll >= 0) return value;
  } catch { /* Ignore obsolete or unreadable positions. */ }
}

function capturePosition(reader: HTMLElement): Position {
  const scroll = window.scrollY;
  const readingLine = 96;
  const blocks = reader.children;
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (blocks[middle].getBoundingClientRect().bottom < readingLine) low = middle + 1;
    else high = middle;
  }
  const block = blocks[low] as HTMLElement | undefined;
  const top = block?.getBoundingClientRect().top;
  return block?.dataset.readingBlock && top !== undefined && top <= readingLine
    ? { scroll, block: block.dataset.readingBlock, top }
    : { scroll };
}

export function useReadingPosition(body: RefObject<HTMLDivElement | null>, key: string, certificate: string) {
  useLayoutEffect(() => {
    const reader = body.current;
    if (!reader) return;
    const hash = location.hash;
    const saved = readPosition(key);
    const anchor = saved?.block && Array.from(reader.children).find((child) =>
      (child as HTMLElement).dataset.readingBlock === saved.block);
    const restore = () => {
      if (!saved || location.hash !== hash) return;
      const scroll = anchor && typeof saved.top === 'number' && Number.isFinite(saved.top)
        ? window.scrollY + anchor.getBoundingClientRect().top - saved.top
        : saved.scroll;
      window.scrollTo({ top: scroll, behavior: 'instant' });
    };
    restore();
    writeReadingProgress(certificate + '/last-page', hash);

    let pending: Position | undefined;
    let timer = 0;
    const flush = () => {
      window.clearTimeout(timer);
      timer = 0;
      if (pending) writeReadingProgress(key, JSON.stringify(pending));
      pending = undefined;
    };
    const onScroll = () => {
      if (location.hash !== hash || !reader.isConnected) return;
      pending = capturePosition(reader);
      if (!timer) timer = window.setTimeout(flush, 150);
    };
    const onPageHide = () => { onScroll(); flush(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', onPageHide);

    const observer = saved && new ResizeObserver(restore);
    observer?.observe(reader);
    const stopRestoring = () => observer?.disconnect();
    const stopTimer = window.setTimeout(stopRestoring, 1500);
    const interactions = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    for (const event of interactions) window.addEventListener(event, stopRestoring, { capture: true, passive: true });
    return () => {
      flush();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', onPageHide);
      window.clearTimeout(stopTimer);
      stopRestoring();
      for (const event of interactions) window.removeEventListener(event, stopRestoring, true);
    };
  }, [body, key, certificate]);
}
