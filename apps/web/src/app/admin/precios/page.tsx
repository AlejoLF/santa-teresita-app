'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * La gestión de listas de precios se movió a Catálogo → pestaña "Lista de
 * precios". Esta ruta queda como redirect para links/bookmarks viejos.
 */
export default function PreciosRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin/productos?tab=precios');
  }, [router]);
  return (
    <div className="text-ink-500 p-6 text-sm">
      Las listas de precios ahora están en <strong>Catálogo → Lista de precios</strong>.
      Redirigiendo…
    </div>
  );
}
