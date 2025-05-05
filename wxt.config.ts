import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  manifest: {
    permissions: ["activeTab", "tabs", "<all_urls>"],
  },
  modules: ['@wxt-dev/module-svelte'],
  entrypointsDir: "entrypoints",
});
