# Workflow: Parsear "Lista de Precios.xlsx" a JSON de seed

## Objetivo

Convertir el Excel maestro de precios del cliente en un JSON estructurado que el seed
de Prisma usa para poblar `Categoria`, `TipoProducto`, `Producto`, `GrupoModificador`,
`OpcionModificador` y `PrecioPorLista`.

## Inputs

- Excel: `Lista de Precios.xlsx` en raíz del proyecto. Hojas relevantes:
  - **Hoja 1**: precios actuales (16/04/2026). 3 columnas de productos.
  - **RESTO SIMPLE**: jerarquía de tipo → opciones de relleno.
  - **Pedidos YA**: precios alternativos para canal Pedidos YA.

## Tool

`tools/parse_lista_precios.py`

## Comando

```bash
python tools/parse_lista_precios.py \
  --excel "Lista de Precios.xlsx" \
  --output "packages/db/prisma/seed-data/lista-precios.json"
```

## Output

JSON con shape:

```json
{
  "categorias": [...],
  "tipos_producto": [...],
  "productos": [...],
  "modificadores": [...],
  "precios_pedidos_ya": [...],
  "_meta": {...}
}
```

## Quirks aprendidos

- El Excel viene con encoding latino — la "Ñ" aparece como `�` en algunas hojas. El parser lo maneja con `normalizar()`.
- `Chartsheet` no soporta `iter_rows` → se filtra con `hasattr(ws, "iter_rows")`.
- `ws.max_row` puede ser `None` cuando openpyxl no puede determinarlo → fallback a 100.
- **Sorrentinos de Salmón** se modela como producto separado (precio_separado=True), no como modificador, porque el precio difiere mucho del base.
- Las **porciones calientes** (col 4-6 de Hoja 1) tienen `cocina_interviene=true` automático.
- El mapeo de nombres del Excel a categorías canónicas vive en `MAPEO_PRODUCTOS_HOJA1` y `MAPEO_PORCIONES_HOJA1`. Para agregar un producto nuevo, agregar entrada ahí.

## Pendientes

- No parsea precios anteriores (col 1 de hoja "PASTAS") — solo precios actuales. Si querés histórico, ampliar el parser.
- No infiere combos automáticamente — los combos se cargan manualmente en seed o vía UI admin.
- Pizzas con sabores pendientes de precio (Napolitana, Fugazzetta, etc.) quedan sin precio → cargar manualmente cuando llegue.
