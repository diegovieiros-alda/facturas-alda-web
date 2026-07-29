/**
 * db.js — Supabase (Postgres vía REST + Storage para PDFs)
 * Persistente entre despliegues, a diferencia del sql.js/archivo local anterior.
 */
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Faltan variables de entorno SUPABASE_URL / SUPABASE_SECRET_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const PDF_BUCKET = 'facturas-pdfs';

function must(res) {
  if (res.error) { const e = new Error(res.error.message); e.code = res.error.code; throw e; }
  return res.data;
}

// PostgREST devuelve el join como { ...campos, usuarios: { nombre } } — lo aplanamos a revisor_nombre
function flattenRevisor(rows) {
  return rows.map(({ usuarios, ...f }) => ({ ...f, revisor_nombre: usuarios?.nombre ?? null }));
}

async function ensureBucket() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw new Error(error.message);
  if (buckets.some(b => b.name === PDF_BUCKET)) return;
  const { error: createErr } = await supabase.storage.createBucket(PDF_BUCKET, { public: false });
  if (createErr) throw new Error(createErr.message);
}

async function ensureDefaultUser() {
  const { count, error } = await supabase.from('usuarios').select('*', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  if (count > 0) return;
  const hash = bcrypt.hashSync('Alda2026!', 10);
  must(await supabase.from('usuarios').insert({ username: 'admin', password: hash, nombre: 'Administrador', rol: 'admin' }));
  console.log('✅ Usuario admin creado (pass: Alda2026!)');
}

async function seedExampleFacturas() {
  const { count, error } = await supabase.from('facturas').select('*', { count: 'exact', head: true });
  if (error) throw new Error(error.message);
  if (count > 0) return;

  const examples = [
    {
      token: 'demo-factura-001', estado: 'pendiente',
      factura_numero: 'F-2026-001', factura_fecha: '2026-06-10',
      proveedor_nombre: 'Alda Proveedores S.L.', proveedor_cif: 'B12345678',
      importe_total: 1250.5, base_imponible: 1037.19,
      forma_pago_detalle: 'Transferencia', concepto: 'Mantenimiento de instalaciones',
      hotel_nombre_odoo: 'Alda Sol Mediterráneo', codigo_hotel: 'ASM',
      dw_hotel: 'Alda Sol Mediterráneo', dw_fpago: 'Transferencia', sociedad: 'Alda Hotels',
      es_costes_generales: 1, email_remitente: 'compras@aldaexample.com',
      asunto_email: 'Factura mantenimiento junio', detected_pdf_name: 'Factura_001.pdf',
      errores_graves: '[]', errores_leves: JSON.stringify(['Importe redondeado']),
      motivo_revision: null, pdf_filename: null, n8n_webhook_url: null,
    },
    {
      token: 'demo-factura-002', estado: 'pendiente',
      factura_numero: 'F-2026-002', factura_fecha: '2026-06-12',
      proveedor_nombre: 'Servicios Hores S.A.', proveedor_cif: 'A87654321',
      importe_total: 842.0, base_imponible: 697.52,
      forma_pago_detalle: 'Tarjeta', concepto: 'Suministro de material de limpieza',
      hotel_nombre_odoo: 'Alda Marina Club', codigo_hotel: 'AMC',
      dw_hotel: 'Alda Marina Club', dw_fpago: 'Tarjeta', sociedad: 'Alda Hotels',
      es_costes_generales: 0, email_remitente: 'logistica@hores.com',
      asunto_email: 'Factura limpieza', detected_pdf_name: 'Factura_002.pdf',
      errores_graves: '[]', errores_leves: '[]',
      motivo_revision: null, pdf_filename: null, n8n_webhook_url: null,
    },
    {
      token: 'demo-factura-003', estado: 'pendiente',
      factura_numero: 'F-2026-003', factura_fecha: '2026-06-15',
      proveedor_nombre: 'Tech Support Iberia', proveedor_cif: 'C11223344',
      importe_total: 1589.2, base_imponible: 1317.85,
      forma_pago_detalle: 'Transferencia', concepto: 'Soporte informático mensual',
      hotel_nombre_odoo: 'Alda Centro Plaza', codigo_hotel: 'ACP',
      dw_hotel: 'Alda Centro Plaza', dw_fpago: 'Transferencia', sociedad: 'Alda Hotels',
      es_costes_generales: 1, email_remitente: 'facturas@techsupport.com',
      asunto_email: 'Factura soporte junio', detected_pdf_name: 'Factura_003.pdf',
      errores_graves: JSON.stringify(['NIF no coincide']), errores_leves: JSON.stringify(['Concepto incompleto']),
      motivo_revision: 'Revisar datos del proveedor', pdf_filename: null, n8n_webhook_url: null,
    },
  ];

  must(await supabase.from('facturas').insert(examples));
  console.log('✅ Facturas de ejemplo insertadas');
}

async function init() {
  await ensureBucket();
  await ensureDefaultUser();
  await seedExampleFacturas();
  console.log('✅ Base de datos lista (Supabase)');
}

async function uploadPdf(filename, buffer) {
  const { error } = await supabase.storage.from(PDF_BUCKET).upload(filename, buffer, { contentType: 'application/pdf', upsert: true });
  if (error) throw new Error(error.message);
}

async function downloadPdf(filename) {
  const { data, error } = await supabase.storage.from(PDF_BUCKET).download(filename);
  if (error) return null;
  return Buffer.from(await data.arrayBuffer());
}

// ── Sesiones (Store para express-session) ────────────────────────────────────
// MemoryStore (el default de express-session) no sirve en Vercel: cada cold
// start de la función serverless arranca con memoria vacía y tira las sesiones
// activas. Se guarda en la tabla `sesiones` de Supabase, que ya usamos para todo
// lo demás — evita añadir una dependencia nueva (connect-pg-simple, redis...)
// solo para esto.
async function sesionesGet(sid) {
  const { data, error } = await supabase.from('sesiones').select('sess, expire').eq('sid', sid).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || new Date(data.expire) <= new Date()) return null;
  return data.sess;
}
async function sesionesSet(sid, sess, expire) {
  must(await supabase.from('sesiones').upsert({ sid, sess, expire: expire.toISOString() }));
  // ponytail: limpieza probabilística (1/50) en vez de un cron aparte — mismo patrón que
  // usa connect-pg-simple por defecto, suficiente para que la tabla no crezca sin límite.
  if (Math.random() < 0.02) {
    await supabase.from('sesiones').delete().lt('expire', new Date().toISOString());
  }
}
async function sesionesDestroy(sid) {
  must(await supabase.from('sesiones').delete().eq('sid', sid));
}

// ── Queries ───────────────────────────────────────────────────────────────────

const queries = {
  insertFactura: {
    run: async (p) => must(await supabase.from('facturas').insert({
      token: p.token, estado: p.estado, factura_numero: p.factura_numero, factura_fecha: p.factura_fecha,
      proveedor_nombre: p.proveedor_nombre, proveedor_cif: p.proveedor_cif, importe_total: p.importe_total,
      base_imponible: p.base_imponible, forma_pago_detalle: p.forma_pago_detalle, concepto: p.concepto,
      hotel_nombre_odoo: p.hotel_nombre_odoo, codigo_hotel: p.codigo_hotel, dw_hotel: p.dw_hotel, dw_fpago: p.dw_fpago,
      sociedad: p.sociedad, es_costes_generales: p.es_costes_generales, email_remitente: p.email_remitente,
      asunto_email: p.asunto_email, detected_pdf_name: p.detected_pdf_name, errores_graves: p.errores_graves,
      errores_leves: p.errores_leves, motivo_revision: p.motivo_revision, pdf_filename: p.pdf_filename,
      n8n_webhook_url: p.n8n_webhook_url, solo_enlace: p.solo_enlace, enlace_descarga: p.enlace_descarga,
      enlaces_detectados: p.enlaces_detectados,
    })),
  },

  // Listado unificado: filtro por estado + búsqueda de texto + paginación.
  // Sustituye a los antiguos getPendientes/getByEstado/getAll (duplicaban la misma query).
  getFacturas: {
    all: async ({ estado, q, limit = 50, offset = 0 } = {}) => {
      let query = supabase.from('facturas').select('*, usuarios(nombre)', { count: 'exact' });
      if (estado && estado !== 'all') query = query.eq('estado', estado);
      if (q) {
        // ponytail: PostgREST .or() interpreta ',' '(' ')' como sintaxis de filtro — se limpian
        // para que una búsqueda de texto normal no pueda inyectar cláusulas extra.
        const safe = q.replace(/[,()%]/g, ' ').trim();
        if (safe) query = query.or(`proveedor_nombre.ilike.%${safe}%,factura_numero.ilike.%${safe}%,hotel_nombre_odoo.ilike.%${safe}%,dw_hotel.ilike.%${safe}%`);
      }
      query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
      const { data, error, count } = await query;
      if (error) throw new Error(error.message);
      return { items: flattenRevisor(data), total: count };
    },
  },

  getById: {
    // Mismo join que getFacturas — sin esto, el revisor desaparecía del detalle
    // cada vez que se recargaba una factura por id en vez de venir de la lista.
    get: async (id) => {
      const { data, error } = await supabase.from('facturas').select('*, usuarios(nombre)').eq('id', id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? flattenRevisor([data])[0] : undefined;
    },
  },
  getByToken: {
    get: async (token) => { const { data, error } = await supabase.from('facturas').select('*').eq('token', token).maybeSingle(); if (error) throw new Error(error.message); return data || undefined; },
  },

  updateEstado: {
    run: async (p) => must(await supabase.from('facturas').update({
      estado: p.estado, revisado_por: p.usuario_id, revisado_at: new Date().toISOString(),
      updated_at: new Date().toISOString(), hotel_nombre_editado: p.hotel_nombre_editado,
      dw_fpago_editado: p.dw_fpago_editado, nota_revisor: p.nota_revisor,
    }).eq('id', p.id)),
  },

  updatePdfFilename: {
    run: async (id, pdf_filename, detected_pdf_name) => must(await supabase.from('facturas').update({
      pdf_filename, detected_pdf_name, updated_at: new Date().toISOString(),
    }).eq('id', id)),
  },

  getUserByUsername: {
    get: async (username) => { const { data, error } = await supabase.from('usuarios').select('*').eq('username', username).maybeSingle(); if (error) throw new Error(error.message); return data || undefined; },
  },
  getAllUsers: {
    all: async () => must(await supabase.from('usuarios').select('id,username,nombre,rol,created_at').order('nombre')),
  },

  insertUser: {
    run: async (p) => {
      const res = await supabase.from('usuarios').insert({ username: p.username, password: p.password, nombre: p.nombre, rol: p.rol });
      if (res.error) { const e = new Error(res.error.message); e.code = res.error.code; throw e; }
      return res.data;
    },
  },

  deleteUser: {
    run: async (id) => must(await supabase.from('usuarios').delete().eq('id', id).neq('rol', 'admin')),
  },

  insertLog: {
    run: async (fid, uid, accion, detalle) => must(await supabase.from('log_acciones').insert({ factura_id: fid, usuario_id: uid, accion, detalle })),
  },

  getStats: {
    // Contadores vía count:'exact', head:true (Postgres COUNT, no trae filas) — un
    // select('estado') sin límite se topaba con el máximo de filas por defecto de
    // PostgREST (1000) y devolvía conteos truncados en silencio pasadas ~1000 facturas.
    get: async () => {
      const countEstado = async (estado) => {
        let q = supabase.from('facturas').select('*', { count: 'exact', head: true });
        if (estado) q = q.eq('estado', estado);
        const { count, error } = await q;
        if (error) throw new Error(error.message);
        return count;
      };
      const [total, pendientes, aprobadas, rechazadas] = await Promise.all([
        countEstado(), countEstado('pendiente'), countEstado('aprobada'), countEstado('rechazada'),
      ]);
      return { total, pendientes, aprobadas, rechazadas };
    },
  },
};

module.exports = { init, queries, uploadPdf, downloadPdf, sesionesGet, sesionesSet, sesionesDestroy };
