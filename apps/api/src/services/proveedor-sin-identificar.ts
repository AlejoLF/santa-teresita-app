import { prisma } from '@sta/db/client';
import { recordAudit } from './audit.js';

/**
 * EL PROVEEDOR DE ESPERA — dónde aterrizan las facturas cuyo proveedor el OCR
 * no pudo leer.
 *
 * En muchas facturas el nombre del proveedor es un logo estilizado, no texto.
 * Ningún OCR lo lee, y exigirlo hacía que la factura rebotara con 400: se
 * perdía entera y había que cargarla a mano.
 *
 * La factura entra igual, colgada de este proveedor, y queda en
 * PENDIENTE_VALIDACION (el default) hasta que alguien le asigne el proveedor
 * de verdad desde la lista, con "no es este" en la ficha de la factura.
 *
 * POR QUÉ UN PROVEEDOR PLACEHOLDER Y NO `proveedorId` NULL: la columna es NOT
 * NULL y la usan como FK la cuenta corriente, los pagos y la imputación de
 * facturas. Hacerla nullable obligaría a revisar todas esas queries para que
 * no cuenten mal. Con una fila real, todo lo que ya existe —incluido el
 * endpoint para reasignar y el aprendizaje de alias— funciona sin tocar nada.
 *
 * Efectos secundarios buenos de que sea una fila real: la deuda sin identificar
 * se ve en la lista de proveedores en vez de quedar escondida, y como la
 * factura entra sin validar, `facturasPendientesDe` (que sólo mira
 * PENDIENTE_PAGO y PAGADA_PARCIAL) no la ofrece nunca para pagar. No se puede
 * pagar por accidente una factura de la que todavía no se sabe de quién es.
 */
export const PROVEEDOR_SIN_IDENTIFICAR = 'Sin identificar';

let cacheId: string | null = null;

/**
 * Devuelve el id del proveedor de espera, creándolo la primera vez.
 *
 * `activo: false` a propósito: así no aparece como opción para elegir al
 * cargar un pago o una factura a mano, ni entra al `buscarProveedorParecido`
 * (que filtra por activos). Es un casillero del sistema, no un proveedor.
 */
export async function getProveedorSinIdentificar(): Promise<string> {
  if (cacheId) return cacheId;

  const existente = await prisma.proveedor.findFirst({
    where: { nombre: PROVEEDOR_SIN_IDENTIFICAR },
    select: { id: true },
  });
  if (existente) {
    cacheId = existente.id;
    return cacheId;
  }

  const nuevo = await prisma.proveedor.create({
    data: {
      nombre: PROVEEDOR_SIN_IDENTIFICAR,
      activo: false,
      observaciones:
        'Casillero del sistema: acá caen las facturas cuyo proveedor el OCR no pudo leer, ' +
        'hasta que alguien les asigne el proveedor real desde la ficha de la factura.',
    },
    select: { id: true },
  });

  // Igual que con los proveedores que crea el OCR: el audit es lo que genera
  // el evento de outbox que replica la fila a Supabase. Sin esto la factura
  // que lo referencia falla al replicar por violación de FK.
  await recordAudit({
    tabla: 'proveedores',
    registroId: nuevo.id,
    accion: 'INSERT',
    usuarioId: null,
    valorNuevo: { nombre: PROVEEDOR_SIN_IDENTIFICAR, activo: false },
    contexto: { fuente: 'ingest-ocr', motivo: 'proveedor de espera del sistema' },
  });

  cacheId = nuevo.id;
  return cacheId;
}

/** ¿Esta factura todavía no tiene proveedor de verdad? */
export async function esSinIdentificar(proveedorId: string): Promise<boolean> {
  return proveedorId === (await getProveedorSinIdentificar());
}
