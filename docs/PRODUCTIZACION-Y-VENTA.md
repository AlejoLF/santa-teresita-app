# Productización y venta del POS — análisis estratégico

> **Qué es esto:** notas de una sesión de research (multi-agente + datos reales de
> la DB) sobre si/cómo vender Santa Teresita como producto a otros negocios. Es
> **análisis exploratorio**, no una decisión cerrada. Fecha: 2026-06-06.
> Mercados objetivo evaluados: Argentina, España, Portugal.

---

## 1. Veredicto de productización: **3/10 hoy**

Como **build a medida** es 7-8/10 (completo, resiliente, bien hecho). Como
**producto SaaS escalable** es 3/10 porque faltan las dos cosas que sostienen un
SaaS:

1. **Cero multi-tenancy.** El schema es mono-negocio (0 columnas `tenant_id` en
   ~55 tablas). Hoy "qué negocio es" lo define a qué Supabase apunta el `.exe`,
   no los datos. Auth es por PIN sin dimensión de organización.
2. **Sin plano de control para operar a escala.** Updates por auto-update por
   máquina (sin firmar → SmartScreen), migraciones a mano (CLAUDE.md prohíbe
   `prisma migrate dev`), sin tests, sin monitoreo de flota, config por máquina.
   El modelo local-first es genial para 1 local resiliente pero **durísimo de
   operar en 50+**.

**Lo bueno:** reglas de negocio ya config-driven (descuento, repartidor, datos
del local, SMTP), las listas de precios pre-arman franquicias, el hash-chain de
audit es un diferenciador real.

**Adaptación a rubros:** café/restaurante ~85% reuso (2º cliente ideal),
panadería ~80%, **retail ~50% (falta módulo de stock real — hoy no existe a
nivel Producto, es greenfield)**, ropa ~40% (falta matriz de variantes).
**Franquicias:** falta entidad `Sucursal` + vista HQ consolidada + push de
catálogo (build mediano sobre la multi-tenancy).

**Fases para productizar:** P0 de-brand + temas/canales/pagos config (M) → P1
multi-tenant + control plane + tests (L-XL) → P2 self-serve + billing (L) → P3
inventario + i18n (XL) → P4 franquicias (L).

---

## 2. Mercado y regulación (el factor que reordena la geografía)

La regulación define qué mercado se puede atacar y cuándo:

| | 🇦🇷 Argentina | 🇪🇸 España | 🇵🇹 Portugal |
|-|-|-|-|
| Competencia | **Fudo** domina (~30k), Bistrosoft, Maxirest, MercadoPago QR | Saturado: Glop, Ágora, ICG/HioPOS, Square, Lightspeed (venta por **distribuidores**) | ZoneSoft, WinRest, Vendus/Moloni (todos ya certificados) |
| Precio mercado | USD 30-100/mes | €30-60/mes | €4-30/mes |
| Fiscal en el POS | **Soft** — el comercio factura por ARCA gratis. App "Sin ARCA" = **vendible YA** (informal/monotributo) | **DURO — Veri*Factu** | **DURO — certificación AT** |
| ¿Vendible hoy? | **Sí** | **No** sin Veri*Factu | **No** sin certificación |
| Recomendación | **EMPEZAR ACÁ** | **Fase 2** (la oportunidad real) | **DIFERIR** |

**España — Veri*Factu (Ley Antifraude / RD 1007/2023):** desde **29-jul-2025 un
fabricante SOLO puede vender software de facturación adaptado** (SHA-256
hash-chain, QR por ticket, registro inalterable, "declaración responsable").
Vender uno no-compliant = **multa €150.000/año**. Usuarios compliant en 2027
(sociedades 1-ene-2027, autónomos 1-jul-2027). Además TicketBAI (País Vasco) y
B2B e-invoicing "Crea y Crece" (2027-28). **Es muro Y oportunidad:** los
incumbentes retrofitean código viejo; un producto compliant-desde-cero tiene un
feature *obligatorio* como puerta de entrada. Ya tenés un hash-chain propio
(mismo patrón conceptual).

**Portugal — certificación AT:** software de facturación **debe estar certificado**
(SAF-T PT, ATCUD, QR, **firma RSA**, testing de conformidad). Un comercio no
puede usar uno no certificado (multas €1.000-18.750). Requiere NIF portugués +
ingeniería + pasar testing = **proyecto 6-12 meses, no mercado de arranque.**
*(Aparte: los "recibos verdes" sí te permiten facturar a TUS clientes desde PT,
IVA exento <€15k/año — pero eso es cómo cobrás vos, NO resuelve la certificación
del POS.)*

**Cold outreach (idea del usuario: scrape Google Maps + email IA por N8N):**
- ES: conditionally legal — solo a dominios corporativos con interés legítimo +
  opt-out (LSSI Art. 21 + RGPD). Mass-email a direcciones personales scrapeadas
  = ilegal (AEPD multa).
- AR: legal-ish (B2B, excepción de fuente pública; "No Llame" aplica a teléfono,
  no email).
- **Realidad de conversión:** cold email a `info@` scrapeados cierra ~0-2 por
  cada 1.000. **Reorientar a WhatsApp-first** (LatAm: ~98% apertura, 15-20%
  reply) + densidad local + el verdadero moat = **IA en onboarding + soporte
  24/7 en español** (sube el techo de un fundador solo de ~30 a 100+
  instalaciones). El cuello es capacidad de onboarding/soporte, NO leads.

---

## 3. Modelos de precio

**One-time alto vs suscripción:** el pago único PURO es trampa (tenés costos
recurrentes: nube + soporte + tokens de IA + compliance; y no construís valor de
empresa). Pero el SMB odia "pagar todos los meses". **Movida = HÍBRIDO:**

- **Compra del sistema (one-time, AR ~USD 800-1.500)** + instalación → victoria
  emocional SMB, caja arriba; el **local-first lo permite** (sigue andando aunque
  dejen de pagar = "es tuyo, no te lo apago").
- **Plan de servicio (mensual bajo ~USD 20-30)** vendido como "nube + soporte +
  updates + IA", NO como "alquiler del software".
- **La IA (OCR + insights) es el SaaS** → ahí está la recurrencia, el margen y el
  diferenciador.
- España: el plan recurrente (compliance/updates) es casi obligatorio por
  Veri*Factu.

**El precio fuerza la arquitectura:** USD 20-30/mes self-serve ⇒ **pool cloud
multi-tenant** (refactor). Pago alto high-touch ⇒ local-first per-tenant (lo de
hoy). No podés tener el precio del primero con la arquitectura del segundo.

---

## 4. Arquitectura SaaS barato self-serve (USD 20-30/mes, prueba 7 días)

Lo que el usuario quiere = **cloud-first multi-tenant**, casi opuesto al
local-first actual. Decisiones:

- **Web-first** (navegador, sin instalar pesado). El UI ya es Next.js en Vercel →
  a mitad de camino. El `.exe` + servidor LAN pasan a ser **add-on premium
  "modo offline/local"**, no la base.
- **Pool (1 DB compartida, `tenant_id` + RLS), NO silo (1 DB por cliente).** A
  USD 20/mes, una Supabase por cliente (~$25) te hace **perder plata**. El pool
  también arregla las migraciones (una para todos). Es el refactor XL.
- **Impresión:** el navegador no habla directo a la comandera → necesitás un
  **"puente de impresión" liviano** instalado (mucho más liviano que el LAN
  server). O vender a quien no imprime / usa el celu.
- **Offline/cortes de luz:** el cloud puro muere → el local-first se convierte en
  el **upsell premium**.
- **Self-serve:** signup → trial 7 días automático → workspace sembrado → importar
  menú (parser Excel + IA) → usar en navegador → (si imprime) bajar el puente →
  día 7 Stripe cobra o pausa. **Cero llamadas.** Requiere: multi-tenant +
  onboarding automático + billing (Stripe/MP) + soporte self-service (N8N/IA).
- **API:** hoy vive en el `.exe` (local). Para cloud SaaS hay que **hostearla en
  la nube** multi-tenant (precedente: las route handlers de `apps/mobile` ya
  pegan a Supabase).

---

## 5. Capacidad Supabase (medido sobre Santa Teresita real)

**Footprint actual (medido):** DB total **18 MB**; ~**7,5 KB por venta**
(incluye items + pago + filas de audit + ticket). Tabla que más crece:
`audit_log`. 461 ventas en 6 días.

**Por negocio/año:** chico (~100 ventas/día) ~**0,3 GB**; medio (~500/día)
~**1,3 GB**; muy alto (2.500/día) ~6,7 GB. Es minúsculo (texto+números).

| Negocios activos | Storage/año | Plan Supabase | Infra/mes | % de ingresos |
|-|-|-|-|-|
| 10-20 | ~3-10 GB | **Pro** ($25, 8GB incl.) + cómputo Micro/Small | ~$25-35 | ~6% |
| 50 | ~15-25 GB | Pro + storage + cómputo Small/Medium | ~$35-75 | ~4% |
| 100 | ~30-50 GB | Pro + storage + cómputo **Medium** ($50) | ~$75-90 | ~3,4% |

**¿Colapsa con 100 activos a la vez? NO.** Un POS hace poquísimas escrituras:
100 negocios en pico = ~6 ventas/seg = trivial para Postgres (maneja miles de
TPS). El límite NO es storage ni throughput, son: **(1) conexiones** → resolver
con el pooler (Supavisor) en modo transacción (ya se usa la URL pooled); **(2)
cómputo** → un add-on $10-50 sobra. Lo que escala es el cómputo, no el espacio.
Recién a varios cientos de negocios pensarías read-replicas / Postgres dedicado
(Neon/RDS) — y ahí ya hay plata. **Importante:** todo esto asume POOL; con silo,
100 negocios = $2.500/mes solo en infra. Podá lo transitorio (`trabajos_impresion`,
outbox viejo); guardá `audit_log`.

---

## 6. Features de IA propuestos (el diferenciador + el tier recurrente)

**A) Lectura automática de facturas → carga sola de insumos/gastos.** Ya hay base
(`FacturaRecibida` con `ocr_payload`/`ocr_confianza`/`PENDIENTE_VALIDACION`, bot
Telegram + LLM visión en N8N). Es **expandir, no empezar de cero**. Veredicto:
muy fuerte. Caveat honesto: el OCR en sí se está comoditizando (Quipu/Holded/
gestorías lo hacen); **el moat es tenerlo ADENTRO del POS, atado a cashflow +
cuentas de proveedores**. Nunca auto-postear: borrador + confirmación 1-click.

**B) IA que lee tus datos y da insights/feedback.** Reframe clave: **NO un chatbot**
(se abandona) sino **alertas proactivas específicas y plateras por WhatsApp**
("gastaste 15% más en proveedores y vendiste igual → margen bajó, top 3
causas…"). **Bundleá la IA** (vos controlás modelo/costo/calidad y lo cobrás);
BYO-API-key solo para power users. Cuidado privacidad (GDPR/agregación). **A
alimenta a B** — juntos son "back-office + asesor con IA" que ningún POS
competidor tiene bundleado. **Esa combinación, no la tecnología suelta, es el
diferenciador.**

---

## 7. Recomendación / próximos pasos

1. **Ahora:** validar con lo que hay (high-touch, La Plata, gastronomía),
   conseguir 2-3 clientes pagos ~USD 50-80/mes (one-time + servicio). Caso vivo:
   Santa Teresita.
2. **En paralelo barato:** de-branding (P0) para clonar a cliente #2.
3. **Decisión grande:** cuando haya 5-10 clientes + plata, evaluar el refactor a
   **pool multi-tenant cloud** para la versión barata masiva (USD 20-30 self-serve)
   y atacar **España** con Veri*Factu (viento regulatorio a favor, cobrás en euros).
4. **Outreach:** WhatsApp-first + densidad local + IA en onboarding/soporte.
   Olvidar el mail masivo a `info@`.
5. **Portugal:** diferir hasta tener la máquina andando + presupuesto para
   certificar.

**Trabajos de research disponibles si se retoma:** diseño técnico del pool
multi-tenant (tenant_id + RLS + provisioning + billing), modelo de costos neto a
10/50/100 negocios, y análisis de qué implica construir Veri*Factu sobre el
hash-chain actual.
