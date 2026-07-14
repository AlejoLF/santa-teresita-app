/**
 * Búsqueda de texto libre client-side: ¿alguno de los campos contiene el término?
 *
 * Espeja el criterio de los buscadores server-side (Prisma `contains` insensible
 * a mayúsculas). Se usa para que los filtros que corren sobre listas ya cargadas
 * (POS, encargos, remitos, combos) matcheen por TODOS los campos disponibles y no
 * solo por nombre — así buscar una marca trae todos sus productos.
 *
 * @param termino  lo que tipeó el usuario (se normaliza a minúsculas + trim).
 * @param campos   valores donde buscar (nombre, marca, código, etc.). Ignora
 *                 null/undefined. También acepta arrays de strings (ej. sabores).
 * @returns true si el término está vacío (no filtra) o si matchea algún campo.
 */
export function coincideBusqueda(
  termino: string,
  ...campos: Array<string | null | undefined | Array<string | null | undefined>>
): boolean {
  const t = termino.trim().toLowerCase();
  if (!t) return true;
  for (const campo of campos) {
    if (Array.isArray(campo)) {
      if (campo.some((c) => (c ?? '').toLowerCase().includes(t))) return true;
    } else if ((campo ?? '').toLowerCase().includes(t)) {
      return true;
    }
  }
  return false;
}
