import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const owner = 'local';
export const now = () => new Date().toISOString();
export const parse = (value) => JSON.parse(value);

export function openStore(root) {
  mkdirSync(join(root, 'uploads'), { recursive: true });
  const db = new DatabaseSync(join(root, 'study.sqlite'));
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS certificates (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
      exam_date TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0,
      plan_settings TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY, certificate_id TEXT NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
      name TEXT NOT NULL, position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      name TEXT NOT NULL, extension TEXT NOT NULL, file_key TEXT NOT NULL,
      extracted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deleted_uploads (file_key TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS units (
      material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, page INTEGER, text TEXT NOT NULL,
      method TEXT NOT NULL, heading TEXT, PRIMARY KEY(material_id, position)
    );
    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      title TEXT NOT NULL, start_unit INTEGER NOT NULL, end_unit INTEGER NOT NULL,
      position INTEGER NOT NULL, study_minutes INTEGER NOT NULL DEFAULT 30,
      practice_minutes INTEGER NOT NULL DEFAULT 10, analysis TEXT, analysis_hash TEXT,
      learned_at TEXT, practiced_at TEXT, visited_at TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, certificate_id TEXT NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, target_id TEXT NOT NULL, input TEXT NOT NULL,
      status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs(kind, target_id)
      WHERE status IN ('queued', 'running');
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, stem TEXT NOT NULL, options TEXT NOT NULL, answer TEXT NOT NULL,
      explanation TEXT NOT NULL, source TEXT NOT NULL, approved INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, certificate_id TEXT NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
      chapter_id TEXT REFERENCES chapters(id) ON DELETE CASCADE,
      mode TEXT NOT NULL, questions TEXT NOT NULL, result TEXT, submitted_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mistakes (
      question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
      wrong_count INTEGER NOT NULL, mastered INTEGER NOT NULL,
      history TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plan_tasks (
      id TEXT PRIMARY KEY, certificate_id TEXT NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
      chapter_id TEXT REFERENCES chapters(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, day TEXT NOT NULL, minutes INTEGER NOT NULL,
      position INTEGER NOT NULL, completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS chapters_course ON chapters(course_id, position);
    CREATE INDEX IF NOT EXISTS questions_chapter ON questions(chapter_id, approved);
    CREATE INDEX IF NOT EXISTS attempts_certificate ON attempts(certificate_id, created_at);
    CREATE INDEX IF NOT EXISTS tasks_certificate ON plan_tasks(certificate_id, day, position);
    CREATE INDEX IF NOT EXISTS jobs_certificate ON jobs(certificate_id, created_at);
  `);
  const store = {
    run: (sql, ...params) => db.prepare(sql).run(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params),
    get: (sql, ...params) => db.prepare(sql).get(...params),
    close: () => db.close(),
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  store.transaction(() => {
    const columns = store.all('PRAGMA table_info(materials)');
    if (!columns.some((column) => column.name === 'category')) {
      store.run("ALTER TABLE materials ADD COLUMN category TEXT NOT NULL DEFAULT 'supplement' CHECK (category IN ('textbook', 'supplement'))");
    }
    if (!store.all('PRAGMA table_info(units)').some((column) => column.name === 'marks')) {
      store.run("ALTER TABLE units ADD COLUMN marks TEXT NOT NULL DEFAULT '[]'");
    }
    if (!store.all('PRAGMA table_info(units)').some((column) => column.name === 'visuals')) {
      store.run("ALTER TABLE units ADD COLUMN visuals TEXT NOT NULL DEFAULT '[]'");
    }
  });
  return store;
}
