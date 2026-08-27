import type { Prisma } from '@sta/db';
import { EstadoFacturaRecibida } from '@sta/db';
import { calcSaldoFactura } from './facturas.js';
import { ReglaNegocioError } from './errores.js';

/**
 * IMPUTACIÓN DE PAGOS CONTRA FACTURAS DE PROVEEDOR.
 *
 * Una factura no es "pagada o impaga": se paga de a partes. El modelo ya lo
 * contempla (`totalPagado`, estado `PAGADA_PARCIAL`, `PagoFactura.montoAplicado`),
 * pero la lógica vivía suelta dentro de `POST /admin/egreso-a-proveedor`, así
 * que un egreso cargado desde "Aportes y egresos" —que es como la encargada
 * paga la mayoría de las veces— movía la plata y dejaba las facturas impagas.
 * El saldo del proveedor no bajaba nunca.
 *
 * Acá está esa lógica una sola vez, para que los dos caminos imputen igual.
 *
 * DOS MODOS:
 *  - Sin selección → FIFO sobre TODAS las facturas pendientes del proveedor.
 *  - Con selección → FIFO sobre las elegidas, respetando el monto que se haya
 *    fijado a mano para alguna de ellas.
 *
 * En los dos casos el reparto es el mismo: se va llenando de la más vieja a la
 * más nueva, así que las viejas quedan PAGADA y como mucho la última queda
 * PAGADA_PARCIAL. Lo que sobre (se pagó más que lo adeudado) queda como
 * excedente: plata a favor del proveedor, sin factura que la absorba.
 */

/** Lo mínimo que hace falta de una factura para repartir plata contra ella. */
export interface FacturaImputable {
  id: string;
  total: Prisma.Decimal | string | number;
  totalPagado: Prisma.Decimal | string | number;
}

/** Una factura elegida a mano. `monto` opcional: sin él, se llena por FIFO. */
export interface SeleccionFactura {
  facturaId: string;
  monto?: string;
}

export interface Asignacion {
  facturaId: string;
  montoAplicado: number;
}

/**
 * Extiende `ReglaNegocioError` para que el manejador de errores la devuelva
 * como 400 con el mensaje tal cual: son todos errores que la encargada puede
 * corregir sola (eligió mal, se pasó de monto), no fallas del sistema.
 */
export class ImputacionError extends ReglaNegocioError {}

const r2 = (n: number) => Number(n.toFixed(2));

/**
 * Facturas del proveedor que todavía deben plata, de la más vieja a la más
 * nueva. Ese orden ES la regla de imputación, no un detalle de presentación.
 */
export async function facturasPendientesDe(
  tx: Prisma.TransactionClient,
  proveedorId: string,
) {
  return tx.facturaRecibida.findMany({
    where: {
      proveedorId,
      estado: {
        in: [EstadoFacturaRecibida.PENDIENTE_PAGO, EstadoFacturaRecibida.PAGADA_PARCIAL],
      },
    },
    orderBy: [{ fechaEmision: 'asc' }, { numero: 'asc' }],
  });
}

/**
 * Reparte `montoTotal` entre las facturas. No toca la base: devuelve el plan
 * para que el llamador lo valide o lo muestre antes de aplicarlo.
 */
export function planificarImputacion(
  facturas: FacturaImputable[],
  montoTotal: number,
  seleccion?: SeleccionFactura[],
): { asignaciones: Asignacion[]; excedente: number } {
  const porId = new Map(facturas.map((f) => [f.id, f]));

  // Sin selección: FIFO sobre todo lo pendiente, en el orden en que vinieron.
  let candidatas = facturas;
  const montoFijado = new Map<string, number>();

  if (seleccion && seleccion.length > 0) {
    const elegidas: FacturaImputable[] = [];
    for (const s of seleccion) {
      const f = porId.get(s.facturaId);
      if (!f) {
        throw new ImputacionError(
          'Una de las facturas elegidas no está pendiente de pago para este proveedor. Volvé a abrir la pantalla: puede que alguien la haya pagado mientras tanto.',
        );
      }
      if (elegidas.some((e) => e.id === f.id)) {
        throw new ImputacionError('Elegiste la misma factura dos veces.');
      }
      elegidas.push(f);
      if (s.monto !== undefined) {
        const m = Number(s.monto);
        if (m <= 0) throw new ImputacionError('El monto de cada factura tiene que ser mayor a 0.');
        const saldo = calcSaldoFactura(f);
        // Tolerancia de un centavo: el front redondea a 2 decimales y pedir
        // exactitud absoluta haría fallar el caso normal de "pagar todo".
        if (m > saldo + 0.01) {
          throw new ImputacionError(
            `A esa factura le quedan $${saldo.toFixed(2)} y estás imputándole $${m.toFixed(2)}.`,
          );
        }
        montoFijado.set(f.id, m);
      }
    }
    // Se respeta el orden de las facturas (viejas primero), no el orden en que
    // el front las haya mandado.
    const idsElegidos = new Set(elegidas.map((e) => e.id));
    candidatas = facturas.filter((f) => idsElegidos.has(f.id));

    const sumaFijada = r2([...montoFijado.values()].reduce((a, b) => a + b, 0));
    if (sumaFijada > montoTotal + 0.01) {
      throw new ImputacionError(
        `Estás imputando $${sumaFijada.toFixed(2)} entre las facturas y el pago es de $${montoTotal.toFixed(2)}.`,
      );
    }
  }

  const asignaciones: Asignacion[] = [];
  let restante = montoTotal;

  // Primero lo fijado a mano: si el usuario dijo "a ésta $5.000", esa plata se
  // reserva antes de que el FIFO se la coma con una factura anterior.
  for (const f of candidatas) {
    const fijo = montoFijado.get(f.id);
    if (fijo === undefined) continue;
    asignaciones.push({ facturaId: f.id, montoAplicado: r2(fijo) });
    restante = r2(restante - fijo);
  }

  // El resto se reparte FIFO entre las que quedaron sin monto propio.
  for (const f of candidatas) {
    if (restante <= 0.01) break;
    if (montoFijado.has(f.id)) continue;
    const saldo = calcSaldoFactura(f);
    if (saldo <= 0.01) continue;
    const aplicar = Math.min(restante, saldo);
    asignaciones.push({ facturaId: f.id, montoAplicado: r2(aplicar) });
    restante = r2(restante - aplicar);
  }

  // Devolver en orden de factura (vieja → nueva) aunque el reparto haya ido en
  // dos pasadas: es como se muestra en pantalla y como se lee el audit.
  const orden = new Map(facturas.map((f, i) => [f.id, i]));
  asignaciones.sort((a, b) => (orden.get(a.facturaId) ?? 0) - (orden.get(b.facturaId) ?? 0));

  return { asignaciones, excedente: Math.max(0, restante) };
}

/**
 * Escribe el plan: `PagoFactura` por asignación, `totalPagado`/estado de cada
 * factura, y el link `MovimientoFactura`. Va DENTRO de la transacción del
 * movimiento: si el egreso se rollbackea, las facturas no pueden quedar
 * marcadas como pagadas.
 *
 * `pagoId` es opcional porque no todos los caminos crean un `Pago` (un egreso
 * simple de "Aportes y egresos" es sólo un `Movimiento`). Sin él la imputación
 * cuelga del movimiento, que es lo que la pantalla de facturas muestra.
 */
export async function aplicarImputacion(
  tx: Prisma.TransactionClient,
  args: {
    asignaciones: Asignacion[];
    facturas: FacturaImputable[];
    movimientoId: string;
    pagoId?: string;
    fecha: Date;
  },
) {
  const porId = new Map(args.facturas.map((f) => [f.id, f]));
  for (const a of args.asignaciones) {
    const f = porId.get(a.facturaId);
    if (!f) continue;

    if (args.pagoId) {
      await tx.pagoFactura.create({
        data: {
          pagoId: args.pagoId,
          facturaId: f.id,
          movimientoId: args.movimientoId,
          montoAplicado: a.montoAplicado.toFixed(2),
        },
      });
    }

    const totalPagadoNuevo = r2(Number(f.totalPagado) + a.montoAplicado);
    const saldoNuevo = Number(f.total) - totalPagadoNuevo;
    const nuevoEstado =
      saldoNuevo <= 0.01 ? EstadoFacturaRecibida.PAGADA : EstadoFacturaRecibida.PAGADA_PARCIAL;
    await tx.facturaRecibida.update({
      where: { id: f.id },
      data: {
        totalPagado: totalPagadoNuevo.toFixed(2),
        estado: nuevoEstado,
        pagadaAt: nuevoEstado === EstadoFacturaRecibida.PAGADA ? args.fecha : null,
      },
    });

    // `createMany` + skipDuplicates: la PK es (movimientoId, facturaId), y un
    // mismo movimiento puede tocar la misma factura una sola vez. Sin esto, un
    // pago que imputa dos veces a la misma factura reventaría por PK duplicada.
    await tx.movimientoFactura.createMany({
      data: [{ movimientoId: args.movimientoId, facturaId: f.id }],
      skipDuplicates: true,
    });
  }
}

/**
 * Igual que `aplicarImputacion`, pero cuando el pago vino repartido en varias
 * cuentas (una parte en efectivo, otra por transferencia): ahí no hay UN `Pago`
 * sino uno por cuenta, cada uno con su propio movimiento.
 *
 * Reparte cada asignación entre las líneas en orden, como dos punteros. Un
 * `PagoFactura` de $10.000 colgando de una línea de $3.000 sería mentira, y
 * después no habría forma de reconciliar el extracto de esa cuenta contra las
 * facturas que pagó.
 *
 * Ejemplo: factura A $8.000 y factura B $2.000, pagadas con $6.000 en efectivo
 * y $4.000 por transferencia →
 *   efectivo → A $6.000 · transferencia → A $2.000, B $2.000
 */
export async function aplicarImputacionRepartida(
  tx: Prisma.TransactionClient,
  args: {
    asignaciones: Asignacion[];
    facturas: FacturaImputable[];
    lineas: Array<{ movimientoId: string; pagoId: string; monto: number }>;
    fecha: Date;
  },
) {
  const porId = new Map(args.facturas.map((f) => [f.id, f]));

  let iLinea = 0;
  let restaEnLinea = args.lineas[0]?.monto ?? 0;
  let orden = 0;

  for (const a of args.asignaciones) {
    const f = porId.get(a.facturaId);
    if (!f) continue;

    let porRepartir = a.montoAplicado;
    while (porRepartir > 0.004 && iLinea < args.lineas.length) {
      const linea = args.lineas[iLinea]!;
      if (restaEnLinea <= 0.004) {
        iLinea += 1;
        restaEnLinea = args.lineas[iLinea]?.monto ?? 0;
        continue;
      }
      const trozo = r2(Math.min(porRepartir, restaEnLinea));
      await tx.pagoFactura.create({
        data: {
          pagoId: linea.pagoId,
          facturaId: f.id,
          movimientoId: linea.movimientoId,
          montoAplicado: trozo.toFixed(2),
          orden: orden++,
        },
      });
      await tx.movimientoFactura.createMany({
        data: [{ movimientoId: linea.movimientoId, facturaId: f.id }],
        skipDuplicates: true,
      });
      porRepartir = r2(porRepartir - trozo);
      restaEnLinea = r2(restaEnLinea - trozo);
    }

    const totalPagadoNuevo = r2(Number(f.totalPagado) + a.montoAplicado);
    const saldoNuevo = Number(f.total) - totalPagadoNuevo;
    const nuevoEstado =
      saldoNuevo <= 0.01 ? EstadoFacturaRecibida.PAGADA : EstadoFacturaRecibida.PAGADA_PARCIAL;
    await tx.facturaRecibida.update({
      where: { id: f.id },
      data: {
        totalPagado: totalPagadoNuevo.toFixed(2),
        estado: nuevoEstado,
        pagadaAt: nuevoEstado === EstadoFacturaRecibida.PAGADA ? args.fecha : null,
      },
    });
  }
}
