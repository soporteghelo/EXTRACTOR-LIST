import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv, type Plugin} from 'vite';
import geminiHandler from './api/gemini';

// En local no hay Vercel: se monta la misma función de /api/gemini como middleware
// del servidor de desarrollo, para que la app se comporte igual en ambos sitios.
function apiGeminiLocal(): Plugin {
  return {
    name: 'api-gemini-local',
    configureServer(server) {
      server.middlewares.use('/api/gemini', (req, res, next) => {
        geminiHandler(req, res).catch(next);
      });
    },
  };
}

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  // La clave se pasa al proceso del servidor, nunca al bundle: Vite solo expone al
  // navegador las variables VITE_*, y GEMINI_API_KEY no lo es.
  if (env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY) {
    process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;
  }
  return {
    plugins: [react(), tailwindcss(), apiGeminiLocal()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
