export type Job = { id: string; kind: 'import' | 'analyze' | 'generate'; target_id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; progress: number; message: string };
export type Kind = 'study' | 'practice' | 'review';
export type Task = { id: string; kind: Kind; day: string; minutes: number; chapter_id: string | null; title: string | null; completed_at: string | null };
export type Plan = { weekdays: number[]; minutes: number; generatedOn: string; studyDays: number; reviewDays: number; unscheduled: { chapterId: string; title: string; kind: Kind; minutes: number }[] };
export type Cert = { id: string; name: string; examDate: string; demo: boolean; plan: Plan | null };
export type Workspace = { certificates: Cert[]; today: string; aiReady: boolean; searchReady: boolean };
export type Course = { id: string; name: string };
export type MaterialCategory = 'textbook' | 'supplement';
export const materialLabels = { textbook: '原课本', supplement: '补充资料' };
export type Material = { id: string; category: MaterialCategory; name: string; extension: string; course_id: string; extracted: number; unit_count: number; job_id: string | null };
export type TextMark = { start: number; end: number; color?: string; background?: string; underline?: boolean };
export type UnitVisual = { kind: 'figure' | 'formula' | 'table'; anchor: string };
export type Unit = { position: number; page: number | null; text: string; method: 'ocr' | 'text'; marks?: TextMark[]; visuals?: UnitVisual[] };
export type MaterialDetail = Material & { units: Unit[]; job: Job | null };
export type Chapter = { id: string; title: string; material_id: string; material_name: string; material_category: MaterialCategory; course_id: string; start_unit: number;
  end_unit: number; study_minutes: number; practice_minutes: number; question_count: number; learned_at: string | null;
  practiced_at: string | null; visited_at: string | null };
export type Point = { kind: 'key' | 'focus' | 'confusion'; title: string; explanation: string; units: number[] };
export type ChapterDetail = Chapter & { extension: string; unit_count: number; unit_min: number | null; unit_max: number | null; units: Unit[]; drafts: Draft[];
  analysis: { generatedAt: string; sections: { summary: string; points: Point[] }[] } | null };
export type QuestionKind = 'single' | 'multiple' | 'boolean';
export type Source = { type: 'demo' | 'ai' | 'web' | 'official'; url?: string; title?: string };
export type Question = { id: string; kind: QuestionKind; stem: string; options: string[]; source: Source };
export type QuestionData = Pick<Question, 'kind' | 'stem' | 'options'> & { answer: number[]; explanation: string };
export type Draft = Question & QuestionData;
export type SearchResult = { title: string; url: string; snippet: string };
export type Answer = Draft & { choice: number[]; correct: boolean };
export type Grade = { correctCount: number; total: number; results: Answer[]; at: string };
export type Attempt = { id: string; mode: 'chapter' | 'mistake'; chapterId: string | null; questions: Question[]; result: Grade | null };
export type Mistake = Draft & { chapter_id: string; chapter_title: string; course_name: string; course_id: string;
  wrong_count: number; mastered: number; updated_at: string;
  history: { at: string; choice: number[]; answer: number[]; correct: boolean; mode: Attempt['mode'] }[] };
export type Snapshot = { certificate: Cert; today: string; courses: Course[]; chapters: Chapter[]; study_chapter_ids: string[]; materials: Material[];
  jobs: Job[]; tasks: Task[]; mistakes: { total: number; pending: number } };
export type Screen = 'home' | 'materials' | 'chapters' | 'search' | 'mistakes' | 'plan' | 'material' | 'chapter' | 'quiz';
export type Navigate = (screen: Screen, id?: string) => void;
export type Context = { data: Snapshot; base: string; go: Navigate; refresh: () => Promise<void>; notify: (message: string) => void;
  aiReady: boolean; searchReady: boolean };

export const kindLabel = { study: '章节学习', practice: '章节练习', review: '考前复习' };
export const questionLabel = { single: '单选题', multiple: '多选题', boolean: '判断题' };
export const sourceLabel = { ai: 'AI 生成', official: '官方公开题', web: '网络来源', demo: '示例题' };
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
export const displayDay = (day: string, year = false) => new Date(`${day}T12:00:00`).toLocaleDateString('zh-CN', {
  month: 'long', day: 'numeric', ...(year ? { year: 'numeric' } : { weekday: 'long' }),
});
export function studyChapters(data: Snapshot) {
  const ids = new Set(data.study_chapter_ids);
  return data.chapters.filter((chapter) => ids.has(chapter.id));
}

export const isActive = (job?: Job | null) => job?.status === 'running' || job?.status === 'queued';
export const unitLabel = (unit: Unit) => unit.page ? `第 ${unit.page} 页 · 片段 ${unit.position}` : `原文片段 ${unit.position}`;
export const fileURL = (base: string, id: string, page?: number | null) => `${base}/materials/${id}/file${page ? `#page=${page}` : ''}`;
export const choiceText = (question: Pick<Question, 'options'>, indexes: number[]) => indexes.map((index) => question.options[index]).join('、');

export async function api<T = { ok: boolean }>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const form = body instanceof FormData;
  const response = await fetch(path, {
    method,
    signal,
    headers: body === undefined || form ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) throw new Error(data?.error || `本机服务暂时无法响应（${response.status}）。`);
  return data as T;
}
