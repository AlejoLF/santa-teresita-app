/**
 * Cuánto mueve el CAJÓN cada movimiento del turno.
 *
 * ─── Por qué existe este archivo ─────────────────────────────────────────
 *
 * Un `Movimiento` tiene UNA `cuentaOrigenId` y UNA `cuentaDestinoId`, pero la
 * plata puede haber salido de VARIAS cuentas: el reparto real vive en la tabla
 * `pagos`, una fila por cuenta. Una liquidación del banco de horas pagada 40%
 * en efectivo y 60% por transferencia es UN movimiento con DOS pagos, y su
 * `cuentaOrigenId` es —arbitrariamente— la cuenta de la PRIMERA línea
 * (`liquidarEnTransaccion`, services/banco-horas.ts).
 *
 * El cierre de caja calculaba mirando `cuentaOrigen`/`cuentaDestino` y el
 * `monto` TOTAL. Con un pago repartido eso da cualquier cosa:
 *
 *   - Si la primera línea era la transferencia → `cuentaOrigen` es el banco,
 *     no es efectivo, y el egreso contaba CERO. Los $40.000 que salieron del
 *     cajón no se restaban del esperado y la caja cerraba de más.
 *   - Si la primera línea era el efectivo → contaba los $100.000 ENTEROS como
 *     salida de caja, incluidos los $60.000 que fueron por banco.
 *
 * Incidente real (28/08/2026): la encargada editó un pago de sueldo de 100%
 * transferencia a 40% efectivo / 60% transferencia. El movimiento guardó bien
 * las dos líneas —entrando al detalle se ven— pero el cierre siguió tratándolo
 * como 100% banco y a la empleada la caja le daba mal.
 *
 * ─── Por qué NO se parte en dos movimientos ──────────────────────────────
 *
 * Era la otra salida posible: un movimiento por cuenta. Se descartó porque el
 * modelo YA soporta el reparto bien (es para lo que está `pagos`), y partirlo
 * empeoraría todo lo demás: `LiquidacionEmpleado.movimientoId` y
 * `MovimientoBancoHoras.movimientoId` son FKs simples que apuntan a UN
 * movimiento, el listado mostraría dos filas "Sueldo Fulana" que hay que
 * recordar editar juntas, y anular una sin la otra dejaría el pago a medias.
 * Además no arreglaría los repartos que YA existen en la base.
 *
 * El bug no estaba en cómo se guarda: estaba en que los que LEEN ignoraban
 * `pagos`. Se arregla acá, en un solo lugar, y queda arreglado para todos los
 * repartos ya cargados sin tocar un solo dato.
 */

/** Lo mínimo que necesitamos de una cuenta para saber si es el cajón. */
export interface CuentaCierre {
  tipo: string;
  nombre?: string;
  excluidaDeCierreCaja?: boolean | null;
}

/** Un movimiento con lo justo para calcular su efecto en la caja física. */
export interface MovimientoConPagos {
  tipo: string;
  monto: unknown;
  cuentaOrigen?: CuentaCierre | null;
  cuentaDestino?: CuentaCierre | null;
  pagos?: Array<{ monto: unknown; cuenta?: CuentaCierre | null }>;
}

/**
 * ¿Esta cuenta es el efectivo del turno?
 *
 * `excluidaDeCierreCaja` saca cuentas como "Efectivo acumulado" (la plata que
 * el dueño ya barrió): son tipo EFECTIVO pero no son el cajón de este turno.
 */
export function esCajaSesion(c: CuentaCierre | null | undefined): boolean {
  return !!c && c.tipo === 'EFECTIVO' && c.excluidaDeCierreCaja !== true;
}

/**
 * Efecto NETO del movimiento sobre el efectivo del cajón.
 *
 * Positivo = entró plata al cajón. Negativo = salió. Cero = no lo tocó (fue
 * todo por banco/wallet).
 *
 * Cuando el movimiento tiene `pagos`, manda el reparto: se suma cuenta por
 * cuenta y se ignoran `cuentaOrigen`/`cuentaDestino`, que con un pago repartido
 * sólo nombran a una de las cuentas involucradas. Sin `pagos` (el caso de la
 * enorme mayoría) se cae al cálculo de siempre.
 */
export function efectoEnCaja(m: MovimientoConPagos): number {
  const total = Number(m.monto);

  // Las transferencias internas son inherentemente de dos cuentas y ya se
  // describen enteras con origen + destino. No se reparten en `pagos`.
  if (m.tipo !== 'TRANSFERENCIA_INTERNA' && m.pagos && m.pagos.length > 0) {
    const signo = m.tipo === 'INGRESO' ? 1 : -1;
    return m.pagos
      .filter((p) => esCajaSesion(p.cuenta))
      .reduce((acc, p) => acc + signo * Number(p.monto), 0);
  }

  let efecto = 0;
  if (esCajaSesion(m.cuentaOrigen) && (m.tipo === 'EGRESO' || m.tipo === 'TRANSFERENCIA_INTERNA')) {
    efecto -= total;
  }
  if (
    esCajaSesion(m.cuentaDestino) &&
    (m.tipo === 'INGRESO' || m.tipo === 'TRANSFERENCIA_INTERNA')
  ) {
    efecto += total;
  }
  return efecto;
}

/** ¿Tocó el cajón, en cualquier dirección? Para destacarlo en la UI. */
export function afectaCaja(m: MovimientoConPagos): boolean {
  return Math.abs(efectoEnCaja(m)) > 0.0001;
}

/**
 * Cómo se repartió el movimiento, en texto corto ("$40.000 Caja física +
 * $60.000 Santander"). `null` si fue de una sola cuenta — ahí el nombre de la
 * cuenta ya se muestra en su columna y repetirlo sería ruido.
 *
 * Es lo que hacía falta para que la encargada VEA el reparto sin abrir el
 * detalle: hasta ahora la fila decía "Santander" y punto, aunque $40.000
 * hubieran salido del cajón.
 */
export function detalleReparto(m: {
  // Sólo mira las líneas: no pide `tipo`/`monto`/cuentas como el resto, para
  // que la pueda usar cualquier query que traiga `pagos` sin arrastrar el
  // `select` completo de cuentas.
  pagos?: Array<{ monto: unknown; cuenta?: { nombre?: string } | null }>;
}): string | null {
  if (!m.pagos || m.pagos.length < 2) return null;
  return m.pagos
    .map(
      (p) =>
        `$${Number(p.monto).toLocaleString('es-AR', { minimumFractionDigits: 2 })} ` +
        `${p.cuenta?.nombre ?? '—'}`,
    )
    .join(' + ');
}

/**
 * La categoría de los cobros de cuenta corriente de mayoristas.
 *
 * Duplicada a propósito de `routes/mayoristas.ts` (que la crea): importarla
 * desde una ruta metería una dependencia servicio → ruta al revés de como
 * corren las capas. Si cambia el nombre hay que cambiarlo en los dos lados, y
 * por eso el nombre es de sistema (`esSistema: true`) y no se renombra.
 */
export const CATEGORIA_COBRO_CTA_CTE = 'Cobro cuenta corriente';

/**
 * ¿Este movimiento es el cobro de una cuenta corriente de mayorista?
 *
 * No es un "aporte o egreso" de caja: es el pago de mercadería que ya se
 * entregó — o sea, una VENTA que se cobra más tarde. Va con las ventas del
 * turno, no al final entre los ajustes de caja (pedido de la encargada, y es
 * lo correcto: si no, el turno donde cobra $500.000 de mayoristas parece
 * tener un "ingreso extraordinario" en vez de haber vendido).
 */
export function esCobroCuentaCorriente(m: {
  tipo: string;
  categoria?: { nombre: string } | null;
}): boolean {
  return m.tipo === 'INGRESO' && m.categoria?.nombre === CATEGORIA_COBRO_CTA_CTE;
}

/** Una porción del movimiento, atribuida a la cuenta de la que salió/entró. */
export interface TramoCuenta {
  cuenta: string;
  monto: number;
}

/**
 * Las porciones del movimiento que NO pasaron por el cajón, una por cuenta.
 *
 * Existe porque el cierre partía los movimientos en dos listas con un solo
 * booleano —"tocó la caja" / "no la tocó"— y un pago repartido no es ni una
 * cosa ni la otra. Un sueldo de $100.000 pagado 40% en efectivo y 60% por
 * Mercado Pago caía ENTERO en la lista de caja (por los $40.000) y sus
 * $60.000 no aparecían nunca en "movimientos en otras cuentas", donde están
 * los demás sueldos pagados por transferencia. La única huella era el
 * renglón chico del reparto, debajo del monto.
 *
 * Para la encargada eso es peor que un número mal: la lista de transferencias
 * se lee como si fuera todo lo que se pagó por banco, y calladamente no lo es.
 *
 * Con esto, cada movimiento aporta a la sección de caja lo que salió del
 * cajón y a la de otras cuentas lo que salió por banco. Nada se duplica: las
 * dos porciones suman el total.
 *
 * Las transferencias internas quedan afuera a propósito: ya se describen
 * enteras con "origen → destino" y repetirlas del otro lado sería contar dos
 * veces la misma operación.
 */
export function tramosNoCaja(m: MovimientoConPagos): TramoCuenta[] {
  if (m.tipo !== 'TRANSFERENCIA_INTERNA' && m.pagos && m.pagos.length > 0) {
    return m.pagos
      .filter((p) => !esCajaSesion(p.cuenta))
      .map((p) => ({ cuenta: p.cuenta?.nombre ?? '—', monto: Number(p.monto) }))
      .filter((t) => Math.abs(t.monto) > 0.0001);
  }

  // Sin reparto: o fue entero por el cajón, o entero por otra cuenta.
  if (afectaCaja(m)) return [];
  const nombre =
    m.tipo === 'TRANSFERENCIA_INTERNA'
      ? `${m.cuentaOrigen?.nombre ?? '—'} → ${m.cuentaDestino?.nombre ?? '—'}`
      : m.cuentaOrigen?.nombre ?? m.cuentaDestino?.nombre ?? '—';
  const monto = Number(m.monto);
  return Math.abs(monto) > 0.0001 ? [{ cuenta: nombre, monto }] : [];
}
