# POSNETS — Santa Teresita (relevamiento físico + integrabilidad)

> Relevamiento hecho a partir de las fotos en `posnets/` (las sacó el cliente).
> Razón social del comercio: **BEST CHEFF SA**.
> Última actualización: 2026-06-03.

## Estado actual en el sistema

Hoy las ventas con tarjeta se cargan **manualmente** (el cajero elige el método
de pago). El flag `soportaIntegracion` de la sección Configuración → Posnets es
**solo descriptivo** (marca qué aparato *podría* integrarse), **NO** una conexión
real. No existe ningún webhook ni captura de eventos todavía.

## Inventario de posnets (4 aparatos + variantes)

| Cuenta/Banco | Marca/Servicio | Hardware | Serie | Tipo | ¿Integrable en vivo? |
|---|---|---|---|---|---|
| **MercadoPago** | MP **Point Smart** | Modelo **A910** (Android) · MERCADOLIBRE SRL, CUIT 30-70308653-4 | — | Smart POS | ✅ **SÍ** (mejor opción) |
| **Santander** | **Getnet** (Santander) | **Newland N910 Pro** · LTE/BT/SIM · Made in China 05/2024 | **NAB500943423** | Smart POS | ⚠️ Posible (API Getnet, más cerrado) |
| **Galicia** | Galicia (prob. Viumi/Geopagos) | **Positivo L400** (Android) · violeta | IA00513921 (aprox.) | Smart POS | ⚠️ Incierto (depende del adquirente) |
| **Provincia** | **PosNet de Fiserv** | Terminal tradicional (teclado físico) · pagos QR/MODO | — | Legacy autónomo | ❌ **NO** (solo reportes de liquidación) |

## Análisis de integrabilidad

### ✅ MercadoPago Point Smart (A910) — el camino real
- MP tiene la **API de Point** (Payment Intents): se crea una intención de pago
  por API, el aparato la procesa, y MP manda un **webhook** con el resultado
  (aprobado/monto/tarjeta/cuotas). Captura automática, sin doble carga.
- Requiere: **access token** de la cuenta MP del local + el device en modo
  "integrado/PDV" asociado a esa cuenta + un endpoint público para el webhook
  (tenemos VPS/N8N para eso).
- **Recomendación: empezar por acá.** Es el único cleanly integrable y
  probablemente una porción grande del volumen con tarjeta.

### ⚠️ Getnet / Santander (Newland N910 Pro)
- Getnet (Santander) ofrece APIs de integración pero más orientadas a
  integraciones grandes / programas específicos. El aparato es Android pero
  lockeado a la app de Getnet.
- Factibilidad media-baja: habría que contactar a Getnet para acceso a API.

### ⚠️ Galicia (Positivo L400)
- Smart POS Android, pero el adquirente exacto (Viumi / Geopagos / otro) define
  si hay API. Hay que investigarlo caso por caso.
- Factibilidad media-baja / incierta.

### ❌ Provincia — Fiserv PosNet (tradicional)
- Terminal legacy autónomo. Fiserv/Posnet **no** expone una API pública de
  eventos en tiempo real para software de terceros.
- Conciliación solo posible vía **archivos de liquidación** (batch, día
  siguiente), no captura en vivo.

## Plan recomendado

1. **Fase 1 (alto ROI):** integrar **MercadoPago Point** (API + webhook). El
   cobro con ese aparato se registra solo en el sistema.
2. **Fase 2:** todo lo demás (Getnet/Galicia/Fiserv) sigue **manual** + se
   **concilia** contra la liquidación bancaria (Belvo o extracto importado)
   cuando el adquirente deposita (débito ~24-48 hs, crédito ~18 días).
3. Getnet/Galicia quedan como "investigar API" — solo si justifica el volumen.
