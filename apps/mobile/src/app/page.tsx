import { redirect } from 'next/navigation';
import { leerSesion } from '@/lib/auth';
import { Dashboard } from '@/components/Dashboard';

/**
 * Home — si hay sesión válida, muestra el Dashboard. Si no, redirige al login.
 *
 * Esta page es Server Component, así que el check de sesión corre en el
 * servidor (no flash de contenido protegido al cliente).
 */
export default async function HomePage() {
  const session = await leerSesion();
  if (!session) {
    redirect('/login');
  }
  return <Dashboard nombre={session.nombre} />;
}
