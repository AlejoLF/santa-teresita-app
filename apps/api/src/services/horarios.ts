import { prisma } from '@sta/db/client';
import { TurnoCaja } from '@sta/db';

/**
 * Configuración de horarios de atención — modelado como JSON dentro de
 * ConfiguracionSistema bajo la clave `sesiones_horarios`.
 *
 * Cada slot mapea a uno de los dos turnos del enum DB (MANANA / TARDE) — la DB
 * fuerza que en un mismo día (fecha, turno) sea único, así que como máximo
 * habrá un slot MANANA y un slot TARDE por día. Para feriados se puede
 * sobreescribir el día entero (`cerrado: true` o `horarios` propio).
 *
 * Los slots NO pueden cruzar medianoche: horaFin > horaInicio. Si en algún
 * momento el negocio abre 22:00→02:00 lo modelamos como dos slots.
 */
export type SlotHorario = {
  id: string;
  diasSemana: number[]; // 0=domingo, 1=lunes, ..., 6=sábado
  turno: 'MANANA' | 'TARDE';
  horaInicio: string; // "HH:MM"
  horaFin: string; // "HH:MM"
  ventanaCierreMin: number; // grace period post horaFin
};

export type Feriado = {
  fecha: string; // YYYY-MM-DD
  label: string;
  cerrado: boolean; // si true, el local no opera ese día
  horarios?: SlotHorario[]; // si !cerrado y override, qué horarios aplican
};

export type ConfigHorarios = {
  version: number;
  horarios: SlotHorario[];
  feriados: Feriado[];
};

export const DEFAULT_CONFIG: ConfigHorarios = {
  version: 1,
  horarios: [
    {
      id: 'default-manana',
      diasSemana: [1, 2, 3, 4, 5, 6], // lun-sáb
      turno: 'MANANA',
      horaInicio: '07:00',
      horaFin: '14:30',
      ventanaCierreMin: 30,
    },
    {
      id: 'default-tarde',
      diasSemana: [1, 2, 3, 4, 5, 6], // lun-sáb
      turno: 'TARDE',
      horaInicio: '14:30',
      horaFin: '22:00',
      ventanaCierreMin: 30,
    },
    {
      id: 'default-domingo',
      diasSemana: [0], // domingo
      turno: 'TARDE',
      horaInicio: '17:00',
      horaFin: '22:00',
      ventanaCierreMin: 30,
    },
  ],
  feriados: [],
};

/** Lee la config persistida; devuelve DEFAULT_CONFIG si no existe o si está corrupta. */
export async function getConfigHorarios(): Promise<ConfigHorarios> {
  const row = await prisma.configuracionSistema
    .findUnique({ where: { clave: 'sesiones_horarios' } })
    .catch(() => null);

  if (!row?.valor) return DEFAULT_CONFIG;

  try {
    const parsed = JSON.parse(row.valor) as ConfigHorarios;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.horarios)) {
      return DEFAULT_CONFIG;
    }
    return {
      version: parsed.version ?? 1,
      horarios: parsed.horarios,
      feriados: parsed.feriados ?? [],
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function parseHHMM(hhmm: string): number {
  const parts = hhmm.split(':').map((s) => parseInt(s, 10));
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  return h * 60 + m;
}

function fechaLocalYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export type SlotResuelto = {
  slot: SlotHorario;
  estado: 'ACTIVO' | 'GRACE';
  turno: TurnoCaja;
  // Fecha (a medianoche local) del registro SesionCaja al que pertenece este slot.
  fechaSesion: Date;
  // Minutos restantes del estado actual (útil para la UI).
  minutosRestantes: number;
};

export type ResolucionHorario =
  | { tipo: 'CERRADO'; razon: 'FERIADO' | 'FUERA_DE_HORARIO'; proximaApertura?: ProximaApertura }
  | { tipo: 'EN_HORARIO'; slot: SlotResuelto };

export type ProximaApertura = {
  fechaSesion: Date;
  turno: TurnoCaja;
  horaInicio: string;
  minutosEspera: number;
};

/**
 * Resuelve qué slot (si alguno) aplica para el momento dado.
 *
 * - Si el día es feriado y `cerrado: true` → CERRADO/FERIADO.
 * - Si el día es feriado con `horarios` override → usa esos.
 * - Si estamos dentro de [horaInicio, horaFin) → ACTIVO.
 * - Si estamos dentro de [horaFin, horaFin + ventanaCierreMin) → GRACE.
 * - Caso contrario → CERRADO/FUERA_DE_HORARIO (calcula próxima apertura).
 */
export function resolverSlotActivo(
  config: ConfigHorarios,
  ahora: Date,
): ResolucionHorario {
  const ymd = fechaLocalYMD(ahora);
  const minutosAhora = ahora.getHours() * 60 + ahora.getMinutes();

  // 1. Chequear feriado del día actual
  const feriado = config.feriados.find((f) => f.fecha === ymd);
  if (feriado?.cerrado) {
    return { tipo: 'CERRADO', razon: 'FERIADO', proximaApertura: proximaAperturaDesde(config, ahora) };
  }

  // 2. Determinar slots aplicables (override del feriado si tiene; sino los del día de semana)
  const dow = ahora.getDay();
  const slotsCandidatos: SlotHorario[] =
    feriado?.horarios && feriado.horarios.length > 0
      ? feriado.horarios
      : config.horarios.filter((s) => s.diasSemana.includes(dow));

  for (const slot of slotsCandidatos) {
    const inicio = parseHHMM(slot.horaInicio);
    const fin = parseHHMM(slot.horaFin);
    const finGrace = fin + slot.ventanaCierreMin;

    if (minutosAhora >= inicio && minutosAhora < fin) {
      return {
        tipo: 'EN_HORARIO',
        slot: {
          slot,
          estado: 'ACTIVO',
          turno: slot.turno as TurnoCaja,
          fechaSesion: fechaLocalSinHora(ahora),
          minutosRestantes: fin - minutosAhora,
        },
      };
    }
    if (minutosAhora >= fin && minutosAhora < finGrace) {
      return {
        tipo: 'EN_HORARIO',
        slot: {
          slot,
          estado: 'GRACE',
          turno: slot.turno as TurnoCaja,
          fechaSesion: fechaLocalSinHora(ahora),
          minutosRestantes: finGrace - minutosAhora,
        },
      };
    }
  }

  return {
    tipo: 'CERRADO',
    razon: 'FUERA_DE_HORARIO',
    proximaApertura: proximaAperturaDesde(config, ahora),
  };
}

function fechaLocalSinHora(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Busca, mirando hasta 7 días adelante, cuándo abre el próximo slot.
 * Devuelve null si no hay ningún slot configurado (edge case).
 */
function proximaAperturaDesde(config: ConfigHorarios, ahora: Date): ProximaApertura | undefined {
  const minutosAhora = ahora.getHours() * 60 + ahora.getMinutes();

  for (let offset = 0; offset < 8; offset++) {
    const dia = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + offset);
    const ymd = fechaLocalYMD(dia);
    const dow = dia.getDay();

    const feriado = config.feriados.find((f) => f.fecha === ymd);
    if (feriado?.cerrado) continue;

    const slots: SlotHorario[] =
      feriado?.horarios && feriado.horarios.length > 0
        ? feriado.horarios
        : config.horarios.filter((s) => s.diasSemana.includes(dow));

    // Ordenar por hora de inicio
    const ordenados = [...slots].sort(
      (a, b) => parseHHMM(a.horaInicio) - parseHHMM(b.horaInicio),
    );

    for (const slot of ordenados) {
      const inicio = parseHHMM(slot.horaInicio);
      if (offset === 0 && inicio <= minutosAhora) continue; // ya pasó hoy
      const minutosEspera =
        offset * 24 * 60 + inicio - minutosAhora;
      return {
        fechaSesion: dia,
        turno: slot.turno as TurnoCaja,
        horaInicio: slot.horaInicio,
        minutosEspera,
      };
    }
  }
  return undefined;
}

/**
 * Validación zod-style mínima para usar desde el endpoint PUT.
 * Lanza Error con mensaje human-readable si la config tiene inconsistencias.
 */
export function validarConfig(config: unknown): asserts config is ConfigHorarios {
  if (!config || typeof config !== 'object') throw new Error('Config debe ser un objeto');
  const c = config as Partial<ConfigHorarios>;
  if (!Array.isArray(c.horarios)) throw new Error('Config.horarios debe ser un array');

  const re = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const [i, s] of c.horarios.entries()) {
    if (!s.id) throw new Error(`Slot[${i}].id requerido`);
    if (!Array.isArray(s.diasSemana) || s.diasSemana.length === 0)
      throw new Error(`Slot[${i}].diasSemana debe tener al menos un día`);
    if (s.diasSemana.some((d) => d < 0 || d > 6))
      throw new Error(`Slot[${i}].diasSemana: valores entre 0 y 6 (0=domingo)`);
    if (s.turno !== 'MANANA' && s.turno !== 'TARDE')
      throw new Error(`Slot[${i}].turno debe ser MANANA o TARDE`);
    if (!re.test(s.horaInicio)) throw new Error(`Slot[${i}].horaInicio inválida (HH:MM)`);
    if (!re.test(s.horaFin)) throw new Error(`Slot[${i}].horaFin inválida (HH:MM)`);
    if (parseHHMM(s.horaFin) <= parseHHMM(s.horaInicio))
      throw new Error(`Slot[${i}]: horaFin debe ser mayor a horaInicio (sin cruzar medianoche)`);
    if (typeof s.ventanaCierreMin !== 'number' || s.ventanaCierreMin < 0 || s.ventanaCierreMin > 180)
      throw new Error(`Slot[${i}].ventanaCierreMin entre 0 y 180`);
  }

  // Detectar 2 slots MANANA o 2 TARDE en mismo día
  for (let dow = 0; dow < 7; dow++) {
    const slotsHoy = c.horarios.filter((s) => s.diasSemana.includes(dow));
    const mananas = slotsHoy.filter((s) => s.turno === 'MANANA').length;
    const tardes = slotsHoy.filter((s) => s.turno === 'TARDE').length;
    if (mananas > 1) throw new Error(`Día ${dow}: hay ${mananas} slots MANANA (máx 1 por día)`);
    if (tardes > 1) throw new Error(`Día ${dow}: hay ${tardes} slots TARDE (máx 1 por día)`);
  }

  if (c.feriados && !Array.isArray(c.feriados))
    throw new Error('Config.feriados debe ser un array');
  for (const [i, f] of (c.feriados ?? []).entries()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.fecha))
      throw new Error(`Feriado[${i}].fecha debe ser YYYY-MM-DD`);
    if (!f.label) throw new Error(`Feriado[${i}].label requerido`);
    if (typeof f.cerrado !== 'boolean')
      throw new Error(`Feriado[${i}].cerrado debe ser boolean`);
  }
}
