'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';

type SlotHorario = {
  id: string;
  diasSemana: number[];
  turno: 'MANANA' | 'TARDE';
  horaInicio: string;
  horaFin: string;
  ventanaCierreMin: number;
};

type Feriado = {
  fecha: string;
  label: string;
  cerrado: boolean;
  horarios?: SlotHorario[];
};

type ConfigHorarios = {
  version: number;
  horarios: SlotHorario[];
  feriados: Feriado[];
};

const DIAS = [
  { dow: 1, label: 'Lun' },
  { dow: 2, label: 'Mar' },
  { dow: 3, label: 'Mié' },
  { dow: 4, label: 'Jue' },
  { dow: 5, label: 'Vie' },
  { dow: 6, label: 'Sáb' },
  { dow: 0, label: 'Dom' },
];

function nuevoId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export default function HorariosPage() {
  const [config, setConfig] = useState<ConfigHorarios | null>(null);
  const [original, setOriginal] = useState<string>('');
  const [defaultConfig, setDefaultConfig] = useState<ConfigHorarios | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await api.get<{ config: ConfigHorarios; defaultConfig: ConfigHorarios }>(
        '/admin/configuracion/horarios',
      );
      setConfig(r.config);
      setOriginal(JSON.stringify(r.config));
      setDefaultConfig(r.defaultConfig);
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) {
        setError('No se pudo cargar la configuración de horarios');
      }
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const dirty = useMemo(() => {
    if (!config) return false;
    return JSON.stringify(config) !== original;
  }, [config, original]);

  function updateSlot(id: string, patch: Partial<SlotHorario>) {
    if (!config) return;
    setConfig({
      ...config,
      horarios: config.horarios.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  }

  function toggleDia(id: string, dow: number) {
    if (!config) return;
    const slot = config.horarios.find((s) => s.id === id);
    if (!slot) return;
    const has = slot.diasSemana.includes(dow);
    updateSlot(id, {
      diasSemana: has ? slot.diasSemana.filter((d) => d !== dow) : [...slot.diasSemana, dow].sort(),
    });
  }

  function eliminarSlot(id: string) {
    if (!config) return;
    setConfig({ ...config, horarios: config.horarios.filter((s) => s.id !== id) });
  }

  function agregarSlot(turno: 'MANANA' | 'TARDE') {
    if (!config) return;
    setConfig({
      ...config,
      horarios: [
        ...config.horarios,
        {
          id: nuevoId(turno.toLowerCase()),
          diasSemana: [1, 2, 3, 4, 5, 6],
          turno,
          horaInicio: turno === 'MANANA' ? '07:00' : '17:00',
          horaFin: turno === 'MANANA' ? '14:30' : '22:00',
          ventanaCierreMin: 30,
        },
      ],
    });
  }

  function agregarFeriado() {
    if (!config) return;
    const hoy = new Date();
    const ymd = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
    setConfig({
      ...config,
      feriados: [...config.feriados, { fecha: ymd, label: 'Feriado nuevo', cerrado: true }],
    });
  }

  function updateFeriado(idx: number, patch: Partial<Feriado>) {
    if (!config) return;
    setConfig({
      ...config,
      feriados: config.feriados.map((f, i) => (i === idx ? { ...f, ...patch } : f)),
    });
  }

  function eliminarFeriado(idx: number) {
    if (!config) return;
    setConfig({ ...config, feriados: config.feriados.filter((_, i) => i !== idx) });
  }

  async function guardar() {
    if (!config) return;
    setSaving(true);
    setError(null);
    setOkMsg(null);
    try {
      await api.put('/admin/configuracion/horarios', config);
      setOriginal(JSON.stringify(config));
      setOkMsg('Horarios guardados. Aplica a partir de la próxima venta.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Error al guardar');
    } finally {
      setSaving(false);
    }
  }

  function resetearDefault() {
    if (!defaultConfig) return;
    if (!confirm('¿Volver a los horarios por defecto? Vas a perder los cambios sin guardar.'))
      return;
    setConfig(JSON.parse(JSON.stringify(defaultConfig)));
  }

  if (!config) {
    return (
      <div className="max-w-5xl mx-auto p-4 text-ink-500">
        {error ?? 'Cargando horarios…'}
      </div>
    );
  }

  const mananas = config.horarios.filter((s) => s.turno === 'MANANA');
  const tardes = config.horarios.filter((s) => s.turno === 'TARDE');

  return (
    <div className="max-w-5xl mx-auto p-3 sm:p-4 lg:p-6 space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-lg lg:text-xl text-teresita-700">
            Horarios de atención
          </h1>
          <p className="text-sm text-ink-500 mt-1 max-w-2xl">
            Definí cuándo se pueden cargar ventas en cada turno. Cada slot mapea a un{' '}
            <strong>turno de caja</strong> (Mañana o Tarde) y se aplica a los días marcados. La{' '}
            <strong>ventana de cierre</strong> es el tiempo extra después de la hora fin en el
            que todavía se puede cargar una venta tardía.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={resetearDefault}>
            Resetear default
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={!dirty || saving}
            onClick={() => void guardar()}
          >
            {saving ? 'Guardando…' : dirty ? 'Guardar cambios' : 'Guardado'}
          </Button>
        </div>
      </header>

      {error && (
        <div className="bg-pomodoro-50 border border-pomodoro-200 text-pomodoro-700 rounded-md px-4 py-2 text-sm">
          {error}
        </div>
      )}
      {okMsg && (
        <div className="bg-teresita-50 border border-teresita-200 text-teresita-700 rounded-md px-4 py-2 text-sm">
          {okMsg}
        </div>
      )}

      {/* TURNO MAÑANA */}
      <section className="bg-white rounded-lg border border-cream-300 overflow-hidden">
        <header className="flex items-center justify-between px-4 py-3 bg-cream-50 border-b border-cream-300">
          <div>
            <h2 className="font-display text-md text-teresita-700">Turno mañana</h2>
            <p className="text-2xs text-ink-500">
              Hasta 1 slot por día. Si un día no tiene slot, el local está cerrado a la mañana.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => agregarSlot('MANANA')}>
            + Agregar slot
          </Button>
        </header>
        <div className="divide-y divide-cream-200">
          {mananas.length === 0 && (
            <div className="px-4 py-6 text-sm text-ink-400 italic">Sin slots de mañana.</div>
          )}
          {mananas.map((s) => (
            <SlotRow
              key={s.id}
              slot={s}
              onUpdate={(p) => updateSlot(s.id, p)}
              onToggleDia={(dow) => toggleDia(s.id, dow)}
              onEliminar={() => eliminarSlot(s.id)}
            />
          ))}
        </div>
      </section>

      {/* TURNO TARDE */}
      <section className="bg-white rounded-lg border border-cream-300 overflow-hidden">
        <header className="flex items-center justify-between px-4 py-3 bg-cream-50 border-b border-cream-300">
          <div>
            <h2 className="font-display text-md text-teresita-700">Turno tarde</h2>
            <p className="text-2xs text-ink-500">
              Hasta 1 slot por día. Si un día no tiene slot, el local está cerrado a la tarde.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => agregarSlot('TARDE')}>
            + Agregar slot
          </Button>
        </header>
        <div className="divide-y divide-cream-200">
          {tardes.length === 0 && (
            <div className="px-4 py-6 text-sm text-ink-400 italic">Sin slots de tarde.</div>
          )}
          {tardes.map((s) => (
            <SlotRow
              key={s.id}
              slot={s}
              onUpdate={(p) => updateSlot(s.id, p)}
              onToggleDia={(dow) => toggleDia(s.id, dow)}
              onEliminar={() => eliminarSlot(s.id)}
            />
          ))}
        </div>
      </section>

      {/* FERIADOS */}
      <section className="bg-white rounded-lg border border-cream-300 overflow-hidden">
        <header className="flex items-center justify-between px-4 py-3 bg-cream-50 border-b border-cream-300">
          <div>
            <h2 className="font-display text-md text-teresita-700">Feriados</h2>
            <p className="text-2xs text-ink-500">
              Sobreescriben los horarios normales para una fecha específica.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={agregarFeriado}>
            + Agregar feriado
          </Button>
        </header>
        <div className="divide-y divide-cream-200">
          {config.feriados.length === 0 && (
            <div className="px-4 py-6 text-sm text-ink-400 italic">Sin feriados cargados.</div>
          )}
          {config.feriados.map((f, idx) => (
            <div
              key={`${f.fecha}-${idx}`}
              className="px-4 py-3 grid grid-cols-1 sm:grid-cols-[140px_1fr_120px_auto] gap-3 items-center"
            >
              <input
                type="date"
                value={f.fecha}
                onChange={(e) => updateFeriado(idx, { fecha: e.target.value })}
                className="input"
              />
              <input
                type="text"
                value={f.label}
                placeholder="Ej: Día del trabajador"
                onChange={(e) => updateFeriado(idx, { label: e.target.value })}
                className="input"
              />
              <label className="text-sm text-ink-700 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={f.cerrado}
                  onChange={(e) => updateFeriado(idx, { cerrado: e.target.checked })}
                />
                Cerrado
              </label>
              <button
                onClick={() => eliminarFeriado(idx)}
                className="text-pomodoro-600 hover:text-pomodoro-700 text-sm"
              >
                Eliminar
              </button>
            </div>
          ))}
        </div>
      </section>

      <footer className="text-xs text-ink-400">
        Versión config: {config.version}. El cambio aplica inmediatamente a las próximas
        ventas; las sesiones ya abiertas siguen vivas hasta que la encargada las cierre.
      </footer>
    </div>
  );
}

function SlotRow({
  slot,
  onUpdate,
  onToggleDia,
  onEliminar,
}: {
  slot: SlotHorario;
  onUpdate: (p: Partial<SlotHorario>) => void;
  onToggleDia: (dow: number) => void;
  onEliminar: () => void;
}) {
  return (
    <div className="px-4 py-3 grid grid-cols-1 lg:grid-cols-[1fr_auto_auto_auto_auto] gap-3 items-center">
      <div className="flex flex-wrap gap-1">
        {DIAS.map((d) => {
          const active = slot.diasSemana.includes(d.dow);
          return (
            <button
              key={d.dow}
              onClick={() => onToggleDia(d.dow)}
              className={cn(
                'px-2 py-1 rounded-md text-xs font-medium border transition-colors',
                active
                  ? 'bg-teresita-700 text-cream-50 border-teresita-700'
                  : 'bg-white text-ink-500 border-cream-300 hover:bg-cream-50',
              )}
            >
              {d.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-ink-500">Inicio</span>
        <input
          type="time"
          value={slot.horaInicio}
          onChange={(e) => onUpdate({ horaInicio: e.target.value })}
          className="input w-28"
        />
      </div>
      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-ink-500">Fin</span>
        <input
          type="time"
          value={slot.horaFin}
          onChange={(e) => onUpdate({ horaFin: e.target.value })}
          className="input w-28"
        />
      </div>
      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-ink-500">Grace (min)</span>
        <input
          type="number"
          min={0}
          max={180}
          value={slot.ventanaCierreMin}
          onChange={(e) => onUpdate({ ventanaCierreMin: Number(e.target.value) || 0 })}
          className="input w-20"
        />
      </div>
      <button
        onClick={onEliminar}
        className="text-pomodoro-600 hover:text-pomodoro-700 text-sm justify-self-end"
      >
        Eliminar
      </button>
    </div>
  );
}
