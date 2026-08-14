import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@sta/db';
import { prisma } from '@sta/db/client';
import { config } from '../config.js';
import { recordAudit } from '../services/audit.js';

/**
 * Ingesta de máquina — facturas leídas por OCR (n8n local en el server +
 * Ollama). Crea la factura en PENDIENTE_VALIDACION (gate de aprobación humana)
 * con origen TELEGRAM_OCR. NO toca el flujo de pago: cero movimientos de cuenta
 * hasta que un humano valide y luego pague por el flujo existente.
 *
 * Auth: Bearer = INGEST_API_TOKEN (token de máquina, NO una sesión de usuario).
 * Solo esta ruta lo acepta → mínimo blast radius.
 *
 * Idempotencia en 3 capas (n8n puede reintentar sin miedo):
 *   1. adjuntoHash (sha256 del archivo) — la MISMA foto reenviada no duplica.
 *   2. @@unique(proveedor, puntoVenta, numero, tipoComprobante) — el MISMO
 *      comprobante re-OCR'd (otra foto, misma factura) no duplica.
 *   En ambos casos devuelve 200 { duplicate:true, id } en vez de crear.
 */

const monto = z
  .union([z.number(), z.string()])
  .transform((v) => String(v))
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), 'monto inválido');

const BodySchema = z.object({
  // Hash sha256 del archivo (lo computa n8n). Si no viene, lo derivamos del
  // ocr.payload — pero conviene mandarlo: es la idempotencia más fuerte.
  adjunto: z
    .object({ hash: z.string().min(8).max(80).optional(), url: z.string().url().max(1000).optional() })
    .default({}),
  proveedor: z.object({
    nombre: z.string().min(1).max(120),
    cuit: z.string().max(20).optional(),
    razonSocial: z.string().max(160).optional(),
  }),
  comprobante: z.object({
    tipo: z
      .enum([
        'FACTURA_A', 'FACTURA_B', 'FACTURA_C', 'FACTURA_X',
        'NOTA_CREDITO', 'NOTA_DEBITO', 'TICKET', 'REMITO', 'OTRO',
      ])
      .default('OTRO'),
    puntoVenta: z.string().max(20).optional(),
    numero: z.string().min(1).max(40),
    fechaEmision: z.string(), // YYYY-MM-DD (o ISO)
    fechaVencimiento: z.string().optional(),
    cuitEmisor: z.string().max(20).optional(),
    razonSocialEmisor: z.string().max(160).optional(),
  }),
  montos: z
    .object({
      neto: monto.optional(),
      ivaTotal: monto.optional(),
      iva21: monto.optional(),
      iva10_5: monto.optional(),
      iva27: monto.optional(),
      otrosImpuestos: monto.optional(),
      total: monto,
    })
    .default({ total: '0' }),
  items: z
    .array(
      z.object({
        descripcion: z.string().min(1).max(240),
        cantidad: monto.default('1'),
        unidad: z.string().min(1).max(20).default('u'),
        precioUnitario: monto.default('0'),
        alicuotaIva: monto.default('21'),
        subtotal: monto,
      }),
    )
    .default([]),
  ocr: z
    .object({
      confianza: z.coerce.number().min(0).max(1).optional(),
      // payload crudo del modelo (lo guardamos tal cual para forense/debug).
      payload: z.unknown().optional(),
    })
    .default({}),
  observaciones: z.string().max(2000).optional(),
});
type Body = z.infer<typeof BodySchema>;

/** Compara el Bearer con INGEST_API_TOKEN en tiempo constante. */
function tokenOk(req: FastifyRequest): boolean {
  const expected = config.INGEST_API_TOKEN;
  if (!expected) return false;
  const got = req.headers['authorization']?.replace(/^Bearer\s+/i, '') ?? '';
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/** Resuelve el proveedor (por CUIT, luego por nombre) o lo crea. Idempotente. */
async function resolverProveedor(p: Body['proveedor']): Promise<string> {
  if (p.cuit) {
    const porCuit = await prisma.proveedor.findFirst({ where: { cuit: p.cuit }, select: { id: true } });
    if (porCuit) return porCuit.id;
  }
  const porNombre = await prisma.proveedor.findFirst({
    where: { nombre: { equals: p.nombre, mode: 'insensitive' } },
    select: { id: true },
  });
  if (porNombre) return porNombre.id;
  try {
    const nuevo = await prisma.proveedor.create({
      data: {
        nombre: p.nombre,
        cuit: p.cuit ?? null,
        razonSocial: p.razonSocial ?? null,
        activo: true,
      },
      select: { id: true },
    });
    // El audit NO es decorativo acá: es lo que genera el evento de outbox que
    // replica la fila a Supabase. Sin esto, el proveedor nuevo se quedaba solo
    // en el Postgres de S1 y la factura que lo referencia fallaba al replicar
    // con violación de FK — reintentando 25 veces hasta que el replicator la
    // abandonaba. Síntoma: la factura entraba bien en S1, el bot contestaba
    // "cargada", y en la nube no aparecía nunca. Incidente real: 2026-08-14.
    //
    // Va ANTES del audit de la factura (menor `secuencia`), así el replicador
    // aplica primero el proveedor y después la factura, que es el único orden
    // que respeta la FK.
    await recordAudit({
      tabla: 'proveedores',
      registroId: nuevo.id,
      accion: 'INSERT',
      usuarioId: null,
      valorNuevo: { nombre: p.nombre, cuit: p.cuit ?? null },
      contexto: { fuente: 'ingest-ocr', motivo: 'proveedor nuevo detectado por OCR' },
    });
    return nuevo.id;
  } catch (e) {
    // Carrera: otro request creó el mismo nombre (unique). Re-buscamos.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const again = await prisma.proveedor.findFirst({
        where: { nombre: { equals: p.nombre, mode: 'insensitive' } },
        select: { id: true },
      });
      if (again) return again.id;
    }
    throw e;
  }
}

export default async function ingestRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/ingest/facturas',
    { schema: { body: BodySchema } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!config.INGEST_API_TOKEN) {
        return reply.code(503).send({ error: 'Ingesta deshabilitada (falta INGEST_API_TOKEN)' });
      }
      if (!tokenOk(req)) {
        return reply.code(401).send({ error: 'Token de ingesta inválido' });
      }
      const body = req.body as Body;

      // Hash de idempotencia: el del archivo, o uno derivado del contenido OCR.
      const hash =
        body.adjunto.hash ??
        createHash('sha256')
          .update(JSON.stringify({ p: body.proveedor.nombre, n: body.comprobante.numero, t: body.montos.total }))
          .digest('hex')
          .slice(0, 64);

      // Capa 1: misma foto/contenido ya ingerido.
      const yaPorHash = await prisma.facturaRecibida.findFirst({
        where: { adjuntoHash: hash },
        select: { id: true, estado: true },
      });
      if (yaPorHash) {
        return reply.code(200).send({ duplicate: true, motivo: 'adjuntoHash', ...yaPorHash });
      }

      const proveedorId = await resolverProveedor(body.proveedor);
      const fechaEm = new Date(body.comprobante.fechaEmision);

      try {
        const factura = await prisma.$transaction(async (tx) => {
          const f = await tx.facturaRecibida.create({
            data: {
              proveedorId,
              tipoComprobante: body.comprobante.tipo as never,
              puntoVenta: body.comprobante.puntoVenta ?? null,
              numero: body.comprobante.numero,
              cuitEmisor: body.comprobante.cuitEmisor ?? body.proveedor.cuit ?? null,
              razonSocialEmisor: body.comprobante.razonSocialEmisor ?? body.proveedor.razonSocial ?? null,
              fechaEmision: fechaEm,
              fechaComputo: fechaEm,
              fechaVencimiento: body.comprobante.fechaVencimiento ? new Date(body.comprobante.fechaVencimiento) : null,
              netoGravado: body.montos.neto ?? '0',
              iva21: body.montos.iva21 ?? body.montos.ivaTotal ?? '0',
              iva10_5: body.montos.iva10_5 ?? '0',
              iva27: body.montos.iva27 ?? '0',
              otrosImpuestos: body.montos.otrosImpuestos ?? '0',
              total: body.montos.total,
              // estado PENDIENTE_VALIDACION = default → gate de aprobación humana.
              origen: 'TELEGRAM_OCR',
              adjuntoUrl: body.adjunto.url ?? null,
              adjuntoHash: hash,
              ocrPayload: (body.ocr.payload as never) ?? undefined,
              ocrConfianza: body.ocr.confianza != null ? body.ocr.confianza.toFixed(4) : null,
              observaciones: body.observaciones ?? null,
              // usuarioCargaId NULL → carga de máquina. El origen ya lo marca.
              items: {
                create: body.items.map((it, idx) => ({
                  descripcion: it.descripcion,
                  cantidad: it.cantidad,
                  unidad: it.unidad,
                  precioUnitario: it.precioUnitario,
                  alicuotaIva: it.alicuotaIva,
                  subtotal: it.subtotal,
                  orden: idx,
                })),
              },
            },
            select: {
              id: true,
              estado: true,
              total: true,
              numero: true,
              // Los ids de los items hacen falta para auditarlos uno por uno
              // (ver abajo por que).
              items: { select: { id: true }, orderBy: { orden: 'asc' } },
            },
          });

          await recordAudit({
            tabla: 'facturas_recibidas',
            registroId: f.id,
            accion: 'INSERT',
            usuarioId: null,
            valorNuevo: { numero: f.numero, total: f.total.toString(), origen: 'TELEGRAM_OCR' },
            contexto: { fuente: 'ingest-ocr', confianza: body.ocr.confianza ?? null },
            tx,
          });

          // Un audit POR ITEM. `facturas_recibidas_items` es OTRA tabla, y el
          // replicador replica fila por fila a partir de los eventos de
          // outbox: sin evento propio, los renglones se quedaban en S1 y en la
          // nube la factura aparecia con "Productos (0)" aunque el OCR los
          // hubiera leido perfecto. Mismo bug que el del proveedor, un nivel
          // mas abajo. Incidente real: 2026-08-14 (factura de GRAFIPACK).
          //
          // Van DESPUES del audit de la factura (mayor `secuencia`), que es el
          // orden que respeta la FK item -> factura al replicar.
          for (const it of f.items) {
            await recordAudit({
              tabla: 'facturas_recibidas_items',
              registroId: it.id,
              accion: 'INSERT',
              usuarioId: null,
              contexto: { fuente: 'ingest-ocr', facturaId: f.id },
              tx,
            });
          }
          return f;
        });

        return reply.code(201).send({
          ok: true,
          id: factura.id,
          estado: factura.estado,
          // Link de revisión para el humano (lo usa n8n para responder en Telegram).
          reviewPath: `/admin/facturas/${factura.id}`,
        });
      } catch (e) {
        // Capa 2: mismo comprobante (proveedor+pv+numero+tipo) ya existe.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const existente = await prisma.facturaRecibida.findFirst({
            where: {
              proveedorId,
              puntoVenta: body.comprobante.puntoVenta ?? null,
              numero: body.comprobante.numero,
              tipoComprobante: body.comprobante.tipo as never,
            },
            select: { id: true, estado: true },
          });
          if (existente) {
            return reply.code(200).send({ duplicate: true, motivo: 'comprobante', ...existente });
          }
        }
        throw e;
      }
    },
  );
}
