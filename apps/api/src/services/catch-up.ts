import { prisma, createPrismaClientForUrl } from '@sta/db/client';
import { computeHashChain } from '@sta/shared/hash-chain';
import { config } from '../config.js';

/**
 * Catch-up Supabase → local tras un corte de luz (Fase 1.5,
 * docs/SERVIDOR-LOCAL.md §5.2 / §5.3).
 *
 * Durante un corte el server local está apagado; la PWA móvil escribe
 * ventas autoritativas a Supabase tageadas `audit_log.origen='cloud'`.
 * Al volver la luz, ANTES de reanudar la replicación forward, el server
 * absorbe esas filas:
 *
 *   1. Lee de Supabase los audit_log con origen='cloud' cuyo `id` (UUID)
 *      no existe todavía en el audit local → son los del corte.
 *   2. Para cada uno (orden por secuencia de Supabase), trae el grafo
 *      completo de la venta (sesión, cliente, venta, items, pagos,
 *      delivery) y hace upsert por PK en el local. Idempotente.
 *   3. Importa la fila de audit RE-CHAINEÁNDOLA en la secuencia LOCAL:
 *      `secuencia` local nueva, `secuencia_origen` = la de Supabase,
 *      hash recomputado contra el tail local con el salt local,
 *      `origen='cloud'` (marcador forense de que vino del corte).
 *
 * Como el import NO pasa por recordAudit, no genera outbox_events → no se
 * re-empuja a Supabase (no hay loop). Es 100% idempotente: si se corre dos
 * veces, las filas ya existen por PK y el filtro "no en local" las saltea.
 *
 * Sin merge concurrente: durante el corte el local estuvo apagado (cero
 * writes locales) → es un catch-up direccional, no una reconciliación.
 */

function log(m: string): void {
  console.log(`[catch-up] ${m}`);
}

type CloudAudit = {
  id: string;
  secuencia: bigint;
  tabla: string;
  registroId: string;
  accion: string;
  usuarioId: string | null;
  pcOrigen: string | null;
  valorAnterior: unknown;
  valorNuevo: unknown;
  contexto: unknown;
  observaciones: string | null;
  timestamp: Date;
};

/**
 * Trae de `source` (Supabase) los hijos FK-directos de una venta y los
 * sube por PK al local. La sesión/cliente pueden ya existir local (los
 * replicó Fase 1A antes del corte) → upsert es no-op idempotente.
 */
async function importarGrafoVenta(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: any,
  ventaId: string,
): Promise<void> {
  // sesión y cliente referenciados por la venta
  const venta = await source.venta.findUnique({ where: { id: ventaId } });
  if (!venta) {
    log(`venta ${ventaId} no está en Supabase (audit huérfano?) — skip`);
    return;
  }

  // 1. Sesión: si el local ya tiene una sesión con la misma (fecha,turno)
  //    pero DISTINTO id, NO importamos la de cloud (violaría @@unique):
  //    re-apuntamos la venta a la sesión local existente. Si no hay
  //    colisión, importamos la sesión de cloud tal cual.
  let sesionIdFinal = venta.sesionCajaId as string;
  if (venta.sesionCajaId) {
    const sesionCloud = await source.sesionCaja.findUnique({
      where: { id: venta.sesionCajaId },
    });
    if (sesionCloud) {
      const sesionLocalMismoId = await prisma.sesionCaja.findUnique({
        where: { id: sesionCloud.id },
        select: { id: true },
      });
      if (!sesionLocalMismoId) {
        const colision = await prisma.sesionCaja.findFirst({
          where: { fecha: sesionCloud.fecha, turno: sesionCloud.turno },
          select: { id: true },
        });
        if (colision) {
          sesionIdFinal = colision.id; // re-apuntar a la sesión local del turno
          log(
            `sesión ${sesionCloud.id} colisiona (fecha,turno) → venta ${ventaId} re-apuntada a ${colision.id}`,
          );
        } else {
          await prisma.sesionCaja.create({ data: sesionCloud });
        }
      }
    }
  }

  // 2. Cliente (si la venta referencia uno nuevo creado en el corte)
  if (venta.clienteId) {
    const cli = await source.cliente.findUnique({ where: { id: venta.clienteId } });
    if (cli) {
      await prisma.cliente.upsert({
        where: { id: cli.id },
        create: cli,
        update: cli,
      });
    }
  }

  // 3. Venta (con la sesión final, por si se re-apuntó)
  const ventaData = { ...venta, sesionCajaId: sesionIdFinal };
  await prisma.venta.upsert({
    where: { id: ventaId },
    create: ventaData,
    update: ventaData,
  });

  // 4. Hijos: items, pagos, delivery
  for (const tbl of ['itemVenta', 'pago', 'deliveryInfo'] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (source as any)[tbl].findMany({ where: { ventaId } });
    for (const r of rows) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any)[tbl].upsert({ where: { id: r.id }, create: r, update: r });
    }
  }
}

let running = false;

/**
 * Ejecuta el catch-up una vez. Devuelve cuántas filas de audit cloud se
 * absorbieron. Seguro de re-ejecutar (idempotente).
 */
export async function runCatchUp(): Promise<number> {
  if (running) return 0;
  if (config.STA_ROLE !== 'server' || !config.REPLICATE_TO_URL) return 0;
  running = true;
  const source = createPrismaClientForUrl(config.REPLICATE_TO_URL);
  try {
    // Audit cloud que el local todavía no tiene (por id UUID).
    const cloudAudits = (await source.auditLog.findMany({
      where: { origen: 'cloud' },
      orderBy: { secuencia: 'asc' },
      take: 1000,
    })) as unknown as CloudAudit[];
    if (cloudAudits.length === 0) return 0;

    const ids = cloudAudits.map((a) => a.id);
    const yaLocal = new Set(
      (
        await prisma.auditLog.findMany({
          where: { id: { in: ids } },
          select: { id: true },
        })
      ).map((r) => r.id),
    );
    const pendientes = cloudAudits.filter((a) => !yaLocal.has(a.id));
    if (pendientes.length === 0) return 0;

    log(`absorbiendo ${pendientes.length} ventas creadas durante el corte...`);
    let n = 0;
    for (const a of pendientes) {
      // Solo manejamos ventas de la PWA (tabla='ventas'). Otros tipos no
      // los genera la PWA en el corte.
      if (a.tabla === 'ventas') {
        await importarGrafoVenta(source, a.registroId);
      }
      // Re-chain del audit en la secuencia LOCAL.
      const tail = await prisma.auditLog.findFirst({
        orderBy: { secuencia: 'desc' },
        select: { hashActual: true },
      });
      const created = await prisma.auditLog.create({
        data: {
          id: a.id, // mismo UUID → idempotente entre corridas
          tabla: a.tabla,
          registroId: a.registroId,
          accion: a.accion,
          usuarioId: a.usuarioId,
          pcOrigen: a.pcOrigen,
          valorAnterior: (a.valorAnterior as never) ?? undefined,
          valorNuevo: (a.valorNuevo as never) ?? undefined,
          contexto: (a.contexto as never) ?? undefined,
          observaciones: a.observaciones,
          timestamp: a.timestamp,
          hashAnterior: tail?.hashActual ?? null,
          hashActual: 'pending',
          origen: 'cloud',
          secuenciaOrigen: a.secuencia,
        },
      });
      const hash = computeHashChain(
        tail?.hashActual ?? null,
        {
          secuencia: created.secuencia,
          tabla: a.tabla,
          registroId: a.registroId,
          accion: a.accion,
          valorAnterior: a.valorAnterior ?? null,
          valorNuevo: a.valorNuevo ?? null,
          usuarioId: a.usuarioId,
          timestamp: created.timestamp,
        },
        config.AUDIT_HASH_SALT,
      );
      await prisma.auditLog.update({
        where: { id: created.id },
        data: { hashActual: hash },
      });
      n++;
    }
    log(`✓ catch-up: ${n} ventas del corte absorbidas y re-chaineadas`);
    return n;
  } catch (e) {
    log(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  } finally {
    await source.$disconnect().catch(() => {});
    running = false;
  }
}
