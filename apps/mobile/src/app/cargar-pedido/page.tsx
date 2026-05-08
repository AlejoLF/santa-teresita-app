import { redirect } from 'next/navigation';
import { leerSesion } from '@/lib/auth';
import { CargarPedido } from '@/components/CargarPedido';

/**
 * Pantalla de carga de pedido — accesible para ADMIN y VENDEDOR.
 * VENDEDOR aterriza acá automáticamente desde /. ADMIN llega vía botón
 * "+ Pedido" en el header del dashboard.
 */
export default async function CargarPedidoPage() {
  const session = await leerSesion();
  if (!session) redirect('/login');
  return <CargarPedido nombre={session.nombre} rol={session.rol} />;
}
