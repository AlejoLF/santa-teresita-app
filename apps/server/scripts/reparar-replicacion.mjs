/**
 * Diagnostica y repara la cola de replicación local → Supabase.
 *
 * ── El problema que resuelve ──────────────────────────────────────────────
 * El replicador manda filas a la nube a partir de los eventos de `outbox_events`,
 * que los genera `recordAudit`. Si una fila se crea SIN auditar, nunca viaja: y
 * cuando después llega un hijo que la referencia, la nube rechaza el INSERT por
 * violación de FK. Ese evento reintenta 25 veces y queda abandonado.
 *
 * A partir de ahí el registro existe SOLO en S1: en el programa se ve, en la
 * nube no. Es silencioso — nadie se entera hasta que alguien mira la pantalla
 * equivocada. Incidente real: 2026-08-14, 5 facturas por OCR cuyos proveedores
 * nuevos no se auditaban.
 *
 * ── Por qué no alcanza con reintentar ─────────────────────────────────────
 * Resetear `intentos = 0` NO arregla nada por sí solo: el padre sigue sin
 * existir en la nube y la FK vuelve a fallar. Y auditar el padre ahora tampoco
 * alcanza, porque el replicador ordena cada lote por `secuencia`: el evento
 * nuevo del padre tendría una secuencia MÁS ALTA que la del hijo viejo, así que
 * el hijo se intentaría primero y fallaría igual.
 *
 * Por eso este script copia los padres faltantes directamente a la nube (el
 * mismo upsert por PK que hace el replicador) ANTES de reactivar los eventos.
 * Se hace en forma recursiva: un padre puede tener a su vez un padre faltante.
 *
 * ── Uso (en S1, desde C:\sta-server) ──────────────────────────────────────
 *   node api\reparar-replicacion.mjs             → diagnóstico, no escribe nada
 *   node api\reparar-replicacion.mjs --aplicar   → repara
 *
 * Es idempotente: correrlo dos veces no duplica nada (todo es upsert por PK).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient, Prisma } from '@prisma/client';

const APLICAR = process.argv.slice(2).includes('--aplicar');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── .env ────────────────────────────────────────────────────────────────────
// El script vive en C:\sta-server\api\, el .env en C:\sta-server\. Se prueban
// las dos ubicaciones para que ande igual corriéndolo desde cualquiera de las
// dos carpetas.
function cargarEnv() {
  const candidatos = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '.env'),
  ];
  for (const p of candidatos) {
    if (!fs.existsSync(p)) continue;
    for (const linea of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (/^\s*(#|$)/.test(linea)) continue;
      const i = linea.indexOf('=');
      if (i < 0) continue;
      const k = linea.slice(0, i).trim();
      const v = linea.slice(i + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
    return p;
  }
  return null;
}

const envPath = cargarEnv();
const LOCAL_URL = process.env.DATABASE_URL;
const CLOUD_URL = process.env.REPLICATE_TO_URL;
if (!LOCAL_URL) {
  console.error('Falta DATABASE_URL' + (envPath ? ` (leí ${envPath})` : ' y no encontré ningún .env'));
  process.exit(1);
}
if (!CLOUD_URL) {
  console.error('Falta REPLICATE_TO_URL: este server no replica a la nube, no hay nada que reparar.');
  process.exit(1);
}

const local = new PrismaClient({ datasources: { db: { url: LOCAL_URL } } });
const nube = new PrismaClient({ datasources: { db: { url: CLOUD_URL } } });

// ── Mapas del DMMF (cubren TODOS los modelos, sin hardcodear) ───────────────
const porTabla = new Map(); // nombre de tabla (@@map) → modelo del DMMF
const porModelo = new Map(); // nombre del modelo → modelo del DMMF
for (const m of Prisma.dmmf.datamodel.models) {
  porTabla.set(m.dbName ?? m.name, m);
  porModelo.set(m.name, m);
}
const delegado = (m) => m.name.charAt(0).toLowerCase() + m.name.slice(1);

/**
 * Padres de una fila: por cada relación saliente, qué modelo y qué id.
 * `relationFromFields` son los campos escalares que forman la FK; si están en
 * null, la relación es opcional y no hay padre que verificar.
 */
function padresDe(modelo, fila) {
  const out = [];
  for (const f of modelo.fields) {
    if (f.kind !== 'object' || !f.relationFromFields?.length) continue;
    // Guarda defensiva: hoy el schema no tiene ni una FK compuesta (verificado
    // sobre el DMMF), así que esto nunca descarta nada. Si algún día aparece
    // una, este script la ignora en vez de romperse — y hay que extenderlo.
    if (f.relationFromFields.length !== 1) continue;
    const id = fila[f.relationFromFields[0]];
    if (id == null) continue;
    const destino = porModelo.get(f.type);
    if (destino) out.push({ modelo: destino, id, via: f.relationFromFields[0] });
  }
  return out;
}

/**
 * ¿Está esta fila en la nube, con todos sus ancestros? Si `escribir`, la copia.
 * Recursivo: un padre faltante puede tener a su vez un padre faltante.
 * `vistos` corta los ciclos (una tabla puede referenciarse a sí misma).
 */
async function asegurar(modelo, id, escribir, vistos, copiadas) {
  const clave = `${modelo.name}:${id}`;
  if (vistos.has(clave)) return true;
  vistos.add(clave);

  const d = delegado(modelo);
  const enNube = await nube[d].findUnique({ where: { id } }).catch(() => null);
  if (enNube) return true;

  const fila = await local[d].findUnique({ where: { id } });
  if (!fila) {
    console.log(`    ⚠ ${modelo.name} ${id} tampoco existe en S1 — se borró después. Nada que copiar.`);
    return false;
  }

  // Primero los ancestros, después esta fila: es el orden que respeta la FK.
  for (const p of padresDe(modelo, fila)) {
    await asegurar(p.modelo, p.id, escribir, vistos, copiadas);
  }

  copiadas.push(`${modelo.name} ${id}`);
  if (escribir) {
    await nube[d].upsert({ where: { id }, create: fila, update: fila });
  }
  return true;
}

/**
 * Relaciones a-muchos: qué modelo hijo, y con qué campo apunta acá.
 * Del lado del padre el campo es una lista sin FK; la FK vive en el hijo, así
 * que se la busca por `relationName`.
 */
function hijosDe(modelo) {
  const out = [];
  for (const f of modelo.fields) {
    if (f.kind !== 'object' || !f.isList) continue;
    const hijo = porModelo.get(f.type);
    if (!hijo) continue;
    const vuelta = hijo.fields.find(
      (g) => g.kind === 'object' && g.relationName === f.relationName && g.relationFromFields?.length === 1,
    );
    if (!vuelta) continue; // relación N-N con tabla intermedia: fuera de alcance
    out.push({ modelo: hijo, fk: vuelta.relationFromFields[0] });
  }
  return out;
}

/**
 * Los hijos de una fila que existen en S1 y NO en la nube.
 *
 * Hace falta porque el agujero no es solo el evento trabado: los renglones de
 * esas facturas se crearon con el server viejo, que tampoco los auditaba. O sea
 * que no tienen un evento pendiente — directamente NO TIENEN evento. Reactivar
 * el de la factura la haría aparecer en la nube con "Productos (0)", que es la
 * mitad del arreglo y la peor: parece resuelto y no lo está.
 *
 * Solo se aplica a la fila del evento, NO a los padres que se copian de paso:
 * bajar por los hijos de un Proveedor arrastraría todas sus facturas y remitos.
 */
async function asegurarHijos(modelo, id, escribir, vistos, copiadas) {
  const clave = `hijos:${modelo.name}:${id}`;
  if (vistos.has(clave)) return;
  vistos.add(clave);

  for (const h of hijosDe(modelo)) {
    const d = delegado(h.modelo);
    const locales = await local[d].findMany({ where: { [h.fk]: id } });
    for (const fila of locales) {
      const enNube = await nube[d].findUnique({ where: { id: fila.id } }).catch(() => null);
      if (!enNube) {
        copiadas.push(`${h.modelo.name} ${fila.id}`);
        if (escribir) await nube[d].upsert({ where: { id: fila.id }, create: fila, update: fila });
      }
      // Nietos: para los ítems no hay, pero termina solo y cubre el caso general.
      await asegurarHijos(h.modelo, fila.id, escribir, vistos, copiadas);
    }
  }
}

/**
 * "Proveedor <uuid>, FacturaItemRecibida <uuid>, FacturaItemRecibida <uuid>…"
 * → "1 Proveedor, 1 FacturaRecibida, 7 FacturaItemRecibida".
 *
 * Con 7 renglones por factura, listar los UUID uno por uno tapa la pantalla y
 * esconde lo único que se lee de un vistazo: QUÉ y CUÁNTO. Los ids siguen en
 * la DB si hay que rastrear alguno.
 */
function resumirCopiadas(copiadas) {
  const conteo = new Map();
  for (const c of copiadas) {
    const modelo = c.split(' ')[0];
    conteo.set(modelo, (conteo.get(modelo) ?? 0) + 1);
  }
  return [...conteo].map(([m, n]) => `${n} ${m}`).join(', ');
}

// ── Main ────────────────────────────────────────────────────────────────────
const pendientes = await local.outboxEvent.findMany({
  where: { publicadoAt: null },
  orderBy: { agregadoAt: 'asc' },
});

if (pendientes.length === 0) {
  console.log('✅ No hay eventos pendientes. La replicación está al día.');
  await local.$disconnect();
  await nube.$disconnect();
  process.exit(0);
}

console.log(
  `${pendientes.length} evento(s) pendiente(s)` +
    (APLICAR ? ' — modo APLICAR (va a escribir en la nube)\n' : ' — solo diagnóstico, no se escribe nada\n'),
);

// Set y no array: dos eventos distintos pueden depender del MISMO padre
// faltante (cinco facturas del mismo proveedor, por ejemplo). Contarlo una vez
// por evento inflaría el resumen y haría creer que falta más de lo que falta.
const faltantes = new Set();
const aReactivar = []; // ids de eventos a resetear

for (const ev of pendientes) {
  const { tabla, registroId } = ev.payload ?? {};
  const modelo = porTabla.get(tabla);
  const edadMin = Math.round((Date.now() - ev.agregadoAt.getTime()) / 60000);
  console.log(`─ ${tabla} ${registroId}  (${ev.intentos} intentos, hace ${edadMin} min)`);
  // Se etiqueta como YA GUARDADO y en una sola línea a propósito. Antes decía
  // solo "error:" y ocupaba varios renglones: en modo --aplicar parecía que el
  // script estaba fallando EN VIVO, cuando es el error histórico que dejó el
  // replicador y es justamente lo que se viene a arreglar. Confundió dos veces.
  const previo = (ev.ultimoError ?? '(vacío)').replace(/\s+/g, ' ').trim();
  console.log(`    causa que lo trabó (ya registrada, NO es de ahora): ${previo.slice(0, 160)}`);

  if (!modelo) {
    console.log('    ⚠ tabla desconocida para el schema actual. Se saltea.');
    continue;
  }

  const fila = await local[delegado(modelo)].findUnique({ where: { id: registroId } });
  if (!fila) {
    console.log('    la fila ya no existe en S1 — el evento quedó huérfano, se puede publicar y listo.');
    aReactivar.push(ev.id);
    continue;
  }

  const copiadas = [];
  const vistos = new Set();
  // La fila del evento se copia acá y no se deja para el replicador, por el
  // orden: los hijos de abajo necesitan que el padre YA esté en la nube. El
  // reintento posterior del replicador vuelve a upsertear lo mismo — inofensivo.
  await asegurar(modelo, registroId, APLICAR, vistos, copiadas);
  await asegurarHijos(modelo, registroId, APLICAR, vistos, copiadas);

  if (copiadas.length) {
    // En --aplicar estas filas YA se escribieron (asegurar/asegurarHijos las
    // copian). Decir "faltan" ahí sería mentir sobre lo que acaba de pasar.
    const verbo = APLICAR ? '✔ copiado a la nube' : 'falta en la nube';
    console.log(`    ${verbo}: ${resumirCopiadas(copiadas)}`);
    for (const c of copiadas) faltantes.add(c);
  } else {
    console.log('    ya estaba completo en la nube — solo hay que marcar el evento.');
  }
  aReactivar.push(ev.id);
}

console.log('');
if (!APLICAR) {
  console.log(`Resumen: ${faltantes.size} fila(s) para copiar a la nube, ${aReactivar.length} evento(s) para reactivar.`);
  console.log('Para aplicarlo:  node api\\reparar-replicacion.mjs --aplicar');
} else {
  const r = await local.outboxEvent.updateMany({
    where: { id: { in: aReactivar } },
    data: { intentos: 0, ultimoError: null },
  });
  console.log(`✅ ${faltantes.size} fila(s) copiada(s) a la nube.`);
  console.log(`✅ ${r.count} evento(s) reactivado(s) — el replicador los toma en el próximo ciclo (~4s).`);
  console.log('Verificá con:  Invoke-RestMethod http://127.0.0.1:3001/api/v1/sync/status | ConvertTo-Json -Depth 5');
}

await local.$disconnect();
await nube.$disconnect();
