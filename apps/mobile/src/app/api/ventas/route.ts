import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';
import { requireSession } from '@/lib/auth';
import { query } from '@/lib/db';

/**
 * GET /api/ventas?periodo=hoy|semana|mes&canal=RAPPI&q=teresa
 * Devuelve hasta 100 ventas finalizadas filtradas. Diseñado para la lista
 * scrolleable del mobile.
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(req.url);
  const periodo = url.searchParams.get('periodo') ?? 'mes';
  const canal = url.searchParams.get('canal');
  const q = url.searchParams.get('q')?.trim();

  const intervalSql =
    periodo === 'hoy'
      ? 'fecha_finalizacion >= CURRENT_DATE'
      : periodo === 'semana'
        ? "fecha_finalizacion >= (CURRENT_DATE - INTERVAL '7 days')"
        : "fecha_finalizacion >= (CURRENT_DATE - INTERVAL '30 days')";

  const conds: string[] = ["v.estado = 'FINALIZADA'", `v.${intervalSql}`];
  const params: unknown[] = [];
  if (canal) {
    params.push(canal);
    conds.push(`v.canal = $${params.length}`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    conds.push(
      `(LOWER(COALESCE(c.nombre, '')) LIKE $${params.length} OR LOWER(COALESCE(c.telefono, '')) LIKE $${params.length})`,
    );
  }

  const rows = await query<{
    id: string;
    numero: number;
    total: string;
    canal: string;
    modalidad: string;
    fecha: string;
    cliente: string;
    items_count: number;
  }>(
    `
    SELECT
      v.id::text,
      v.numero,
      v.total::text,
      v.canal::text AS canal,
      v.modalidad::text AS modalidad,
      v.fecha_finalizacion::text AS fecha,
      COALESCE(c.nombre || COALESCE(' ' || c.apellido, ''), 'NN') AS cliente,
      (SELECT COUNT(*)::int FROM items_venta i WHERE i.venta_id = v.id) AS items_count
    FROM ventas v
    LEFT JOIN clientes c ON c.id = v.cliente_id
    WHERE ${conds.join(' AND ')}
    ORDER BY v.fecha_finalizacion DESC
    LIMIT 100
    `,
    params,
  );

  return NextResponse.json({ ventas: rows });
}

/**
 * POST /api/ventas — venta express creada desde el PWA mobile.
 *
 * Body:
 *   {
 *     items: Array<{
 *       productoId: string;
 *       cantidad: number;             // siempre en unidad principal
 *       opcionId?: string;            // sabor seleccionado (modificador)
 *       opcionNombre?: string;        // snapshot para nombre legible
 *       precioUnitario: string;       // ya con delta del modificador
 *       observacion?: string;
 *     }>;
 *     cobro: {
 *       metodo: MetodoPago;
 *       cuentaId?: string;            // si no viene, resolvemos por método
 *       monto: string;
 *       cambioDado?: string;
 *       numeroReferencia?: string;
 *     };
 *     canal: CanalVenta;
 *     modalidad: ModalidadVenta;
 *     cliente?: { nombre: string; telefono?: string };
 *     direccion?: { calle: string; numero: string; observaciones?: string };
 *     observaciones?: string;
 *   }
 *
 * Diferencias vs desktop:
 *   - Single-shot: crea venta + items + pago + finaliza en una transacción.
 *   - No imprime comanda (no hay impresora en mobile).
 *   - No genera audit hash-chain (la sincronización inversa lo va a reconciliar).
 *   - Aplica descuento 10% efectivo si metodo === 'EFECTIVO' (regla del local).
 *
 * Limitaciones:
 *   - Solo single-method. Multi-pago se hace desde desktop.
 *   - Sin combos.
 *   - Sin modificadores múltiples (1 sabor por item).
 */

interface VentaItemBody {
  productoId: string;
  cantidad: number;
  opcionId?: string;
  opcionNombre?: string;
  precioUnitario: string;
  observacion?: string;
}

interface VentaBody {
  items: VentaItemBody[];
  cobro: {
    metodo: string;
    cuentaId?: string;
    monto: string;
    cambioDado?: string;
    numeroReferencia?: string;
  };
  canal: string;
  modalidad: string;
  cliente?: { nombre: string; telefono?: string };
  direccion?: { calle: string; numero: string; observaciones?: string };
  observaciones?: string;
}

const METODOS_VALIDOS = [
  'EFECTIVO',
  'DEBITO',
  'CREDITO_1_PAGO',
  'CREDITO_CUOTAS',
  'TRANSFERENCIA',
  'DEPOSITO',
  'MERCADOPAGO_QR',
  'CHEQUE',
  'TARJETA_NARANJA',
  'OTRO',
];

const CANALES_VALIDOS = [
  'MOSTRADOR',
  'TELEFONO',
  'WHATSAPP',
  'WEB',
  'RAPPI',
  'PEDIDOS_YA',
  'MERCADO_LIBRE',
  'DELIVERATE',
];

const MODALIDADES_VALIDAS = [
  'TAKE_AWAY',
  'DELIVERY_PROPIO',
  'DELIVERY_PLATAFORMA',
  'DELIVERY_DELIVERATE',
];

let pool: Pool | null = null;
function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.SUPABASE_DB_URL_POOLED;
  if (!url) throw new Error('SUPABASE_DB_URL_POOLED no configurada');
  pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

export async function POST(req: NextRequest) {
  let session;
  try {
    session = await requireSession();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  let body: VentaBody;
  try {
    body = (await req.json()) as VentaBody;
  } catch {
    return NextResponse.json({ error: 'Body JSON inválido' }, { status: 400 });
  }

  // Validación básica
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: 'Carrito vacío' }, { status: 400 });
  }
  if (!METODOS_VALIDOS.includes(body.cobro?.metodo)) {
    return NextResponse.json({ error: 'Método de pago inválido' }, { status: 400 });
  }
  if (!CANALES_VALIDOS.includes(body.canal)) {
    return NextResponse.json({ error: 'Canal inválido' }, { status: 400 });
  }
  if (!MODALIDADES_VALIDAS.includes(body.modalidad)) {
    return NextResponse.json({ error: 'Modalidad inválida' }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    // 1) Sesión caja: turno = MAÑANA si hora <14, TARDE si no.
    //    Reuse sesión ABIERTA del día/turno o creamos una nueva.
    const ahora = new Date();
    const hora = ahora.getHours();
    const turno = hora < 14 ? 'MANANA' : 'TARDE';

    const sesionExistente = await client.query<{ id: string }>(
      `SELECT id::text FROM sesiones_caja
       WHERE fecha = CURRENT_DATE AND turno = $1 AND estado = 'ABIERTA'
       LIMIT 1`,
      [turno],
    );
    let sesionId: string;
    if (sesionExistente.rows.length > 0) {
      sesionId = sesionExistente.rows[0].id;
    } else {
      const nuevaSesion = await client.query<{ id: string }>(
        `INSERT INTO sesiones_caja (id, fecha, turno, horario_apertura, existencia_inicial, usuario_apertura_id, estado)
         VALUES (gen_random_uuid(), CURRENT_DATE, $1, NOW(), 0, $2, 'ABIERTA')
         RETURNING id::text`,
        [turno, session.userId],
      );
      sesionId = nuevaSesion.rows[0].id;
    }

    // 2) Lista de precios por defecto (la primera activa)
    const lista = await client.query<{ id: string }>(
      `SELECT id::text FROM listas_precios WHERE activa = true ORDER BY nombre LIMIT 1`,
    );
    if (lista.rows.length === 0) {
      throw new Error('No hay listas de precios activas');
    }
    const listaPreciosId = lista.rows[0].id;

    // 3) Cuenta para el pago: si viene cuentaId la usamos; sino resolvemos por método.
    let cuentaId = body.cobro.cuentaId;
    if (!cuentaId) {
      // Heurística: EFECTIVO → "Caja", MERCADOPAGO_QR → "MercadoPago",
      // TRANSFERENCIA/DEPOSITO → "Santander". Si no hay match, primera activa.
      const metodoToCuenta: Record<string, string[]> = {
        EFECTIVO: ['Caja', 'caja'],
        MERCADOPAGO_QR: ['MercadoPago', 'mercadopago', 'MP'],
        TRANSFERENCIA: ['Santander', 'Galicia'],
        DEPOSITO: ['Santander', 'Galicia'],
      };
      const candidatos = metodoToCuenta[body.cobro.metodo] ?? [];
      if (candidatos.length > 0) {
        const placeholders = candidatos.map((_, i) => `$${i + 1}`).join(',');
        const cuenta = await client.query<{ id: string }>(
          `SELECT id::text FROM cuentas WHERE activa = true AND nombre IN (${placeholders}) LIMIT 1`,
          candidatos,
        );
        if (cuenta.rows.length > 0) cuentaId = cuenta.rows[0].id;
      }
      if (!cuentaId) {
        const cualquiera = await client.query<{ id: string }>(
          `SELECT id::text FROM cuentas WHERE activa = true ORDER BY nombre LIMIT 1`,
        );
        if (cualquiera.rows.length === 0) throw new Error('No hay cuentas activas');
        cuentaId = cualquiera.rows[0].id;
      }
    }

    // 4) Cliente: si viene { nombre, telefono }, upsert por teléfono o creo nuevo
    let clienteId: string | null = null;
    if (body.cliente?.nombre) {
      if (body.cliente.telefono) {
        const existente = await client.query<{ id: string }>(
          `SELECT id::text FROM clientes WHERE telefono = $1 LIMIT 1`,
          [body.cliente.telefono],
        );
        if (existente.rows.length > 0) {
          clienteId = existente.rows[0].id;
        }
      }
      if (!clienteId) {
        const nuevoCliente = await client.query<{ id: string }>(
          `INSERT INTO clientes (id, tipo, nombre, telefono)
           VALUES (gen_random_uuid(), 'CASUAL', $1, $2)
           RETURNING id::text`,
          [body.cliente.nombre, body.cliente.telefono ?? null],
        );
        clienteId = nuevoCliente.rows[0].id;
      }
    }

    // 5) Compute subtotal + descuento. Regla del local: efectivo = -10%.
    let subtotal = 0;
    for (const item of body.items) {
      subtotal += Number(item.precioUnitario) * item.cantidad;
    }
    const aplicaDescEfectivo = body.cobro.metodo === 'EFECTIVO';
    const descuento = aplicaDescEfectivo ? Math.round(subtotal * 0.10 * 100) / 100 : 0;
    const total = subtotal - descuento;

    // 6) Numero de orden del turno (atómico)
    const numOrden = await client.query<{ ultimo_numero_orden: number }>(
      `UPDATE sesiones_caja
       SET ultimo_numero_orden = ultimo_numero_orden + 1
       WHERE id = $1
       RETURNING ultimo_numero_orden`,
      [sesionId],
    );
    const numeroOrdenTurno = numOrden.rows[0].ultimo_numero_orden;

    // 7) Insert venta (FINALIZADA directamente)
    const tieneCocina = body.items.some((it) => it.opcionId); // heurística simple
    const ventaIns = await client.query<{ id: string; numero: number }>(
      `INSERT INTO ventas (
        id, numero_orden_turno, canal, modalidad, estado, cliente_id, lista_precios_id,
        subtotal, descuento_total, total, total_pagado,
        pc_origen, usuario_apertura_id, usuario_cierre_id,
        sesion_caja_id, fecha_apertura, fecha_finalizacion,
        observaciones, tiene_cocina, descuento_efectivo_aplicado
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, 'FINALIZADA', $4, $5,
        $6, $7, $8, $8,
        'mobile-pwa', $9, $9,
        $10, NOW(), NOW(),
        $11, $12, $13
      )
      RETURNING id::text, numero`,
      [
        numeroOrdenTurno,
        body.canal,
        body.modalidad,
        clienteId,
        listaPreciosId,
        subtotal,
        descuento,
        total,
        session.userId,
        sesionId,
        body.observaciones ?? null,
        tieneCocina,
        aplicaDescEfectivo,
      ],
    );
    const ventaId = ventaIns.rows[0].id;
    const ventaNumero = ventaIns.rows[0].numero;

    // 8) Items
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i];
      // snapshot del nombre — leemos producto + opcion
      const prod = await client.query<{
        nombre: string;
        forma_venta: string;
        cocina_interviene: boolean;
      }>(
        `SELECT p.nombre, p.forma_venta::text AS forma_venta, tp.cocina_interviene
         FROM productos p
         JOIN tipos_producto tp ON tp.id = p.tipo_producto_id
         WHERE p.id = $1`,
        [item.productoId],
      );
      if (prod.rows.length === 0) {
        throw new Error(`Producto no encontrado: ${item.productoId}`);
      }
      const nombreSnap = item.opcionNombre
        ? `${prod.rows[0].nombre} (${item.opcionNombre})`
        : prod.rows[0].nombre;
      const subtotalLinea =
        Math.round(Number(item.precioUnitario) * item.cantidad * 100) / 100;
      const modificadores = item.opcionId
        ? JSON.stringify([
            { opcionId: item.opcionId, nombre: item.opcionNombre, deltaPrecio: 0 },
          ])
        : null;

      await client.query(
        `INSERT INTO items_venta (
           id, venta_id, producto_id, nombre_snapshot, cantidad, unidad, precio_unitario,
           modificadores_aplicados, delta_modificadores, subtotal, total_linea,
           observacion, orden, cocina_interviene
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, $4, $5::"FormaVenta", $6,
           $7::jsonb, 0, $8, $8,
           $9, $10, $11
         )`,
        [
          ventaId,
          item.productoId,
          nombreSnap,
          item.cantidad,
          prod.rows[0].forma_venta,
          item.precioUnitario,
          modificadores,
          subtotalLinea,
          item.observacion ?? null,
          i,
          prod.rows[0].cocina_interviene,
        ],
      );
    }

    // 9) Pago
    const monto = Number(body.cobro.monto || total);
    const cambio = Number(body.cobro.cambioDado || 0);
    await client.query(
      `INSERT INTO pagos (
         id, venta_id, metodo, cuenta_id, monto, cambio_dado, numero_referencia, estado, fecha
       ) VALUES (
         gen_random_uuid(), $1, $2::"MetodoPago", $3, $4, $5, $6, 'CONFIRMADO', NOW()
       )`,
      [ventaId, body.cobro.metodo, cuentaId, monto, cambio, body.cobro.numeroReferencia ?? null],
    );

    // 10) Delivery info si corresponde
    if (
      (body.modalidad === 'DELIVERY_PROPIO' ||
        body.modalidad === 'DELIVERY_PLATAFORMA' ||
        body.modalidad === 'DELIVERY_DELIVERATE') &&
      body.direccion
    ) {
      const direccionSnap = JSON.stringify({
        calle: body.direccion.calle,
        numero: body.direccion.numero,
        observaciones: body.direccion.observaciones ?? null,
      });
      await client.query(
        `INSERT INTO delivery_info (id, venta_id, direccion_snapshot, estado)
         VALUES (gen_random_uuid(), $1, $2::jsonb, 'PENDIENTE')`,
        [ventaId, direccionSnap],
      );
    }

    await client.query('COMMIT');

    return NextResponse.json({
      ok: true,
      ventaId,
      numero: ventaNumero,
      numeroOrdenTurno,
      total,
      descuento,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    const msg = e instanceof Error ? e.message : 'Error desconocido';
    console.error('[ventas POST]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
