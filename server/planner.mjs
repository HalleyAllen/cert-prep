import { randomUUID } from 'node:crypto';
import { now } from './store.mjs';

export function localDay(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function shiftDay(day, amount) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function validDay(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && shiftDay(day, 0) === day;
}

export function schedule({ today, examDate, settings, chapters, completed }) {
  const tasks = [];
  const unscheduled = [];
  const days = [];
  const minutesDone = new Map();
  const dayMinutes = new Map();
  for (const task of completed) {
    const key = `${task.chapter_id}:${task.kind}`;
    minutesDone.set(key, (minutesDone.get(key) || 0) + task.minutes);
    const completionDay = task.completed_at ? localDay(new Date(task.completed_at)) : task.day;
    dayMinutes.set(completionDay, (dayMinutes.get(completionDay) || 0) + task.minutes);
  }
  for (let day = today; day < examDate; day = shiftDay(day, 1)) {
    if (settings.weekdays.includes(new Date(`${day}T12:00:00Z`).getUTCDay())) {
      days.push({ day, remaining: Math.max(0, settings.minutes - (dayMinutes.get(day) || 0)) });
    }
  }
  const reviewCount = days.length >= 2 ? Math.min(days.length - 1, Math.ceil(days.length * 0.2)) : 0;
  const studyDays = days.slice(0, days.length - reviewCount);
  let cursor = 0;
  const add = (day, chapterId, kind, minutes) => {
    tasks.push({ day: day.day, chapterId, kind, minutes });
    day.remaining -= minutes;
  };
  for (const chapter of chapters) {
    for (const [kind, total, finished] of [
      ['study', chapter.study_minutes, chapter.learned_at],
      ['practice', chapter.practice_minutes, chapter.practiced_at],
    ]) {
      if (finished) continue;
      let remaining = Math.max(0, total - (minutesDone.get(`${chapter.id}:${kind}`) || 0));
      while (remaining && cursor < studyDays.length) {
        const day = studyDays[cursor];
        if (day.remaining === 0) {
          cursor += 1;
          continue;
        }
        const minutes = Math.min(day.remaining, remaining);
        add(day, chapter.id, kind, minutes);
        remaining -= minutes;
      }
      if (remaining) unscheduled.push({ chapterId: chapter.id, title: chapter.title, kind, minutes: remaining });
    }
  }
  if (chapters.length && reviewCount) {
    for (const day of days.slice(-reviewCount)) {
      if (day.remaining) add(day, null, 'review', day.remaining);
    }
  }
  return { tasks, unscheduled, studyDays: days.length, reviewDays: reviewCount };
}

export function saveSchedule(store, cert, settings, today) {
  const chapters = store.all(`SELECT ch.* FROM chapters ch JOIN courses co ON co.id=ch.course_id
    JOIN materials ma ON ma.id=ch.material_id WHERE co.certificate_id=?
    ORDER BY co.position, ma.created_at, ma.id, ch.start_unit, ch.position`, cert.id);
  const completed = store.all('SELECT * FROM plan_tasks WHERE certificate_id=? AND completed_at IS NOT NULL', cert.id);
  const result = schedule({ today, examDate: cert.exam_date, settings, chapters, completed });
  store.run('UPDATE certificates SET plan_settings=?, updated_at=? WHERE id=?',
    JSON.stringify({ ...settings, unscheduled: result.unscheduled, studyDays: result.studyDays,
      reviewDays: result.reviewDays, generatedOn: today }), now(), cert.id);
  store.run('DELETE FROM plan_tasks WHERE certificate_id=? AND completed_at IS NULL', cert.id);
  result.tasks.forEach((task, index) => store.run(`INSERT INTO plan_tasks
    (id, certificate_id, chapter_id, kind, day, minutes, position) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  randomUUID(), cert.id, task.chapterId, task.kind, task.day, task.minutes, index));
}
