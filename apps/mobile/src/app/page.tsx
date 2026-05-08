import { redirect } from 'next/navigation';
import { leerSesion } from '@/lib/auth';
import { Dashboard } from '@/components/Dashboard';

/**
 * Home — si hay sesión válida, muestra el Dashboard (ADMIN) o redirige a
 * /cargar-pedido (VENDEDOR). Si no hay sesión, login.
 *
 * Server Component → el check corre en el servidor (sin flash de contenido).
 */
export default async function HomePage() {
  const session = await leerSesion();
  if (!session) {
    redirect('/login');
  }
  if (session.rol === 'VENDEDOR') {
    redirect('/cargar-pedido');
  }
  return <Dashboard nombre={session.nombre} rol={session.rol} />;
}
