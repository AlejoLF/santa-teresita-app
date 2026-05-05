import Link from 'next/link';

const SECCIONES = [
  {
    href: '/admin/configuracion/usuarios',
    icon: '👤',
    title: 'Usuarios y PINs',
    desc: 'Cambiar PINs, crear empleados con acceso, resetear o desactivar usuarios.',
    accent: 'border-pomodoro-600',
  },
  {
    href: '/admin/configuracion/cuentas',
    icon: '💰',
    title: 'Cuentas y posnets',
    desc: 'Editar las 5 cuentas reales (Caja, Santander, Galicia, BAPRO, MP), agregar posnets.',
    accent: 'border-teresita-700',
  },
  {
    href: '/admin/configuracion/parametros',
    icon: '🛠️',
    title: 'Parámetros del sistema',
    desc: '% descuento efectivo, sesión admin, intentos máx., diferencia caja, etc.',
    accent: 'border-saffron-600',
  },
  {
    href: '/admin/configuracion/local',
    icon: '🏪',
    title: 'Datos del local',
    desc: 'Nombre, dirección, teléfono y redes que aparecen en el ticket cliente.',
    accent: 'border-ocean-600',
  },
];

export default function ConfiguracionInicio() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-500 mb-2">
        Antes de salir en producción, asegurate de cambiar los PINs default por unos seguros.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {SECCIONES.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className={`card p-5 hover:shadow-md transition-shadow border-l-4 ${s.accent}`}
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl">{s.icon}</span>
              <div>
                <h3 className="font-display text-md text-ink-900 mb-1">{s.title}</h3>
                <p className="text-sm text-ink-500">{s.desc}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
