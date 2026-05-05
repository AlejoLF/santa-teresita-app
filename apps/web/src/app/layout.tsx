import type { Metadata } from 'next';
import './globals.css';
import { DemoBanner } from '@/components/DemoBanner';

export const metadata: Metadata = {
  title: 'Santa Teresita Pastas — Demo',
  description: 'Sistema POS + cashflow para pastería en La Plata. Versión de demostración.',
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
        {children}
      </body>
    </html>
  );
}
