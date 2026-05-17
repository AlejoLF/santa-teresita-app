import { z } from 'zod';

/**
 * Parser de booleans para querystrings.
 *
 * GOTCHA que esto resuelve: `z.coerce.boolean()` usa `Boolean(value)` de JS.
 * Los query params SIEMPRE llegan como string, y `Boolean("false") === true`
 * (cualquier string no vacío es truthy). Resultado: `?incluirInactivos=false`
 * se interpretaba como `true` y el filtro `{ activo: true }` NUNCA se aplicaba
 * — los registros inactivos quedaban siempre visibles. Bug reportado en el
 * catálogo (toggle "mostrar inactivos" sin efecto), presente también en
 * clientes/empleados/proveedores/combos.
 *
 * `queryBool` interpreta correctamente: solo "true" / "1" → true. Acepta el
 * param ausente (undefined) y aplica el default.
 */
export const queryBool = (def = false) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      if (v === undefined) return def;
      return v === 'true' || v === '1';
    });
