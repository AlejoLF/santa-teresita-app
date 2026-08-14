/**
 * Reconocer al proveedor cuando el nombre de la factura no es el del sistema.
 *
 * El nombre impreso en el comprobante casi nunca es el que el local usa: la
 * razón social completa ("GRAFIPACK SAN MARTIN S.R.L.") contra el nombre corto
 * de todos los días ("Grafipack"). Sin esto, cada factura por OCR creaba un
 * proveedor NUEVO y duplicado, partiendo la cuenta corriente en dos.
 *
 * Se resuelve en tres pasos, del más confiable al menos:
 *   1. CUIT exacto            — si está, no hay ambigüedad posible.
 *   2. Alias guardado         — alguien ya confirmó a mano que ese nombre es
 *                               ese proveedor. Es la memoria del sistema.
 *   3. Parecido de nombres    — lo de acá abajo.
 *
 * Y si nada da, recién ahí se crea uno nuevo.
 */

/** Formas jurídicas y ruido que no distinguen a nadie. */
const RUIDO = new Set([
  'srl', 'sa', 'sas', 'sh', 'scs', 'sca', 'sd', 'saic', 'saci', 'sacif',
  'sociedad', 'anonima', 'responsabilidad', 'limitada', 'colectiva',
  'y', 'e', 'de', 'del', 'la', 'las', 'el', 'los', 'cia', 'compania',
]);

/**
 * Nombre → forma canónica para comparar y para guardar como alias.
 * Minúsculas, sin acentos, sin puntuación, sin formas jurídicas.
 */
export function normalizarNombre(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // acentos
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    // Se descartan las letras sueltas: "S.R.L." se parte en "s r l" al sacar
    // la puntuación, y esas piezas no distinguen a nadie — solo ensucian el
    // alias guardado y desbalancean el conteo de tokens.
    .filter((t) => t.length > 1 && !RUIDO.has(t))
    .join(' ')
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(normalizarNombre(s).split(' ').filter(Boolean));
}

/**
 * ¿Son el mismo proveedor?
 *
 * Se usa CONTENCIÓN (compartido / el más chico de los dos), no Jaccard. Con
 * Jaccard, "grafipack san martin" vs "grafipack" da 0.33 y no matchea nunca —
 * que es justo el caso real que hay que resolver: el nombre del sistema suele
 * ser un subconjunto del de la factura.
 *
 * El piso de 5 caracteres en algún token compartido es lo que evita el falso
 * positivo obvio: "Distribuidora Sur" y "Distribuidora Norte" comparten
 * "distribuidora", pero la contención da 0.5 y no alcanza; y aunque alcanzara,
 * dos nombres que solo comparten una palabra genérica no son el mismo.
 */
export function puntajeParecido(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;

  const compartidos = [...ta].filter((t) => tb.has(t));
  if (compartidos.length === 0) return 0;
  // Al menos una palabra compartida tiene que ser DISTINTIVA. Sin esto,
  // "Panaderia Norte" y "Panaderia Sur" darian match.
  if (!compartidos.some((t) => t.length >= 5)) return 0;

  return compartidos.length / Math.min(ta.size, tb.size);
}

const PISO = 0.75;

export interface CandidatoProveedor {
  id: string;
  nombre: string;
  razonSocial?: string | null;
}

/**
 * Busca UN proveedor parecido entre los existentes.
 *
 * Devuelve null si no hay ninguno o si hay EMPATE entre varios: ante la duda
 * no se elige, se deja que lo decida un humano. Elegir mal es peor que no
 * elegir — mezcla la cuenta corriente de dos proveedores distintos, y eso se
 * descubre tarde y se limpia a mano.
 */
export function buscarProveedorParecido(
  nombreFactura: string,
  candidatos: CandidatoProveedor[],
): CandidatoProveedor | null {
  let mejor: { c: CandidatoProveedor; score: number } | null = null;
  let empatados = 0;

  for (const c of candidatos) {
    // Se prueba contra el nombre Y contra la razón social: el sistema puede
    // tener el nombre corto y la razón social larga, y la factura cualquiera
    // de los dos.
    const score = Math.max(
      puntajeParecido(nombreFactura, c.nombre),
      c.razonSocial ? puntajeParecido(nombreFactura, c.razonSocial) : 0,
    );
    if (score < PISO) continue;
    if (!mejor || score > mejor.score) {
      mejor = { c, score };
      empatados = 1;
    } else if (score === mejor.score) {
      empatados += 1;
    }
  }

  if (!mejor || empatados > 1) return null;
  return mejor.c;
}
