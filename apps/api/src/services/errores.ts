/**
 * Códigos de error: que "Internal Server Error" deje de ser el final del
 * camino.
 *
 * ── El problema que resuelve ─────────────────────────────────────────────
 *
 * Cuando algo falla en el mostrador, la cajera ve un cartel y llama. Hasta
 * ahora lo único que podía decir era "me tira error interno del servidor", que
 * no distingue una base caída de un precio mal cargado de un bug nuestro. Sin
 * más dato que ése, diagnosticar es adivinar.
 *
 * Ahora cada error sale con un código como `STA-DB-7K4M2P`:
 *
 *   - `DB` dice de QUÉ tipo es, de un vistazo y sin abrir nada.
 *   - `7K4M2P` es único de ESA vez que falló, y queda en el log del servidor
 *     junto al stack, la ruta, el usuario y el detalle técnico.
 *
 * Así, "me dio STA-DB-7K4M2P" alcanza para encontrar el incidente exacto en
 * Admin → Errores, con todo lo que hizo falta para entenderlo.
 *
 * ── Por qué el sufijo es aleatorio y no un contador ──────────────────────
 *
 * Un contador se reinicia con el proceso, y con varias cajas corriendo su
 * propio API habría tres errores distintos con el número 7. El sufijo
 * aleatorio no colisiona en la práctica y no necesita coordinación.
 *
 * ── Por qué NO se le muestra el detalle técnico a la cajera ──────────────
 *
 * El mensaje que ve ella dice qué pasó en criollo y el código. El stack, la
 * query y los datos del pedido quedan del lado del servidor: no le sirven, y
 * un stack en pantalla arriba de un mostrador lleno es ruido que asusta.
 */

/** Familia del error. El prefijo que se lee de un vistazo. */
export type CategoriaError =
  | 'VAL' // el pedido/formulario venía mal armado
  | 'AUTH' // sesión vencida, PIN, permisos
  | 'HORARIO' // fuera del horario del turno
  | 'DB' // la base rechazó la operación
  | 'CONN' // no se pudo hablar con la base
  | 'IMPR' // comandera/impresión
  | 'EXCEL' // el archivo de proveedores
  | 'REGLA' // una regla del negocio dijo que no
  | 'SRV'; // lo que no entra en ninguna de las anteriores

/** Qué se le muestra a quien está usando el sistema, por categoría. */
const MENSAJE: Record<CategoriaError, string> = {
  VAL: 'Hay un dato mal cargado en el pedido.',
  AUTH: 'La sesión no es válida o no tenés permiso para esto.',
  HORARIO: 'Estás fuera del horario del turno.',
  DB: 'La base de datos rechazó la operación.',
  CONN: 'No se pudo conectar con la base de datos.',
  IMPR: 'Falló la impresión.',
  EXCEL: 'No se pudo trabajar con el archivo de Excel.',
  REGLA: 'La operación no está permitida.',
  SRV: 'Hubo un error inesperado en el sistema.',
};

/**
 * Alfabeto sin `0/O/1/I/L`: el código se dicta por teléfono o se copia de una
 * pantalla, y esos cinco caracteres se confunden entre sí.
 */
const ALFABETO = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function sufijo(largo = 6): string {
  let s = '';
  for (let i = 0; i < largo; i++) {
    s += ALFABETO[Math.floor(Math.random() * ALFABETO.length)];
  }
  return s;
}

export function nuevoCodigo(cat: CategoriaError): string {
  return `STA-${cat}-${sufijo()}`;
}

/**
 * Una regla del negocio dijo que no.
 *
 * `throw new Error('Producto X no existe')` sale como 500 "error inesperado del
 * sistema", que es mentira: el sistema anda, lo que falta es el producto. Y a
 * quien está en el mostrador le importa la diferencia — una la puede arreglar
 * sola, la otra hay que reportarla. Con esta clase el mensaje llega tal cual a
 * la pantalla y el error se clasifica como REGLA, no como bug nuestro.
 */
export class ReglaNegocioError extends Error {
  override readonly name = 'ReglaNegocioError';
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Categoría a partir del status, para las respuestas de error que no pasan por
 * el manejador de errores (las que hacen `reply.code(401).send(...)` derecho).
 */
export function categoriaDeStatus(status: number): CategoriaError {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 423) return 'HORARIO';
  if (status === 400 || status === 422) return 'VAL';
  if (status < 500) return 'REGLA';
  if (status === 503) return 'CONN';
  return 'SRV';
}

interface ErrorCrudo {
  name?: string;
  message?: string;
  code?: string;
  statusCode?: number;
  stack?: string;
  meta?: unknown;
  clientVersion?: string;
}

/**
 * De qué tipo es este error y con qué status responder.
 *
 * El orden importa: lo más específico primero. Un `PrismaClientKnownRequestError`
 * también tiene `message`, así que si mirásemos el texto antes que el tipo
 * clasificaríamos mal.
 */
export function clasificar(err: unknown): {
  categoria: CategoriaError;
  status: number;
  /** Detalle técnico — va al log, NO a la pantalla. */
  detalle: string;
} {
  const e = (err ?? {}) as ErrorCrudo;
  const nombre = e.name ?? '';
  const msg = e.message ?? '';
  const status = typeof e.statusCode === 'number' ? e.statusCode : undefined;

  // ── Errores propios, que ya traen su status ──
  if (nombre === 'FueraDeHorarioError') {
    return { categoria: 'HORARIO', status: 423, detalle: msg };
  }
  if (nombre === 'AuthError') {
    return { categoria: 'AUTH', status: status ?? 401, detalle: msg };
  }
  if (nombre === 'ReglaNegocioError') {
    return { categoria: 'REGLA', status: status ?? 400, detalle: msg };
  }

  // ── Prisma ──
  // `code` es el P-code de Prisma (P2002 unique, P2003 FK, P2025 no existe…).
  // Los errores de Postgres que Prisma no mapea llegan como
  // PrismaClientUnknownRequestError con el SQLSTATE dentro del mensaje — el
  // caso del `22P02 invalid input syntax for type uuid` que rompió las
  // porciones calientes en alpha.62.
  if (nombre === 'PrismaClientInitializationError' || nombre === 'PrismaClientRustPanicError') {
    return { categoria: 'CONN', status: 503, detalle: `${nombre}: ${msg}` };
  }
  if (nombre.startsWith('PrismaClient')) {
    const p = e.code ? ` [${e.code}]` : '';
    const sqlstate = /\b(\d{2}[0-9A-Z]{3})\b/.exec(msg)?.[1];
    return {
      categoria: 'DB',
      status: 500,
      detalle: `${nombre}${p}${sqlstate ? ` [SQLSTATE ${sqlstate}]` : ''}: ${msg}`,
    };
  }

  // ── Con status explícito: lo puso alguien a propósito ──
  if (status !== undefined) {
    return { categoria: categoriaDeStatus(status), status, detalle: msg };
  }

  // ── Por área, según de dónde vino ──
  if (/impres|comandera|printer|ESC\/POS/i.test(msg)) {
    return { categoria: 'IMPR', status: 500, detalle: msg };
  }
  if (/\.xlsx|excel|hoja "|worksheet/i.test(msg)) {
    return { categoria: 'EXCEL', status: 500, detalle: msg };
  }

  return { categoria: 'SRV', status: 500, detalle: msg || String(err) };
}

/** Una entrada del registro de errores recientes. */
export interface ErrorRegistrado {
  codigo: string;
  categoria: CategoriaError;
  status: number;
  /** Lo que vio la persona. */
  mensaje: string;
  /** Lo técnico: tipo de error, código de Prisma, texto original. */
  detalle: string;
  metodo: string;
  ruta: string;
  usuario: string | null;
  pcOrigen: string | null;
  at: string;
  stack: string | null;
}

/**
 * Los últimos errores, en memoria.
 *
 * En memoria y no en una tabla a propósito: si la base es justo lo que está
 * fallando, un registro que necesita escribir en la base no sirve para nada —
 * que es exactamente cuando más se lo necesita. Se pierde al reiniciar, y está
 * bien: para eso el error también va al log del servidor, que sí persiste.
 */
/**
 * Dos anillos y no uno: los 401 vienen de a montones.
 *
 * Una caja con la sesión vencida sigue pidiéndole cosas al servidor y dispara
 * decenas de "sesión inválida" por minuto. En una lista sola, esa ráfaga
 * empuja afuera el error de base que estamos tratando de encontrar — justo el
 * que importa. Separados, un vendaval de sesión no puede tapar nada.
 */
const CAPACIDAD = 400;
const CAPACIDAD_SESION = 100;
const recientes: ErrorRegistrado[] = [];
const recientesSesion: ErrorRegistrado[] = [];

export function registrarError(e: ErrorRegistrado): void {
  const anillo = e.categoria === 'AUTH' ? recientesSesion : recientes;
  const tope = e.categoria === 'AUTH' ? CAPACIDAD_SESION : CAPACIDAD;
  anillo.unshift(e);
  if (anillo.length > tope) anillo.length = tope;
}

export function erroresRecientes(opts?: { categoria?: CategoriaError; codigo?: string; limite?: number }) {
  // Se juntan al leer, ordenados por hora: quien mira la lista ve una sola
  // cronología, sin enterarse de que por dentro son dos.
  let out =
    recientesSesion.length === 0
      ? recientes
      : [...recientes, ...recientesSesion].sort((a, b) => (a.at < b.at ? 1 : -1));
  if (opts?.codigo) {
    const q = opts.codigo.trim().toUpperCase();
    out = out.filter((e) => e.codigo.includes(q));
  }
  if (opts?.categoria) out = out.filter((e) => e.categoria === opts.categoria);
  return out.slice(0, opts?.limite ?? 100);
}

/** El texto que ve la persona: qué pasó, y el código para reportarlo. */
export function mensajeParaPantalla(cat: CategoriaError, codigo: string, propio?: string): string {
  // Si alguien tiró un error con un mensaje escrito para el usuario (las
  // reglas de negocio lo hacen), ese gana: dice algo más útil que el genérico.
  const base = propio && propio.trim() ? propio.trim() : MENSAJE[cat];
  return `${base} (código ${codigo})`;
}
