# Migración de datos Innovo → Santa Teresita

Estado: **✅ MIGRACIÓN COMPLETA** — histórico cargado a Supabase 2026-06-09.
Última actualización: 2026-06-09.

## 0. Resultado final (cargado a Supabase)

- **217.652 ventas + 453.392 items** históricos (2019-06 → 2026-05-31), mezclados
  en las tablas vivas (`ventas`/`items_venta`) con `origen='innovo'`, mapeados a
  nuestros productos. Facturado total $1.983M; por año coherente (2019 $7,7M →
  2025 $792M). Cutover 2026-06-01 respetado: la data viva de junio (462 ventas)
  intacta, sin duplicados (0 items huérfanos).
- **781 contactos de delivery** → `clientes` (`origen='innovo'`, dedup por tel).
- **10 productos nuevos** (9 postres `POS-*` + `OTROS-HIST`), inactivos, para anclar
  el histórico.
- Esquema: `origen` + `sesion_caja_id` nullable + CHECK (commit `7dd4843`).
- **Reversible:** `DELETE FROM items_venta USING ventas WHERE ...` /
  `DELETE FROM ventas WHERE origen='innovo'` deshace todo.
- Loaders en `D:\innovo-migracion\loaders\` (fuera del repo).

### Pendiente (opcional, follow-up)
- Server LOCAL no tiene el histórico (se cargó solo a Supabase → lo ve la PWA de
  stats; las cajas leen local y no lo necesitan). Si se quiere en el admin de
  escritorio (que lee local), cargar igual al server + releasear binarios con el
  Prisma nuevo (`sesionCajaId` opcional).
- Pagos históricos NO migrados (requieren resolver la cadena premio de Innovo;
  no afectan facturado/productos/canal). `total_pagado` = `total`.

## 1. Qué encontramos

Los 4 `.7z` en `bases/BackupPostgreSemanal/` son backups **físicos en frío**
(Cobian Backup, encriptados) del cluster **PostgreSQL 9.6** de Innovo Suite.
No se pudieron desencriptar (clave de Cobian), así que dumpeamos **la base viva**
directamente del server de Innovo en S1 (`postgresql-x64-9.6`, puerto 12640, data
en `D:\Bases\Postgre9.6`) vía un acceso `trust` temporal y reversible en `pg_hba`.

Es **toda la operación, 7 años (2019-06 → 2026-06)**:

| Tabla | Filas reales |
|-|-|
| ventas.historial (log) | 1.666.977 |
| ventas.venta_detalle | 514.379 |
| ventas.venta | 234.209 |
| ventas.premio / venta_premio | 225.244 |
| ventas.movimiento / pago | ~65.000 |
| ventas.cliente | 25.234 |
| ventas.producto | 1.685 (1.025 activos) |
| ventas.caja (cierres) | 5.193 |

> Nota: los conteos de `pg_stat_user_tables` (n_live_tup) estaban desactualizados
> por ~100x. Estos son `count(*)` reales.

Dumps extraídos (en `innovo-dump/`): `InnovoSuite.schema.sql`,
`innovo-catalogo.sql` (30 MB), `innovo-ventas.sql` (337 MB), `exact-counts.txt`,
`mapeo-draft.csv`.

## 2. Qué se migra (decidido con el cliente)

1. **Histórico de ventas (234K)** — limpio, mapeado a NUESTROS productos, como
   data nativa de nuestro sistema (NO el catálogo de Innovo, que se descarta —
   ya tenemos 347 productos propios).
2. **~784 contactos de delivery** (clientes con teléfono) → a nuestra tabla
   `clientes` con `origen='innovo'`, deduplicando por teléfono. (El resto de los
   25.234 son nombres sueltos sin datos → se descartan.)

NO se migra: catálogo de productos de Innovo, los 24.450 "clientes" vacíos.

### Mezcla en las tablas vivas (decisión 2026-06-09 — reemplaza idea de tablas separadas)
El histórico va a las **MISMAS tablas operativas** (`ventas`, `items_venta`,
`pagos`), NO a tablas `historico_*` aparte. Aparece en todas las estadísticas
normales (dashboard, ranking de productos, facturado por día/canal), sin sección
"Histórico". Se hizo la equivalencia → es data nuestra. Plumbing:

- **Flag invisible `origen` (nueva columna en `ventas` y `clientes`):**
  `'innovo'` en las filas migradas. NO es UI — sirve para dedup, poder deshacer
  la carga, y excluirlas del hash-chain forense (las importadas NO se encadenan
  como operaciones vivas).
- **`sesion_caja_id = NULL`** en las migradas: son históricas, no pertenecen a un
  turno vivo → entran en stats por fecha, NO en cierres de caja (correcto). Las
  5.193 cajas de Innovo se pueden importar como sesiones históricas si hace falta.
- **Cutover 2026-06-01:** se importa Innovo solo HASTA 2026-05-31. Del 1-jun en
  adelante manda nuestra data viva (la encargada usó ambos sistemas en la
  transición; Innovo Jun 1-8 ≈1.163 ventas se descartan = 0,5%, evita duplicados
  y no borra nada vivo).
- **Canal inferido:** las migradas toman canal de los recargos/cuenta de Innovo
  (Recargo Pedidos YA → PEDIDOSYA, Recargo Rappi → RAPPI, ENVIO/Caja Delivery →
  delivery propio, resto → MOSTRADOR) para que las stats por canal sean correctas.

## 3. El problema del mapeo

Nuestros códigos NO coinciden con los de Innovo (catálogo re-codificado). Y el
modelo difiere: Innovo usa **SKU plano por variante** ("FIDEOS ESPINACA MEDIANOS
C/ BOLOGNESA") mientras nosotros usamos **producto base + modificadores**. Por eso
el match es **muchos-a-uno** y necesita criterio. El match exacto por nombre solo
cubre el 10,3%.

Con reglas por palabra clave (`build-mapeo-v2.sql`, catálogo completo + reglas
finas de salsas/postres/almacén) llegamos a:

| Estado | Productos | % de renglones vendidos |
|-|-|-|
| ✅ Mapeado (alta/media/baja) | 1.060 | **85,8%** |
| 🍰 Postres (código nuevo a crear) | 21 | 5,4% |
| ❌ EXCLUIR (basura) | 7 | 5,6% |
| ❓ Residual sin match (cola larga) | 296 | 3,2% |

El mapeo completo (1.384 productos vendidos) está en **`innovo-dump/mapeo-draft.csv`**
con columnas: `innovo_cod, innovo_nombre, categoria, renglones, sug_codigo,
sug_nombre, confianza`. **Para revisar/corregir a mano.**

## 4. Basura a EXCLUIR (confirmar) ❌

No son productos — contaminan estadísticas. Se descartan del histórico:

| Innovo | Renglones |
|-|-|
| ENVIO / ENVIO DOBLE / ENVIO TRIPLE | 25.471 |
| Recargo Pedidos YA | 3.649 |
| Recargo Mercado Pago | 300 |
| Recargo Resto Simple | 136 |
| Recargo Rappi | 108 |
| Ventas Varias | 9 |

## 5. Decisiones (RESUELTAS con el cliente) ✅

- **5.a Salsas → fino:** clásicas (bolognesa/fileto/blanca/tuco/napole/mixta) →
  `SAL-SIMPLE` (Salsa simple); premium (roquefort/cuatro quesos/pesto/verdeo/
  príncipe/crema/hongos/carbonara) → `SAL-ESPECIAL` (Salsa especial). _Aplicado._
- **5.b Postres → código propio por postre.** Hay que **crear 9 productos de
  postre** en el catálogo (códigos propuestos, a confirmar):

  | Postre | Código propuesto | Renglones aprox. |
  |-|-|-|
  | Tiramisú | `POS-TIRAMISU` | 6.896 |
  | Helado (Vacalín) | `POS-HELADO` | ~6.100 |
  | Cheesecake | `POS-CHEESECAKE` | 3.378 |
  | Bombón Vacalín | `POS-BOMBON` | 3.033 |
  | Lemon Pie | `POS-LEMONPIE` | 2.648 |
  | Chocotorta | `POS-CHOCOTORTA` | 2.329 |
  | Trimousse / Mousse | `POS-MOUSSE` | 2.086 |
  | Budín de pan | `POS-BUDIN` | 1.015 |
  | Alfajores | `POS-ALFAJOR` | 739 |
  | (resto postres) | `POS-VARIOS` | — |

- **5.c Cola larga → mapeada contra almacén.** Reglas de almacén (queso/rallado,
  aceitunas, mostaza, mermelada, aceto, oliva, cerveza, vino, pimientos,
  escabeches, etc.). Residual **3,2%** (fiambres/panadería que no tenemos como
  producto: Grisines, Longaniza, Salamín, Medialunas, Chipa) → `OTROS-HIST`.

Basura adicional detectada en la revisión: **"VENTAS EMPLEADOS"** (779) → excluir.

## 6. Plan de ejecución (tras tu revisión)

1. Aplicar el mapeo final (tu CSV corregido) → tabla `mapeo` definitiva.
2. Diseñar tablas `historico_venta` / `historico_venta_item` (denormalizadas).
3. ETL: transformar 514K líneas → descartar basura → resolver nombres/códigos
   nuestros → cargar histórico limpio.
4. Vista "Histórico" en admin para navegar/reportar.
5. Importar ~784 contactos de delivery a `clientes`.

## 7. Infra técnica (para retomar)

- Réplica local de análisis: **PostgreSQL 9.6** en `D:\innovo-migracion\pg96`,
  cluster en `D:\innovo-migracion\pgdata-local`, puerto **5440**, base `InnovoSuite`
  (catálogo + 234K ventas ya cargadas, FK desactivadas en la carga).
- Scripts: `D:\innovo-migracion\build-mapeo.sql`, `match-catalogo.sql`,
  `load-catalogo.sql`, `load-ventas.sql`.
- Acceso a Innovo vivo en S1: truco `pg_hba trust` (host-only, reversible) — ver
  historial de comandos. Servicio `postgresql-x64-9.6`, puerto 12640.
