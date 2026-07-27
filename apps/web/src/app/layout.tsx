import type { Metadata, Viewport } from 'next';
import './globals.css';
import { DemoBanner } from '@/components/DemoBanner';
import { ServiceWorkerRegister } from '@/components/ServiceWorkerRegister';
import { InstallPrompt } from '@/components/InstallPrompt';
import { NotasDeVersion } from '@/components/NotasDeVersion';

const isDemo = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

export const metadata: Metadata = {
  title: isDemo ? 'Santa Teresita Pastas — Demo' : 'Santa Teresita Pastas',
  description: 'Gestión integral — Santa Teresita Pastas (La Plata).',
  applicationName: 'Santa Teresita',
  // App de gestión financiera privada — que NO la indexen los buscadores.
  robots: { index: false, follow: false },
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Santa Teresita',
  },
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: '#1f4d3c',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export const dynamic = 'force-dynamic';

const FONTS_LINK = (
  <>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
    <link
      href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=JetBrains+Mono:wght@400;500;600&display=swap"
      rel="stylesheet"
    />
    <link
      href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap"
      rel="stylesheet"
    />
  </>
);

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR">
      <head>{FONTS_LINK}</head>
      <body className="min-h-screen antialiased">
        <DemoBanner />
        <ServiceWorkerRegister />
        <InstallPrompt />
        <NotasDeVersion />
        {children}
      </body>
    </html>
  );
}
