import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'wxt';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { permissionLists } from './src/ui/manifest-permissions';
import { brand } from './src/brand';
import { legacyCss } from './src/compat/legacy-css';

// The autorun build (fixtures/autorun.mjs) keeps the optional permissions required, unless it is asked to build with the
// product's lists (WXT_PRODUCT_PERMISSIONS), to check the features without them.
const autorun = !!process.env.WXT_AUTORUN_URL;
const productPermissions = !autorun || !!process.env.WXT_PRODUCT_PERMISSIONS;
const legacy = process.env.WXT_LEGACY === '1' || process.argv.includes('--mv2');

export default defineConfig({
  imports: false,
  // Unattended development builds (fixtures/autorun.mjs) go elsewhere, so dist/ stays a normal build.
  manifestVersion: legacy ? 2 : 3,
  outDir: !autorun
    ? legacy
      ? 'dist-mv2'
      : 'dist'
    : legacy
      ? productPermissions
        ? '.output/autorun-mv2-product'
        : '.output/autorun-mv2'
      : productPermissions
        ? '.output/autorun-product'
        : '.output/autorun',
  outDirTemplate: '',
  alias: {
    '@src': 'src',
  },
  manifest: {
    // The name, description and the strings Chrome shows itself follow Chrome's language (public/_locales).
    name: brand.name,
    description: brand.description,
    default_locale: 'en',
    minimum_chrome_version: legacy ? '80' : '125',
    ...(!legacy ? { host_permissions: ['<all_urls>'] } : {}),
    ...permissionLists(productPermissions ? 'product' : 'autorun', legacy),
    ...(legacy
      ? { browser_action: { default_icon: brand.toolbarIcon, default_title: brand.name } }
      : { action: { default_icon: brand.toolbarIcon, default_title: brand.name } }),
    icons: { 32: brand.toolbarIcon, 128: brand.icon },
    commands: {
      'open-panel': { suggested_key: { default: 'Alt+Shift+N' }, description: `打开 ${brand.name}` },
      'open-test-panel': { description: 'Open the browser control test panel (developers)' },
    },
  },
  // `pnpm zip` packs dist/ into dist-zip/, outside the folder Chrome loads.
  zip: {
    artifactTemplate: `../dist-zip/internal-browser-assistant-{{version}}-${legacy ? 'mv2' : 'mv3'}.zip`,
    exclude: ['**/*.map'],
  },
  hooks: {
    'build:publicAssets': async (_wxt, files) => {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        if (!/^_locales\/[\w-]+\/messages\.json$/.test(file.relativeDest.replace(/\\/g, '/'))) continue;
        const source = 'absoluteSrc' in file ? await readFile(file.absoluteSrc, 'utf8') : String(file.contents);
        const messages = JSON.parse(source) as Record<string, { message: string }>;
        for (const entry of Object.values(messages)) entry.message = entry.message.replace(/Nanobrowser/g, brand.name);
        messages.extName.message = brand.name;
        messages.extDescription.message = brand.description;
        files[index] = { relativeDest: file.relativeDest, contents: JSON.stringify(messages, null, 2) };
      }
    },
    'zip:extension:start': () => mkdir('dist-zip', { recursive: true }).then(() => {}),
    'config:resolved': wxt => {
      // WXT 0.21.4 still installs Unimport's Vite plugin with imports: false; clear its presets.
      wxt.config.imports.presets = [];
      wxt.config.imports.imports = [];
    },
    'build:manifestGenerated': (_wxt, manifest) => {
      if (manifest.background) {
        if (legacy) {
          delete (manifest.background as { type?: string }).type;
          (manifest.background as { persistent?: boolean }).persistent = true;
        } else (manifest.background as { type?: string }).type = 'module';
      }
      // No panel by default: the worker enables it per tab with a path.
      delete (manifest as { side_panel?: unknown }).side_panel;
    },
  },
  vite: env => ({
    plugins: [
      react(),
      {
        name: 'product-branding',
        transformIndexHtml: html =>
          html.replace(/Nanobrowser/g, brand.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')),
      },
    ],
    resolve: {
      alias: {
        // puppeteer-core 25 imports @puppeteer/browsers for the `channel` option, which is never used here.
        '@puppeteer/browsers': resolve(import.meta.dirname, 'src/browser-control/host/puppeteer-browsers-stub.ts'),
      },
      conditions: ['browser', 'module', 'import', 'default'],
      mainFields: ['browser', 'module', 'main'],
    },
    css: {
      postcss: {
        plugins: [
          tailwindcss({ config: resolve(import.meta.dirname, 'tailwind.config.ts') }),
          ...(legacy ? [legacyCss()] : []),
          autoprefixer(),
        ],
      },
    },
    build: {
      target: legacy ? 'chrome80' : 'chrome125',
      sourcemap: env.mode === 'development',
      minify: env.mode === 'production',
    },
  }),
});
