import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

// One dev server for both the static site and the Worker relay (same origin).
export default defineConfig({
  plugins: [cloudflare()],
});
