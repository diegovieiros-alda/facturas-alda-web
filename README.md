# Portal de Facturas Alda Hotels

Portal web para revisar/aprobar/rechazar facturas procesadas por el workflow de n8n
"Procesamiento Facturas Procurement", con archivado final en DocuWare.

Persistencia: **Supabase** (Postgres + Storage). Funciona igual desde Vercel, un Synology NAS o
cualquier otro host — la base de datos y los PDFs viven en Supabase, no en el disco local del
servidor.

## Cómo funciona el flujo completo

1. n8n procesa un email con factura (extrae datos, identifica hotel, valida contra Odoo).
2. Si la factura **no tiene error grave** → n8n la archiva directo en DocuWare y la manda igualmente
   al portal, ya con `estado: "aprobada"` (queda de registro/consulta, no requiere acción).
3. Si la factura **tiene error grave** → n8n la manda al portal con `estado: "pendiente"` y espera
   revisión manual.
4. El revisor entra al portal, ve las pendientes, aprueba o rechaza.
5. Al aprobar/rechazar, el portal llama de vuelta a `n8n_webhook_url` (nodo `Webhook_Validacion` en
   n8n) para que archive en DocuWare o descarte la factura.

Nodos clave en n8n: `HTTP_Portal_Enviar` manda la factura al portal; `Webhook_Validacion` recibe la
respuesta del revisor.

---

## 1. Crear el proyecto en Supabase

1. Crea un proyecto gratis en [supabase.com](https://supabase.com).
2. Ve a **SQL Editor → New query**, pega el contenido de [`supabase_schema.sql`](./supabase_schema.sql)
   y ejecútalo. Crea las tablas `usuarios`, `facturas` y `log_acciones`.
3. Ve a **Project Settings → API** y copia:
   - **Project URL** → variable `SUPABASE_URL`
   - **secret key** (`sb_secret_...`, no la `publishable`) → variable `SUPABASE_SECRET_KEY`

El primer arranque del servidor crea automáticamente el bucket de Storage (`facturas-pdfs`), el
usuario `admin` (contraseña `Alda2026!`) y 3 facturas de ejemplo si la tabla está vacía.

⚠️ La `secret key` da acceso total a la base de datos — trátala como una contraseña. Nunca la subas
al repo ni la pegues en sitios públicos; guárdala solo como variable de entorno.

---

## 2. Desplegar

### Opción A — Vercel

```bash
npx vercel env add SUPABASE_URL production        # pega el Project URL
npx vercel env add SUPABASE_SECRET_KEY production  # pega la secret key
npx vercel --prod
```

El `vercel.json` ya incluye lo necesario para el build. No hay filesystem que gestionar — todo lo
persistente vive en Supabase, así que los redeploys y cold starts ya **no** pierden datos (antes de
Supabase esto era un problema real: cada redeploy borraba todo porque Vercel solo tiene `/tmp`
efímero).

Nota menor: las sesiones de login sí se invalidan en cada redeploy (se guardan en memoria del
proceso, no en Supabase) — solo implica volver a hacer login, no pérdida de datos.

### Opción B — Synology NAS / servidor propio

```bash
cd facturas-web
npm install
cp .env.example .env
# Editar .env con SUPABASE_URL, SUPABASE_SECRET_KEY, SESSION_SECRET, PORTAL_TOKEN
node src/server.js
```

Abre `http://IP-DEL-SERVIDOR:3000`. Autoarranque: Panel de control → Programador de tareas → Crear
→ Tarea desencadenada → Evento: Arranque → Comando: `node /volume1/facturas-web/src/server.js`.

**Credenciales por defecto:** usuario `admin`, contraseña `Alda2026!`. Cámbiala desde la sección de
usuarios del portal.

---

## 3. Configurar n8n para enviar facturas al portal

### Nodo `HTTP_Portal_Enviar`

- **URL:** la del portal desplegado, por ejemplo `https://facturas-web-omega.vercel.app/api/webhook/factura`
  (⚠️ revisa que no quede apuntando a una IP local vieja tipo `http://192.168.x.x:3000/...` — si el
  portal está en la nube, una IP de tu red local no es alcanzable desde n8n).
- **Método:** POST
- **Headers:** `X-Portal-Token: <valor de PORTAL_TOKEN>` (por defecto `Ald4.2026.P0rtal` si no lo
  configuraste) y `Content-Type: application/json`. Sin este header, el portal responde
  `401 {"error":"Token de portal inválido"}`.

### Nodo `Prep_Portal_Payload` — cuerpo del POST

```json
{
  "token": "identificador_unico_factura",
  "estado": "pendiente",
  "factura_numero": "F2026001",
  "factura_fecha": "2026-06-01",
  "proveedor_nombre": "Nombre del proveedor",
  "proveedor_cif": "B12345678",
  "importe_total": 1234.56,<>
  "base_imponible": 1020.29,
  "forma_pago_detalle": "Domiciliacion",
  "concepto": "Descripción del servicio",
  "hotel_nombre_odoo": "Hotel identificado por el sistema",
  "codigo_hotel": "301",
  "dw_hotel": "301. Hotel Alda Bueumar",
  "dw_fpago": "03",
  "sociedad": "Alda Rías Baixas S.L.U.",
  "es_costes_generales": false,
  "email_remitente": "proveedor@empresa.com",
  "asunto_email": "Factura enero 2026",
  "detected_pdf_name": "factura_enero.pdf",
  "errores_graves": [],
  "errores_leves": ["Aviso: confianza media en identificación del hotel"],
  "motivo_revision": "factura_dirigida_a_sociedad",
  "pdf_base64": "BASE64_DEL_PDF_AQUI",
  "n8n_webhook_url": "https://n8n.gestionalda.es/webhook/factura-validada"
}
```

- `estado`: `"aprobada"` si la factura no necesita revisión (se guarda de registro, no aparece en la
  pestaña "Pendientes"); cualquier otro valor (u omitirlo) se guarda como `"pendiente"`. El portal
  **no acepta** `"rechazada"` por esta vía — ese estado solo lo pone el revisor desde la web.
- `n8n_webhook_url`: la URL que el portal llamará cuando el revisor apruebe/rechace. **Debe ser
  pública** (ej. `https://n8n.gestionalda.es/webhook/...`), no `http://localhost:...` — si el portal
  corre en la nube, no puede alcanzar una URL local de tu PC.

### Enrutado en `IF_Necesita_Aprobacion`

El nodo decide por `tiene_error_grave`:
- **true** (con error grave) → `Prep_Portal_Payload` con `estado: "pendiente"` (más `Drive_Subir_PDF`
  en paralelo).
- **false** (sin error grave) → `Prep_DocuWare_Centros` (archiva directo) **y también**
  `Prep_Portal_Payload` con `estado: "aprobada"` en paralelo, para que quede visible en el portal.

---

## Verificación rápida (checklist de diagnóstico)

Si "no llegan facturas al portal", comprueba en este orden:

1. **¿El portal responde?**
   ```bash
   curl https://facturas-web-omega.vercel.app/api/health
   ```
   Debe devolver `{"ok":true,...}`.

2. **¿El webhook acepta el token?**
   ```bash
   curl -X POST https://facturas-web-omega.vercel.app/api/webhook/factura \
     -H "Content-Type: application/json" \
     -H "X-Portal-Token: Ald4.2026.P0rtal" \
     -d '{"factura_numero":"TEST","estado":"aprobada"}'
   ```
   `200 {"ok":true,"token":"..."}` = el portal y Supabase funcionan. `401` = falta o está mal el
   header `X-Portal-Token` en el nodo `HTTP_Portal_Enviar` de n8n. `500` = revisa `SUPABASE_URL` /
   `SUPABASE_SECRET_KEY` en las variables de entorno del portal.

3. **¿n8n realmente está llamando al portal?** En n8n, abre el historial de ejecuciones del workflow
   y revisa el nodo `HTTP_Portal_Enviar`: ¿se ejecutó?, ¿qué URL usó?, ¿qué código de respuesta dio?

4. **¿La factura llegó pero no la ves?** En el portal, revisa las 4 pestañas (Pendientes / Aprobadas /
   Rechazadas / Todas) — las auto-aprobadas (`estado: "aprobada"`) no aparecen en "Pendientes".

5. **¿Los datos desaparecen solos?** Con Supabase esto ya no debería pasar (a diferencia del
   filesystem efímero de Vercel usado antes). Si vuelve a pasar, revisa en el dashboard de Supabase
   (Table Editor → facturas) si los registros están ahí — si están en Supabase pero no en el portal,
   el problema es de sesión/caché del navegador, no de datos perdidos.
