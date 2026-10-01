-- El usuario de sistema "Canales" (00000000-0000-0000-0000-000000000009): a él
-- se atribuyen las ventas que entran por el puente de plataformas (RAPPI /
-- PedidosYa / MELI), porque crearVenta exige un usuario para la sesión de caja
-- y el audit. Hasta ahora lo creaba SOLO el seed, así que una base armada por
-- migraciones (Supabase detrás de Railway, S1) no lo tenía: el primer pedido
-- real de RAPPI (01/10) reventó con "Foreign key constraint violated:
-- sesiones_caja_usuario_apertura_id_fkey" y respondió 500.
--
-- NO es un login humano: el pin_hash es bcrypt de un texto largo no numérico,
-- así que ningún PIN de 4 dígitos puede autenticarse como él.
-- Aditiva e idempotente (ON CONFLICT DO NOTHING).
INSERT INTO "usuarios" ("id", "nombre", "rol", "pin_hash", "activo")
VALUES (
  '00000000-0000-0000-0000-000000000009',
  'Canales (RAPPI / PedidosYa / MELI)',
  'VENDEDOR',
  '$2a$10$SvqzF42mMmTF/PSZhWccoeGXtPdXH2JvtklJL6ox4xspDRK0.6owC',
  true
)
ON CONFLICT ("id") DO NOTHING;
