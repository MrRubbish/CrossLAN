import { defineConfig, presetUno } from 'unocss';

export default defineConfig({
  presets: [presetUno()],
  theme: {
    colors: {
      ink: 'rgb(var(--color-ink) / <alpha-value>)',
      mist: 'rgb(var(--color-mist) / <alpha-value>)',
      panel: 'rgb(var(--color-panel) / <alpha-value>)',
      line: 'rgb(var(--color-line) / <alpha-value>)',
      teal: 'rgb(var(--color-teal) / <alpha-value>)',
      coral: 'rgb(var(--color-coral) / <alpha-value>)',
      amber: 'rgb(var(--color-amber) / <alpha-value>)'
    }
  },
  shortcuts: {
    panel: 'bg-panel border border-line rounded-lg shadow-sm',
    tap: 'min-h-11 rounded-md transition active:scale-[0.99] focus:outline-none focus:ring-2 focus:ring-teal/25',
    label: 'text-xs font-600 uppercase tracking-wide text-ink/55'
  }
});
