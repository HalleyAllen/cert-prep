import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'PORT');
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      proxy: { '/api': `http://127.0.0.1:${process.env.PORT || env.PORT || '4173'}` },
    },
  };
});
