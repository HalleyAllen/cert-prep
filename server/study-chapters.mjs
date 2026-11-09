import { chapterLabel } from './pdf-structure.mjs';
import { isFrontMatter } from './text-cleanup.mjs';

const normalizedTitle = (title) => title.normalize('NFKC').toLowerCase().replace(/[\s：:、]/gu, '');

function topicKey(chapter) {
  const label = chapterLabel(chapter.title);
  const topic = label?.name ? label.kind + ':' + label.ordinal + ':' + normalizedTitle(label.name) : normalizedTitle(chapter.title);
  return chapter.course_id + ':' + topic;
}

export function selectStudyChapters(chapters) {
  const hasBody = new Set(chapters.filter((chapter) => !isFrontMatter(chapter.title)).map((chapter) => chapter.material_id));
  const candidates = chapters.filter((chapter) => !isFrontMatter(chapter.title) || !hasBody.has(chapter.material_id));
  const textbookTopics = new Set(candidates.filter((chapter) => chapter.material_category === 'textbook').map(topicKey));
  return candidates.filter((chapter) => chapter.material_category !== 'supplement' || !textbookTopics.has(topicKey(chapter)));
}
