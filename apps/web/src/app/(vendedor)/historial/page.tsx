'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { MoneyAmount } from '@/components/ui/MoneyAmount';
import { Button } from '@/components/ui/Button';

interface VentaResumen {
  id: string;
  numero: number;
  numeroOrdenTurno: number;
  canal: string;
  estado: 'PROCESADA' | 'FINALIZADA' | 'ANULADA';
  total: string;
  fechaApertura: string;
  motivoAnulacion?: string | null;
}

interface Historial {
  sesion: { id: string; fecha: string; turno: string };
  abiertas: VentaResumen[];
  cerradas: VentaResumen[];
  anuladas: VentaResumen[];
}

export default function HistorialPage() {
  const router = useRouter();
  const [data, setData] = useState<Historial | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setData(await api.get<Historial>('/ventas/historial-sesion'));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) router.replace('/login');
      }
    })();
  }, [router]);

  if (!data) return <div className="p-12 text-ink-500">Cargando...</div>;

  return (
    <div className="min-h-screen p-8 max-w-3xl mx-auto">
      <header className="flex justify-between items-baseline mb-6">
        <h1 className="font-display text-2xl text-teresita-700">
          Historial — {data.sesion.turno} {data.sesion.fecha.slice(0, 10)}
        </h1>
        <Button variant="secondary" onClick={() => router.back()}>
          ← Volver
        </Button>
      </header>

      <Section title={`Abiertos (${data.abiertas.length})`} ventas={data.abiertas} estado="abierto" />
      <Section title={`Cerrados hoy (${data.cerradas.length})`} ventas={data.cerradas} estado="cerrado" />
      <Section title={`Anulados hoy (${data.anuladas.length})`} ventas={data.anuladas} estado="anulado" />
    </div>
  );
}

function Section({
  title,
  ventas,
  estado,
}: {
  title: string;
  ventas: VentaResumen[];
  estado: 'abierto' | 'cerrado' | 'anulado';
}) {
  if (ventas.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="text-md font-medium text-ink-700 mb-3">{title}</h2>
      <div className="card divide-y divide-cream-200">
        {ventas.map((v) => {
          const RowWrapper = ({ children }: { children: React.ReactNode }) =>
            estado === 'abierto' || estado === 'cerrado' ? (
              <Link
                href={`/venta/${v.id}`}
                className="block hover:bg-cream-100 transition-colors"
              >
                {children}
              </Link>
            ) : (
              <div>{children}</div>
            );
          return (
            <RowWrapper key={v.id}>
              <div className="px-4 py-3 flex justify-between items-center">
                <div>
                  <span className="font-mono text-sm text-ink-700">
                    #{String(v.numeroOrdenTurno).padStart(3, '0')}
                  </span>
                  <span className="text-xs text-ink-500 ml-3">
                    {new Date(v.fechaApertura).toLocaleTimeString('es-AR', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="text-xs text-ink-500 ml-3">{v.canal.replace('_', ' ')}</span>
                  {v.motivoAnulacion && (
                    <div className="text-xs italic text-pomodoro-600 mt-0.5">
                      {v.motivoAnulacion}
                    </div>
                  )}
                </div>
                <div className="text-right flex items-center gap-3">
                  <div>
                    <MoneyAmount
                      value={v.total}
                      className={
                        estado === 'anulado'
                          ? 'text-ink-300 line-through'
                          : estado === 'cerrado'
                            ? 'text-basil-600'
                            : 'text-teresita-700'
                      }
                    />
                    <div className="text-2xs text-ink-500">{estado.toUpperCase()}</div>
                  </div>
                  {estado === 'abierto' && (
                    <span className="text-teresita-700 text-md">→</span>
                  )}
                </div>
              </div>
            </RowWrapper>
          );
        })}
      </div>
    </section>
  );
}
