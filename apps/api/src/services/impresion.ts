import { prisma } from '@sta/db/client';
import type { Prisma } from '@sta/db';
import { TipoTrabajoImpresion, EstadoTrabajoImpresion } from '@sta/db';

/**
 * Servicio de la cola de impresión.
 *
 * Encolar trabajos es idempotente vía `tx` opcional para que la creación de
 * la venta y la encolada del trabajo sean un único commit atómico.
 *
 * REGLAS DE ROUTING (qué venta va a qué comandera) — SOLO PARA COMANDAS.
 * El TICKET_CLIENTE va siempre a MOSTRADOR y se enqueua aparte en
 * `encolarTicketClienteParaVenta` al finalizar la venta.
 *
 *   Comandera 1 = MOSTRADOR — solo TICKET_CLIENTE (no comandas, la cajera
 *                              ve el pedido en pantalla y le entrega al
 *                              cliente el ticket fiscal con totales).
 *   Comandera 2 = DELIVERY  — todos los pedidos de delivery propio
 *                              (TELEFONO/WHATSAPP/WEB con DELIVERY_PROPIO)
 *   Comandera 3 = COCINA    — pedidos con items que requieren preparación
 *                              caliente + todos los de apps externas (RAPPI,
 *                              Pedidos YA, MELI, DELIVERATE)
 *
 * | Caso                                    | MOSTRADOR | DELIVERY | COCINA |
 * |-----------------------------------------|-----------|----------|--------|
 * | Mostrador + sin cocina                  | ·         | ·        | ·      |
 * | Mostrador + con cocina                  | ·         | ·        | ✓      |
 * | Delivery propio + sin cocina            | ·         | ✓        | ·      |
 * | Delivery propio + con cocina            | ·         | ✓        | ✓      |
 * | Apps externas (RAPPI/PYA/MELI/DELIVERATE)| ·        | ·        | ✓      |
 */

type DbClient = Prisma.TransactionClient | typeof prisma;

export type DestinoImpresion = 'MOSTRADOR' | 'DELIVERY' | 'COCINA';

/**
 * Type guard del destino guardado en `ventas.destino_impresion_encargo`
 * (VARCHAR: los encargos anteriores a este cambio lo tienen en NULL → Mostrador).
 */
export function esDestinoImpresion(v: unknown): v is DestinoImpresion {
  return v === 'MOSTRADOR' || v === 'DELIVERY' || v === 'COCINA';
}

/**
 * Cómo se imprime un modificador en los tickets (línea hija "> ..." debajo del
 * producto). Los grupos CLÁSICOS imprimen solo la opción, como siempre:
 *   - sabores ("Sabor — Ravioles")            → "> Carne"
 *   - salsa de porciones ("Tipo — Salsa ...") → "> Fileto"
 * Los grupos GENÉRICOS creados desde el admin (fix 3d: "Salsa", "Agregados",
 * etc.) imprimen "Grupo: Opción" → "> Salsa: Fileto" — la cocina ve de qué
 * grupo es la opción sin ambigüedad.
 */
function nombreModParaTicket(m: {
  opcionNombre?: string;
  grupoNombre?: string | null;
} | null): string | null {
  if (!m || typeof m.opcionNombre !== 'string' || !m.opcionNombre) return null;
  const grupo = typeof m.grupoNombre === 'string' ? m.grupoNombre.trim() : '';
  if (
    !grupo ||
    grupo.startsWith('Sabor') ||
    grupo.startsWith('Tipo — Salsa') ||
    grupo.startsWith('Tipo - Salsa')
  ) {
    return m.opcionNombre;
  }
  return `${grupo}: ${m.opcionNombre}`;
}

/**
 * Devuelve el "repartidor" que se deriva automáticamente del canal cuando
 * es una plataforma externa. Para los canales internos (MOSTRADOR/TELEFONO/
 * WHATSAPP/WEB) devuelve null — en esos casos el repartidor lo asigna
 * manualmente la cajera (Damián / otro empleado / DELIVERATE / etc.) o,
 * si no asignó nada, cae al default de `configuracion_sistema.delivery_repartidor_default`.
 */
export function repartidorPorCanal(canal: string): string | undefined {
  switch (canal) {
    case 'RAPPI':
      return 'RAPPI';
    case 'PEDIDOS_YA':
      return 'PEDIDOS YA';
    case 'MERCADO_LIBRE':
      return 'MERCADO LIBRE';
    case 'DELIVERATE':
      return 'DELIVERATE';
    default:
      return undefined;
  }
}

/**
 * Lee el repartidor default configurado en `configuracion_sistema` para los
 * canales internos sin asignación manual. Cache simple por proceso para no
 * pegar a la DB en cada impresión. La encargada puede cambiarlo desde admin
 * — invalidar con `resetDeliveryRepartidorDefaultCache()` cuando se actualice.
 */
let _deliveryRepartidorDefaultCache: string | null | undefined;
async function getDeliveryRepartidorDefault(client: DbClient = prisma): Promise<string | undefined> {
  if (_deliveryRepartidorDefaultCache !== undefined) {
    return _deliveryRepartidorDefaultCache ?? undefined;
  }
  const row = await client.configuracionSistema.findUnique({
    where: { clave: 'delivery_repartidor_default' },
  });
  const valor = row?.valor?.trim();
  _deliveryRepartidorDefaultCache = valor && valor.length > 0 ? valor : null;
  return _deliveryRepartidorDefaultCache ?? undefined;
}

export function resetDeliveryRepartidorDefaultCache(): void {
  _deliveryRepartidorDefaultCache = undefined;
}

/**
 * Resuelve el repartidor a imprimir en tickets/comandas según la prioridad:
 *   1. Empleado interno asignado explícitamente (`_empleadoNombre` en snapshot)
 *   2. Empresa explícita (DELIVERATE u otra cargada por la cajera)
 *   3. Inferido del canal (RAPPI/PEDIDOS_YA/MERCADO_LIBRE/DELIVERATE)
 *   4. Default de `configuracion_sistema.delivery_repartidor_default` (Damián por seed)
 *      — sólo aplica si modalidad es DELIVERY_PROPIO (no en TAKE_AWAY donde no hay reparto).
 */
async function resolverRepartidor(args: {
  canal: string;
  modalidad: string;
  deliveryInfo: { empresaExterna?: string | null; direccionSnapshot?: unknown } | null;
  client?: DbClient;
}): Promise<string | undefined> {
  // DELIVERATE es una MODALIDAD (sobre un canal interno como TELEFONO): el
  // reparto SIEMPRE lo hace la empresa DELIVERATE — nunca un empleado interno
  // ni el default "Damián". Va PRIMERO, antes de mirar el snapshot: la comanda
  // se encola "al enviar", cuando el snapshot puede tener todavía el empleado
  // default y aún no el _empresaExterna. (Incidente: venta 1151 salió "Damián".)
  if (args.modalidad === 'DELIVERY_DELIVERATE') return 'DELIVERATE';

  const snap = (args.deliveryInfo?.direccionSnapshot as Record<string, unknown> | null) ?? {};
  const empleado = typeof snap._empleadoNombre === 'string' ? snap._empleadoNombre : undefined;
  const empresaExplicita =
    args.deliveryInfo?.empresaExterna ??
    (typeof snap._empresaExterna === 'string' ? snap._empresaExterna : undefined);
  const inferido = repartidorPorCanal(args.canal);
  const resuelto = empleado ?? empresaExplicita ?? inferido;
  if (resuelto) return resuelto;
  // Fallback al default global SOLO si la venta es delivery (no TAKE_AWAY).
  if (args.modalidad === 'DELIVERY_PROPIO') {
    return getDeliveryRepartidorDefault(args.client);
  }
  return undefined;
}

/**
 * Devuelve la lista de comanderas donde tiene que imprimirse la COMANDA de una
 * venta, según la matriz configurable comandera × canal (config de impresoras).
 *
 * Para cada comandera ACTIVA cuyo listado de `canales` incluye el canal de la
 * venta, se imprime ahí. La COCINA además se limita a pedidos con cocción — es
 * la impresora de la cocina, no tiene sentido mandarle un pedido frío (ej. una
 * bolsa de pasta seca). El ticket del cliente en el mostrador es un flujo aparte
 * (se imprime al finalizar) y no depende de esta matriz.
 *
 * Los defaults de la matriz replican el ruteo histórico (ver DEFAULT_CONFIG); la
 * encargada puede cambiar qué canal sale en qué comandera desde Configuración.
 *
 * @param canal       Canal de la venta (MOSTRADOR / TELEFONO / RAPPI / ...)
 * @param tieneCocina true si al menos un item requiere preparación caliente
 * @param client      Cliente Prisma. CRÍTICO: cuando se llama DENTRO de una
 *   transacción (finalizar venta), hay que pasar `tx`. Contra el pooler de
 *   Supabase con `connection_limit=1`, leer la config con el prisma GLOBAL
 *   mientras la transacción retiene la única conexión deadlockea → 500. Usar
 *   el mismo cliente reusa la conexión de la transacción. (Incidente: cobros
 *   rotos en alpha.52 — encargos OK porque no pasan por acá.)
 */
export async function determinarDestinos(
  canal: string,
  tieneCocina: boolean,
  client: DbClient = prisma,
): Promise<DestinoImpresion[]> {
  const cfg = await getConfigImpresion(client);
  const destinos: DestinoImpresion[] = [];
  for (const destino of ['MOSTRADOR', 'DELIVERY', 'COCINA'] as DestinoImpresion[]) {
    const c = cfg[destino];
    if (!c.activa) continue;
    if (!c.canales.includes(canal)) continue;
    // La cocina solo imprime lo que hay que cocinar.
    if (destino === 'COCINA' && !tieneCocina) continue;
    destinos.push(destino);
  }
  return destinos;
}

interface EncolarArgs {
  tipo: TipoTrabajoImpresion;
  destino: DestinoImpresion;
  payload: Record<string, unknown>;
  ventaId?: string | null;
  tx?: Prisma.TransactionClient;
}

export async function encolarTrabajo(args: EncolarArgs) {
  const client: DbClient = args.tx ?? prisma;
  return client.trabajoImpresion.create({
    data: {
      tipo: args.tipo,
      destino: args.destino,
      payload: args.payload as Prisma.InputJsonValue,
      ventaId: args.ventaId ?? null,
    },
  });
}

/**
 * Include de Prisma para traer la ficha del producto de cada item del ticket.
 *
 * `ItemVenta` solo snapshotea el NOMBRE, así que la marca / presentación / rubro
 * se leen del producto vivo al momento de imprimir. Ventaja: las re-impresiones
 * de ventas y encargos viejos también salen con la info completa.
 */
const INCLUDE_FICHA_PRODUCTO = {
  producto: {
    select: {
      marca: true,
      presentacion: true,
      tipoProducto: {
        select: { nombre: true, categoria: { select: { nombre: true } } },
      },
    },
  },
} as const;

type ProductoFicha = {
  marca: string | null;
  presentacion: string | null;
  tipoProducto: { nombre: string; categoria: { nombre: string } };
};

/**
 * Datos descriptivos del producto que van impresos junto al nombre del item:
 * marca, presentación y el flag SIN TACC.
 *
 * "Sin TACC" NO es un campo del producto: es una CATEGORÍA del catálogo (con
 * subcategorías como "La Pastelera" o "Manjar"). Se detecta por el nombre de la
 * categoría o de la subcategoría — misma idea que `incluyeSalsa`, que se deriva
 * del nombre del tipo. Es información crítica en cocina (contaminación cruzada)
 * y útil en el mostrador, así que sale en los cuatro tickets.
 */
function fichaProductoItem(producto: ProductoFicha | null | undefined): {
  marca?: string;
  presentacion?: string;
  sinTacc?: boolean;
} {
  if (!producto) return {};
  const esSinTacc = (s: string | undefined | null) => /sin\s*tacc/i.test(s ?? '');
  const sinTacc =
    esSinTacc(producto.tipoProducto?.categoria?.nombre) ||
    esSinTacc(producto.tipoProducto?.nombre);
  return {
    ...(producto.marca ? { marca: producto.marca } : {}),
    ...(producto.presentacion ? { presentacion: producto.presentacion } : {}),
    ...(sinTacc ? { sinTacc: true } : {}),
  };
}

/**
 * Construye el ComandaPayload completo a partir de la venta y sus items.
 *
 * Incluye los datos de delivery (cliente, dirección, teléfono, indicaciones)
 * cuando la venta es DELIVERY_*. La cocinera ve TODO en una sola hoja:
 * items de cocina + a quién/dónde se entrega.
 */
export async function buildComandaPayload(
  ventaId: string,
  client: DbClient = prisma,
): Promise<Record<string, unknown>> {
  const venta = await client.venta.findUnique({
    where: { id: ventaId },
    include: {
      items: {
        orderBy: { orden: 'asc' },
        include: { combo: true, ...INCLUDE_FICHA_PRODUCTO },
      },
      deliveryInfo: true,
    },
  });
  if (!venta) throw new Error(`Venta ${ventaId} no encontrada`);

  // Datos de delivery: si modalidad NO es TAKE_AWAY, queremos imprimir el
  // bloque DELIVERY en la comanda incluso si todavía no hay deliveryInfo
  // (porque para RAPPI/PYA/MELI/DELIVERATE el "repartidor" se deriva del
  // canal — no requiere asignación manual de la cajera).
  let delivery: Record<string, unknown> | undefined;
  if (venta.modalidad !== 'TAKE_AWAY') {
    const snap =
      (venta.deliveryInfo?.direccionSnapshot as Record<string, unknown> | null) ?? {};
    const repartidor = await resolverRepartidor({
      canal: venta.canal,
      modalidad: venta.modalidad,
      deliveryInfo: venta.deliveryInfo,
      client,
    });
    delivery = {
      clienteNombre: snap.clienteNombre ?? null,
      clienteTelefono: snap.clienteTelefono ?? null,
      direccion: snap.direccion ?? null,
      indicaciones: snap.indicaciones ?? null,
      horaPrometida: venta.deliveryInfo?.horaPrometida
        ? venta.deliveryInfo.horaPrometida.toISOString()
        : null,
      repartidor,
    };
  }

  return {
    // numeroOrdenTurno = el "Pedido #017" grande arriba (correlativo del turno).
    // numero = el id global de la venta, lo que aparece en /admin/ventas — se
    // imprime chiquito al pie para que la encargada pueda buscar el pedido
    // en el programa cuando le acercan el ticket.
    numeroOrden: venta.numeroOrdenTurno,
    numeroVenta: venta.numero,
    hora: venta.fechaApertura.toISOString().slice(11, 16),
    canal: venta.canal,
    items: venta.items.map((it) => {
      const mods =
        (it.modificadoresAplicados as Array<{
          opcionNombre?: string;
          grupoNombre?: string | null;
          deltaPrecio?: string | number | null;
        }> | null) ?? [];
      return {
        cantidad: String(it.cantidad),
        nombre: it.nombreSnapshot,
        modificadores: mods
          .map((m) => {
            const nombre = nombreModParaTicket(m);
            if (typeof nombre !== 'string') return nombre;
            // Los adicionales con cargo se imprimen discriminados: la cocinera
            // usa la comanda como referencia de lo que hay que cobrar.
            const delta = Number(m.deltaPrecio ?? 0);
            if (!(delta > 0)) return nombre;
            const monto = delta.toLocaleString('es-AR', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            });
            return `${nombre} (+$${monto})`;
          })
          .filter((x): x is string => typeof x === 'string'),
        observacion: it.observacion ?? undefined,
        parteDeCombo: it.combo?.nombre,
        // Ficha del producto: marca, presentación y SIN TACC.
        ...fichaProductoItem(it.producto),
        // Importes por línea — la comanda de cocina se usa como referencia de
        // cobro cuando el pedido se despacha en el local o sale al reparto.
        precioUnitario: it.precioUnitario.toFixed(2),
        subtotal: it.subtotal.toFixed(2),
      };
    }),
    total: venta.total.toFixed(2),
    pcOrigen: venta.pcOrigen,
    delivery,
  };
}

/**
 * Encolar COCINA al crear venta y al agregar items.
 *
 * IMPORTANTE: el TICKET_DELIVERY NO se encola desde acá — al momento de
 * crear la venta todavía no hay pago registrado, así que el ticket saldría
 * con el método "EFECTIVO / A_COBRAR" default (incidente real: la encargada
 * recibió tickets con metodo=EFECTIVO cuando la venta se había cobrado con
 * DEBITO). El TICKET_DELIVERY se encola al finalizar la venta en
 * `encolarTicketDeliveryParaVenta`, con el pago real ya registrado.
 *
 * DEDUP: si ya hay una comanda de cocina PENDIENTE (todavía no impresa) para
 * esta venta, en vez de encolar otra ACTUALIZAMOS su payload. Así cualquier
 * doble-disparo del ciclo de vida de la venta (crear + agregar items en
 * ráfaga, reintento del frontend) colapsa a UNA sola comanda. Si la comanda
 * anterior ya se imprimió (EN_PROCESO/IMPRESO), encolamos una nueva con la
 * versión actualizada — la cocina ya arrancó la tanda anterior y necesita ver
 * los cambios. Esto arregla el bug de comandas de cocina duplicadas/triplicadas.
 */
export async function encolarComandasParaVenta(
  ventaId: string,
  tx: Prisma.TransactionClient,
): Promise<DestinoImpresion[]> {
  const venta = await tx.venta.findUnique({
    where: { id: ventaId },
    select: { canal: true, tieneCocina: true },
  });
  if (!venta) return [];

  // Sólo COCINA en este path. DELIVERY se mueve al cierre/finalización.
  // `tx`: leer la config con el cliente de la transacción (connection_limit=1).
  const destinos = (await determinarDestinos(venta.canal, venta.tieneCocina, tx)).filter(
    (d) => d === 'COCINA',
  );
  if (destinos.length === 0) return [];

  const comandaPayload = await buildComandaPayload(ventaId, tx);
  for (const destino of destinos) {
    // ¿Ya hay una comanda de cocina sin imprimir para esta venta? La reusamos.
    const pendiente = await tx.trabajoImpresion.findFirst({
      where: {
        ventaId,
        destino,
        tipo: TipoTrabajoImpresion.COMANDA_COCINA,
        estado: EstadoTrabajoImpresion.PENDIENTE,
      },
      orderBy: { encoladoAt: 'desc' },
      select: { id: true },
    });
    if (pendiente) {
      await tx.trabajoImpresion.update({
        where: { id: pendiente.id },
        data: { payload: comandaPayload as Prisma.InputJsonValue },
      });
    } else {
      await encolarTrabajo({
        tipo: TipoTrabajoImpresion.COMANDA_COCINA,
        destino,
        payload: comandaPayload,
        ventaId,
        tx,
      });
    }
  }
  return destinos;
}

/**
 * ¿La venta YA tiene una comanda de COCINA encolada (en cualquier estado)?
 *
 * La comanda de cocina debe salir UNA sola vez: al "enviar a cocina" (crear con
 * `enviarACocina`), o al confirmar el pago si la venta se creó con "Cobrar".
 * Este chequeo evita el duplicado:
 *   - `agregarItemsAVenta` re-encola SOLO si ya se había enviado (así los items
 *     nuevos llegan a una cocina que ya arrancó; si no arrancó, no imprime nada).
 *   - `finalizar` encola la comanda SOLO si no se envió antes (cubre el flujo
 *     "Cobrar", donde recién ahí sale a cocina).
 */
export async function ventaYaEnviadaACocina(
  ventaId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const existe = await tx.trabajoImpresion.findFirst({
    where: { ventaId, tipo: TipoTrabajoImpresion.COMANDA_COCINA },
    select: { id: true },
  });
  return !!existe;
}

/**
 * Encola el TICKET_DELIVERY al finalizar la venta — con el pago REAL ya
 * registrado en la DB. Sólo aplica para canales internos con DELIVERY_PROPIO
 * (TELEFONO/WHATSAPP/WEB). Las apps externas (RAPPI/PYA/MELI/DELIVERATE) no
 * necesitan TICKET_DELIVERY: la propia app maneja la entrega.
 *
 * Devuelve true si se encoló (la venta era delivery propio), false si no.
 */
export async function encolarTicketDeliveryParaVenta(
  ventaId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const venta = await tx.venta.findUnique({
    where: { id: ventaId },
    select: { canal: true, modalidad: true },
  });
  if (!venta) return false;
  // Apps externas y mostrador no van por acá.
  if (venta.modalidad !== 'DELIVERY_PROPIO') return false;
  const esCanalInterno =
    venta.canal === 'TELEFONO' || venta.canal === 'WHATSAPP' || venta.canal === 'WEB';
  if (!esCanalInterno) return false;

  const payload = await buildTicketDeliveryPayload(ventaId, tx);
  if (!payload) return false;
  await encolarTrabajo({
    tipo: TipoTrabajoImpresion.TICKET_DELIVERY,
    destino: 'DELIVERY',
    payload,
    ventaId,
    tx,
  });
  return true;
}

/**
 * Construye el TicketDeliveryPayload con datos del cliente, dirección, items,
 * total, hora prometida y forma de pago. Devuelve null si la venta no tiene
 * deliveryInfo (no debería pasar para canales delivery, pero por las dudas).
 */
async function buildTicketDeliveryPayload(
  ventaId: string,
  client: DbClient = prisma,
): Promise<Record<string, unknown> | null> {
  const venta = await client.venta.findUnique({
    where: { id: ventaId },
    include: {
      items: { orderBy: { orden: 'asc' }, include: INCLUDE_FICHA_PRODUCTO },
      pagos: { orderBy: { fecha: 'asc' } },
      cliente: true,
      usuarioApertura: true,
      deliveryInfo: true,
    },
  });
  if (!venta) return null;

  const snap = (venta.deliveryInfo?.direccionSnapshot as Record<string, unknown>) ?? {};
  const clienteNombre =
    (typeof snap.clienteNombre === 'string' && snap.clienteNombre) ||
    (venta.cliente
      ? `${venta.cliente.nombre}${venta.cliente.apellido ? ' ' + venta.cliente.apellido : ''}`
      : 'Sin nombre');
  const clienteTelefono =
    (typeof snap.clienteTelefono === 'string' && snap.clienteTelefono) ||
    venta.cliente?.telefono ||
    undefined;

  // direccion puede venir como string (snapshot legacy) o como objeto
  // estructurado. Normalizamos a string.
  let direccion = '';
  if (typeof snap.direccion === 'string') {
    direccion = snap.direccion;
  } else if (snap.direccion && typeof snap.direccion === 'object') {
    const d = snap.direccion as Record<string, unknown>;
    const partes = [
      [d.calle, d.numero].filter(Boolean).join(' '),
      d.piso ? `piso ${d.piso}` : null,
      d.depto ? `dpto ${d.depto}` : null,
      d.entreCalles ? `entre ${d.entreCalles}` : null,
      d.localidad,
    ].filter((x): x is string => typeof x === 'string' && x.length > 0);
    direccion = partes.join(', ');
  } else {
    // fallback: campos planos en el snapshot
    const partes = [
      [snap.calle, snap.numero].filter(Boolean).join(' '),
      snap.piso ? `piso ${snap.piso}` : null,
      snap.depto ? `dpto ${snap.depto}` : null,
      snap.entreCalles ? `entre ${snap.entreCalles}` : null,
    ].filter((x): x is string => typeof x === 'string' && x.length > 0);
    direccion = partes.join(', ');
  }

  const indicaciones =
    (typeof snap.indicaciones === 'string' && snap.indicaciones) ||
    venta.deliveryInfo?.observaciones ||
    undefined;

  // Repartidor: empleado explícito > empresa explícita > inferido del canal
  // > default global (configuracion_sistema.delivery_repartidor_default).
  // El renderer del ticket delivery elige empleadoNombre o empresaExterna,
  // así que decidimos cuál de los dos populamos según el origen del valor.
  const empleadoExplicito =
    typeof snap._empleadoNombre === 'string' ? snap._empleadoNombre : undefined;
  const empresaExplicita =
    venta.deliveryInfo?.empresaExterna ??
    (typeof snap._empresaExterna === 'string' ? snap._empresaExterna : undefined);
  const empresaInferida = empresaExplicita ?? repartidorPorCanal(venta.canal);
  let empleadoNombre: string | undefined = empleadoExplicito;
  let empresaExterna: string | undefined = empresaInferida;
  if (venta.modalidad === 'DELIVERY_DELIVERATE') {
    // DELIVERATE siempre lo reparte la empresa DELIVERATE (modalidad), nunca un
    // empleado interno ni el default. No depende del snapshot (que al encolar
    // puede tener todavía el empleado default). Ver resolverRepartidor.
    empleadoNombre = undefined;
    empresaExterna = 'DELIVERATE';
  } else if (!empleadoNombre && !empresaExterna && venta.modalidad === 'DELIVERY_PROPIO') {
    // Default global a empleado interno (típicamente "Damián").
    const def = await getDeliveryRepartidorDefault(client);
    if (def) empleadoNombre = def;
  }

  // Pago: si hay pagos confirmados → PAGADO. Sino A_COBRAR (motoquero cobra).
  const pagosConfirmados = venta.pagos.filter((p) => p.estado === 'CONFIRMADO');
  let pago: { metodo: string; estado: 'PAGADO' | 'A_COBRAR'; montoACobrar?: string };
  if (pagosConfirmados.length > 0) {
    const metodo =
      pagosConfirmados.length === 1
        ? pagosConfirmados[0]!.metodo
        : pagosConfirmados.map((p) => p.metodo).join(' + ');
    pago = { metodo, estado: 'PAGADO' };
  } else {
    // Default: efectivo a cobrar al entregar (caso típico).
    pago = {
      metodo: 'EFECTIVO',
      estado: 'A_COBRAR',
      montoACobrar: Number(venta.total).toFixed(2),
    };
  }

  return {
    numeroVenta: venta.numero,
    numeroOrden: venta.numeroOrdenTurno,
    canal: venta.canal,
    idExterno: venta.idExternoCanal ?? undefined,
    empleadoNombre,
    empresaExterna,
    cliente: {
      nombre: clienteNombre,
      telefono: clienteTelefono,
      direccion,
      indicaciones,
    },
    horaPrometida: venta.deliveryInfo?.horaPrometida
      ? venta.deliveryInfo.horaPrometida.toISOString()
      : null,
    items: venta.items.map((it) => {
      const mods =
        (it.modificadoresAplicados as Array<{
          opcionNombre?: string;
          grupoNombre?: string | null;
        }> | null) ?? [];
      return {
        cantidad: String(it.cantidad),
        nombre: it.nombreSnapshot,
        modificadores: mods
          .map(nombreModParaTicket)
          .filter((x): x is string => typeof x === 'string'),
        observacion: it.observacion ?? undefined,
        ...fichaProductoItem(it.producto),
        precioUnitario: Number(it.precioUnitario).toFixed(2),
        subtotal: Number(it.totalLinea).toFixed(2),
      };
    }),
    envio:
      venta.modalidad === 'DELIVERY_PROPIO' && Number(venta.recargoCanal) > 0
        ? Number(venta.recargoCanal).toFixed(2)
        : null,
    total: Number(venta.total).toFixed(2),
    pago,
    cajero: venta.usuarioApertura?.nombre ?? 'NN',
    pcOrigen: venta.pcOrigen,
    fecha: venta.fechaApertura.toISOString(),
  };
}

/**
 * Encolar comandas CANCELADAS para una venta — sale con marca
 * "*** CANCELADA ***" en todas las comanderas donde se imprimió el original
 * para que el operador en cada estación tache el pedido.
 *
 * La COCINA se imprime al ENVIAR (crear/agregar items), así que si se anula
 * una venta con items de cocina —finalizada o no— hay que mandarle la
 * cancelación a la comandera de cocina para que tachen el pedido. En cambio
 * el TICKET_CLIENTE y el TICKET_DELIVERY recién salen al finalizar (con el
 * pago real): si la venta nunca se finalizó, esos nunca se imprimieron y no
 * hay nada que cancelar ahí. Por eso, si no está finalizada, dejamos sólo
 * COCINA en los destinos.
 */
export async function encolarComandasCanceladas(
  ventaId: string,
  tx: Prisma.TransactionClient,
): Promise<DestinoImpresion[]> {
  const venta = await tx.venta.findUnique({
    where: { id: ventaId },
    select: { canal: true, tieneCocina: true, fechaFinalizacion: true },
  });
  if (!venta) return [];

  // `tx`: mismo cliente de la transacción (connection_limit=1 en el pooler).
  let destinos = await determinarDestinos(venta.canal, venta.tieneCocina, tx);
  if (!venta.fechaFinalizacion) {
    // No finalizada → sólo imprimió la comanda de cocina (al enviar).
    destinos = destinos.filter((d) => d === 'COCINA');
  }
  if (destinos.length === 0) return [];

  const payload = await buildComandaPayload(ventaId, tx);
  for (const destino of destinos) {
    await encolarTrabajo({
      tipo: TipoTrabajoImpresion.COMANDA_CANCELADA,
      destino,
      payload,
      ventaId,
      tx,
    });
  }
  return destinos;
}

/**
 * Encola el TICKET_CLIENTE — comprobante con datos completos (precios,
 * descuento, total, método de pago, fecha, header del comercio) que se
 * imprime en la comandera de MOSTRADOR al finalizar la venta y se entrega
 * al cliente.
 *
 * Sólo aplica para canal = MOSTRADOR (el cliente está físicamente en el
 * local). Delivery propio + apps externas reciben el comprobante por otros
 * medios (motoquero / la propia app).
 *
 * Para multi-pago se concatenan los métodos ("EFECTIVO + DEBITO"). Si es
 * single y EFECTIVO, mostramos `recibido` + `cambio` para que cierre la
 * conciliación de caja del cliente.
 */
export async function encolarTicketClienteParaVenta(
  ventaId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const venta = await tx.venta.findUnique({
    where: { id: ventaId },
    include: {
      items: { orderBy: { orden: 'asc' }, include: INCLUDE_FICHA_PRODUCTO },
      pagos: { orderBy: { fecha: 'asc' } },
      cliente: true,
      usuarioCierre: true,
      usuarioApertura: true,
      deliveryInfo: true,
    },
  });
  if (!venta) return false;
  if (venta.canal !== 'MOSTRADOR') return false;

  // Repartidor: empleado interno > empresa explícita > inferido del canal
  // > default global. Se imprime en la misma sección que el método de pago
  // para que la encargada vea quién va a entregar al despachar.
  const repartidor = await resolverRepartidor({
    canal: venta.canal,
    modalidad: venta.modalidad,
    deliveryInfo: venta.deliveryInfo,
    client: tx,
  });

  const pagosConfirmados = venta.pagos.filter((p) => p.estado === 'CONFIRMADO');
  let pagoInfo: { metodo: string; recibido?: string; cambio?: string };
  const primer = pagosConfirmados[0];
  if (pagosConfirmados.length === 1 && primer) {
    const isEfectivo = primer.metodo === 'EFECTIVO';
    const cambio = Number(primer.cambioDado);
    pagoInfo = {
      metodo: primer.metodo,
      recibido: isEfectivo ? Number(primer.monto).toFixed(2) : undefined,
      cambio: isEfectivo && cambio > 0 ? cambio.toFixed(2) : undefined,
    };
  } else {
    pagoInfo = { metodo: pagosConfirmados.map((p) => p.metodo).join(' + ') || 'MIXTO' };
  }

  const clienteNombre = venta.cliente
    ? `${venta.cliente.nombre}${venta.cliente.apellido ? ' ' + venta.cliente.apellido : ''}`
    : 'Mostrador';
  const vendedorNombre =
    venta.usuarioCierre?.nombre ?? venta.usuarioApertura?.nombre ?? 'NN';

  const subtotal = Number(venta.subtotal);
  const descuentoMonto = Number(venta.descuentoTotal);
  const descuento =
    descuentoMonto > 0 && subtotal > 0
      ? { pct: Math.round((descuentoMonto / subtotal) * 100), monto: descuentoMonto.toFixed(2) }
      : null;

  const fechaIso = (venta.fechaFinalizacion ?? venta.fechaApertura).toISOString();

  const payload = {
    numeroVenta: venta.numero,
    numeroOrden: venta.numeroOrdenTurno,
    cliente: clienteNombre,
    vendedor: vendedorNombre,
    pcOrigen: venta.pcOrigen,
    items: venta.items.map((it) => {
      const mods =
        (it.modificadoresAplicados as Array<{
          opcionNombre?: string;
          grupoNombre?: string | null;
        }> | null) ?? [];
      return {
        cantidad: String(it.cantidad),
        nombre: it.nombreSnapshot,
        modificadores: mods
          .map(nombreModParaTicket)
          .filter((x): x is string => typeof x === 'string'),
        observacion: it.observacion ?? undefined,
        ...fichaProductoItem(it.producto),
        precio: Number(it.precioUnitario).toFixed(2),
        subtotal: Number(it.totalLinea).toFixed(2),
      };
    }),
    subtotal: subtotal.toFixed(2),
    descuento,
    total: Number(venta.total).toFixed(2),
    pago: pagoInfo,
    ...(repartidor && { repartidor }),
    // ISO — el renderer del local-agent lo formatea como DD/MM/YYYY HH:MM:SS AR
    fecha: fechaIso,
  };

  await encolarTrabajo({
    tipo: TipoTrabajoImpresion.TICKET_CLIENTE,
    destino: 'MOSTRADOR',
    payload,
    ventaId,
    tx,
  });
  return true;
}

/**
 * Re-encola los tickets/comandas de una venta ya existente. Marca el tipo
 * como REIMPRESION para que el renderer muestre el header "*** REIMPRESIÓN ***"
 * y la cocinera/encargada sepa que es duplicado (no procesar la cocina de
 * nuevo).
 *
 * Acepta una lista opcional de destinos. Si no se pasa, re-imprime en todos
 * los destinos donde originalmente se imprimió (COCINA si tenía items
 * cocinables + DELIVERY si era delivery propio + MOSTRADOR si era mostrador).
 */
export async function reimprimirVenta(
  ventaId: string,
  destinos?: DestinoImpresion[],
): Promise<DestinoImpresion[]> {
  const venta = await prisma.venta.findUnique({
    where: { id: ventaId },
    select: { canal: true, tieneCocina: true },
  });
  if (!venta) throw new Error('Venta no encontrada');

  const originales = await determinarDestinos(venta.canal, venta.tieneCocina);
  const incluirMostrador = venta.canal === 'MOSTRADOR';
  const todosDisponibles = [
    ...originales,
    ...(incluirMostrador ? (['MOSTRADOR'] as DestinoImpresion[]) : []),
  ];
  const targets = destinos
    ? destinos.filter((d) => todosDisponibles.includes(d))
    : todosDisponibles;

  const resultados: DestinoImpresion[] = [];
  for (const destino of targets) {
    if (destino === 'COCINA') {
      const payload = await buildComandaPayload(ventaId);
      await encolarTrabajo({
        tipo: TipoTrabajoImpresion.COMANDA_REIMPRESION,
        destino,
        payload,
        ventaId,
      });
      resultados.push(destino);
    } else if (destino === 'DELIVERY') {
      const payload = await buildTicketDeliveryPayload(ventaId);
      if (payload) {
        await encolarTrabajo({
          tipo: TipoTrabajoImpresion.TICKET_DELIVERY,
          destino,
          payload,
          ventaId,
        });
        resultados.push(destino);
      }
    } else if (destino === 'MOSTRADOR') {
      // Solo aplica si la venta es de mostrador (canal=MOSTRADOR).
      // Usamos una mini transacción para reusar encolarTicketClienteParaVenta.
      await prisma.$transaction(async (tx) => {
        await encolarTicketClienteParaVenta(ventaId, tx);
      });
      resultados.push(destino);
    }
  }
  return resultados;
}

/**
 * Encola la COMANDA_ENCARGO → MOSTRADOR. Es el registro físico del encargo para
 * la encargada (decisión del dueño: siempre a mostrador, sea retiro o envío).
 * Lleva rótulo grande invertido "ENCARGO" arriba + "A PAGAR"/"COBRADO" abajo,
 * con todos los datos: items, cliente, día y hora/franja, retiro/envío + dirección.
 *
 * @param estado 'A_PAGAR' al cargar el encargo · 'COBRADO' al finalizar el cobro.
 */
export async function encolarComandaEncargo(
  ventaId: string,
  _estadoHint: 'A_PAGAR' | 'COBRADO',
  tx?: Prisma.TransactionClient,
  // Comandera destino. Default MOSTRADOR (decisión original del dueño para la
  // impresión automática); la RE-impresión deja elegir cualquiera.
  destino: DestinoImpresion = 'MOSTRADOR',
): Promise<void> {
  const client: DbClient = tx ?? prisma;
  // Resolver la RAÍZ: si ventaId es una adición ("modificación adicional"), la
  // comanda sale SIEMPRE fusionada desde el encargo padre. El estado global se
  // CALCULA acá (no se usa el hint): todo cobrado → COBRADO, nada → A PAGAR,
  // mezcla raíz/adiciones → PAGO PARCIAL con detalle de qué está pago y qué no.
  const inicial = await client.venta.findUnique({
    where: { id: ventaId },
    select: { id: true, encargoPadreId: true },
  });
  if (!inicial) return;
  const rootId = inicial.encargoPadreId ?? inicial.id;

  const venta = await client.venta.findUnique({
    where: { id: rootId },
    include: {
      items: { orderBy: { orden: 'asc' }, include: INCLUDE_FICHA_PRODUCTO },
      deliveryInfo: true,
      adicionesEncargo: {
        where: { estado: { not: 'ANULADA' } },
        orderBy: { fechaApertura: 'asc' },
        include: {
          items: { orderBy: { orden: 'asc' }, include: INCLUDE_FICHA_PRODUCTO },
        },
      },
    },
  });
  if (!venta) return;

  const snap = (venta.deliveryInfo?.direccionSnapshot as Record<string, unknown> | null) ?? {};
  const clienteNombre =
    (typeof snap.clienteNombre === 'string' && snap.clienteNombre) || 'Sin nombre';
  const clienteTelefono =
    typeof snap.clienteTelefono === 'string' ? snap.clienteTelefono : undefined;
  const direccion = typeof snap.direccion === 'string' ? snap.direccion : undefined;
  const indicaciones = typeof snap.indicaciones === 'string' ? snap.indicaciones : undefined;

  const mapItems = (
    its: typeof venta.items,
    pagado: boolean,
    adicionDe?: number,
  ) =>
    its.map((it) => {
      const mods =
        (it.modificadoresAplicados as Array<{
          opcionNombre?: string;
          grupoNombre?: string | null;
        }> | null) ?? [];
      return {
        cantidad: String(it.cantidad),
        nombre: it.nombreSnapshot,
        modificadores: mods
          .map(nombreModParaTicket)
          .filter((x): x is string => typeof x === 'string'),
        observacion: it.observacion ?? undefined,
        ...fichaProductoItem(it.producto),
        pagado,
        ...(adicionDe !== undefined && { adicion: adicionDe }),
      };
    });

  const rootPagado = venta.estadoCobroEncargo === 'COBRADO';
  const partes = [
    { pagado: rootPagado, total: Number(venta.total), items: venta.items, adicion: undefined as number | undefined },
    ...venta.adicionesEncargo.map((a, i) => ({
      pagado: a.estadoCobroEncargo === 'COBRADO',
      total: Number(a.total),
      items: a.items,
      adicion: i + 1 as number | undefined,
    })),
  ];
  const todoPagado = partes.every((p) => p.pagado);
  const nadaPagado = partes.every((p) => !p.pagado);
  const estado: 'A_PAGAR' | 'COBRADO' | 'PAGO_PARCIAL' = todoPagado
    ? 'COBRADO'
    : nadaPagado
      ? 'A_PAGAR'
      : 'PAGO_PARCIAL';
  const totalPagado = partes.filter((p) => p.pagado).reduce((a, p) => a + p.total, 0);
  const totalGlobal = partes.reduce((a, p) => a + p.total, 0);

  const payload = {
    numeroOrden: venta.numeroOrdenTurno,
    numeroVenta: venta.numero,
    hora: venta.fechaApertura.toISOString().slice(11, 16),
    estado,
    tipoEntrega: venta.tipoEntregaEncargo ?? (direccion ? 'ENVIO' : 'RETIRO'),
    // YYYY-MM-DD (UTC, tal como se guardó @db.Date).
    fechaEntrega: venta.fechaEntregaPromesa
      ? venta.fechaEntregaPromesa.toISOString().slice(0, 10)
      : null,
    horaEntrega: venta.horaEntregaExacta ?? undefined,
    franja: venta.franjaEntrega ?? undefined,
    cliente: { nombre: clienteNombre, telefono: clienteTelefono, direccion, indicaciones },
    items: partes.flatMap((p) => mapItems(p.items, p.pagado, p.adicion)),
    total: totalGlobal.toFixed(2),
    totalPagado: totalPagado.toFixed(2),
    totalPendiente: (totalGlobal - totalPagado).toFixed(2),
    // Observaciones a nivel encargo (campo "Observaciones del encargo" de la
    // carga) — antes NO viajaban en el payload y no salían impresas.
    observaciones: venta.observaciones ?? undefined,
    pcOrigen: venta.pcOrigen,
  };

  await encolarTrabajo({
    tipo: TipoTrabajoImpresion.COMANDA_ENCARGO,
    destino,
    payload,
    ventaId: rootId,
    tx,
  });
}

/**
 * Trabajo TEST — útil para que el admin verifique que la impresora está OK
 * desde el panel de configuración (un click → sale un ticket "=== TEST OK ===").
 */
export async function encolarTrabajoTest(destino: DestinoImpresion) {
  return encolarTrabajo({
    tipo: TipoTrabajoImpresion.TEST,
    destino,
    payload: { destino },
  });
}

/**
 * Configuración runtime de impresoras (por destino). Se persiste en
 * `configuracion_sistema` con clave `impresora_kitchen|counter|delivery`.
 *
 * Defaults: 192.168.1.50/51/52:9100 con 42 chars de ancho (papel 80mm).
 * El admin puede cambiarlas desde el panel.
 */
export interface PrinterDestinoConfig {
  host: string;
  port: number;
  width: number;
  activa: boolean;
  /**
   * Canales cuyos pedidos imprimen su COMANDA en esta comandera. Configurable
   * por el admin (matriz comandera × canal): la encargada elige DÓNDE y CUÁLES
   * tickets salen. COCINA además se limita a pedidos con cocción (ver
   * `determinarDestinos`). El ticket del cliente en el mostrador es un flujo
   * aparte y no depende de esta lista.
   */
  canales: string[];
}

/** Los 8 canales de venta enrutables (mismo orden que el enum CanalVenta). */
export const CANALES_ENRUTABLES = [
  'MOSTRADOR',
  'TELEFONO',
  'WHATSAPP',
  'WEB',
  'RAPPI',
  'PEDIDOS_YA',
  'MERCADO_LIBRE',
  'DELIVERATE',
] as const;

// Los `canales` por defecto replican el ruteo histórico (hardcodeado antes en
// `determinarDestinos`): delivery propio → Comandera 2; todo lo que tiene
// cocción → Comandera 3. El mostrador imprime el ticket del cliente por otro
// camino, así que su comandera no recibe comandas por defecto (canales: []).
const DEFAULT_CONFIG: Record<DestinoImpresion, PrinterDestinoConfig> = {
  MOSTRADOR: { host: '192.168.1.50', port: 9100, width: 42, activa: true, canales: [] },
  DELIVERY: {
    host: '192.168.1.51',
    port: 9100,
    width: 42,
    activa: true,
    canales: ['TELEFONO', 'WHATSAPP', 'WEB'],
  },
  COCINA: {
    host: '192.168.1.52',
    port: 9100,
    width: 42,
    activa: true,
    canales: [...CANALES_ENRUTABLES],
  },
};

export async function getConfigImpresion(
  client: DbClient = prisma,
): Promise<Record<DestinoImpresion, PrinterDestinoConfig>> {
  const rows = await client.configuracionSistema.findMany({
    where: { categoria: 'impresoras' },
  });
  const byClave = new Map(rows.map((r) => [r.clave, r.valor]));
  const result: Record<DestinoImpresion, PrinterDestinoConfig> = { ...DEFAULT_CONFIG };
  for (const destino of ['MOSTRADOR', 'DELIVERY', 'COCINA'] as const) {
    const raw = byClave.get(`impresora_${destino.toLowerCase()}`);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<PrinterDestinoConfig>;
      result[destino] = { ...DEFAULT_CONFIG[destino], ...parsed };
    } catch {
      /* fallback al default */
    }
  }
  return result;
}
