import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Problem } from './services.mjs';
import { parse } from './store.mjs';

export function cleanupUpload(store, root, key) {
  if (!/^[a-z0-9_-][a-z0-9._-]*$/iu.test(key)) return false;
  try {
    unlinkSync(join(root, 'uploads', key));
  } catch (error) {
    if (error.code !== 'ENOENT') return false;
  }
  store.run('DELETE FROM deleted_uploads WHERE file_key=?', key);
  return true;
}

function removeDeletedQuestions(store, certificateId, materialId) {
  const ids = new Set(store.all(`SELECT q.id FROM questions q JOIN chapters ch ON ch.id=q.chapter_id
    WHERE ch.material_id=?`, materialId).map(({ id }) => id));
  if (!ids.size) return;
  const attempts = store.all("SELECT id, questions, result FROM attempts WHERE certificate_id=? AND mode='mistake'", certificateId);
  for (const attempt of attempts) {
    const original = parse(attempt.questions);
    const questions = original.filter((question) => !ids.has(question.id));
    if (questions.length === original.length) continue;
    if (questions.length === 0) {
      store.run('DELETE FROM attempts WHERE id=?', attempt.id);
      continue;
    }
    const result = attempt.result ? parse(attempt.result) : null;
    if (result) {
      result.results = result.results.filter((answer) => !ids.has(answer.id));
      result.total = result.results.length;
      result.correctCount = result.results.filter((answer) => answer.correct).length;
    }
    store.run('UPDATE attempts SET questions=?, result=? WHERE id=?', JSON.stringify(questions),
      result ? JSON.stringify(result) : null, attempt.id);
  }
}

export function deleteMaterial(store, root, certificate, material) {
  store.transaction(() => {
    const relatedJobs = `certificate_id=? AND ((kind='import' AND target_id=?)
      OR (kind IN ('analyze','generate') AND target_id IN (SELECT id FROM chapters WHERE material_id=?)))`;
    const params = [certificate.id, material.id, material.id];
    const busy = store.get(`SELECT kind FROM jobs WHERE ${relatedJobs} AND status IN ('queued','running') LIMIT 1`, ...params);
    if (busy) throw new Problem(409, busy.kind === 'import'
      ? '请先取消这份资料的导入，再删除。'
      : '这份资料的章节正在等待分析或出题，请等任务结束后再删除。');

    removeDeletedQuestions(store, certificate.id, material.id);
    if (certificate.plan_settings) {
      const plan = parse(certificate.plan_settings);
      const chapterIds = new Set(store.all('SELECT id FROM chapters WHERE material_id=?', material.id).map(({ id }) => id));
      const unscheduled = plan.unscheduled?.filter((task) => !chapterIds.has(task.chapterId));
      if (unscheduled && unscheduled.length !== plan.unscheduled.length) {
        store.run('UPDATE certificates SET plan_settings=? WHERE id=?',
          JSON.stringify({ ...plan, unscheduled }), certificate.id);
      }
    }
    store.run(`DELETE FROM jobs WHERE ${relatedJobs}`, ...params);
    store.run('DELETE FROM materials WHERE id=?', material.id);
    store.run('INSERT OR IGNORE INTO deleted_uploads(file_key) VALUES (?)', material.file_key);
  });
  return { ok: true, fileCleanupPending: !cleanupUpload(store, root, material.file_key) };
}
