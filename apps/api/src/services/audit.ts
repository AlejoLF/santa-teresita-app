import { prisma } from '@sta/db/client';
import { Prisma } from '@sta/db';
import { computeHashChain, type HashChainEntry } from '@sta/shared/hash-chain';
import { config } from '../config.js';

interface AuditEntryInput {
  tabla: string;
  registroId: string;
  accion: string;
  usuarioId: string | null;
  pcOrigen?: string | null;
  ipOrigen?: string | null;
  valorAnterior?: unknown;
  valorNuevo?: unknown;
  contexto?: Record<string, unknown>;
  observaciones?: string;
  /**
   * Cliente transaccional del caller. Cuando se pasa, recordAudit se suma a la
   * transacción existente en vez de abrir la suya propia. Esencial cuando esta
   * función se llama desde un outer `prisma.$transaction(...)` para que el
   * audit y la mutación principal sean atómicos.
   */
  tx?: Prisma.TransactionClient;
}

type DbClient = Prisma.TransactionClient | typeof prisma;

async function writeAuditEntry(client: DbClient, entry: AuditEntryInput): Promise<void> {
  const last = await client.auditLog.findFirst({
    orderBy: { secuencia: 'desc' },
    select: { hashActual: true, secuencia: true },
  });
  const created = await client.auditLog.create({
    data: {
      tabla: entry.tabla,
      registroId: entry.registroId,
      accion: entry.accion,
      usuarioId: entry.usuarioId,
      pcOrigen: entry.pcOrigen ?? null,
      ipOrigen: entry.ipOrigen ?? null,
      valorAnterior: (entry.valorAnterior as never) ?? undefined,
      valorNuevo: (entry.valorNuevo as never) ?? undefined,
      contexto: (entry.contexto as never) ?? undefined,
      observaciones: entry.observaciones ?? null,
      hashAnterior: last?.hashActual ?? null,
      hashActual: 'pending',
      // Isla de origen (catch-up post-corte, docs/SERVIDOR-LOCAL.md §5.3).
      // 'cloud' solo si esta API corre en Vercel (STA_ROLE=cloud); el
      // server LAN y las cajas escriben 'local'.
      origen: config.STA_ROLE === 'cloud' ? 'cloud' : 'local',
    },
  });
  const chainEntry: HashChainEntry = {
    secuencia: created.secuencia,
    tabla: entry.tabla,
    registroId: entry.registroId,
    accion: entry.accion,
    valorAnterior: entry.valorAnterior ?? null,
    valorNuevo: entry.valorNuevo ?? null,
    usuarioId: entry.usuarioId,
    timestamp: created.timestamp,
  };
  const hash = computeHashChain(last?.hashActual ?? null, chainEntry, config.AUDIT_HASH_SALT);
  await client.auditLog.update({
    where: { id: created.id },
    data: { hashActual: hash },
  });

  // ── Transactional outbox (replicación local → Supabase) ──
  // Solo si STA_OUTBOX_REPLICATION está prendido (server LAN + cajas en
  // modo LAN). En la MISMA tx que el audit → garantía atómica: si la
  // mutación commitea, el evento de replicación existe; si rollbackea, no.
  // El payload es mínimo (qué fila cambió + secuencia para orden total);
  // el replicator resuelve el row completo al drenar (idempotente).
  if (config.STA_OUTBOX_REPLICATION) {
    await client.outboxEvent.create({
      data: {
        topic: `${entry.tabla}.${entry.accion}`,
        payload: {
          tabla: entry.tabla,
          registroId: entry.registroId,
          accion: entry.accion,
          secuencia: created.secuencia.toString(),
        } as never,
      },
    });
  }
}

/**
 * Varias entradas de audit en UNA tanda, con tres consultas en total en vez
 * de tres POR ENTRADA.
 *
 * ─── Por qué existe ──────────────────────────────────────────────────────
 *
 * `writeAuditEntry` cuesta tres viajes a la base: leer el último hash, crear
 * la fila, y actualizarla con su hash (hay que insertarla primero porque el
 * hash depende del `secuencia` y el `timestamp` que asigna Postgres).
 *
 * Eso está bien para un audit suelto. El problema es el camino de una venta:
 * audita la venta y DESPUÉS una entrada por renglón, en serie y dentro de la
 * misma transacción. Un pedido de treinta productos son noventa y tres viajes
 * encadenados. Con la base en la nube, cada viaje cuesta latencia de red, y el
 * conjunto cruzaba el techo de la transacción: Prisma la cortaba y a la cajera
 * le salía "la base de datos rechazó la operación" sin más pista. El síntoma
 * era que los pedidos grandes había que partirlos en dos o tres.
 * Incidente real: 24/09/2026 (P2028, `Transaction already closed`).
 *
 * ─── La cadena de hashes NO se debilita ──────────────────────────────────
 *
 * Cada fila se sigue encadenando con la anterior, en el mismo orden y con el
 * mismo cálculo: se insertan todas, se leen los `secuencia`/`timestamp` que
 * asignó Postgres, se encadena EN ESE ORDEN y se escriben los hashes. El
 * resultado es idéntico al que daría hacerlo de a una — lo único que cambia
 * es cuántas veces se habla con la base.
 *
 * Se ordena explícitamente por `secuencia` antes de encadenar: es el orden
 * canónico de la cadena y el que usa cualquier verificación, así que no se
 * deja depender del orden en que la librería devuelva las filas.
 */
export async function recordAuditBatch(
  client: DbClient,
  entries: AuditEntryInput[],
): Promise<void> {
  if (entries.length === 0) return;
  if (entries.length === 1) {
    await writeAuditEntry(client, entries[0]!);
    return;
  }

  const last = await client.auditLog.findFirst({
    orderBy: { secuencia: 'desc' },
    select: { hashActual: true },
  });

  const creadas = await client.auditLog.createManyAndReturn({
    data: entries.map((entry) => ({
      tabla: entry.tabla,
      registroId: entry.registroId,
      accion: entry.accion,
      usuarioId: entry.usuarioId,
      pcOrigen: entry.pcOrigen ?? null,
      ipOrigen: entry.ipOrigen ?? null,
      valorAnterior: (entry.valorAnterior as never) ?? undefined,
      valorNuevo: (entry.valorNuevo as never) ?? undefined,
      contexto: (entry.contexto as never) ?? undefined,
      observaciones: entry.observaciones ?? null,
      hashAnterior: null,
      hashActual: 'pending',
      origen: config.STA_ROLE === 'cloud' ? 'cloud' : 'local',
    })),
    select: { id: true, secuencia: true, timestamp: true, registroId: true },
  });

  // El orden de la cadena es el de `secuencia`, no el de la respuesta.
  const porSecuencia = [...creadas].sort((a, b) =>
    a.secuencia < b.secuencia ? -1 : a.secuencia > b.secuencia ? 1 : 0,
  );
  // `createManyAndReturn` respeta el orden de entrada, así que la fila i-ésima
  // por secuencia corresponde a la entrada i-ésima. Se comprueba igual con el
  // registroId: si algún día eso cambiara, es mejor romper acá que escribir
  // una cadena con los datos cruzados.
  const enlaces: Array<{ id: string; hash: string }> = [];
  let anterior = last?.hashActual ?? null;
  for (const [i, fila] of porSecuencia.entries()) {
    const entry = entries[i]!;
    if (fila.registroId !== entry.registroId) {
      throw new Error(
        'audit batch: el orden de las filas creadas no coincide con el de las entradas',
      );
    }
    const hash = computeHashChain(
      anterior,
      {
        secuencia: fila.secuencia,
        tabla: entry.tabla,
        registroId: entry.registroId,
        accion: entry.accion,
        valorAnterior: entry.valorAnterior ?? null,
        valorNuevo: entry.valorNuevo ?? null,
        usuarioId: entry.usuarioId,
        timestamp: fila.timestamp,
      },
      config.AUDIT_HASH_SALT,
    );
    enlaces.push({ id: fila.id, hash });
    // `hashAnterior` de la siguiente es el `hashActual` de ésta.
    anterior = hash;
  }

  // Un solo UPDATE para toda la tanda. `hash_anterior` se reconstruye acá y no
  // en el INSERT porque recién ahora se conoce el hash de la fila previa.
  const valores = Prisma.join(
    enlaces.map(
      (e, i) =>
        Prisma.sql`(${e.id}::uuid, ${e.hash}, ${i === 0 ? (last?.hashActual ?? null) : enlaces[i - 1]!.hash})`,
    ),
  );
  await client.$executeRaw`
    UPDATE "audit_log" AS a
       SET "hash_actual" = v.hash_actual,
           "hash_anterior" = v.hash_anterior
      FROM (VALUES ${valores}) AS v(id, hash_actual, hash_anterior)
     WHERE a."id" = v.id
  `;

  if (config.STA_OUTBOX_REPLICATION) {
    await client.outboxEvent.createMany({
      data: porSecuencia.map((fila, i) => ({
        topic: `${entries[i]!.tabla}.${entries[i]!.accion}`,
        payload: {
          tabla: entries[i]!.tabla,
          registroId: entries[i]!.registroId,
          accion: entries[i]!.accion,
          secuencia: fila.secuencia.toString(),
        } as never,
      })),
    });
  }
}

/**
 * Registra una entrada en audit_log calculando el hash-chain SHA-256.
 *
 * Si el caller pasa `entry.tx` (un cliente transaccional), recordAudit se
 * suma a esa transacción y NO abre una nueva — esto permite que la
 * mutación principal y el audit log sean un solo commit atómico.
 *
 * Si NO viene `tx`, abre una transacción Serializable propia (modo legacy
 * para call sites que no se pueden envolver en una transacción mayor).
 */
export async function recordAudit(entry: AuditEntryInput): Promise<void> {
  if (entry.tx) {
    await writeAuditEntry(entry.tx, entry);
    return;
  }
  await prisma.$transaction(
    async (tx) => {
      await writeAuditEntry(tx, entry);
    },
    { isolationLevel: 'Serializable' },
  );
}
