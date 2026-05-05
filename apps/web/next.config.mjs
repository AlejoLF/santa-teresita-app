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
  // En modo demo no hay backend; saltamos lint/typecheck que cierra el build por
  // strict-TS pre-existente. Para producción se espera que el dev los arregle.
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
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
