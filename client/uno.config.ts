import { defineConfig, presetUno } from 'unocss';

export default defineConfig({
  presets: [presetUno()],
  theme: {
    colors: {
      ink: '#17211f',
      mist: '#f7faf9',
      line: '#d8e4df',
      teal: '#0f766e',
      coral: '#dc6b4f',
      amber: '#c98a18'
    }
  },
  shortcuts: {
    panel: 'bg-white border border-line rounded-lg shadow-sm',
    tap: 'min-h-11 rounded-md transition active:scale-[0.99] focus:outline-none focus:ring-2 focus:ring-teal/25',
    label: 'text-xs font-600 uppercase tracking-wide text-ink/55'
  }
});
