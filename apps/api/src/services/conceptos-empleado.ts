import type { Prisma } from '@sta/db';

/**
 * De qué concepto fue cada pago a un empleado.
 *
 * ─── El problema ─────────────────────────────────────────────────────────
 *
 * La encargada carga los pagos eligiendo un concepto: Sueldo, Jornada, Horas
 * extra, Feriado, Vacaciones, Aguinaldo, Adelanto, Comisión… Pero el
 * movimiento se guardaba con la CATEGORÍA CONTABLE, que agrupa seis de esos
 * en uno solo ("Sueldos"). El concepto elegido sobrevivía únicamente como
 * prefijo de texto en la observación.
 *
 * Resultado: ella cargaba cinco cosas distintas y el sistema le devolvía un
 * número solo. No podía ver cuánto se fue en horas extra, cuánto en jornadas,
 * cuánto en plus.
 *
 * ─── Cómo se resuelve ────────────────────────────────────────────────────
 *
 * Los pagos NUEVOS guardan el concepto en `movimientos.adicionales`
 * (`{ conceptoEmpleado: 'Horas extra' }`). Es una columna JSONB que ya existe
 * y ya se usa para lo mismo en Aportes/Egresos, así que NO hace falta tocar el
 * schema ni correr una migración.
 *
 * Los pagos VIEJOS no tienen ese dato — y son todos los que la encargada ya
 * cargó. Para esos se lee el prefijo de la observación, que es exactamente lo
 * que el endpoint de pago venía escribiendo ahí. Sin esto, la pantalla nueva
 * le mostraría "Sueldos: todo" sobre su historial entero, que es el problema
 * que vino a resolver.
 *
 * El orden importa: primero el dato estructurado, después el texto, y recién
 * al final la categoría contable como último recurso.
 */

/**
 * Los conceptos que ofrece la pantalla de pago, en el orden en que se
 * muestran. Se corresponde con el dominio `concepto_pago_empleado` de las
 * listas configurables (ver el seed). Acá está duplicado a propósito: es el
 * orden de presentación de los totales, no la lista de opciones — si la
 * encargada agrega un concepto propio desde Configuración, aparece igual,
 * ordenado después de los conocidos.
 */
export const CONCEPTOS_CONOCIDOS = [
  'Sueldo',
  'Jornada',
  'Horas extra',
  'Feriado',
  'Vacaciones',
  'Aguinaldo',
  'Plus',
  'Adelanto',
  'Comisión',
] as const;

/** Lo que se muestra cuando no se puede saber de qué fue el pago. */
export const CONCEPTO_SIN_DATO = 'Otros';

type MovimientoParaConcepto = {
  observacion: string | null;
  adicionales?: Prisma.JsonValue | null;
  categoria?: { nombre: string } | null;
};

/**
 * El prefijo que el endpoint de pago antepone a la observación cuando el
 * concepto no es el plano "Sueldo" — p. ej. `"Horas extra · sábado"` o, en un
 * pago repartido entre cuentas, `"Horas extra (parte 1/2)"`.
 *
 * Se compara contra la lista de conceptos conocidos en vez de cortar por el
 * separador: así una observación escrita a mano ("Pagado en mano · efectivo")
 * no se confunde con un concepto.
 */
function conceptoDesdeObservacion(obs: string | null, extra: string[]): string | null {
  if (!obs) return null;
  const texto = obs.trim();
  const candidatos = [...extra, ...CONCEPTOS_CONOCIDOS]
    // Del más largo al más corto: "Horas extra" tiene que ganarle a un
    // hipotético "Horas" si algún día existiera.
    .sort((a, b) => b.length - a.length);
  for (const c of candidatos) {
    const bajo = texto.toLowerCase();
    const cb = c.toLowerCase();
    if (bajo === cb) return c;
    // Seguido del separador que usa el endpoint, del paréntesis de "(parte
    // 1/2)", o de nada más que espacio.
    if (bajo.startsWith(cb + ' ·') || bajo.startsWith(cb + ' (')) return c;
  }
  return null;
}

/**
 * El concepto de UN movimiento. `extra` son los conceptos que la encargada
 * agregó por su cuenta a la lista configurable.
 */
export function conceptoDe(mov: MovimientoParaConcepto, extra: string[] = []): string {
  const ad = mov.adicionales as { conceptoEmpleado?: unknown } | null | undefined;
  if (ad && typeof ad === 'object' && typeof ad.conceptoEmpleado === 'string') {
    const v = ad.conceptoEmpleado.trim();
    if (v) return v;
  }
  const delTexto = conceptoDesdeObservacion(mov.observacion, extra);
  if (delTexto) return delTexto;
  // Último recurso: la categoría contable. "Sueldos" sin más detalle quiere
  // decir un pago de sueldo plano (el único que no lleva prefijo).
  const cat = mov.categoria?.nombre;
  if (cat === 'Sueldos') return 'Sueldo';
  if (cat === 'Adelanto a empleado') return 'Adelanto';
  if (cat === 'Comisiones') return 'Comisión';
  return CONCEPTO_SIN_DATO;
}

export interface TotalPorConcepto {
  concepto: string;
  monto: string;
  cantidad: number;
}

/**
 * Agrupa por concepto y ordena: primero los conceptos conocidos en el orden de
 * la pantalla de pago, después los que agregó la encargada (alfabético), y
 * "Otros" siempre último — para que el ojo encuentre cada número en el mismo
 * lugar aunque cambie el período.
 */
export function totalesPorConcepto<T extends MovimientoParaConcepto>(
  movimientos: T[],
  montoDe: (m: T) => number,
  extra: string[] = [],
): TotalPorConcepto[] {
  const acc = new Map<string, { monto: number; cantidad: number }>();
  for (const m of movimientos) {
    const c = conceptoDe(m, extra);
    const cur = acc.get(c) ?? { monto: 0, cantidad: 0 };
    cur.monto += montoDe(m);
    cur.cantidad += 1;
    acc.set(c, cur);
  }

  const rank = (c: string): number => {
    if (c === CONCEPTO_SIN_DATO) return 9_000;
    const i = (CONCEPTOS_CONOCIDOS as readonly string[]).indexOf(c);
    return i >= 0 ? i : 1_000;
  };

  return [...acc.entries()]
    .map(([concepto, v]) => ({
      concepto,
      monto: v.monto.toFixed(2),
      cantidad: v.cantidad,
    }))
    .sort((a, b) => {
      const d = rank(a.concepto) - rank(b.concepto);
      return d !== 0 ? d : a.concepto.localeCompare(b.concepto, 'es');
    });
}
