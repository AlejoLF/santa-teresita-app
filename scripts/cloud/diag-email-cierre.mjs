/**
 * Diagnóstico (SÓLO LECTURA) de la cola del email del cierre de caja en
 * Supabase. Para cuando "lo mandé desde el celular y no llegó nada".
 *
 * Qué muestra:
 *   1. Los últimos pedidos de envío (envios_email_cierre): estado, intentos,
 *      origen, error y a qué sesión corresponden. Los emails van enmascarados
 *      (sólo el dominio): el log de Actions lo ve cualquiera con acceso al repo.
 *   2. Si S1 está vivo y replicando: lo último que llegó a Supabase desde el
 *      local (audit_log con origen 'local' y la última venta).
 *   3. Las últimas sesiones con su marca de "email enviado".
 *
 * Cómo leerlo:
 *   - PENDIENTE con intentos = 0 → S1 nunca lo tomó (S1 apagado, sin la versión
 *     nueva, o sin conexión a Supabase).
 *   - PENDIENTE/ERROR con intentos > 0 → S1 lo intentó y el correo falló: el
 *     motivo está en ultimo_error.
 *   - ENVIADO → salió: buscar en spam o revisar el destinatario.
 *
 * Uso: Actions → "Cloud Diag" → Run workflow (o local con SUPABASE_DB_URL_POOLED).
 */
import { Client } from 'pg';
import { pooledUrl, maskUrl } from './_url.mjs';

const AR = 'America/Argentina/Buenos_Aires';
const hora = (d) => (d ? new Date(d).toLocaleString('es-AR', { timeZone: AR, hour12: false }) : '—');
const enmascarar = (emails) =>
  (emails ?? [])
    .map((e) => String(e).replace(/^[^@]*/, '***'))
    .join(', ') || '(los de siempre)';
const hace = (d) => {
  if (!d) return '';
  const min = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  return min < 60 ? `hace ${min} min` : `hace ${Math.round(min / 60)} h`;
};

const url = pooledUrl();
console.log(`▸ Supabase: ${maskUrl(url)}\n`);
const client = new Client({
  connectionString: url,
  // PGSSLMODE=disable sólo para probarlo contra una base local.
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});
await client.connect();
await client.query('SET TRANSACTION READ ONLY').catch(() => {});

try {
  const existe = await client.query(`SELECT to_regclass('public.envios_email_cierre') AS t`);
  if (!existe.rows[0].t) {
    console.log('✗ La tabla envios_email_cierre NO existe en Supabase: falta correr Cloud Migrate.');
  } else {
    const envios = await client.query(`
      SELECT e.creado_at, e.estado, e.intentos, e.origen, e.automatico, e.ultimo_error,
             e.proximo_intento_at, e.enviado_at, e.destinatarios,
             s.fecha AS sesion_fecha, s.turno AS sesion_turno
        FROM envios_email_cierre e
        LEFT JOIN sesiones_caja s ON s.id = e.sesion_caja_id
       ORDER BY e.creado_at DESC
       LIMIT 20`);
    console.log(`═══ Pedidos de envío en Supabase (${envios.rowCount}, los más nuevos primero) ═══`);
    if (envios.rowCount === 0) console.log('  (ninguno: el pedido del celular no llegó a guardarse en la nube)');
    for (const r of envios.rows) {
      const sesion = r.sesion_fecha
        ? `${new Date(r.sesion_fecha).toISOString().slice(0, 10)} ${r.sesion_turno}`
        : '(sesión no encontrada en Supabase)';
      console.log(
        `• pedido ${hora(r.creado_at)} (${hace(r.creado_at)}) · cierre ${sesion} · ${r.estado} · ` +
          `intentos ${r.intentos} · origen ${r.origen}${r.automatico ? ' (automático)' : ''} · a ${enmascarar(r.destinatarios)}`,
      );
      if (r.enviado_at) console.log(`    enviado ${hora(r.enviado_at)}`);
      else if (r.estado === 'PENDIENTE') console.log(`    próximo intento ${hora(r.proximo_intento_at)}`);
      if (r.ultimo_error) console.log(`    último error: ${String(r.ultimo_error).slice(0, 300)}`);
    }
  }

  console.log('\n═══ ¿S1 está vivo y replicando? ═══');
  const audit = await client.query(
    `SELECT max(timestamp) AS ultimo FROM audit_log WHERE origen = 'local'`,
  );
  const venta = await client.query(`SELECT max(fecha_apertura) AS ultimo FROM ventas`);
  console.log(`  último registro replicado desde el local: ${hora(audit.rows[0].ultimo)} (${hace(audit.rows[0].ultimo)})`);
  console.log(`  última venta en Supabase:                 ${hora(venta.rows[0].ultimo)} (${hace(venta.rows[0].ultimo)})`);

  console.log('\n═══ Últimas sesiones cerradas y su email ═══');
  const ses = await client.query(`
    SELECT fecha, turno, estado, horario_cierre, email_enviado_at, email_enviado_a
      FROM sesiones_caja WHERE estado IN ('CERRADA','APROBADA')
     ORDER BY fecha DESC, turno DESC LIMIT 6`);
  for (const s of ses.rows) {
    console.log(
      `  ${new Date(s.fecha).toISOString().slice(0, 10)} ${s.turno} · ${s.estado} · cerró ${hora(s.horario_cierre)} · ` +
        (s.email_enviado_at
          ? `email ${hora(s.email_enviado_at)} a ${enmascarar(String(s.email_enviado_a ?? '').split(','))}`
          : 'sin email registrado'),
    );
  }
} finally {
  await client.end();
}
