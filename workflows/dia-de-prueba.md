# Workflow — Día de prueba (cierre + email)

## Objetivo

Probar el ciclo completo de **caja** y **email**:
1. Generar un día con ventas (mañana + tarde)
2. Cerrar cada caja
3. Enviar el cierre por email
4. Revisar el Excel adjunto

## Inputs

- DB local levantada (`pnpm docker:up`)
- Seed corrido (`pnpm db:seed`)
- (Opcional) SMTP configurado en `.env` para enviar a Gmail real

## Paso 1 — Generar el día de prueba

```bash
pnpm --filter @sta/api exec tsx src/scripts/generar-dia-prueba.ts
```

Esto crea **AYER** (default) con:
- Sesión MAÑANA: ~30 ventas mezcladas (mostrador / teléfono / WSP / RAPPI / PYA)
- Sesión TARDE: ~45 ventas
- Métodos de pago variados con peso realista (efectivo 40%, débito 22%, crédito 18%, MP/QR 15%, transfer 5%)
- ~3% de ventas anuladas
- 15% de ventas con pago dividido (ej: 30% efectivo + 70% débito)
- Movimientos del turno: adelanto a empleado, combustible, pago a proveedor, sueldos, aporte de Julio
- Cierre con pequeña diferencia de caja (±0.5%) para mostrar el caso "no cuadra"

Para usar otra fecha:
```bash
pnpm --filter @sta/api exec tsx src/scripts/generar-dia-prueba.ts --fecha=2026-04-25
```

Para borrar lo generado y volver a empezar:
```bash
pnpm --filter @sta/api exec tsx src/scripts/generar-dia-prueba.ts --limpiar
# o con fecha explícita:
pnpm --filter @sta/api exec tsx src/scripts/generar-dia-prueba.ts --limpiar --fecha=2026-04-25
```

## Paso 2 — Configurar SMTP (para envío a Gmail real)

> Si saltás este paso, el sistema usa Ethereal (https://ethereal.email): genera
> un email de prueba con URL para previsualizar, pero **no llega a tu Gmail**.

### Setup Gmail (recomendado)

1. Activar **verificación en 2 pasos** en tu cuenta Google
2. Crear un **App Password** en https://myaccount.google.com/apppasswords
   - "App": Mail
   - "Device": Other → "Santa Teresita"
3. Copiar el password de 16 caracteres
4. Agregar al `.env` (no `.env.example`):

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=tu-cuenta@gmail.com
SMTP_PASS=xxxxxxxxxxxxxxxx
SMTP_FROM="Santa Teresita Pastas <tu-cuenta@gmail.com>"
ADMIN_EMAIL_RECIPIENTS=alejolafalce@gmail.com
```

5. Reiniciar la API (`pnpm dev` en `apps/api/`).

### Test rápido del SMTP

Ir a `/admin/cierres` y tocar el botón **✉️ Probar SMTP** (esquina superior derecha).
Pedirá el email destinatario, manda un mail vacío de prueba, y reporta si llegó.

Alternativa por CLI:
```bash
pnpm --filter @sta/api exec tsx -e "
import { sendTestEmail } from './src/services/mailer.ts';
sendTestEmail('alejolafalce@gmail.com').then(console.log);
"
```

## Paso 3 — Enviar el cierre

### Vía UI

1. `pnpm dev` (api + web)
2. Login admin → ir a **Cierres** (sidebar izquierda)
3. Cada sesión muestra los KPIs + el botón **📧 Enviar por email**
4. Pide email destinatario (vacío = usa `ADMIN_EMAIL_RECIPIENTS`)
5. Si todo bien → aparece "✓ Email enviado a ... ✓" debajo de la sesión
6. Si SMTP no está configurado → aparece el link **ver preview** que abre Ethereal

### Vía script (smoke test rápido)

```bash
# Manda el cierre más reciente al destinatario por defecto
pnpm --filter @sta/api exec tsx src/scripts/smoke-cierre-email.ts

# A un destinatario específico
pnpm --filter @sta/api exec tsx src/scripts/smoke-cierre-email.ts --to=alejolafalce@gmail.com
```

## Paso 4 — Qué verificar

### En el email (HTML body)

- [ ] Header con logo + fecha + turno
- [ ] Bloque grande con **Total cobrado** + **Diferencia de caja** (color según signo)
- [ ] Tabla "Pagos por método" con cantidad y total por (método, cuenta)
- [ ] Bloque "Recaudación esperada" mostrando el cálculo:
  - existencia inicial + cobrado efectivo + ingresos − egresos = esperada
- [ ] Tabla "Movimientos del turno" (primeros 20)
- [ ] Mención del Excel adjunto

### En el Excel adjunto (4 hojas)

- [ ] **Resumen**: estado de la sesión, recaudación esperada vs contada, diferencia, ventas finalizadas/anuladas, descuentos
- [ ] **Pagos**: tabla agregada por (método, cuenta) con totales
- [ ] **Ventas**: una fila por venta con número de orden, hora, canal, modalidad, items, subtotal, descuento, total y pagos
- [ ] **Movimientos**: ingresos / egresos del turno con categoría, cuenta, monto y observación

### En la app

- [ ] La sesión queda marcada con "✉ Enviado a {emails} · {fecha}"
- [ ] Refresh de la página persiste ese estado
- [ ] Volver a tocar "Enviar por email" lo manda de nuevo (no es one-shot)

## Troubleshooting

- **"No hay destinatarios"** → faltó `ADMIN_EMAIL_RECIPIENTS` o no pasaste `to[]`
- **Gmail rechaza con "Invalid login"** → revisar que sea un App Password y no el password normal de la cuenta
- **El email tarda mucho** → Gmail SMTP puede tomar 3–10 segundos; OK
- **El Excel viene corrupto** → revisar que `exceljs` esté en `dependencies` (no `devDependencies`)
- **Ya existe una sesión para esa fecha** → correr con `--limpiar` primero

## Limpieza después del test

```bash
pnpm --filter @sta/api exec tsx src/scripts/generar-dia-prueba.ts --limpiar
```

Esto borra ventas, items, pagos, movimientos y la sesión del día generado. NO borra los productos ni el catálogo.
