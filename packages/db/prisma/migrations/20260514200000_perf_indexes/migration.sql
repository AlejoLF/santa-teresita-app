-- Índices de performance (alpha.18) — derivados de la auditoría de hot paths.
--
-- Background: la API corre cloud-first contra Supabase (São Paulo). Cada query
-- cuesta ~200ms RTT desde Argentina, así que un seq scan + filter en
-- aplicación es órdenes de magnitud más caro que en un servidor local. Estos
-- índices cubren los WHERE/ORDER BY que aparecen en los endpoints más usados.

-- /admin/movimientos: filtros combinados por tipo + estado + ordenados por
-- fechaComputo DESC. Antes esto usaba el índice (fechaComputo) y filtraba en
-- el motor.
CREATE INDEX IF NOT EXISTS idx_movimientos_tipo_estado_fecha
  ON movimientos (tipo, estado, fecha_computo DESC);

-- /admin/dashboard: pagos confirmados de hoy. El JOIN a ventas con filtro
-- por estado='FINALIZADA' + fechaFinalizacion >= inicioHoy ya se beneficia
-- de los índices existentes; este índice acelera el lado "pagos" del JOIN.
CREATE INDEX IF NOT EXISTS idx_pagos_estado_fecha
  ON pagos (estado, fecha DESC);

-- /admin/movimientos: lookup de audit logs para mostrar tag "modificado"
-- en la tabla. El WHERE incluye tabla='movimientos' + registroId IN (page)
-- + accion IN ('UPDATE','TRANSITION') + ORDER BY timestamp DESC. El índice
-- compuesto evita un heap fetch tras el bitmap scan.
CREATE INDEX IF NOT EXISTS idx_audit_log_tabla_registro_accion
  ON audit_log (tabla, registro_id, accion, timestamp DESC);

-- /admin/dashboard: pedidosAbiertos count. Partial index porque en general
-- solo hay decenas de ventas PROCESADAS (ventas abiertas) en cualquier
-- momento, vs cientos de miles FINALIZADAS. El índice queda chiquito y el
-- COUNT(*) es instantáneo.
CREATE INDEX IF NOT EXISTS idx_ventas_procesadas
  ON ventas (estado)
  WHERE estado = 'PROCESADA';
