import { prisma } from '@sta/db/client';

/**
 * Cumpleaños de clientes.
 *
 * Pedido de la encargada: que el sistema le avise UN DÍA ANTES de que un
 * cliente cumpla años, para poder prepararle algo. Así que lo que importa acá
 * es "quién cumple mañana", no "quién cumplió".
 *
 * Dos cosas a no romper:
 *
 *  1. **El día es el día argentino.** `fecha_nacimiento` es un DATE (sin hora),
 *     pero "mañana" depende de dónde esté parado el proceso: la API puede
 *     correr en Vercel/Railway en UTC, y a las 21:30 de Argentina allá ya es
 *     otro día. Se calcula la fecha con TZ Argentina explícita y recién ahí se
 *     saca mes y día. (Mismo criterio que el resto del sistema, ver CLAUDE.md.)
 *
 *  2. **Los 29 de febrero.** Quien nació un 29/2 no tiene cumpleaños en los
 *     años comunes. En vez de saltearlo tres años de cada cuatro, se lo avisa
 *     junto con los del 28/2.
 */

export interface ClienteCumple {
  id: string;
  nombre: string;
  apellido: string | null;
  telefono: string | null;
  fechaNacimiento: string; // 'YYYY-MM-DD'
  /** Los que cumple ESE día. `null` si el año de nacimiento no es creíble. */
  edad: number | null;
}

const TZ_AR = 'America/Argentina/Buenos_Aires';

/** La fecha de hoy en Argentina, como 'YYYY-MM-DD'. */
export function hoyEnArgentina(ahora: Date = new Date()): string {
  return ahora.toLocaleDateString('en-CA', { timeZone: TZ_AR });
}

/**
 * Corre una fecha 'YYYY-MM-DD' unos días. La aritmética se hace a mediodía UTC
 * a propósito: así ningún cambio de huso ni horario de verano puede empujar el
 * resultado al día de al lado.
 */
export function correrDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function esBisiesto(anio: number): boolean {
  return (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0;
}

/** Clientes activos que cumplen años en esa fecha (un 'YYYY-MM-DD' argentino). */
export async function cumplenEl(fecha: string): Promise<ClienteCumple[]> {
  const [anio, mes, dia] = fecha.split('-').map(Number) as [number, number, number];

  // El 28/2 de un año común se lleva también a los nacidos el 29/2.
  const tomaEl29DeFebrero = mes === 2 && dia === 28 && !esBisiesto(anio);

  const filas = await prisma.$queryRaw<
    Array<{
      id: string;
      nombre: string;
      apellido: string | null;
      telefono: string | null;
      fecha_nacimiento: Date;
    }>
  >`
    SELECT "id", "nombre", "apellido", "telefono", "fecha_nacimiento"
      FROM "clientes"
     WHERE "activo" = true
       AND "fecha_nacimiento" IS NOT NULL
       AND (
         (EXTRACT(MONTH FROM "fecha_nacimiento")::int = ${mes}
          AND EXTRACT(DAY FROM "fecha_nacimiento")::int = ${dia})
         OR (${tomaEl29DeFebrero}::boolean
             AND EXTRACT(MONTH FROM "fecha_nacimiento")::int = 2
             AND EXTRACT(DAY FROM "fecha_nacimiento")::int = 29)
       )
     ORDER BY "nombre" ASC, "apellido" ASC NULLS FIRST
  `;

  return filas.map((f) => {
    // La columna es DATE: Prisma la devuelve a medianoche UTC, así que se lee
    // en UTC. Leerla en la TZ del proceso la correría un día para atrás.
    const nac = f.fecha_nacimiento.toISOString().slice(0, 10);
    const anioNac = Number(nac.slice(0, 4));
    const edad = anioNac >= 1900 && anioNac < anio ? anio - anioNac : null;
    return {
      id: f.id,
      nombre: f.nombre,
      apellido: f.apellido,
      telefono: f.telefono,
      fechaNacimiento: nac,
      edad,
    };
  });
}

/**
 * Lo que necesita el aviso del panel: quién cumple mañana (el pedido) y quién
 * cumple hoy (porque si el aviso de ayer no se vio, todavía se está a tiempo).
 */
export async function agendaDeCumpleanos(ahora: Date = new Date()): Promise<{
  hoy: ClienteCumple[];
  manana: ClienteCumple[];
}> {
  const hoyAR = hoyEnArgentina(ahora);
  const [hoy, manana] = await Promise.all([cumplenEl(hoyAR), cumplenEl(correrDias(hoyAR, 1))]);
  return { hoy, manana };
}
