/**
 * Hook que vigila cambios remotos de una venta mientras el usuario la edita.
 *
 * Uso:
 *   const aviso = useVentaWatch(venta.id, miFingerprint);
 *   if (aviso) {
 *     // Mostrar toast "Esta venta fue modificada por X — recargá".
 *   }
 *
 * `miFingerprint` es opcional: si lo pasás, ignoramos eventos cuyo total/estado
 * coinciden con el último que vimos localmente (i.e. el eco de nuestro propio
 * UPDATE). En la práctica `commit_timestamp` ya nos sirve para distinguir.
 */
'use client';

import { useEffect, useState } from 'react';
import { subscribirVenta, type VentaCambioEvento } from '@/lib/realtime';

export function useVentaWatch(ventaId: string | null) {
  const [aviso, setAviso] = useState<VentaCambioEvento | null>(null);

  useEffect(() => {
    if (!ventaId) return;
    setAviso(null); // reset cuando cambia el id
    const off = subscribirVenta(ventaId, (e) => setAviso(e));
    return off;
  }, [ventaId]);

  return aviso;
}

/** Reset manual del aviso (después de que el usuario lo descarta o recarga). */
export function descartarAviso(setAviso: (a: null) => void) {
  setAviso(null);
}
