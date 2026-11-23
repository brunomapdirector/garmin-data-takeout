import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

// The commit a build comes from, shown in every page's footer so anyone can check
// which code is running. 'dev' when git is unavailable.
function commit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

// Public GitHub URL for "View the code" links; links are hidden while it is empty.
// Set it when building: GARMIN_TAKEOUT_REPO=https://github.com/<you>/garmin-data-takeout
const repoUrl = (process.env.GARMIN_TAKEOUT_REPO ?? '').replace(/\/$/, '');

// One dev server for both the static site and the Worker relay (same origin).
export default defineConfig({
  plugins: [cloudflare()],
  define: {
    __COMMIT__: JSON.stringify(commit()),
    __REPO_URL__: JSON.stringify(repoUrl),
  },
  // The pages belong to the browser build only (the Worker build has its own entry).
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            home: resolve(import.meta.dirname, 'index.html'),
            export: resolve(import.meta.dirname, 'export.html'),
          },
        },
      },
    },
  },
});
