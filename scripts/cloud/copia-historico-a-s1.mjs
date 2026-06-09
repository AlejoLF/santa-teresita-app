// Copia el histórico de Innovo de Supabase -> base LOCAL de S1.
// Correr EN S1, desde C:\sta-server\api  (ahí resuelve `pg`):
//     cd C:\sta-server\api
//     node ..\copia-historico-a-s1.mjs        (o la ruta donde lo dejes)
// Lee DATABASE_URL (local) y REPLICATE_TO_URL (Supabase) de C:\sta-server\.env.
// Idempotente (ON CONFLICT DO NOTHING). Reversible: las filas llevan
// origen='innovo' / sesion centinela.
import pkg from 'pg';
import fs from 'node:fs';
const { Pool } = pkg;

const env = Object.fromEntries(
  fs.readFileSync('C:/sta-server/.env', 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const localUrl = env.DATABASE_URL;
const cloudUrl = env.REPLICATE_TO_URL;
if (!localUrl || !cloudUrl) { console.error('Falta DATABASE_URL o REPLICATE_TO_URL en .env'); process.exit(1); }

const local = new Pool({ connectionString: localUrl, max: 4 });
const cloud = new Pool({ connectionString: cloudUrl, ssl: { rejectUnauthorized: false }, max: 4 });

const VCOLS = 'id,numero,numero_orden_turno,canal,modalidad,estado,cliente_id,lista_precios_id,subtotal,descuento_total,recargo_canal,total,total_pagado,pc_origen,usuario_apertura_id,usuario_cierre_id,usuario_anulacion_id,motivo_anulacion,sesion_caja_id,fecha_apertura,fecha_finalizacion,fecha_anulacion,observaciones,id_externo_canal,payload_externo,tiene_cocina,comanda_impresa,ticket_cliente_impreso,descuento_efectivo_aplicado,origen';
const VDEF = 'id uuid,numero int,numero_orden_turno int,canal text,modalidad text,estado text,cliente_id uuid,lista_precios_id uuid,subtotal numeric,descuento_total numeric,recargo_canal numeric,total numeric,total_pagado numeric,pc_origen text,usuario_apertura_id uuid,usuario_cierre_id uuid,usuario_anulacion_id uuid,motivo_anulacion text,sesion_caja_id uuid,fecha_apertura timestamp,fecha_finalizacion timestamp,fecha_anulacion timestamp,observaciones text,id_externo_canal text,payload_externo text,tiene_cocina boolean,comanda_impresa boolean,ticket_cliente_impreso boolean,descuento_efectivo_aplicado boolean,origen text';
const VSEL = 'id,numero,numero_orden_turno,canal::"CanalVenta",modalidad::"ModalidadVenta",estado::"EstadoVenta",cliente_id,lista_precios_id,subtotal,descuento_total,recargo_canal,total,total_pagado,pc_origen,usuario_apertura_id,usuario_cierre_id,usuario_anulacion_id,motivo_anulacion,sesion_caja_id,fecha_apertura,fecha_finalizacion,fecha_anulacion,observaciones,id_externo_canal,payload_externo::jsonb,tiene_cocina,comanda_impresa,ticket_cliente_impreso,descuento_efectivo_aplicado,origen';
const ICOLS = 'id,venta_id,producto_id,nombre_snapshot,cantidad,unidad,precio_unitario,delta_modificadores,subtotal,descuento_linea,total_linea,orden,cocina_interviene,creado_at';
const IDEF = 'id uuid,venta_id uuid,producto_id uuid,nombre_snapshot text,cantidad numeric,unidad text,precio_unitario numeric,delta_modificadores numeric,subtotal numeric,descuento_linea numeric,total_linea numeric,orden int,cocina_interviene boolean,creado_at timestamp';
const ISEL = 'id,venta_id,producto_id,nombre_snapshot,cantidad,unidad::"FormaVenta",precio_unitario,delta_modificadores,subtotal,descuento_linea,total_linea,orden,cocina_interviene,creado_at';

// Lee de cloud por keyset (id) y escribe a local por lotes.
async function copy(label, baseFrom, cols, def, sel, target, batch) {
  let last = '00000000-0000-0000-0000-000000000000', done = 0;
  for (;;) {
    const { rows } = await cloud.query(
      `SELECT row_to_json(t) j, t.id::text id FROM (${baseFrom} AND t.id > $1 ORDER BY t.id LIMIT ${batch}) t`,
      [last],
    );
    if (rows.length === 0) break;
    const json = JSON.stringify(rows.map((r) => r.j));
    await local.query(
      `INSERT INTO ${target} (${cols}) SELECT ${sel} FROM json_to_recordset($1::json) AS x(${def}) ON CONFLICT (id) DO NOTHING`,
      [json],
    );
    last = rows[rows.length - 1].id; done += rows.length;
    if (done % (batch * 10) === 0) console.log(`  ${label}: ${done}`);
  }
  console.log(`✓ ${label}: ${done}`);
}

try {
  console.log('1) Esquema (origen + sesion nullable + check, idempotente)...');
  await local.query(`ALTER TABLE ventas ADD COLUMN IF NOT EXISTS origen varchar(20)`);
  await local.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS origen varchar(20)`);
  await local.query(`ALTER TABLE ventas ALTER COLUMN sesion_caja_id DROP NOT NULL`);
  await local.query(`ALTER TABLE ventas DROP CONSTRAINT IF EXISTS ventas_sesion_o_origen_chk`);
  await local.query(`ALTER TABLE ventas ADD CONSTRAINT ventas_sesion_o_origen_chk CHECK (sesion_caja_id IS NOT NULL OR origen = 'innovo')`);

  console.log('2) 10 productos nuevos (postres + otros)...');
  await copy('productos', `SELECT id,tipo_producto_id,nombre,forma_venta::text,precio_base,unidad_precio::text,codigo,activo FROM productos t WHERE (codigo LIKE 'POS-%' OR codigo='OTROS-HIST')`,
    'id,tipo_producto_id,nombre,forma_venta,precio_base,unidad_precio,codigo,activo',
    'id uuid,tipo_producto_id uuid,nombre text,forma_venta text,precio_base numeric,unidad_precio text,codigo text,activo boolean',
    'id,tipo_producto_id,nombre,forma_venta::"FormaVenta",precio_base,unidad_precio::"UnidadPrecio",codigo,activo', 'productos', 50);

  console.log('3) Sesión centinela...');
  await copy('sesion', `SELECT id,fecha,turno::text,horario_apertura,horario_cierre,existencia_inicial,existencia_final,usuario_apertura_id,usuario_cierre_id,aprobada_por_admin,estado::text,ultimo_numero_orden,observaciones,cerrada_anticipadamente FROM sesiones_caja t WHERE id='00000000-0000-0000-0000-000000000099'`,
    'id,fecha,turno,horario_apertura,horario_cierre,existencia_inicial,existencia_final,usuario_apertura_id,usuario_cierre_id,aprobada_por_admin,estado,ultimo_numero_orden,observaciones,cerrada_anticipadamente',
    'id uuid,fecha date,turno text,horario_apertura timestamp,horario_cierre timestamp,existencia_inicial numeric,existencia_final numeric,usuario_apertura_id uuid,usuario_cierre_id uuid,aprobada_por_admin boolean,estado text,ultimo_numero_orden int,observaciones text,cerrada_anticipadamente boolean',
    'id,fecha,turno::"TurnoCaja",horario_apertura,horario_cierre,existencia_inicial,existencia_final,usuario_apertura_id,usuario_cierre_id,aprobada_por_admin,estado::"EstadoSesionCaja",ultimo_numero_orden,observaciones,cerrada_anticipadamente', 'sesiones_caja', 10);

  console.log('4) Ventas históricas (217K)...');
  await copy('ventas', `SELECT ${VCOLS.split(',').map((c)=>'t.'+c).join(',')} FROM ventas t WHERE t.origen='innovo'`, VCOLS, VDEF, VSEL, 'ventas', 1000);

  console.log('5) Items históricos (453K)...');
  await copy('items', `SELECT ${ICOLS.split(',').map((c)=>'t.'+c).join(',')} FROM items_venta t JOIN ventas v ON v.id=t.venta_id WHERE v.origen='innovo'`, ICOLS, IDEF, ISEL, 'items_venta', 2500);

  const chk = (await local.query(`SELECT count(*)::int v FROM ventas WHERE origen='innovo'`)).rows[0];
  const chi = (await local.query(`SELECT count(*)::int i FROM items_venta i JOIN ventas v ON v.id=i.venta_id WHERE v.origen='innovo'`)).rows[0];
  console.log(`\n✓ EN S1-LOCAL: ${chk.v} ventas históricas, ${chi.i} items.`);
} catch (e) {
  console.error('ERROR:', e.message); process.exitCode = 1;
} finally {
  await local.end(); await cloud.end();
}
