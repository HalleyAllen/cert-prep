import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import multer from 'multer';
import { createApi, materialUploadLimitMB } from './api.mjs';
import { seedDemo } from './demo.mjs';
import { createJobs } from './jobs.mjs';
import { createServices, Problem } from './services.mjs';
import { openStore } from './store.mjs';
import { cleanupUpload } from './material-deletion.mjs';

const project = dirname(dirname(fileURLToPath(import.meta.url)));

export function createApp({ root = process.env.CERT_PREP_DATA_DIR || join(project, 'data'), services = createServices(), demo = true } = {}) {
  const dataRoot = resolve(root);
  const store = openStore(dataRoot);
  for (const { file_key: key } of store.all('SELECT file_key FROM deleted_uploads')) cleanupUpload(store, dataRoot, key);
  if (demo) seedDemo(store, dataRoot);
  const jobs = createJobs(store, dataRoot, services);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "frame-ancestors 'none'" });
    if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return next(new Problem(403, '请从本机地址访问备考台。'));
    if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('Origin')) {
      const allowed = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.get('Origin'));
      if (!allowed) return next(new Problem(403, '请求来源不属于本机。'));
    }
    next();
  });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', express.json({ limit: '2mb' }), createApi(store, dataRoot, services, jobs));
  app.use('/api', (_req, _res, next) => next(new Problem(404, '接口不存在。')));
  const dist = join(project, 'dist');
  app.use(express.static(dist));
  app.get('/{*path}', (_req, res) => {
    if (existsSync(join(dist, 'index.html'))) return res.sendFile(join(dist, 'index.html'));
    res.status(503).type('text/plain').send('前端尚未构建。请运行 npm run build，或使用 npm run dev 启动开发环境。');
  });
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof Problem) return res.status(error.status).json({ error: error.message });
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE'
      ? `文件超过 ${materialUploadLimitMB} MB，请拆分后再上传。` : '上传格式无效，每次请选择一个文件。' });
    if (error.status === 400 || error.status === 413) return res.status(error.status).json({ error: '请求格式无效或内容过大。' });
    if (error.status === 404) return res.status(404).json({ error: '找不到原始文件。' });
    console.error(error);
    res.status(500).json({ error: '本机服务暂时无法完成操作，请重试。' });
  });
  return { app, store, jobs };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须在 1–65535 范围内。');
  const { app } = createApp();
  app.listen(port, '127.0.0.1', () => console.log(`备考台已启动 http://127.0.0.1:${port}`));
}
