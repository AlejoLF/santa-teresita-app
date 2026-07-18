-- Idempotencia de ÓRDENES de canal creadas por el PUENTE AUTOMÁTICO
-- (endpoint /channel/orders → integradores RAPPI / Pedidos YA / Mercado Libre).
-- El webhook de la plataforma se puede reenviar, así que un mismo
-- (canal, id_externo_canal) debe crear UNA sola venta.
--
-- ¿Por qué PARCIAL y no un unique plano sobre (canal, id_externo_canal)?
-- Porque `id_externo_canal` es TEXTO LIBRE que la encargada tipea a mano al
-- cargar pedidos de plataforma en el flujo MANUAL, y NO es único: el patrón
-- cargar→anular→recargar (o dos cobros del mismo pedido) repite el número.
-- Hoy ya existen pares PEDIDOS_YA con el mismo id (ambos reales, origen=null).
-- Un unique plano fallaría al crearse Y rompería la carga manual a futuro.
--
-- El puente automático atribuye SIEMPRE la venta al usuario de sistema
-- "Canales" (00000000-0000-0000-0000-000000000009). Scopeamos el índice a ese
-- usuario → la unicidad aplica solo a las filas del bot; las cargas manuales
-- (cualquier otro usuario) quedan exentas. Al momento de crearse, 0 filas del
-- bot existen, así que la creación nunca falla.
--
-- Aditiva e idempotente (IF NOT EXISTS). Índice parcial → NO se modela como
-- @@unique en schema.prisma (Prisma no expresa índices parciales).
CREATE UNIQUE INDEX IF NOT EXISTS "ventas_canal_idexterno_bot_key"
  ON "ventas" ("canal", "id_externo_canal")
  WHERE "usuario_apertura_id" = '00000000-0000-0000-0000-000000000009'
    AND "id_externo_canal" IS NOT NULL;
