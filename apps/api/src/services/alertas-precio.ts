/**
 * "Este producto aumentó un X%".
 *
 * Cuando entra una factura, cada ítem trae su precio unitario. Si difiere del
 * último precio conocido de ese insumo con ese proveedor, se levanta un aviso
 * para la encargada.
 *
 * ── Por qué el precio NO se actualiza solo ───────────────────────────────
 *
 * Un aumento puede ser real, pero también puede ser que el OCR leyó mal, que
 * vino otra presentación (5 kg en vez de 1 kg), o que la factura trae un
 * recargo puntual. Actualizar en silencio ensucia el costo de todo lo que usa
 * ese insumo, y eso no se descubre hasta que la rentabilidad no cierra —
 * meses después y sin rastro de cuándo empezó.
 *
 * Así que el aviso queda PENDIENTE. Recién cuando alguien lo aprueba se toca
 * el precio del sistema y, si se pide, el del Excel.
 *
 * ── También se avisa cuando BAJA ─────────────────────────────────────────
 *
 * Una baja inesperada casi nunca es una buena noticia: suele ser un error de
 * lectura o un cambio de presentación que nadie registró. Avisar solo de las
 * subas dejaría pasar justo el caso que más ensucia el costeo.
 */

import { prisma } from '@sta/db/client';
import type { Prisma } from '@sta/db';

/**
 * Umbral por defecto: por debajo de esto no se molesta a nadie.
 *
 * 2% deja pasar el ruido de redondeo (un precio unitario que sale de dividir
 * un total por una cantidad con decimales nunca da exacto) sin dejar pasar un
 * aumento de verdad, que en este rubro arranca en 5-10%.
 */
export const UMBRAL_PCT_DEFAULT = 2;

export interface AlertaDetectada {
  insumoId: string;
  insumoNombre: string;
  proveedorId: string;
  precioAnterior: number;
  precioNuevo: number;
  variacionPct: number;
}

/**
 * Revisa los ítems de una factura y levanta los avisos que correspondan.
 *
 * Idempotente por factura: si ya hay un aviso PENDIENTE para el mismo insumo y
 * proveedor, no se crea otro — se actualiza el precio nuevo. Sin esto, tres
 * facturas seguidas del mismo proveedor dejaban tres avisos del mismo producto
 * y la pantalla se volvía inusable.
 */
export async function detectarAumentos(args: {
  facturaId: string;
  umbralPct?: number;
  tx?: Prisma.TransactionClient;
}): Promise<AlertaDetectada[]> {
  const db = args.tx ?? prisma;
  const umbral = args.umbralPct ?? UMBRAL_PCT_DEFAULT;

  const factura = await db.facturaRecibida.findUnique({
    where: { id: args.facturaId },
    select: {
      proveedorId: true,
      items: {
        select: {
          id: true,
          insumoId: true,
          precioUnitario: true,
          insumo: { select: { nombre: true } },
        },
      },
    },
  });
  if (!factura) return [];

  const conInsumo = factura.items.filter((i) => i.insumoId);
  if (conInsumo.length === 0) return [];

  const vinculos = await db.insumoProveedor.findMany({
    where: {
      proveedorId: factura.proveedorId,
      insumoId: { in: conInsumo.map((i) => i.insumoId!) },
    },
    select: { insumoId: true, precioUltimo: true },
  });
  const precioPrevio = new Map(
    vinculos.filter((v) => v.precioUltimo != null).map((v) => [v.insumoId, Number(v.precioUltimo)]),
  );

  const detectadas: AlertaDetectada[] = [];

  for (const item of conInsumo) {
    const anterior = precioPrevio.get(item.insumoId!);
    const nuevo = Number(item.precioUnitario);
    // Sin precio anterior no hay con qué comparar: es la primera compra. Se
    // registra el precio y listo, no es un aumento.
    if (anterior == null || anterior <= 0 || !Number.isFinite(nuevo) || nuevo <= 0) {
      if (nuevo > 0) {
        await db.insumoProveedor.upsert({
          where: { insumoId_proveedorId: { insumoId: item.insumoId!, proveedorId: factura.proveedorId } },
          create: {
            insumoId: item.insumoId!,
            proveedorId: factura.proveedorId,
            precioUltimo: nuevo.toFixed(2),
            fechaUltimoPrecio: new Date(),
          },
          update: { precioUltimo: nuevo.toFixed(2), fechaUltimoPrecio: new Date() },
        });
      }
      continue;
    }

    const variacion = ((nuevo - anterior) / anterior) * 100;
    if (Math.abs(variacion) < umbral) continue;

    const yaHay = await db.alertaPrecioInsumo.findFirst({
      where: {
        insumoId: item.insumoId!,
        proveedorId: factura.proveedorId,
        estado: 'PENDIENTE',
      },
      select: { id: true },
    });

    if (yaHay) {
      await db.alertaPrecioInsumo.update({
        where: { id: yaHay.id },
        data: {
          precioNuevo: nuevo.toFixed(4),
          variacionPct: variacion.toFixed(4),
          facturaItemId: item.id,
          detectadaAt: new Date(),
        },
      });
    } else {
      await db.alertaPrecioInsumo.create({
        data: {
          insumoId: item.insumoId!,
          proveedorId: factura.proveedorId,
          facturaItemId: item.id,
          precioAnterior: anterior.toFixed(4),
          precioNuevo: nuevo.toFixed(4),
          variacionPct: variacion.toFixed(4),
        },
      });
    }

    detectadas.push({
      insumoId: item.insumoId!,
      insumoNombre: item.insumo?.nombre ?? '',
      proveedorId: factura.proveedorId,
      precioAnterior: anterior,
      precioNuevo: nuevo,
      variacionPct: Math.round(variacion * 100) / 100,
    });
  }

  return detectadas;
}

/** El texto que ve la encargada. En criollo, no en jerga. */
export function textoAlerta(a: {
  insumoNombre: string;
  variacionPct: number;
  precioAnterior: number;
  precioNuevo: number;
}): string {
  const pct = Math.abs(a.variacionPct).toFixed(1).replace('.0', '');
  const verbo = a.variacionPct > 0 ? 'aumentó' : 'bajó';
  const fmt = (n: number) => `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
  return `${a.insumoNombre} ${verbo} un ${pct}%: de ${fmt(a.precioAnterior)} a ${fmt(a.precioNuevo)}.`;
}
