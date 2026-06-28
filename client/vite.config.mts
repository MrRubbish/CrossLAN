import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import UnoCSS from 'unocss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    vue(),
    UnoCSS(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'service-worker.ts',
      manifest: {
        name: 'CrossLAN',
        short_name: 'CrossLAN',
        description: 'LAN WebRTC file transfer',
        theme_color: '#0f766e',
        background_color: '#f7faf9',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        share_target: {
          action: '/',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [
              {
                name: 'files',
                accept: ['*/*']
              }
            ]
          }
        },
        icons: [
          {
            src: '/pwa.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable'
          }
        ]
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024
      },
      devOptions: {
        enabled: true,
        type: 'module'
      }
    })
  ],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true
      },
      '/api': 'http://localhost:8080'
    }
  }
});
