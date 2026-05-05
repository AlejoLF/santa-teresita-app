import type { Config } from 'tailwindcss';

/**
 * Design tokens de Santa Teresita Pastas.
 * Mapean a CSS variables (definidas en globals.css) para soportar dark mode futuro.
 * SPEC §7.2.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Marca
        teresita: {
          50: 'var(--green-teresita-50)',
          100: 'var(--green-teresita-100)',
          300: 'var(--green-teresita-300)',
          500: 'var(--green-teresita-500)',
          700: 'var(--green-teresita-700)',
          900: 'var(--green-teresita-900)',
        },
        cream: {
          50: 'var(--cream-50)',
          100: 'var(--cream-100)',
          200: 'var(--cream-200)',
          300: 'var(--cream-300)',
        },
        ink: {
          900: 'var(--ink-900)',
          700: 'var(--ink-700)',
          500: 'var(--ink-500)',
          300: 'var(--ink-300)',
        },
        pomodoro: {
          100: 'var(--pomodoro-100)',
          600: 'var(--pomodoro-600)',
        },
        basil: {
          100: 'var(--basil-100)',
          600: 'var(--basil-600)',
        },
        saffron: {
          100: 'var(--saffron-100)',
          600: 'var(--saffron-600)',
        },
        ocean: {
          100: 'var(--ocean-100)',
          600: 'var(--ocean-600)',
        },
        // Alias semánticos
        surface: {
          app: 'var(--surface-app)',
          'app-vendedor': 'var(--surface-app-vendedor)',
          card: 'var(--surface-card)',
          elevated: 'var(--surface-elevated)',
          sunken: 'var(--surface-sunken)',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'serif'],
        body: ['var(--font-body)', 'sans-serif'],
        mono: ['var(--font-mono)', 'monospace'],
      },
      fontSize: {
        // Subido (antes 11px / 12px) — la encargada se quejaba de que cuesta leer.
        '2xs': ['12px', '17px'],
        xs: ['13px', '19px'],
        sm: ['15px', '21px'],
        base: ['16px', '24px'],
        md: ['18px', '26px'],
        lg: ['22px', '30px'],
        xl: ['28px', '36px'],
        '2xl': ['36px', '44px'],
        '3xl': ['48px', '56px'],
        '4xl': ['60px', '68px'],
      },
      spacing: {
        '4.5': '18px',
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        '2xl': '24px',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        modal: 'var(--shadow-modal)',
        focus: 'var(--shadow-focus-ring)',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
        spring: 'var(--ease-spring)',
      },
      transitionDuration: {
        instant: '80ms',
        fast: '150ms',
        base: '250ms',
        slow: '400ms',
      },
    },
  },
  plugins: [],
};

export default config;
