-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gin";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateEnum
CREATE TYPE "RolUsuario" AS ENUM ('VENDEDOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "FormaVenta" AS ENUM ('UNIDAD', 'GRAMO', 'PLANCHA', 'PORCION');

-- CreateEnum
CREATE TYPE "UnidadPrecio" AS ENUM ('POR_UNIDAD', 'POR_GRAMO', 'POR_KILO', 'POR_PORCION', 'POR_PLANCHA', 'POR_DOCENA');

-- CreateEnum
CREATE TYPE "TipoSeleccion" AS ENUM ('UNICA', 'MULTIPLE');

-- CreateEnum
CREATE TYPE "CanalListaPrecios" AS ENUM ('LOCAL_MOSTRADOR', 'LOCAL_WEB', 'WHATSAPP', 'TELEFONO', 'RAPPI', 'PEDIDOS_YA', 'MERCADO_LIBRE', 'DELIVERATE', 'MAYORISTA');

-- CreateEnum
CREATE TYPE "TipoComponenteCombo" AS ENUM ('PRODUCTO_FIJO', 'OPCION_ENTRE_VARIOS');

-- CreateEnum
CREATE TYPE "TipoCuenta" AS ENUM ('EFECTIVO', 'BANCO', 'WALLET');

-- CreateEnum
CREATE TYPE "MetodoActualizacionCuenta" AS ENUM ('MANUAL', 'API_MP', 'BELVO', 'IMPORT_EXTRACTO');

-- CreateEnum
CREATE TYPE "TipoCuentaACobrar" AS ENUM ('TARJETA_DEBITO', 'TARJETA_CREDITO', 'TARJETA_CUOTAS', 'PLATAFORMA_DELIVERY', 'EMPRESA_DELIVERY');

-- CreateEnum
CREATE TYPE "EstadoLiquidacion" AS ENUM ('PENDIENTE', 'LIQUIDADA', 'ANULADA');

-- CreateEnum
CREATE TYPE "TipoMovimiento" AS ENUM ('INGRESO', 'EGRESO', 'TRANSFERENCIA_INTERNA', 'LIQUIDACION', 'AJUSTE');

-- CreateEnum
CREATE TYPE "EstadoMovimiento" AS ENUM ('PENDIENTE', 'CONFIRMADO', 'ANULADO');

-- CreateEnum
CREATE TYPE "TipoCategoriaMovimiento" AS ENUM ('INGRESO', 'EGRESO', 'TRANSFERENCIA', 'AMBOS');

-- CreateEnum
CREATE TYPE "MetodoPago" AS ENUM ('EFECTIVO', 'DEBITO', 'CREDITO_1_PAGO', 'CREDITO_CUOTAS', 'TRANSFERENCIA', 'DEPOSITO', 'MERCADOPAGO_QR', 'CHEQUE', 'TARJETA_NARANJA', 'OTRO');

-- CreateEnum
CREATE TYPE "EstadoPago" AS ENUM ('PENDIENTE', 'CONFIRMADO', 'ANULADO');

-- CreateEnum
CREATE TYPE "TurnoCaja" AS ENUM ('MANANA', 'TARDE');

-- CreateEnum
CREATE TYPE "EstadoSesionCaja" AS ENUM ('ABIERTA', 'CERRADA', 'APROBADA');

-- CreateEnum
CREATE TYPE "CanalVenta" AS ENUM ('MOSTRADOR', 'TELEFONO', 'WHATSAPP', 'WEB', 'RAPPI', 'PEDIDOS_YA', 'MERCADO_LIBRE', 'DELIVERATE');

-- CreateEnum
CREATE TYPE "ModalidadVenta" AS ENUM ('TAKE_AWAY', 'DELIVERY_PROPIO', 'DELIVERY_PLATAFORMA', 'DELIVERY_DELIVERATE');

-- CreateEnum
CREATE TYPE "EstadoVenta" AS ENUM ('PROCESADA', 'FINALIZADA', 'ANULADA');

-- CreateEnum
CREATE TYPE "TipoCliente" AS ENUM ('CASUAL', 'REGISTRADO', 'CORPORATIVO', 'PLATAFORMA');

-- CreateEnum
CREATE TYPE "EstadoEntregaDelivery" AS ENUM ('PENDIENTE', 'EN_RUTA', 'ENTREGADO', 'NO_ENTREGADO', 'DEVUELTO');

-- CreateEnum
CREATE TYPE "CondicionIva" AS ENUM ('RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO', 'CONSUMIDOR_FINAL');

-- CreateEnum
CREATE TYPE "CategoriaInsumo" AS ENUM ('VERDULERIA', 'LACTEOS', 'CARNES', 'POLLO', 'HUEVOS', 'HARINAS', 'CONDIMENTOS', 'ENVASES', 'LIMPIEZA', 'BEBIDAS', 'SIN_TACC', 'POSTRES', 'OTROS');

-- CreateEnum
CREATE TYPE "UnidadCompra" AS ENUM ('KG', 'GRAMOS', 'UNIDAD', 'LITRO', 'CAJA', 'BOLSA', 'PAQUETE', 'DOCENA', 'OTRO');

-- CreateEnum
CREATE TYPE "TipoComprobanteRecibido" AS ENUM ('FACTURA_A', 'FACTURA_B', 'FACTURA_C', 'FACTURA_X', 'NOTA_CREDITO', 'NOTA_DEBITO', 'TICKET', 'REMITO', 'OTRO');

-- CreateEnum
CREATE TYPE "EstadoFacturaRecibida" AS ENUM ('PENDIENTE_VALIDACION', 'PENDIENTE_PAGO', 'PAGADA_PARCIAL', 'PAGADA', 'ANULADA');

-- CreateEnum
CREATE TYPE "OrigenFacturaRecibida" AS ENUM ('TELEGRAM_OCR', 'PROGRAMA_FOTO', 'PROGRAMA_MANUAL', 'EXCEL_LEGACY');

-- CreateEnum
CREATE TYPE "TipoComprobanteEmitido" AS ENUM ('FACTURA_A', 'FACTURA_B', 'FACTURA_C');

-- CreateEnum
CREATE TYPE "TipoLoginAudit" AS ENUM ('LOGIN_EXITOSO', 'LOGIN_FALLIDO', 'APROBACION_ADMIN_INLINE', 'CAMBIO_PIN', 'RESET_PIN', 'BLOQUEO_INACTIVIDAD', 'DESBLOQUEO', 'LOGOUT_MANUAL');

-- CreateEnum
CREATE TYPE "EstadoAprobacionExcel" AS ENUM ('PENDIENTE', 'APROBADA', 'RECHAZADA', 'POSPUESTA', 'APLICADA_PARCIAL');

-- CreateEnum
CREATE TYPE "FuenteSyncExcel" AS ENUM ('LISTA_PRECIOS', 'PROVEEDORES', 'VENTAS', 'CASHFLOW');

-- CreateEnum
CREATE TYPE "TipoTrabajoImpresion" AS ENUM ('COMANDA_COCINA', 'COMANDA_CANCELADA', 'COMANDA_REIMPRESION', 'TICKET_CLIENTE', 'TICKET_DELIVERY', 'TICKET_REIMPRESION', 'TEST');

-- CreateEnum
CREATE TYPE "EstadoTrabajoImpresion" AS ENUM ('PENDIENTE', 'EN_PROCESO', 'IMPRESO', 'ERROR', 'CANCELADO');

-- CreateTable
CREATE TABLE "usuarios" (
    "id" UUID NOT NULL,
    "nombre" VARCHAR(120) NOT NULL,
    "rol" "RolUsuario" NOT NULL,
    "pin_hash" TEXT NOT NULL,
    "pin_ultimo_cambio_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "intentos_fallidos" INTEGER NOT NULL DEFAULT 0,
    "bloqueado_hasta" TIMESTAMP(3),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_por_id" UUID,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "pc_origen" VARCHAR(40) NOT NULL,
    "ip_origen" VARCHAR(64),
    "user_agent" TEXT,
    "token_hash" TEXT NOT NULL,
    "emitido_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultima_actividad_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expira_at" TIMESTAMP(3) NOT NULL,
    "revocada_at" TIMESTAMP(3),
    "motivo_revocacion" TEXT,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categorias" (
    "id" UUID NOT NULL,
    "nombre" VARCHAR(80) NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "icono" VARCHAR(40),
    "color" VARCHAR(20),
    "activa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "categorias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tipos_producto" (
    "id" UUID NOT NULL,
    "categoria_id" UUID NOT NULL,
    "nombre" VARCHAR(120) NOT NULL,
    "descripcion" TEXT,
    "cocina_interviene" BOOLEAN NOT NULL DEFAULT false,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tipos_producto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "productos" (
    "id" UUID NOT NULL,
    "tipo_producto_id" UUID NOT NULL,
    "nombre" VARCHAR(160) NOT NULL,
    "forma_venta" "FormaVenta" NOT NULL,
    "precio_base" DECIMAL(18,2) NOT NULL,
    "unidad_precio" "UnidadPrecio" NOT NULL,
    "cantidad_default" DECIMAL(12,3),
    "descripcion" TEXT,
    "imagen_url" TEXT,
    "codigo" VARCHAR(40),
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "productos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grupos_modificador" (
    "id" UUID NOT NULL,
    "nombre" VARCHAR(80) NOT NULL,
    "tipo_seleccion" "TipoSeleccion" NOT NULL,
    "obligatorio" BOOLEAN NOT NULL DEFAULT false,
    "min_opciones" INTEGER NOT NULL DEFAULT 0,
    "max_opciones" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "grupos_modificador_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opciones_modificador" (
    "id" UUID NOT NULL,
    "grupo_id" UUID NOT NULL,
    "nombre" VARCHAR(120) NOT NULL,
    "delta_precio" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "opciones_modificador_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modificadores_aplicables" (
    "id" UUID NOT NULL,
    "grupo_modificador_id" UUID NOT NULL,
    "tipo_producto_id" UUID,
    "producto_id" UUID,
    "obligatorio_override" BOOLEAN,

    CONSTRAINT "modificadores_aplicables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combos" (
    "id" UUID NOT NULL,
    "nombre" VARCHAR(160) NOT NULL,
    "precio_combo" DECIMAL(18,2) NOT NULL,
    "vigencia_desde" DATE,
    "vigencia_hasta" DATE,
    "canales_aplicables" "CanalListaPrecios"[],
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "observaciones" TEXT,
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "combos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "componentes_combo" (
    "id" UUID NOT NULL,
    "combo_id" UUID NOT NULL,
    "tipo" "TipoComponenteCombo" NOT NULL,
    "cantidad" DECIMAL(12,3) NOT NULL,
    "producto_id" UUID,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "etiqueta" VARCHAR(80),

    CONSTRAINT "componentes_combo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opciones_componente_combo" (
    "id" UUID NOT NULL,
    "componente_id" UUID NOT NULL,
    "producto_id" UUID NOT NULL,

    CONSTRAINT "opciones_componente_combo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listas_precios" (
    "id" UUID NOT NULL,
    "nombre" VARCHAR(80) NOT NULL,
    "canal_default" "CanalListaPrecios" NOT NULL,
    "ajuste_pct_default" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "moneda" VARCHAR(8) NOT NULL DEFAULT 'ARS',
    "activa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "listas_precios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "precios_por_lista" (
    "id" UUID NOT NULL,
    "producto_id" UUID NOT NULL,
    "lista_id" UUID NOT NULL,
    "precio_efectivo" DECIMAL(18,2) NOT NULL,
    "vigencia_desde" TIMESTAMP(3) NOT NULL,
    "vigencia_hasta" TIMESTAMP(3),
    "usuario_id" UUID,

    CONSTRAINT "precios_por_lista_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historial_precios" (
    "id" UUID NOT NULL,
    "producto_id" UUID NOT NULL,
    "lista_id" UUID,
    "precio_anterior" DECIMAL(18,2) NOT NULL,
    "precio_nuevo" DECIMAL(18,2) NOT NULL,
    "fecha_cambio" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usuario_id" UUID,
    "motivo" TEXT,

    CONSTRAINT "historial_precios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cuentas" (
    "id" UUID NOT NULL,
    "nombre" VARCHAR(80) NOT NULL,
    "tipo" "TipoCuenta" NOT NULL,
    "banco" VARCHAR(80),
    "cbu_cvu" VARCHAR(40),
    "alias" VARCHAR(40),
    "moneda" VARCHAR(8) NOT NULL DEFAULT 'ARS',
    "saldo_actual" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "metodo_actualizacion" "MetodoActualizacionCuenta" NOT NULL DEFAULT 'MANUAL',
    "ultima_conciliacion" TIMESTAMP(3),
    "comision_mensual" DECIMAL(18,2),
    "activa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "cuentas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cuentas_a_cobrar" (
    "id" UUID NOT NULL,
    "nombre" VARCHAR(80) NOT NULL,
    "tipo" "TipoCuentaACobrar" NOT NULL,
    "cuenta_destino_id" UUID NOT NULL,
    "plazo_dias" INTEGER NOT NULL DEFAULT 0,
    "comision_pct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "saldo_pendiente" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "activa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "cuentas_a_cobrar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liquidaciones_pendientes" (
    "id" UUID NOT NULL,
    "cuenta_a_cobrar_id" UUID NOT NULL,
    "venta_id" UUID,
    "pago_id" UUID,
    "monto_bruto" DECIMAL(18,2) NOT NULL,
    "comision_estimada" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "monto_neto_esperado" DECIMAL(18,2) NOT NULL,
    "fecha_acreditacion_esperada" DATE NOT NULL,
    "estado" "EstadoLiquidacion" NOT NULL DEFAULT 'PENDIENTE',
    "fecha_liquidacion_real" TIMESTAMP(3),
    "monto_liquidado_real" DECIMAL(18,2),
    "diferencia" DECIMAL(18,2),
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "liquidaciones_pendientes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posnets" (
    "id" UUID NOT NULL,
    "nombre" VARCHAR(80) NOT NULL,
    "marca" VARCHAR(80) NOT NULL,
    "modelo" VARCHAR(80),
    "adquirente" VARCHAR(80),
    "cuenta_a_cobrar_debito_id" UUID,
    "cuenta_a_cobrar_credito_id" UUID,
    "cuenta_destino_id" UUID,
    "ubicacion" VARCHAR(80),
    "soporta_integracion" BOOLEAN NOT NULL DEFAULT false,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "posnets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categorias_movimiento" (
    "id" UUID NOT NULL,
    "nombre" VARCHAR(80) NOT NULL,
    "tipo" "TipoCategoriaMovimiento" NOT NULL,
    "es_sistema" BOOLEAN NOT NULL DEFAULT false,
    "es_operativa" BOOLEAN NOT NULL DEFAULT true,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "categorias_movimiento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movimientos" (
    "id" UUID NOT NULL,
    "tipo" "TipoMovimiento" NOT NULL,
    "monto" DECIMAL(18,2) NOT NULL,
    "moneda" VARCHAR(8) NOT NULL DEFAULT 'ARS',
    "cuenta_origen_id" UUID,
    "cuenta_destino_id" UUID,
    "cuenta_a_cobrar_id" UUID,
    "categoria_id" UUID NOT NULL,
    "entidad_id" UUID,
    "venta_id" UUID,
    "fecha_computo" TIMESTAMP(3) NOT NULL,
    "fecha_alta" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha_vencimiento" TIMESTAMP(3),
    "estado" "EstadoMovimiento" NOT NULL DEFAULT 'CONFIRMADO',
    "observacion" TEXT,
    "usuario_id" UUID NOT NULL,
    "sesion_caja_id" UUID,
    "adicionales" JSONB,

    CONSTRAINT "movimientos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movimiento_facturas" (
    "movimiento_id" UUID NOT NULL,
    "factura_id" UUID NOT NULL,

    CONSTRAINT "movimiento_facturas_pkey" PRIMARY KEY ("movimiento_id","factura_id")
);

-- CreateTable
CREATE TABLE "pagos" (
    "id" UUID NOT NULL,
    "movimiento_id" UUID,
    "venta_id" UUID,
    "metodo" "MetodoPago" NOT NULL,
    "cuenta_id" UUID NOT NULL,
    "cuenta_a_cobrar_id" UUID,
    "monto" DECIMAL(18,2) NOT NULL,
    "cambio_dado" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "retenido" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "numero_referencia" VARCHAR(80),
    "titular" VARCHAR(120),
    "banco" VARCHAR(80),
    "tarjeta_ultimos4" VARCHAR(8),
    "posnet_id" UUID,
    "estado" "EstadoPago" NOT NULL DEFAULT 'CONFIRMADO',
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pagos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pagos_factura" (
    "id" UUID NOT NULL,
    "pago_id" UUID NOT NULL,
    "factura_id" UUID NOT NULL,
    "movimiento_id" UUID,
    "monto_aplicado" DECIMAL(18,2) NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pagos_factura_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sesiones_caja" (
    "id" UUID NOT NULL,
    "fecha" DATE NOT NULL,
    "turno" "TurnoCaja" NOT NULL,
    "horario_apertura" TIMESTAMP(3) NOT NULL,
    "horario_cierre" TIMESTAMP(3),
    "existencia_inicial" DECIMAL(18,2) NOT NULL,
    "existencia_final" DECIMAL(18,2),
    "recaudacion_esperada" DECIMAL(18,2),
    "diferencia" DECIMAL(18,2),
    "usuario_apertura_id" UUID NOT NULL,
    "usuario_cierre_id" UUID,
    "aprobada_por_admin" BOOLEAN NOT NULL DEFAULT false,
    "aprobada_admin_id" UUID,
    "fecha_aprobacion" TIMESTAMP(3),
    "estado" "EstadoSesionCaja" NOT NULL DEFAULT 'ABIERTA',
    "observaciones" TEXT,
    "email_enviado_a" TEXT,
    "email_enviado_at" TIMESTAMP(3),

    CONSTRAINT "sesiones_caja_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ventas" (
    "id" UUID NOT NULL,
    "numero" SERIAL NOT NULL,
    "numero_orden_turno" INTEGER NOT NULL,
    "canal" "CanalVenta" NOT NULL,
    "modalidad" "ModalidadVenta" NOT NULL,
    "estado" "EstadoVenta" NOT NULL DEFAULT 'PROCESADA',
    "cliente_id" UUID,
    "lista_precios_id" UUID NOT NULL,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "descuento_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "recargo_canal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total_pagado" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "pc_origen" VARCHAR(40) NOT NULL,
    "usuario_apertura_id" UUID NOT NULL,
    "usuario_cierre_id" UUID,
    "usuario_anulacion_id" UUID,
    "motivo_anulacion" TEXT,
    "sesion_caja_id" UUID NOT NULL,
    "fecha_apertura" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha_finalizacion" TIMESTAMP(3),
    "fecha_anulacion" TIMESTAMP(3),
    "observaciones" TEXT,
    "id_externo_canal" VARCHAR(120),
    "payload_externo" JSONB,
    "tiene_cocina" BOOLEAN NOT NULL DEFAULT false,
    "comanda_impresa" BOOLEAN NOT NULL DEFAULT false,
    "ticket_cliente_impreso" BOOLEAN NOT NULL DEFAULT false,
    "descuento_efectivo_aplicado" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ventas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items_venta" (
    "id" UUID NOT NULL,
    "venta_id" UUID NOT NULL,
    "producto_id" UUID NOT NULL,
    "nombre_snapshot" VARCHAR(160) NOT NULL,
    "cantidad" DECIMAL(12,3) NOT NULL,
    "unidad" "FormaVenta" NOT NULL,
    "precio_unitario" DECIMAL(18,2) NOT NULL,
    "modificadores_aplicados" JSONB,
    "delta_modificadores" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "descuento_linea" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total_linea" DECIMAL(18,2) NOT NULL,
    "observacion" TEXT,
    "parte_de_combo_id" UUID,
    "parte_de_combo_instancia" UUID,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "cocina_interviene" BOOLEAN NOT NULL DEFAULT false,
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editado_at" TIMESTAMP(3),
    "editado_por_id" UUID,

    CONSTRAINT "items_venta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clientes" (
    "id" UUID NOT NULL,
    "tipo" "TipoCliente" NOT NULL DEFAULT 'CASUAL',
    "nombre" VARCHAR(120) NOT NULL,
    "apellido" VARCHAR(120),
    "telefono" VARCHAR(40),
    "email" VARCHAR(120),
    "cuit_cuil" VARCHAR(20),
    "fecha_nacimiento" DATE,
    "observaciones" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clientes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "direcciones" (
    "id" UUID NOT NULL,
    "cliente_id" UUID NOT NULL,
    "etiqueta" VARCHAR(40) NOT NULL DEFAULT 'Casa',
    "calle" VARCHAR(120) NOT NULL,
    "numero" VARCHAR(20) NOT NULL,
    "piso" VARCHAR(10),
    "depto" VARCHAR(10),
    "entre_calles" VARCHAR(160),
    "localidad" VARCHAR(80) NOT NULL DEFAULT 'La Plata',
    "codigo_postal" VARCHAR(20),
    "indicaciones" TEXT,
    "es_default" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "direcciones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_info" (
    "id" UUID NOT NULL,
    "venta_id" UUID NOT NULL,
    "direccion_id" UUID,
    "direccion_snapshot" JSONB NOT NULL,
    "repartidor_id" UUID,
    "empresa_externa" VARCHAR(80),
    "hora_prometida" TIMESTAMP(3),
    "hora_salida" TIMESTAMP(3),
    "hora_entrega" TIMESTAMP(3),
    "estado" "EstadoEntregaDelivery" NOT NULL DEFAULT 'PENDIENTE',
    "motivo_no_entrega" TEXT,
    "observaciones" TEXT,

    CONSTRAINT "delivery_info_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proveedores" (
    "id" UUID NOT NULL,
    "nombre" VARCHAR(120) NOT NULL,
    "razon_social" VARCHAR(160),
    "cuit" VARCHAR(20),
    "condicion_iva" "CondicionIva",
    "direccion" VARCHAR(200),
    "localidad" VARCHAR(80),
    "telefono" VARCHAR(40),
    "email" VARCHAR(120),
    "persona_contacto" VARCHAR(120),
    "categoria_principal" VARCHAR(80),
    "plazo_pago_dias" INTEGER NOT NULL DEFAULT 0,
    "observaciones" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimo_movimiento_at" TIMESTAMP(3),

    CONSTRAINT "proveedores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insumos" (
    "id" UUID NOT NULL,
    "nombre" VARCHAR(160) NOT NULL,
    "categoria" "CategoriaInsumo" NOT NULL,
    "unidad_compra" "UnidadCompra" NOT NULL,
    "presentacion" VARCHAR(160),
    "proveedor_principal_id" UUID,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "stock_actual" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "stock_minimo" DECIMAL(18,3),
    "observaciones" TEXT,

    CONSTRAINT "insumos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insumo_proveedores" (
    "insumo_id" UUID NOT NULL,
    "proveedor_id" UUID NOT NULL,
    "precio_ultimo" DECIMAL(18,2),
    "fecha_ultimo_precio" DATE,
    "es_principal" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "insumo_proveedores_pkey" PRIMARY KEY ("insumo_id","proveedor_id")
);

-- CreateTable
CREATE TABLE "facturas_recibidas" (
    "id" UUID NOT NULL,
    "proveedor_id" UUID NOT NULL,
    "tipo_comprobante" "TipoComprobanteRecibido" NOT NULL,
    "punto_venta" VARCHAR(20),
    "numero" VARCHAR(40) NOT NULL,
    "cuit_emisor" VARCHAR(20),
    "razon_social_emisor" VARCHAR(160),
    "fecha_emision" DATE NOT NULL,
    "fecha_computo" DATE NOT NULL,
    "fecha_vencimiento" DATE,
    "neto_gravado" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "neto_no_gravado" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "iva_21" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "iva_10_5" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "iva_27" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "otros_impuestos" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL,
    "total_pagado" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "estado" "EstadoFacturaRecibida" NOT NULL DEFAULT 'PENDIENTE_VALIDACION',
    "origen" "OrigenFacturaRecibida" NOT NULL,
    "adjunto_url" TEXT,
    "adjunto_hash" VARCHAR(80),
    "ocr_payload" JSONB,
    "ocr_confianza" DECIMAL(5,4),
    "fecha_pago_programada" DATE,
    "observaciones" TEXT,
    "usuario_carga_id" UUID,
    "usuario_validacion_id" UUID,
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validada_at" TIMESTAMP(3),
    "pagada_at" TIMESTAMP(3),

    CONSTRAINT "facturas_recibidas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facturas_recibidas_items" (
    "id" UUID NOT NULL,
    "factura_id" UUID NOT NULL,
    "insumo_id" UUID,
    "descripcion" VARCHAR(240) NOT NULL,
    "cantidad" DECIMAL(12,3) NOT NULL,
    "unidad" VARCHAR(20) NOT NULL,
    "precio_unitario" DECIMAL(18,4) NOT NULL,
    "alicuota_iva" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "facturas_recibidas_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facturas_emitidas" (
    "id" UUID NOT NULL,
    "cliente_id" UUID NOT NULL,
    "tipo_comprobante" "TipoComprobanteEmitido" NOT NULL,
    "numero_interno" VARCHAR(40) NOT NULL,
    "numero_fiscal" VARCHAR(40),
    "fecha_emision" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "neto_gravado" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "iva" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL,
    "pdf_generado_url" TEXT,
    "observaciones" TEXT,
    "creado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creado_por_id" UUID NOT NULL,

    CONSTRAINT "facturas_emitidas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "secuencia" BIGSERIAL NOT NULL,
    "tabla" VARCHAR(80) NOT NULL,
    "registro_id" VARCHAR(80) NOT NULL,
    "accion" VARCHAR(40) NOT NULL,
    "usuario_id" UUID,
    "pc_origen" VARCHAR(40),
    "ip_origen" VARCHAR(64),
    "valor_anterior" JSONB,
    "valor_nuevo" JSONB,
    "contexto" JSONB,
    "observaciones" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hash_anterior" VARCHAR(80),
    "hash_actual" VARCHAR(80) NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_audit" (
    "id" UUID NOT NULL,
    "usuario_id" UUID,
    "tipo" "TipoLoginAudit" NOT NULL,
    "pc_origen" VARCHAR(40),
    "ip_origen" VARCHAR(64),
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accion_aprobada" VARCHAR(120),
    "accion_contexto" JSONB,
    "usuario_solicitante_id" UUID,
    "observaciones" TEXT,

    CONSTRAINT "login_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aprobaciones_excel" (
    "id" UUID NOT NULL,
    "fuente" "FuenteSyncExcel" NOT NULL,
    "archivo_nombre" VARCHAR(160) NOT NULL,
    "archivo_drive_file_id" VARCHAR(160) NOT NULL,
    "modificado_en" TIMESTAMP(3) NOT NULL,
    "modificado_por" VARCHAR(120),
    "detectado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cambios_total" INTEGER NOT NULL DEFAULT 0,
    "cambios_aplicables" INTEGER NOT NULL DEFAULT 0,
    "cambios_sospechosos" INTEGER NOT NULL DEFAULT 0,
    "cambios_errores" INTEGER NOT NULL DEFAULT 0,
    "estado" "EstadoAprobacionExcel" NOT NULL DEFAULT 'PENDIENTE',
    "diff" JSONB NOT NULL,
    "aprobada_at" TIMESTAMP(3),
    "aprobada_por_id" UUID,
    "observaciones" TEXT,

    CONSTRAINT "aprobaciones_excel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trabajos_impresion" (
    "id" UUID NOT NULL,
    "tipo" "TipoTrabajoImpresion" NOT NULL,
    "venta_id" UUID,
    "destino" VARCHAR(40) NOT NULL,
    "payload" JSONB NOT NULL,
    "estado" "EstadoTrabajoImpresion" NOT NULL DEFAULT 'PENDIENTE',
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "ultimo_error" TEXT,
    "encolado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "procesado_at" TIMESTAMP(3),
    "impreso_at" TIMESTAMP(3),

    CONSTRAINT "trabajos_impresion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "topic" VARCHAR(80) NOT NULL,
    "payload" JSONB NOT NULL,
    "agregado_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publicado_at" TIMESTAMP(3),
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "ultimo_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_VentaFacturaEmitida" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL
);

-- CreateIndex
CREATE INDEX "usuarios_rol_activo_idx" ON "usuarios"("rol", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_usuario_id_revocada_at_idx" ON "auth_sessions"("usuario_id", "revocada_at");

-- CreateIndex
CREATE INDEX "auth_sessions_expira_at_idx" ON "auth_sessions"("expira_at");

-- CreateIndex
CREATE UNIQUE INDEX "categorias_nombre_key" ON "categorias"("nombre");

-- CreateIndex
CREATE INDEX "tipos_producto_categoria_id_activo_idx" ON "tipos_producto"("categoria_id", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "productos_codigo_key" ON "productos"("codigo");

-- CreateIndex
CREATE INDEX "productos_tipo_producto_id_activo_idx" ON "productos"("tipo_producto_id", "activo");

-- CreateIndex
CREATE INDEX "productos_nombre_idx" ON "productos"("nombre");

-- CreateIndex
CREATE INDEX "opciones_modificador_grupo_id_activa_idx" ON "opciones_modificador"("grupo_id", "activa");

-- CreateIndex
CREATE UNIQUE INDEX "modificadores_aplicables_grupo_modificador_id_tipo_producto_key" ON "modificadores_aplicables"("grupo_modificador_id", "tipo_producto_id", "producto_id");

-- CreateIndex
CREATE INDEX "combos_activo_vigencia_desde_vigencia_hasta_idx" ON "combos"("activo", "vigencia_desde", "vigencia_hasta");

-- CreateIndex
CREATE INDEX "componentes_combo_combo_id_orden_idx" ON "componentes_combo"("combo_id", "orden");

-- CreateIndex
CREATE UNIQUE INDEX "opciones_componente_combo_componente_id_producto_id_key" ON "opciones_componente_combo"("componente_id", "producto_id");

-- CreateIndex
CREATE UNIQUE INDEX "listas_precios_nombre_key" ON "listas_precios"("nombre");

-- CreateIndex
CREATE INDEX "precios_por_lista_producto_id_lista_id_vigencia_desde_idx" ON "precios_por_lista"("producto_id", "lista_id", "vigencia_desde");

-- CreateIndex
CREATE INDEX "historial_precios_producto_id_fecha_cambio_idx" ON "historial_precios"("producto_id", "fecha_cambio");

-- CreateIndex
CREATE UNIQUE INDEX "cuentas_nombre_key" ON "cuentas"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "cuentas_a_cobrar_nombre_key" ON "cuentas_a_cobrar"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "liquidaciones_pendientes_pago_id_key" ON "liquidaciones_pendientes"("pago_id");

-- CreateIndex
CREATE INDEX "liquidaciones_pendientes_cuenta_a_cobrar_id_fecha_acreditac_idx" ON "liquidaciones_pendientes"("cuenta_a_cobrar_id", "fecha_acreditacion_esperada", "estado");

-- CreateIndex
CREATE INDEX "liquidaciones_pendientes_estado_fecha_acreditacion_esperada_idx" ON "liquidaciones_pendientes"("estado", "fecha_acreditacion_esperada");

-- CreateIndex
CREATE UNIQUE INDEX "posnets_nombre_key" ON "posnets"("nombre");

-- CreateIndex
CREATE UNIQUE INDEX "categorias_movimiento_nombre_key" ON "categorias_movimiento"("nombre");

-- CreateIndex
CREATE INDEX "movimientos_fecha_computo_idx" ON "movimientos"("fecha_computo");

-- CreateIndex
CREATE INDEX "movimientos_categoria_id_estado_idx" ON "movimientos"("categoria_id", "estado");

-- CreateIndex
CREATE INDEX "movimientos_entidad_id_estado_idx" ON "movimientos"("entidad_id", "estado");

-- CreateIndex
CREATE INDEX "movimientos_sesion_caja_id_idx" ON "movimientos"("sesion_caja_id");

-- CreateIndex
CREATE INDEX "pagos_venta_id_idx" ON "pagos"("venta_id");

-- CreateIndex
CREATE INDEX "pagos_movimiento_id_idx" ON "pagos"("movimiento_id");

-- CreateIndex
CREATE INDEX "pagos_fecha_idx" ON "pagos"("fecha");

-- CreateIndex
CREATE INDEX "pagos_factura_factura_id_idx" ON "pagos_factura"("factura_id");

-- CreateIndex
CREATE INDEX "pagos_factura_movimiento_id_idx" ON "pagos_factura"("movimiento_id");

-- CreateIndex
CREATE INDEX "sesiones_caja_estado_fecha_idx" ON "sesiones_caja"("estado", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "sesiones_caja_fecha_turno_key" ON "sesiones_caja"("fecha", "turno");

-- CreateIndex
CREATE UNIQUE INDEX "ventas_numero_key" ON "ventas"("numero");

-- CreateIndex
CREATE INDEX "ventas_estado_fecha_apertura_idx" ON "ventas"("estado", "fecha_apertura");

-- CreateIndex
CREATE INDEX "ventas_sesion_caja_id_estado_idx" ON "ventas"("sesion_caja_id", "estado");

-- CreateIndex
CREATE INDEX "ventas_canal_fecha_apertura_idx" ON "ventas"("canal", "fecha_apertura");

-- CreateIndex
CREATE INDEX "ventas_cliente_id_idx" ON "ventas"("cliente_id");

-- CreateIndex
CREATE INDEX "items_venta_venta_id_orden_idx" ON "items_venta"("venta_id", "orden");

-- CreateIndex
CREATE INDEX "clientes_tipo_activo_idx" ON "clientes"("tipo", "activo");

-- CreateIndex
CREATE INDEX "clientes_telefono_idx" ON "clientes"("telefono");

-- CreateIndex
CREATE INDEX "direcciones_cliente_id_idx" ON "direcciones"("cliente_id");

-- CreateIndex
CREATE INDEX "direcciones_cliente_id_es_default_idx" ON "direcciones"("cliente_id", "es_default");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_info_venta_id_key" ON "delivery_info"("venta_id");

-- CreateIndex
CREATE UNIQUE INDEX "proveedores_nombre_key" ON "proveedores"("nombre");

-- CreateIndex
CREATE INDEX "proveedores_activo_idx" ON "proveedores"("activo");

-- CreateIndex
CREATE INDEX "insumos_categoria_activo_idx" ON "insumos"("categoria", "activo");

-- CreateIndex
CREATE INDEX "facturas_recibidas_estado_fecha_vencimiento_idx" ON "facturas_recibidas"("estado", "fecha_vencimiento");

-- CreateIndex
CREATE INDEX "facturas_recibidas_proveedor_id_estado_idx" ON "facturas_recibidas"("proveedor_id", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "facturas_recibidas_proveedor_id_punto_venta_numero_tipo_com_key" ON "facturas_recibidas"("proveedor_id", "punto_venta", "numero", "tipo_comprobante");

-- CreateIndex
CREATE INDEX "facturas_recibidas_items_factura_id_idx" ON "facturas_recibidas_items"("factura_id");

-- CreateIndex
CREATE INDEX "facturas_recibidas_items_insumo_id_idx" ON "facturas_recibidas_items"("insumo_id");

-- CreateIndex
CREATE UNIQUE INDEX "facturas_emitidas_numero_interno_key" ON "facturas_emitidas"("numero_interno");

-- CreateIndex
CREATE INDEX "facturas_emitidas_cliente_id_idx" ON "facturas_emitidas"("cliente_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_secuencia_key" ON "audit_log"("secuencia");

-- CreateIndex
CREATE INDEX "audit_log_tabla_registro_id_idx" ON "audit_log"("tabla", "registro_id");

-- CreateIndex
CREATE INDEX "audit_log_usuario_id_timestamp_idx" ON "audit_log"("usuario_id", "timestamp");

-- CreateIndex
CREATE INDEX "audit_log_timestamp_idx" ON "audit_log"("timestamp");

-- CreateIndex
CREATE INDEX "login_audit_usuario_id_timestamp_idx" ON "login_audit"("usuario_id", "timestamp");

-- CreateIndex
CREATE INDEX "login_audit_tipo_timestamp_idx" ON "login_audit"("tipo", "timestamp");

-- CreateIndex
CREATE INDEX "aprobaciones_excel_estado_detectado_at_idx" ON "aprobaciones_excel"("estado", "detectado_at");

-- CreateIndex
CREATE INDEX "trabajos_impresion_estado_encolado_at_idx" ON "trabajos_impresion"("estado", "encolado_at");

-- CreateIndex
CREATE INDEX "trabajos_impresion_venta_id_idx" ON "trabajos_impresion"("venta_id");

-- CreateIndex
CREATE INDEX "outbox_events_publicado_at_agregado_at_idx" ON "outbox_events"("publicado_at", "agregado_at");

-- CreateIndex
CREATE UNIQUE INDEX "_VentaFacturaEmitida_AB_unique" ON "_VentaFacturaEmitida"("A", "B");

-- CreateIndex
CREATE INDEX "_VentaFacturaEmitida_B_index" ON "_VentaFacturaEmitida"("B");

-- AddForeignKey
ALTER TABLE "usuarios" ADD CONSTRAINT "usuarios_creado_por_id_fkey" FOREIGN KEY ("creado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tipos_producto" ADD CONSTRAINT "tipos_producto_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "categorias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "productos" ADD CONSTRAINT "productos_tipo_producto_id_fkey" FOREIGN KEY ("tipo_producto_id") REFERENCES "tipos_producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opciones_modificador" ADD CONSTRAINT "opciones_modificador_grupo_id_fkey" FOREIGN KEY ("grupo_id") REFERENCES "grupos_modificador"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modificadores_aplicables" ADD CONSTRAINT "modificadores_aplicables_grupo_modificador_id_fkey" FOREIGN KEY ("grupo_modificador_id") REFERENCES "grupos_modificador"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modificadores_aplicables" ADD CONSTRAINT "modificadores_aplicables_tipo_producto_id_fkey" FOREIGN KEY ("tipo_producto_id") REFERENCES "tipos_producto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modificadores_aplicables" ADD CONSTRAINT "modificadores_aplicables_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "componentes_combo" ADD CONSTRAINT "componentes_combo_combo_id_fkey" FOREIGN KEY ("combo_id") REFERENCES "combos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "componentes_combo" ADD CONSTRAINT "componentes_combo_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opciones_componente_combo" ADD CONSTRAINT "opciones_componente_combo_componente_id_fkey" FOREIGN KEY ("componente_id") REFERENCES "componentes_combo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opciones_componente_combo" ADD CONSTRAINT "opciones_componente_combo_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "precios_por_lista" ADD CONSTRAINT "precios_por_lista_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "precios_por_lista" ADD CONSTRAINT "precios_por_lista_lista_id_fkey" FOREIGN KEY ("lista_id") REFERENCES "listas_precios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historial_precios" ADD CONSTRAINT "historial_precios_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historial_precios" ADD CONSTRAINT "historial_precios_lista_id_fkey" FOREIGN KEY ("lista_id") REFERENCES "listas_precios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cuentas_a_cobrar" ADD CONSTRAINT "cuentas_a_cobrar_cuenta_destino_id_fkey" FOREIGN KEY ("cuenta_destino_id") REFERENCES "cuentas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidaciones_pendientes" ADD CONSTRAINT "liquidaciones_pendientes_cuenta_a_cobrar_id_fkey" FOREIGN KEY ("cuenta_a_cobrar_id") REFERENCES "cuentas_a_cobrar"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidaciones_pendientes" ADD CONSTRAINT "liquidaciones_pendientes_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "ventas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidaciones_pendientes" ADD CONSTRAINT "liquidaciones_pendientes_pago_id_fkey" FOREIGN KEY ("pago_id") REFERENCES "pagos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posnets" ADD CONSTRAINT "posnets_cuenta_a_cobrar_debito_id_fkey" FOREIGN KEY ("cuenta_a_cobrar_debito_id") REFERENCES "cuentas_a_cobrar"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posnets" ADD CONSTRAINT "posnets_cuenta_a_cobrar_credito_id_fkey" FOREIGN KEY ("cuenta_a_cobrar_credito_id") REFERENCES "cuentas_a_cobrar"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posnets" ADD CONSTRAINT "posnets_cuenta_destino_id_fkey" FOREIGN KEY ("cuenta_destino_id") REFERENCES "cuentas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_cuenta_origen_id_fkey" FOREIGN KEY ("cuenta_origen_id") REFERENCES "cuentas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_cuenta_destino_id_fkey" FOREIGN KEY ("cuenta_destino_id") REFERENCES "cuentas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_cuenta_a_cobrar_id_fkey" FOREIGN KEY ("cuenta_a_cobrar_id") REFERENCES "cuentas_a_cobrar"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "categorias_movimiento"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "ventas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimientos" ADD CONSTRAINT "movimientos_sesion_caja_id_fkey" FOREIGN KEY ("sesion_caja_id") REFERENCES "sesiones_caja"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimiento_facturas" ADD CONSTRAINT "movimiento_facturas_movimiento_id_fkey" FOREIGN KEY ("movimiento_id") REFERENCES "movimientos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimiento_facturas" ADD CONSTRAINT "movimiento_facturas_factura_id_fkey" FOREIGN KEY ("factura_id") REFERENCES "facturas_recibidas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_movimiento_id_fkey" FOREIGN KEY ("movimiento_id") REFERENCES "movimientos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "ventas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_cuenta_id_fkey" FOREIGN KEY ("cuenta_id") REFERENCES "cuentas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_cuenta_a_cobrar_id_fkey" FOREIGN KEY ("cuenta_a_cobrar_id") REFERENCES "cuentas_a_cobrar"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos" ADD CONSTRAINT "pagos_posnet_id_fkey" FOREIGN KEY ("posnet_id") REFERENCES "posnets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_factura" ADD CONSTRAINT "pagos_factura_pago_id_fkey" FOREIGN KEY ("pago_id") REFERENCES "pagos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_factura" ADD CONSTRAINT "pagos_factura_factura_id_fkey" FOREIGN KEY ("factura_id") REFERENCES "facturas_recibidas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pagos_factura" ADD CONSTRAINT "pagos_factura_movimiento_id_fkey" FOREIGN KEY ("movimiento_id") REFERENCES "movimientos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sesiones_caja" ADD CONSTRAINT "sesiones_caja_usuario_apertura_id_fkey" FOREIGN KEY ("usuario_apertura_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sesiones_caja" ADD CONSTRAINT "sesiones_caja_usuario_cierre_id_fkey" FOREIGN KEY ("usuario_cierre_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sesiones_caja" ADD CONSTRAINT "sesiones_caja_aprobada_admin_id_fkey" FOREIGN KEY ("aprobada_admin_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_lista_precios_id_fkey" FOREIGN KEY ("lista_precios_id") REFERENCES "listas_precios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_usuario_apertura_id_fkey" FOREIGN KEY ("usuario_apertura_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_usuario_cierre_id_fkey" FOREIGN KEY ("usuario_cierre_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_usuario_anulacion_id_fkey" FOREIGN KEY ("usuario_anulacion_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ventas" ADD CONSTRAINT "ventas_sesion_caja_id_fkey" FOREIGN KEY ("sesion_caja_id") REFERENCES "sesiones_caja"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items_venta" ADD CONSTRAINT "items_venta_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "ventas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items_venta" ADD CONSTRAINT "items_venta_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items_venta" ADD CONSTRAINT "items_venta_parte_de_combo_id_fkey" FOREIGN KEY ("parte_de_combo_id") REFERENCES "combos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items_venta" ADD CONSTRAINT "items_venta_editado_por_id_fkey" FOREIGN KEY ("editado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "direcciones" ADD CONSTRAINT "direcciones_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_info" ADD CONSTRAINT "delivery_info_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "ventas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_info" ADD CONSTRAINT "delivery_info_direccion_id_fkey" FOREIGN KEY ("direccion_id") REFERENCES "direcciones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insumos" ADD CONSTRAINT "insumos_proveedor_principal_id_fkey" FOREIGN KEY ("proveedor_principal_id") REFERENCES "proveedores"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insumo_proveedores" ADD CONSTRAINT "insumo_proveedores_insumo_id_fkey" FOREIGN KEY ("insumo_id") REFERENCES "insumos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insumo_proveedores" ADD CONSTRAINT "insumo_proveedores_proveedor_id_fkey" FOREIGN KEY ("proveedor_id") REFERENCES "proveedores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facturas_recibidas" ADD CONSTRAINT "facturas_recibidas_proveedor_id_fkey" FOREIGN KEY ("proveedor_id") REFERENCES "proveedores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facturas_recibidas" ADD CONSTRAINT "facturas_recibidas_usuario_carga_id_fkey" FOREIGN KEY ("usuario_carga_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facturas_recibidas" ADD CONSTRAINT "facturas_recibidas_usuario_validacion_id_fkey" FOREIGN KEY ("usuario_validacion_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facturas_recibidas_items" ADD CONSTRAINT "facturas_recibidas_items_factura_id_fkey" FOREIGN KEY ("factura_id") REFERENCES "facturas_recibidas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facturas_recibidas_items" ADD CONSTRAINT "facturas_recibidas_items_insumo_id_fkey" FOREIGN KEY ("insumo_id") REFERENCES "insumos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facturas_emitidas" ADD CONSTRAINT "facturas_emitidas_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facturas_emitidas" ADD CONSTRAINT "facturas_emitidas_creado_por_id_fkey" FOREIGN KEY ("creado_por_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_audit" ADD CONSTRAINT "login_audit_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_audit" ADD CONSTRAINT "login_audit_usuario_solicitante_id_fkey" FOREIGN KEY ("usuario_solicitante_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aprobaciones_excel" ADD CONSTRAINT "aprobaciones_excel_aprobada_por_id_fkey" FOREIGN KEY ("aprobada_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trabajos_impresion" ADD CONSTRAINT "trabajos_impresion_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "ventas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_VentaFacturaEmitida" ADD CONSTRAINT "_VentaFacturaEmitida_A_fkey" FOREIGN KEY ("A") REFERENCES "facturas_emitidas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_VentaFacturaEmitida" ADD CONSTRAINT "_VentaFacturaEmitida_B_fkey" FOREIGN KEY ("B") REFERENCES "ventas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
