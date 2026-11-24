import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {zipSync} from 'fflate';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {defineConfig, type Plugin} from 'vite';

// `__dirname` is not defined when Vite loads this config with the native ESM
// loader, so derive the project root from import.meta.url instead.
const rootDir = path.dirname(fileURLToPath(import.meta.url));

function windowsProjectArchive(): Plugin {
  const archivePath = 'windows-c-project/source.zip';
  const projectDir = path.join(rootDir, 'public/windows-c-project');
  const files = [
    'scheduler.h', 'scheduler.c', 'monitor.h', 'monitor.c',
    'server.c', 'dashboard.html', 'build.bat', 'README.md',
  ];
  const buildArchive = () => {
    const entries = Object.fromEntries(files.map((name) => [name, fs.readFileSync(path.join(projectDir, name))]));
    return zipSync(entries, {mtime: new Date(1980, 0, 1)});
  };

  return {
    name: 'windows-project-archive',
    generateBundle() {
      this.emitFile({type: 'asset', fileName: archivePath, source: buildArchive()});
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `/${archivePath}` || (req.method !== 'GET' && req.method !== 'HEAD')) {
          return next();
        }
        const zip = buildArchive();
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Length', zip.length);
        res.end(req.method === 'HEAD' ? undefined : zip);
      });
    },
  };
}

export default defineConfig(() => {
  return {
    // Vercel serves production builds from the domain root.
    base: '/',
    plugins: [
      react(),
      tailwindcss(),
      windowsProjectArchive(),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(rootDir, 'dist');
          const srcAssets = path.resolve(rootDir, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': rootDir,
      },
    },
    // Accept proxied/tunneled hostnames (e.g. *.e2b.app previews) so the dev
    // and preview servers don't answer with "Blocked request".
    preview: {
      allowedHosts: true as const,
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      allowedHosts: true as const,
    },
  };
});
