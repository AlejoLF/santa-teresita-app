/**
 * Delta (precio extra) de un SABOR resuelto CONTRA UNA LISTA DE PRECIOS.
 *
 * El modelo es "sólo excepciones": `OpcionModificador.deltaPrecio` es el delta
 * de catálogo y vale para todas las listas; `DeltaOpcionPorLista` lo pisa sólo
 * donde alguien lo editó a mano. Así, subir el precio de un sabor en el
 * catálogo sigue propagando a todas las listas menos las que tienen precio
 * propio — que es exactamente lo que se espera de una lista custom.
 *
 * Este módulo es la ÚNICA fuente de verdad del delta. Todo lo que cobre plata
 * (venta, encargo, remito) tiene que pasar por acá en vez de confiar en el
 * `deltaPrecio` que manda el front: el cliente puede mentir, y con listas por
 * cliente mayorista la diferencia ya no es cosmética.
 */

import { prisma } from '@sta/db/client';

export type DeltasResueltos = Map<string, number>;

/**
 * Delta efectivo de cada opción para `listaId`.
 *
 * Devuelve una entrada por cada `opcionId` que exista en la base. Las opciones
 * inexistentes quedan afuera del Map a propósito: quien cobra decide qué hacer
 * (hoy: tratarlas como delta 0, ver `deltaDeModificadores`).
 */
export async function resolverDeltasDeLista(
  listaId: string | null | undefined,
  opcionIds: string[],
): Promise<DeltasResueltos> {
  const ids = [...new Set(opcionIds.filter(Boolean))];
  const out: DeltasResueltos = new Map();
  if (ids.length === 0) return out;

  const opciones = await prisma.opcionModificador.findMany({
    where: { id: { in: ids } },
    select: { id: true, deltaPrecio: true },
  });
  for (const o of opciones) out.set(o.id, Number(o.deltaPrecio));

  if (listaId) {
    const overrides = await prisma.deltaOpcionPorLista.findMany({
      where: { listaId, opcionId: { in: ids } },
      select: { opcionId: true, deltaPrecio: true },
    });
    for (const d of overrides) out.set(d.opcionId, Number(d.deltaPrecio));
  }
  return out;
}

/** Un modificador tal como viaja en el body de una venta/encargo/remito. */
export interface ModificadorEntrada {
  opcionId?: string | null;
  deltaPrecio?: string | number | null;
}

/**
 * Suma de los deltas de una lista de modificadores, resuelta server-side.
 *
 * Dos reglas, las dos por incidentes reales:
 *
 * - **Piso en 0.** Un modificador SUMA (queso extra), nunca resta; un delta
 *   negativo llevaba el total a cero o abajo (A6 del acid-test de seguridad).
 *
 * - **Techo en el delta de la lista.** El front puede mandar MENOS que el
 *   precio de catálogo y se respeta —hay casos legítimos, como la salsa que ya
 *   viene incluida en la pasta y va con delta 0—, pero no puede mandar de más.
 *   Un modificador sin `opcionId` (etiqueta libre) no tiene precio con el que
 *   comparar: va 0.
 */
export function deltaDeModificadores(
  modificadores: ModificadorEntrada[],
  deltas: DeltasResueltos,
): number {
  let total = 0;
  for (const m of modificadores) {
    if (!m.opcionId) continue;
    const tope = deltas.get(m.opcionId);
    if (tope === undefined) continue; // opción inexistente → no se cobra
    const pedido = Number(m.deltaPrecio ?? tope);
    total += Math.min(Math.max(0, Number.isFinite(pedido) ? pedido : 0), Math.max(0, tope));
  }
  return total;
}

/** Junta los `opcionId` de una tanda de ítems, para pedir los deltas de una. */
export function opcionIdsDeItems(
  items: Array<{ modificadores?: ModificadorEntrada[] | null }>,
): string[] {
  const ids: string[] = [];
  for (const it of items) {
    for (const m of it.modificadores ?? []) {
      if (m.opcionId) ids.push(m.opcionId);
    }
  }
  return ids;
}
