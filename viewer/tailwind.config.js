/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'bg-main': '#0d1117',
        'bg-panel': '#161b22',
        'bg-accent': '#1c2333',
        phosphor: '#39ff14',
        'phosphor-dim': '#1a7a0a',
        'text-main': '#c9d1d9',
        'text-dim': '#8b949e',
        verified: '#4CAF50',
        warning: '#FFC107',
        error: '#F44336',
        selected: '#2196F3',
        'net-active': '#FF9800',
      },
      fontFamily: {
        mono: ['"IBM Plex Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
};
