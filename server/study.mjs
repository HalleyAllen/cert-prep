import { randomUUID } from 'node:crypto';
import { now, parse } from './store.mjs';
import { Problem } from './services.mjs';

export const questionView = (row) => ({ ...row, options: parse(row.options), answer: parse(row.answer), source: parse(row.source) });
export const withoutAnswer = ({ id, stem, kind, options, source }) => ({ id, stem, kind, options, source });

export function insertQuestion(store, chapterId, data, source, approved) {
  const id = randomUUID();
  store.run(`INSERT INTO questions (id, chapter_id, kind, stem, options, answer, explanation, source, approved, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, chapterId, data.kind, data.stem, JSON.stringify(data.options),
  JSON.stringify(data.answer), data.explanation, JSON.stringify(source), approved ? 1 : 0, now());
  return id;
}

export function chapterUnits(store, chapter, withMarks = false) {
  const rows = store.all(`SELECT position, page, text, method${withMarks ? ', marks, visuals' : ''} FROM units WHERE material_id=? AND position BETWEEN ? AND ?
    ORDER BY position`, chapter.material_id, chapter.start_unit, chapter.end_unit);
  return withMarks ? rows.map((row) => ({ ...row, marks: parse(row.marks), visuals: parse(row.visuals) })) : rows;
}

export function completeKind(store, certId, chapterId, kind, at) {
  store.run(`UPDATE plan_tasks SET completed_at=? WHERE certificate_id=? AND chapter_id=? AND kind=? AND completed_at IS NULL`,
    at, certId, chapterId, kind);
}

export function openAttempt(store, cert, chapter, mode, questionIds = []) {
  const questions = mode === 'chapter'
    ? store.all('SELECT * FROM questions WHERE chapter_id=? AND approved=1 ORDER BY created_at, id', chapter.id)
    : store.all(`SELECT q.* FROM mistakes m JOIN questions q ON q.id=m.question_id
        JOIN chapters ch ON ch.id=q.chapter_id JOIN courses co ON co.id=ch.course_id
        WHERE co.certificate_id=? AND q.approved=1 ORDER BY m.updated_at DESC`, cert.id)
      .filter((question) => questionIds.includes(question.id));
  if (!questions.length) throw new Problem(422, mode === 'chapter' ? '本章还没有可练习的题目。' : '请先选择要重练的错题。');
  if (mode === 'mistake' && questions.length !== questionIds.length) throw new Problem(400, '部分题目不属于当前错题本。');
  const id = randomUUID();
  const snapshot = questions.map(questionView);
  store.run(`INSERT INTO attempts(id, certificate_id, chapter_id, mode, questions, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id, cert.id, chapter?.id || null, mode, JSON.stringify(snapshot), now());
  return { id, mode, questions: snapshot.map(withoutAnswer) };
}

export function submitAttempt(store, certId, attemptId, answers) {
  return store.transaction(() => {
    const attempt = store.get('SELECT * FROM attempts WHERE id=? AND certificate_id=?', attemptId, certId);
    if (!attempt) throw new Problem(404, '练习记录不存在。');
    if (attempt.result) return parse(attempt.result);
    const questions = parse(attempt.questions);
    if (Object.keys(answers).length !== questions.length) throw new Problem(400, '请回答所有题目再提交。');
    const results = questions.map((question) => {
      const choice = answers[question.id];
      if (!choice?.length || new Set(choice).size !== choice.length || choice.some((index) => index >= question.options.length)
          || (question.kind !== 'multiple' && choice.length !== 1)) throw new Problem(400, '提交的答案有误，请检查题目选项。');
      const correct = choice.length === question.answer.length && choice.every((index) => question.answer.includes(index));
      return { ...withoutAnswer(question), choice, answer: question.answer, correct, explanation: question.explanation };
    });
    const at = now();
    for (const result of results) {
      const previous = store.get('SELECT * FROM mistakes WHERE question_id=?', result.id);
      if (result.correct && !previous) continue;
      const history = previous ? parse(previous.history) : [];
      history.push({ at, choice: result.choice, answer: result.answer, correct: result.correct, mode: attempt.mode });
      const wrongCount = (previous?.wrong_count || 0) + (result.correct ? 0 : 1);
      const mastered = result.correct ? (attempt.mode === 'mistake' ? 1 : previous.mastered) : 0;
      store.run(`INSERT INTO mistakes(question_id, wrong_count, mastered, history, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(question_id) DO UPDATE SET wrong_count=excluded.wrong_count, mastered=excluded.mastered,
        history=excluded.history, updated_at=excluded.updated_at`, result.id, wrongCount, mastered, JSON.stringify(history), at);
    }
    if (attempt.mode === 'chapter') {
      store.run('UPDATE chapters SET practiced_at=COALESCE(practiced_at, ?), visited_at=? WHERE id=?', at, at, attempt.chapter_id);
      completeKind(store, certId, attempt.chapter_id, 'practice', at);
    }
    const result = { correctCount: results.filter((answer) => answer.correct).length, total: results.length, results, at };
    store.run('UPDATE attempts SET result=?, submitted_at=? WHERE id=?', JSON.stringify(result), at, attempt.id);
    return result;
  });
}
