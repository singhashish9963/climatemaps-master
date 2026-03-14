/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{html,ts}',
  ],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#6366f1',
          light: '#eef2ff',
          hover: '#4f46e5',
          2: '#06b6d4',
        },
        surface: {
          base: '#ffffff',
          muted: '#f8fafc',
          elevated: '#f1f5f9',
        },
        border: {
          subtle: '#e2e8f0',
          DEFAULT: '#cbd5e1',
          strong: '#94a3b8',
        },
        content: {
          primary: '#0f172a',
          secondary: '#475569',
          muted: '#94a3b8',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Geist Mono', 'monospace'],
      },
      boxShadow: {
        sm: '0 1px 2px rgba(0,0,0,0.05)',
        md: '0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.05)',
        lg: '0 10px 15px -3px rgba(0,0,0,0.08), 0 4px 6px rgba(0,0,0,0.05)',
        focus: '0 0 0 3px rgba(99,102,241,0.15)',
      },
      borderRadius: {
        sm: '6px',
        md: '8px',
        lg: '12px',
        xl: '16px',
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  },
}


