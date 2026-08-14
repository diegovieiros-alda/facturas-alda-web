const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { init, queries, uploadPdf, downloadPdf, sesionesGet, sesionesSet, sesionesDestroy } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'alda-facturas-secret-2026';
const PORTAL_TOKEN = process.env.PORTAL_TOKEN || 'Ald4.2026.P0rtal';   // <-- NUEVO
const SESSION_MAX_AGE = 8 * 60 * 60 * 1000;
// Vacío en local/Vercel; en el server de la empresa se despliega bajo /facturas
// (proxy Apache con el prefijo recortado) — ver BASE_PATH en el .env de ese server.
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');

// Las páginas traen "__BASE_PATH__" como placeholder en todas las rutas absolutas
// (fetch, redirects) para que funcionen igual montadas en la raíz o en un subpath.
const readHtml = (file) => fs.readFileSync(path.join(__dirname, '../public', file), 'utf8').replace(/__BASE_PATH__/g, BASE_PATH);
const INDEX_HTML = readHtml('index.html');
const LOGIN_HTML = readHtml('login.html');
const HISTORICO_HTML = readHtml('historico.html');
const LOG_HTML = readHtml('log.html');

// express-session con MemoryStore (el default) pierde todas las sesiones en cada
// cold start de Vercel — el usuario se veía deslogueado sin motivo aparente.
// Store mínimo respaldado en la tabla `sesiones` de Supabase (ver src/db.js).
class SupabaseSessionStore extends session.Store {
  get(sid, cb) { sesionesGet(sid).then(sess => cb(null, sess)).catch(cb); }
  set(sid, sess, cb) {
    const expire = new Date(Date.now() + (sess.cookie?.maxAge ?? SESSION_MAX_AGE));
    sesionesSet(sid, sess, expire).then(() => cb(null)).catch(cb);
  }
  destroy(sid, cb) { sesionesDestroy(sid).then(() => cb(null)).catch(cb); }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new SupabaseSessionStore(),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: SESSION_MAX_AGE }
}));

const requireAuth = (req, res, next) => {
  if (req.session?.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autorizado' });
  res.redirect(BASE_PATH + '/login');
};

const requireAdmin = (req, res, next) => {
  if (req.session?.user?.rol === 'admin') return next();
  res.status(403).json({ error: 'Acceso denegado' });
};

// NUEVO: middleware que valida el token compartido con n8n
const requirePortalToken = (req, res, next) => {
  if (req.headers['x-portal-token'] !== PORTAL_TOKEN) {
    return res.status(401).json({ error: 'Token de portal inválido' });
  }
  next();
};

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect(BASE_PATH + '/');
  res.type('html').send(LOGIN_HTML);
});

app.get('/historico', requireAuth, (req, res) => res.type('html').send(HISTORICO_HTML));
app.get('/log', requireAuth, (req, res) => res.type('html').send(LOG_HTML));

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await queries.getUserByUsername.get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  req.session.user = { id: user.id, username: user.username, nombre: user.nombre, rol: user.rol };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.session.user));

// NUEVO: endpoint de salud
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Webhook desde n8n ─────────────────────────────────────────────────────────
// CAMBIO: ahora requiere X-Portal-Token

app.post('/api/webhook/factura', requirePortalToken, async (req, res) => {
  try {
    const data = req.body;
    const token = data.token || `${Date.now()}_${Math.random().toString(36).slice(2)}`;

    let pdfFilename = null;
    if (data.pdf_base64) {
      const pdfBuffer = Buffer.from(data.pdf_base64, 'base64');
      // ponytail: n8n puede mandar un marcador de modo de almacenamiento (ej. "filesystem-v2")
      // en vez del PDF real si el binario no se resolvió bien — descartamos si no es un PDF de verdad
      if (pdfBuffer.subarray(0, 5).toString('latin1') === '%PDF-') {
        pdfFilename = `${token}.pdf`;
        await uploadPdf(pdfFilename, pdfBuffer);
      } else {
        console.warn('pdf_base64 recibido no es un PDF válido, se ignora. token:', token);
      }
    }

    const duplicado = await queries.findDuplicado.get(data.factura_numero, data.proveedor_nombre, token);
    const erroresLeves = data.errores_leves || [];
    if (duplicado) {
      erroresLeves.push(
        `Posible duplicado: ya existe una factura de "${data.proveedor_nombre}" con el mismo número ` +
        `(#${duplicado.id}, ${duplicado.estado}, recibida el ${new Date(duplicado.created_at).toLocaleDateString('es-ES')}) — revisar antes de aprobar.`
      );
    }

    await queries.insertFactura.run({
      token,
      estado:             data.estado === 'aprobada' ? 'aprobada' : 'pendiente',
      factura_numero:     data.factura_numero || null,
      factura_fecha:      data.factura_fecha || null,
      proveedor_nombre:   data.proveedor_nombre || null,
      proveedor_cif:      data.proveedor_cif || null,
      importe_total:      data.importe_total || null,
      base_imponible:     data.base_imponible || null,
      forma_pago_detalle: data.forma_pago_detalle || null,
      concepto:           data.concepto || null,
      hotel_nombre_odoo:  data.hotel_nombre_odoo || null,
      codigo_hotel:       data.codigo_hotel || null,
      dw_hotel:           data.dw_hotel || null,
      dw_fpago:           data.dw_fpago || null,
      sociedad:           data.sociedad || null,
      es_costes_generales: data.es_costes_generales ? 1 : 0,
      email_remitente:    data.email_remitente || null,
      asunto_email:       data.asunto_email || null,
      detected_pdf_name:  data.detected_pdf_name || null,
      errores_graves:     JSON.stringify(data.errores_graves || []),
      errores_leves:      JSON.stringify(erroresLeves),
      motivo_revision:    data.motivo_revision || null,
      pdf_filename:       pdfFilename,
      n8n_webhook_url:    data.n8n_webhook_url || null,
      solo_enlace:        data.solo_enlace ? 1 : 0,
      enlace_descarga:    data.enlace_descarga || null,
      enlaces_detectados: JSON.stringify(data.enlaces_detectados || []),
      requiere_acceso_portal: data.requiere_acceso_portal ? 1 : 0,
      id_transaccion:      data.id_transaccion || null,
      hotel_destino_factura: data.hotel_destino_factura || null,
      sociedad_destino_factura: data.sociedad_destino_factura || null,
      nivel_validacion:    data.nivel_validacion ?? null,
      metodo_identificacion: data.metodo_identificacion || null,
    });

    res.json({ ok: true, token, posible_duplicado: !!duplicado });
  } catch (err) {
    // token duplicado (n8n reintentando el mismo envío) — no es un error real,
    // la factura ya está registrada, respondemos ok en vez de 500.
    if (err.code === '23505') {
      console.warn('Webhook: token duplicado ignorado:', req.body?.token);
      return res.json({ ok: true, token: req.body?.token, duplicado: true });
    }
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Segunda notificación de n8n, disparada tras Prep_Sheet_Centros (ya con el resultado
// real de DocuWare) para la rama de auto-archivado — no lleva token, se correlaciona
// por id_transaccion, que ya viaja en el webhook inicial de arriba.
app.post('/api/webhook/factura-archivada', requirePortalToken, async (req, res) => {
  const { id_transaccion, resultado_docuware, fecha_docuware, estado_final, carpeta_imap } = req.body;
  if (!id_transaccion) return res.status(400).json({ error: 'Falta id_transaccion' });
  await queries.updateArchivado.run({ id_transaccion, resultado_docuware, fecha_docuware, estado_final, carpeta_imap });
  res.json({ ok: true });
});

// ── API Facturas ──────────────────────────────────────────────────────────────

const parseFactura = (f) => ({
  ...f,
  errores_graves:     JSON.parse(f.errores_graves || '[]'),
  errores_leves:      JSON.parse(f.errores_leves || '[]'),
  enlaces_detectados: JSON.parse(f.enlaces_detectados || '[]'),
});

app.get('/api/facturas', requireAuth, async (req, res) => {
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  // Tope 1000 en vez de 200 — la página de histórico pide todo de una para la tabla/export CSV.
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 1000);
  const { items, total, totalImporte } = await queries.getFacturas.all({
    estado: req.query.estado, q: req.query.q, desde: req.query.desde, hasta: req.query.hasta,
    hotel: req.query.hotel, sociedad: req.query.sociedad,
    importeMin: req.query.importeMin, importeMax: req.query.importeMax,
    sort: req.query.sort, dir: req.query.dir, offset, limit,
  });
  res.json({ items: items.map(parseFactura), total, totalImporte });
});

// Nota: deben ir antes de /api/facturas/:id, si no "filtros"/"..." matchea como :id.
app.get('/api/facturas/filtros', requireAuth, async (req, res) => res.json(await queries.getFiltros.get()));

app.get('/api/facturas/:id', requireAuth, async (req, res) => {
  const f = await queries.getById.get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'No encontrada' });
  res.json(parseFactura(f));
});

app.get('/api/facturas/:id/log', requireAuth, async (req, res) => res.json(await queries.getLogFactura.all(Number(req.params.id))));

app.get('/api/facturas/:id/pdf', requireAuth, async (req, res) => {
  const f = await queries.getById.get(Number(req.params.id));
  if (!f?.pdf_filename) return res.status(404).json({ error: 'PDF no disponible' });
  const buf = await downloadPdf(f.pdf_filename);
  if (!buf) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${f.detected_pdf_name || f.pdf_filename}"`);
  res.send(buf);
});

// Subida manual del PDF — cubre el caso "solo enlace" (la factura llegó sin PDF
// adjunto, solo un link de descarga) y cualquier caso donde el PDF no se guardó
// bien: el revisor lo descarga del enlace y lo sube aquí antes de poder aprobar.
app.post('/api/facturas/:id/pdf-upload', requireAuth, async (req, res) => {
  const f = await queries.getById.get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'No encontrada' });
  if (f.estado !== 'pendiente') return res.status(400).json({ error: 'Ya procesada' });

  const { pdf_base64, filename } = req.body;
  if (!pdf_base64) return res.status(400).json({ error: 'Falta pdf_base64' });

  const buf = Buffer.from(pdf_base64, 'base64');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return res.status(400).json({ error: 'El archivo no es un PDF válido' });
  }

  const pdfFilename = `${f.token}.pdf`;
  await uploadPdf(pdfFilename, buf);
  await queries.updatePdfFilename.run(f.id, pdfFilename, filename || f.detected_pdf_name);
  res.json({ ok: true });
});

// ── APROBAR — el await va aquí dentro, esta función es async ─────────────────
app.post('/api/facturas/:id/aprobar', requireAuth, async (req, res) => {
  const f = await queries.getById.get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'No encontrada' });
  if (f.estado !== 'pendiente') return res.status(400).json({ error: 'Ya procesada' });

  const { hotel_nombre_editado, dw_fpago_editado, nota_revisor } = req.body;
  const hotelFinal = hotel_nombre_editado?.trim() || f.dw_hotel;
  const fpagoFinal = dw_fpago_editado?.trim() || f.dw_fpago;
  let mensaje = 'Factura aprobada';
  let resultadoDocuware = null, fechaDocuware = null;

  if (f.n8n_webhook_url) {
    let pdf_base64 = null;
    try {
      if (f.pdf_filename) {
        const buf = await downloadPdf(f.pdf_filename);
        if (buf) pdf_base64 = buf.toString('base64');
      }
    } catch (_) { /* si falla la lectura, n8n decidirá */ }

    // Handler_Validacion en n8n rechaza cualquier aprobación sin pdf_base64 (facturas
    // "solo enlace" o donde falló la subida del PDF) — lo cortamos aquí con un mensaje
    // claro en vez de dejar que la factura quede "aprobada" en el portal sin archivarse.
    if (!pdf_base64) {
      return res.status(400).json({ error: 'Esta factura no tiene un PDF asociado. Sube el PDF (ver enlace de descarga) antes de aprobar, o no se podrá archivar en DocuWare.' });
    }

    try {
      const r = await fetch(f.n8n_webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accion:            'aprobar',
          token:             f.token,
          factura_numero:    f.factura_numero,
          proveedor:         f.proveedor_nombre,
          hotel:             hotelFinal,         // "código. Nombre"
          fpago:             fpagoFinal,         // 00..05
          detected_pdf_name: f.detected_pdf_name,
          pdf_base64,                            // <-- el PDF viaja de vuelta
        }),
      });
      if (!r.ok) return res.status(502).json({ error: 'Error n8n/DocuWare: ' + await r.text() });
      // n8n puede responder 200 con archivado:false (p.ej. si Handler_Validacion
      // rechazó el archivado) — sin esto, el portal marcaba "aprobada" aunque
      // DocuWare nunca recibiera la factura.
      let body;
      try { body = await r.json(); } catch (_) { body = {}; }
      if (body.archivado === false) {
        return res.status(502).json({ error: 'n8n no pudo archivar la factura en DocuWare' + (body.error ? ': ' + body.error : '') + '. La factura sigue pendiente.' });
      }
      mensaje = 'Factura aprobada y enviada a DocuWare';
      resultadoDocuware = 'OK';
      fechaDocuware = new Date();
    } catch (e) {
      return res.status(502).json({ error: 'No se pudo contactar n8n: ' + e.message });
    }
  } else {
    mensaje = 'Factura aprobada (sin URL de n8n configurada, no se envió a DocuWare)';
  }

  await queries.updateEstado.run({
    id: f.id, estado: 'aprobada', usuario_id: req.session.user.id,
    hotel_nombre_editado: hotel_nombre_editado || null, dw_fpago_editado: dw_fpago_editado || null,
    nota_revisor: nota_revisor || null, resultado_docuware: resultadoDocuware, fecha_docuware: fechaDocuware,
    estado_final: 'Aprobada manualmente (portal)',
  });
  await queries.insertLog.run(f.id, req.session.user.id, 'aprobada', `Hotel: ${hotelFinal}, Fpago: ${fpagoFinal}`);
  res.json({ ok: true, mensaje });
});

app.post('/api/facturas/:id/rechazar', requireAuth, async (req, res) => {
  const f = await queries.getById.get(Number(req.params.id));
  if (!f) return res.status(404).json({ error: 'No encontrada' });
  if (f.estado !== 'pendiente') return res.status(400).json({ error: 'Ya procesada' });

  const { nota_revisor } = req.body;
  // Motivo obligatorio para auditoría — validado también aquí, no solo en el
  // formulario, para que no se pueda saltear con una llamada directa a la API.
  if (!nota_revisor || !nota_revisor.trim()) return res.status(400).json({ error: 'El motivo del rechazo es obligatorio' });
  if (f.n8n_webhook_url) {
    // Antes se ignoraba la respuesta de n8n aquí, a diferencia de /aprobar — un fallo
    // real (n8n caído, error al notificar el rechazo) quedaba invisible para el revisor.
    try {
      const r = await fetch(f.n8n_webhook_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: f.token, accion: 'rechazar', nota: nota_revisor }) });
      if (!r.ok) return res.status(502).json({ error: 'Error n8n al procesar el rechazo: ' + await r.text() });
    } catch (e) {
      return res.status(502).json({ error: 'No se pudo contactar n8n: ' + e.message });
    }
  }

  await queries.updateEstado.run({ id: f.id, estado: 'rechazada', usuario_id: req.session.user.id, hotel_nombre_editado: null, nota_revisor: nota_revisor || null, estado_final: 'Rechazada manualmente (portal)' });
  await queries.insertLog.run(f.id, req.session.user.id, 'rechazada', nota_revisor || '');
  res.json({ ok: true });
});

// ── Usuarios ──────────────────────────────────────────────────────────────────

app.get('/api/usuarios', requireAuth, requireAdmin, async (req, res) => res.json(await queries.getAllUsers.all()));

app.post('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
  const { username, password, nombre, rol } = req.body;
  if (!username || !password || !nombre) return res.status(400).json({ error: 'Faltan campos' });
  try {
    await queries.insertUser.run({ username, password: bcrypt.hashSync(password, 10), nombre, rol: rol || 'revisor' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.code === '23505' ? 'Usuario ya existe' : e.message });
  }
});

app.delete('/api/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
  await queries.deleteUser.run(Number(req.params.id));
  res.json({ ok: true });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', requireAuth, async (req, res) => res.json(await queries.getStats.get({ desde: req.query.desde, hasta: req.query.hasta })));

// ── SPA fallback ──────────────────────────────────────────────────────────────

app.get('*', requireAuth, (req, res) => {
  res.type('html').send(INDEX_HTML);
});

// ── Start ─────────────────────────────────────────────────────────────────────

const ready = init().catch(err => {
  console.error('Error iniciando BD:', err);
  if (!process.env.VERCEL) process.exit(1);
});

if (process.env.VERCEL) {
  // ponytail: handler serverless — espera a que la BD esté lista antes de atender cada request
  module.exports = (req, res) => ready.then(() => app(req, res));
} else {
  ready.then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Portal Facturas Alda corriendo en http://localhost:${PORT}`);
    });
  });
}