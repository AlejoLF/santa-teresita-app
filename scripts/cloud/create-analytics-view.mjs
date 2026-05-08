/**
 * Crea la VIEW `analytics_ventas` en la cloud DB para que Julio pueda
 * consultar el negocio vía MCP/LLM sin tener que entender el modelo
 * normalizado completo.
 *
 * Diseño:
 *   - VIEW (no MATERIALIZED) → siempre fresca, sin refresh.
 *   - JOINs sobre `ventas`, `clientes`, `usuarios`, `pagos`, `cuentas`,
 *     `items_venta`, `delivery_info`.
 *   - Una fila por venta.
 *   - Productos + pagos como JSONB array (rico para el LLM).
 *   - Productos también como string concat (para queries quick tipo
 *     "ventas con ravioles" → ILIKE).
 *
 * Crea ADEMÁS:
 *   - Rol DB `julio_analytics` (LOGIN, no superuser).
 *   - Password generada al crear el rol; se devuelve en stdout para que el
 *     dueño la copie al MCP de su Claude/ChatGPT.
 *   - Grant SELECT solo sobre la VIEW (no sobre las tablas raíz).
 *   - Si el rol ya existe, no recrea password — usa el mismo. Si querés
 *     rotarla, dropeá el rol primero (DROP ROLE julio_analytics).
 *
 * Idempotente: re-ejecutable sin efectos colaterales.
 */

import { Client } from 'pg';
import { randomBytes } from 'node:crypto';
import { pooledUrl, maskUrl } from './_url.mjs';

const VIEW_SQL = `
-- ─── analytics_ventas: VIEW desnormalizada para queries de Julio ─────
CREATE OR REPLACE VIEW public.analytics_ventas AS
SELECT
  -- Identidad
  v.id                                AS venta_id,
  v.numero                            AS numero,
  v.numero_orden_turno                AS numero_orden,
  v.estado                            AS estado,
  v.canal                             AS canal,
  v.modalidad                         AS modalidad,

  -- Tiempos
  v.fecha_apertura::date              AS fecha,
  v.fecha_apertura::time              AS hora,
  v.fecha_apertura                    AS timestamp_apertura,
  v.fecha_finalizacion                AS timestamp_cierre,
  v.fecha_anulacion                   AS timestamp_anulacion,
  EXTRACT(DOW FROM v.fecha_apertura)::int  AS dia_semana,  -- 0=domingo
  EXTRACT(HOUR FROM v.fecha_apertura)::int AS hora_del_dia,

  -- Cliente
  COALESCE(c.nombre || COALESCE(' ' || c.apellido, ''), 'NN')
                                      AS cliente_nombre,
  c.telefono                          AS cliente_telefono,
  c.tipo                              AS cliente_tipo,
  (c.id IS NOT NULL AND c.tipo <> 'CASUAL')
                                      AS cliente_recurrente,

  -- Vendedor
  u_apert.nombre                      AS vendedor_nombre,
  u_cierre.nombre                     AS cerrado_por,
  u_anul.nombre                       AS anulado_por,
  v.motivo_anulacion                  AS motivo_anulacion,

  -- Financiero
  v.subtotal                          AS subtotal,
  v.descuento_total                   AS descuento,
  v.recargo_canal                     AS recargo_canal,
  v.total                             AS total,
  v.total_pagado                      AS total_pagado,
  v.descuento_efectivo_aplicado       AS descuento_efectivo,

  -- Pagos: array detallado + string resumen
  (SELECT json_agg(json_build_object(
     'metodo', p.metodo,
     'cuenta', cu.nombre,
     'monto', p.monto,
     'cambio_dado', p.cambio_dado,
     'tarjeta_ultimos_4', p.tarjeta_ultimos4,
     'numero_referencia', p.numero_referencia,
     'titular', p.titular,
     'banco', p.banco
   ) ORDER BY p.fecha) FROM public.pagos p
   LEFT JOIN public.cuentas cu ON cu.id = p.cuenta_id
   WHERE p.venta_id = v.id)          AS pagos,

  (SELECT string_agg(DISTINCT p.metodo::text, ' + ' ORDER BY p.metodo::text)
   FROM public.pagos p WHERE p.venta_id = v.id)
                                      AS metodos_pago,

  -- Items: array detallado + string resumen + cantidad
  (SELECT json_agg(json_build_object(
     'producto', i.nombre_snapshot,
     'cantidad', i.cantidad,
     'unidad', i.unidad,
     'precio_unitario', i.precio_unitario,
     'total_linea', i.total_linea,
     'modificadores', COALESCE(
       (SELECT string_agg(m->>'opcionNombre', ', ' ORDER BY ord)
        FROM jsonb_array_elements(i.modificadores_aplicados) WITH ORDINALITY AS arr(m, ord)
        WHERE m ? 'opcionNombre'),
       ''
     ),
     'observacion', i.observacion,
     'cocina', i.cocina_interviene
   ) ORDER BY i.orden) FROM public.items_venta i
   WHERE i.venta_id = v.id)          AS productos,

  (SELECT string_agg(
     i.nombre_snapshot ||
     CASE WHEN i.cantidad <> 1 THEN ' x' || i.cantidad::text ELSE '' END,
     ' | ' ORDER BY i.orden
   ) FROM public.items_venta i WHERE i.venta_id = v.id)
                                      AS productos_resumen,

  (SELECT count(*)::int FROM public.items_venta i WHERE i.venta_id = v.id)
                                      AS cantidad_items,

  -- Delivery
  (v.modalidad::text LIKE 'DELIVERY%')          AS es_delivery,
  d.direccion_snapshot->>'direccion'            AS direccion_entrega,
  d.empresa_externa                             AS empresa_delivery,
  d.hora_prometida                              AS hora_prometida,
  d.hora_salida                                 AS hora_salida,
  d.hora_entrega                                AS hora_entrega,
  d.estado                                      AS estado_delivery,
  CASE WHEN d.hora_entrega IS NOT NULL
       THEN EXTRACT(EPOCH FROM (d.hora_entrega - v.fecha_apertura))::int / 60
       ELSE NULL
  END                                           AS demora_delivery_min,

  -- Auditoría / contexto extra
  v.observaciones                     AS observaciones,
  v.id_externo_canal                  AS id_orden_externa,
  v.tiene_cocina                      AS tiene_cocina,
  v.pc_origen                         AS pc_origen

FROM public.ventas v
LEFT JOIN public.clientes c          ON c.id = v.cliente_id
LEFT JOIN public.usuarios u_apert    ON u_apert.id = v.usuario_apertura_id
LEFT JOIN public.usuarios u_cierre   ON u_cierre.id = v.usuario_cierre_id
LEFT JOIN public.usuarios u_anul     ON u_anul.id = v.usuario_anulacion_id
LEFT JOIN public.delivery_info d     ON d.venta_id = v.id;

COMMENT ON VIEW public.analytics_ventas IS
  'Vista desnormalizada de ventas para queries analíticas (Julio vía MCP). Una fila por venta.';
`;

const ROLE_NAME = 'julio_analytics';

async function setupRole(client) {
  // Si ya existe, dejarlo. Si no, crear con password random.
  const exists = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [ROLE_NAME]);
  let password = null;
  if (exists.rowCount === 0) {
    password = randomBytes(18).toString('base64url'); // ~24 chars URL-safe
    // El nombre del rol no se puede parametrizar — sanitizado a constante arriba.
    await client.query(
      `CREATE ROLE ${ROLE_NAME} WITH LOGIN PASSWORD '${password.replace(/'/g, "''")}'`,
    );
    console.log(`  ✓ Rol ${ROLE_NAME} creado con password nueva`);
  } else {
    console.log(`  ✓ Rol ${ROLE_NAME} ya existe — password preservada`);
  }

  // Permisos: SELECT solo sobre la view, NADA más en public.
  // Si alguna vez agregamos otra view "analytics_*", también dale SELECT acá.
  await client.query(`REVOKE ALL ON SCHEMA public FROM ${ROLE_NAME}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${ROLE_NAME}`);
  await client.query(`GRANT SELECT ON public.analytics_ventas TO ${ROLE_NAME}`);

  return password;
}

async function main() {
  const url = pooledUrl();
  console.log(`▸ Pooler: ${maskUrl(url)}\n`);
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('▸ Creando VIEW analytics_ventas...');
  await client.query(VIEW_SQL);
  console.log('  ✓ View aplicada');

  // Sanity: la view se puede leer
  const sample = await client.query(`SELECT count(*)::int as n FROM public.analytics_ventas`);
  console.log(`  ✓ ${sample.rows[0].n} filas accesibles via la view`);

  console.log('\n▸ Setup rol read-only julio_analytics...');
  const password = await setupRole(client);

  await client.end();

  if (password) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('CREDENCIALES PARA EL MCP DE JULIO (guardar 1 vez):');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  user:     ${ROLE_NAME}`);
    console.log(`  password: ${password}`);
    console.log(`  host:     aws-1-sa-east-1.pooler.supabase.com`);
    console.log(`  port:     6543`);
    console.log(`  database: postgres`);
    console.log('  schema:   public');
    console.log('  acceso:   SELECT-only sobre analytics_ventas');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n⚠ COPIÁ ESTO AHORA — no se vuelve a mostrar.');
    console.log('  Si la perdés, dropeá el rol y re-ejecutá este script:');
    console.log('  pnpm cloud:status && DROP ROLE julio_analytics; -- en SQL Editor');
  } else {
    console.log('\ni Para rotar la password de julio_analytics:');
    console.log('  1) Conectate al SQL Editor de Supabase y corré: DROP ROLE julio_analytics;');
    console.log('  2) Re-ejecutá: pnpm cloud:create-analytics-view');
    console.log('  3) Te imprime una nueva password aleatoria.');
  }

  console.log('\n✓ analytics_ventas + julio_analytics listos');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
