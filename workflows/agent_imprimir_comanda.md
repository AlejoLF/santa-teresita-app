# Workflow: Imprimir comanda en cocina

## Objetivo

Cuando una venta pasa a `PROCESADA` y `tieneCocina = true`, se encola un `TrabajoImpresion`
de tipo `COMANDA_COCINA`. El local agent (que corre en una PC del local) lo lee y manda
a la EPSON TM-T20II en cocina vía ESC/POS sobre TCP:9100.

## Flujo

1. La API crea la venta (POST /ventas) → trigger del servicio `imprimir-comanda` encola
   un row en `trabajos_impresion` con `tipo=COMANDA_COCINA, destino=KITCHEN, estado=PENDIENTE`.
2. El local agent hace polling cada 2s a `GET /api/v1/impresion/pendientes`.
3. Para cada trabajo, llama a `imprimirComanda(payload)` (apps/local-agent/src/printers.ts).
4. La librería `node-thermal-printer` abre conexión TCP a la EPSON, manda los bytes ESC/POS,
   cierra. Timeout 5s.
5. Si OK → reporta `IMPRESO` a la API. Si falla → reporta `ERROR` con mensaje. La API
   reintenta hasta 3 veces antes de marcar como definitivo.

## Tools

- `apps/local-agent/src/printers.ts` — drivers de las 3 impresoras (kitchen, counter, delivery).
- `apps/local-agent/src/agent.ts` — daemon de polling.

## Quirks aprendidos

- La EPSON TM-T20II usa charset `PC850_MULTILINGUAL` para acentos AR (ñ, á, é).
- El doble-alto + doble-ancho son `ESC ! 0x30` — `node-thermal-printer` lo expone como
  `setTextSize(2, 2)` o `setTextDoubleHeight()`.
- Cuando se quiere "negativo" (negro sobre blanco invertido) — útil en CANCELADA — hay que
  llamar `printer.invert(true)` antes y `false` después.
- La impresora debe estar en LAN del local; si la VPS quiere imprimir directo, no funciona
  (no hay túnel). De ahí la arquitectura de agent + outbox.
- Si la EPSON está apagada, `isPrinterConnected()` falla con timeout 5s. El agent no
  bloquea el loop — sigue al siguiente trabajo.

## Pendientes

- Implementar TICKET_DELIVERY (Wireframe 10 ticket 3) — requiere renderizado HTML→PDF
  para la láser Lexmark E460. Stack candidato: Puppeteer + CSS print.
- Manejar reconexión automática a impresora apagada.
- Heartbeat — agent reporta a la API cada 30s "estoy vivo" para que admin vea estado de
  impresoras en dashboard.
