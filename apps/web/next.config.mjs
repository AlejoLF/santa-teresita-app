/** @type {import('next').NextConfig} */
const nextConfig = {
  // Para el bundle desktop necesitamos el output standalone (Next sirve solo).
  // En Vercel demo lo dejamos `undefined`.
  output: process.env.STA_BUILD_TARGET === 'desktop' ? 'standalone' : undefined,
  reactStrictMode: true,
  transpilePackages: ['@sta/shared'],
  experimental: {
    typedRoutes: false,
  },
  // TS errors ya resueltos en Sprint 3 (S3.6). Si vuelven a aparecer, el build
  // falla — eso es lo que queremos para detectarlos antes de empacar.
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    // ESLint sigue ignorado en build porque no hemos configurado reglas custom
    // todavía. Cuando se agregue (Sprint 4 con e2e), revertir a false.
    ignoreDuringBuilds: true,
  },
  // Exponemos al cliente las env vars que Vercel inyecta al build con
  // metadata del deploy. Nos permite mostrar la versión actual (commit SHA
  // + branch + fecha) en la pantalla "Acerca de" del admin. En builds
  // locales (dev / desktop bundleado) estas vars están undefined.
  env: {
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? '',
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF ?? '',
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_MESSAGE: (process.env.VERCEL_GIT_COMMIT_MESSAGE ?? '').slice(0, 100),
    NEXT_PUBLIC_VERCEL_DEPLOY_TIME: new Date().toISOString(),
  },
  // Headers de seguridad (mismo set que la PWA, que sí los tenía). X-Frame-Options
  // DENY cierra clickjacking; nosniff evita MIME-sniffing; Referrer-Policy limita
  // el leak. (Una CSP estricta queda como follow-up: Next inyecta scripts inline
  // y requiere nonce/unsafe-inline afinado para no romper la app.)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
  // El package @sta/shared usa imports ESM con extensión .js que apuntan a .ts (NodeNext-style).
  // Webpack por defecto no hace ese mapping → le decimos cómo.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  async rewrites() {
    if (process.env.NEXT_PUBLIC_DEMO_MODE === 'true') return [];
    return [
      {
        source: '/api/v1/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/api/v1/:path*`,
      },
    ];
  },
};
export default nextConfig;
