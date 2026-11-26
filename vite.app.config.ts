import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { velaUiSource } from './scripts/vela-ui-source.mjs';

/**
 * The ChartLab app (app/): the workspace as a standalone page, imported straight from src/
 * (no library build), so a host only needs `npm ci --ignore-scripts && npm run build:app`.
 */

/** Apache-2.0 §4(d) and the NOTICE require both files to travel with a redistribution. Emitted at
 *  build time so they are never duplicated in git. */
function emitNotices(): Plugin {
    return {
        name: 'chartlab-notices',
        generateBundle() {
            for (const name of ['LICENSE', 'NOTICE']) {
                this.emitFile({ type: 'asset', fileName: name, source: readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url))) });
            }
        },
    };
}

export default defineConfig({
    root: 'app',
    server: { port: 5192, strictPort: true },
    plugins: [velaUiSource(), emitNotices()],
    build: { outDir: 'dist', emptyOutDir: true },
});
