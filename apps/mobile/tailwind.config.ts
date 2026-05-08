import type { Config } from 'tailwindcss';

// Reusamos el design system del admin desktop — mismos colores Santa Teresita
// (verde + cremoso) para consistencia visual entre desktop y mobile.
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        teresita: {
          50: '#f0f7f2',
          100: '#dceae0',
          300: '#6fa086',
          500: '#2e7053',
          700: '#1f4d3c',
          900: '#0f2d22',
        },
        cream: {
          50: '#fdfbf7',
          100: '#faf6ee',
          200: '#f0e9dc',
          300: '#e2ddd0',
        },
        ink: {
          900: '#0f0f0e',
          700: '#2a2a28',
          500: '#5c5c58',
          300: '#9c9a93',
        },
        pomodoro: { 600: '#b91c1c', 100: '#fee2e2' },
        basil: { 600: '#15803d', 100: '#dcfce7' },
        saffron: { 600: '#c2410c', 100: '#ffedd5' },
      },
      fontFamily: {
        display: ['"Fraunces"', 'serif'],
        body: ['"Inter"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
