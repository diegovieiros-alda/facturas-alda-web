/**
 * db.js — PostgreSQL (pg) + PDFs en el filesystem local.
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('Falta la variable de entorno DATABASE_URL');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PDF_DIR = path.join(__dirname, '../data/pdfs');
const SCHEMA_FILE = path.join(__dirname, '../schema.sql');

async function ensureDefaultUser() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM usuarios');
  if (rows[0].n > 0) return;
  const hash = bcrypt.hashSync('Alda2026!', 10);
  await pool.query(
    'INSERT INTO usuarios (username, password, nombre, rol) VALUES ($1,$2,$3,$4)',
    ['admin', hash, 'Administrador', 'admin']
  );
  console.log('✅ Usuario admin creado (pass: Alda2026!)');
}

async function init() {
  await pool.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  await fs.promises.mkdir(PDF_DIR, { recursive: true });
  await ensureDefaultUser();
  console.log('✅ Base de datos lista (PostgreSQL)');
}

async function uploadPdf(filename, buffer) {
  await fs.promises.writeFile(path.join(PDF_DIR, filename), buffer);
}

async function downloadPdf(filename) {
  try {
    return await fs.promises.readFile(path.join(PDF_DIR, filename));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// ── Sesiones (Store para express-session) ────────────────────────────────────
async function sesionesGet(sid) {
  const { rows } = await pool.query('SELECT sess, expire FROM sesiones WHERE sid = $1', [sid]);
  if (!rows[0] || new Date(rows[0].expire) <= new Date()) return null;
  return rows[0].sess;
}
async function sesionesSet(sid, sess, expire) {
  await pool.query(
    `INSERT INTO sesiones (sid, sess, expire) VALUES ($1,$2,$3)
     ON CONFLICT (sid) DO UPDATE SET sess = $2, expire = $3`,
    [sid, JSON.stringify(sess), expire]
  );
  // ponytail: limpieza probabilística (1/50) en vez de un cron aparte — mismo patrón que
  // usa connect-pg-simple por defecto, suficiente para que la tabla no crezca sin límite.
  if (Math.random() < 0.02) {
    await pool.query('DELETE FROM sesiones WHERE expire < now()');
  }
}
async function sesionesDestroy(sid) {
  await pool.query('DELETE FROM sesiones WHERE sid = $1', [sid]);
}

// ── Queries ───────────────────────────────────────────────────────────────────

const FACTURA_COLS = [
  'token', 'estado', 'factura_numero', 'factura_fecha', 'proveedor_nombre', 'proveedor_cif',
  'importe_total', 'base_imponible', 'forma_pago_detalle', 'concepto', 'hotel_nombre_odoo',
  'codigo_hotel', 'dw_hotel', 'dw_fpago', 'sociedad', 'es_costes_generales', 'email_remitente',
  'asunto_email', 'detected_pdf_name', 'errores_graves', 'errores_leves', 'motivo_revision',
  'pdf_filename', 'n8n_webhook_url', 'solo_enlace', 'enlace_descarga', 'enlaces_detectados',
  'requiere_acceso_portal', 'id_transaccion', 'hotel_destino_factura', 'sociedad_destino_factura',
  'nivel_validacion', 'metodo_identificacion',
];

const queries = {
  insertFactura: {
    run: async (p) => {
      const values = FACTURA_COLS.map(c => p[c] ?? null);
      const placeholders = FACTURA_COLS.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await pool.query(
        `INSERT INTO facturas (${FACTURA_COLS.join(',')}) VALUES (${placeholders}) RETURNING id`,
        values
      );
      return rows[0].id;
    },
  },

  // Listado unificado: filtro por estado + búsqueda de texto + rango de fechas + orden + paginación.
  getFacturas: {
    // Whitelist — el nombre de columna de ORDER BY no se puede parametrizar como valor normal,
    // así que se valida contra esta lista en vez de interpolar lo que venga de la query string.
    SORT_COLS: {
      created_at: 'f.created_at', factura_fecha: 'f.factura_fecha', importe_total: 'f.importe_total',
      proveedor_nombre: 'f.proveedor_nombre', estado: 'f.estado', factura_numero: 'f.factura_numero',
    },
    all: async ({ estado, q, desde, hasta, hotel, sociedad, importeMin, importeMax, sort, dir, limit = 50, offset = 0 } = {}) => {
      const where = [];
      const params = [];
      if (estado && estado !== 'all') { params.push(estado); where.push(`f.estado = $${params.length}`); }
      if (q && q.trim()) {
        params.push(`%${q.trim()}%`);
        const i = params.length;
        where.push(`(f.proveedor_nombre ILIKE $${i} OR f.factura_numero ILIKE $${i} OR f.hotel_nombre_odoo ILIKE $${i} OR f.dw_hotel ILIKE $${i})`);
      }
      // factura_fecha es texto (viene de n8n en formato ISO YYYY-MM-DD) — la comparación
      // lexicográfica coincide con la cronológica sin necesidad de castear a date.
      if (desde) { params.push(desde); where.push(`f.factura_fecha >= $${params.length}`); }
      if (hasta) { params.push(hasta); where.push(`f.factura_fecha <= $${params.length}`); }
      if (hotel) { params.push(hotel); where.push(`coalesce(f.hotel_nombre_editado, f.hotel_nombre_odoo) = $${params.length}`); }
      if (sociedad) { params.push(sociedad); where.push(`f.sociedad = $${params.length}`); }
      if (importeMin != null && importeMin !== '') { params.push(importeMin); where.push(`f.importe_total >= $${params.length}`); }
      if (importeMax != null && importeMax !== '') { params.push(importeMax); where.push(`f.importe_total <= $${params.length}`); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const sortCol = queries.getFacturas.SORT_COLS[sort] || 'f.created_at';
      const sortDir = dir === 'asc' ? 'ASC' : 'DESC';
      params.push(limit, offset);
      const { rows } = await pool.query(
        `SELECT f.*, u.nombre AS revisor_nombre, count(*) OVER() AS full_count,
                coalesce(sum(f.importe_total) OVER(), 0) AS full_sum,
                exists(
                  SELECT 1 FROM facturas d
                  WHERE d.id <> f.id
                    AND lower(trim(d.factura_numero)) = lower(trim(f.factura_numero))
                    AND lower(trim(d.proveedor_nombre)) = lower(trim(f.proveedor_nombre))
                    AND f.factura_numero IS NOT NULL AND f.proveedor_nombre IS NOT NULL
                ) AS posible_duplicado
         FROM facturas f LEFT JOIN usuarios u ON f.revisado_por = u.id
         ${whereSql}
         ORDER BY ${sortCol} ${sortDir} NULLS LAST, f.id ${sortDir}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      const total = rows[0] ? Number(rows[0].full_count) : 0;
      const totalImporte = rows[0] ? Number(rows[0].full_sum) : 0;
      return { items: rows.map(({ full_count, full_sum, ...f }) => f), total, totalImporte };
    },
  },

  // Valores realmente usados en la tabla (no el catálogo completo de HOTELES del
  // frontend) — para poblar el filtro del histórico con lo que existe de verdad.
  getFiltros: {
    get: async () => {
      const [hoteles, sociedades] = await Promise.all([
        pool.query(`SELECT DISTINCT coalesce(hotel_nombre_editado, hotel_nombre_odoo) AS h FROM facturas WHERE coalesce(hotel_nombre_editado, hotel_nombre_odoo) IS NOT NULL ORDER BY 1`),
        pool.query(`SELECT DISTINCT sociedad FROM facturas WHERE sociedad IS NOT NULL ORDER BY 1`),
      ]);
      return { hoteles: hoteles.rows.map(r => r.h), sociedades: sociedades.rows.map(r => r.sociedad) };
    },
  },

  getById: {
    get: async (id) => {
      const { rows } = await pool.query(
        `SELECT f.*, u.nombre AS revisor_nombre FROM facturas f
         LEFT JOIN usuarios u ON f.revisado_por = u.id WHERE f.id = $1`,
        [id]
      );
      return rows[0];
    },
  },
  // Mismo nº de factura + proveedor ya recibido con otro token — n8n puede reenviar
  // el mismo email dos veces (reintento del workflow) y generar dos facturas "distintas".
  findDuplicado: {
    get: async (factura_numero, proveedor_nombre, token) => {
      if (!factura_numero || !proveedor_nombre) return null;
      const { rows } = await pool.query(
        `SELECT id, token, estado, created_at FROM facturas
         WHERE lower(trim(factura_numero)) = lower(trim($1))
           AND lower(trim(proveedor_nombre)) = lower(trim($2))
           AND token <> $3
         ORDER BY created_at DESC LIMIT 1`,
        [factura_numero, proveedor_nombre, token]
      );
      return rows[0] || null;
    },
  },

  getByToken: {
    get: async (token) => {
      const { rows } = await pool.query('SELECT * FROM facturas WHERE token = $1', [token]);
      return rows[0];
    },
  },

  updateEstado: {
    run: async (p) => pool.query(
      `UPDATE facturas SET estado=$1, revisado_por=$2, revisado_at=now(), updated_at=now(),
       hotel_nombre_editado=$3, dw_fpago_editado=$4, nota_revisor=$5,
       resultado_docuware=coalesce($7,resultado_docuware), fecha_docuware=coalesce($8,fecha_docuware),
       estado_final=coalesce($9,estado_final)
       WHERE id=$6`,
      [p.estado, p.usuario_id, p.hotel_nombre_editado, p.dw_fpago_editado, p.nota_revisor, p.id,
       p.resultado_docuware ?? null, p.fecha_docuware ?? null, p.estado_final ?? null]
    ),
  },

  // Segunda notificación de n8n (tras Prep_Sheet_Centros tras archivar en DocuWare),
  // correlacionada por id_transaccion — no por token, que solo existe en la rama del portal.
  updateArchivado: {
    run: async (p) => pool.query(
      `UPDATE facturas SET resultado_docuware=$1, fecha_docuware=$2, estado_final=$3,
       carpeta_imap=$4, updated_at=now() WHERE id_transaccion=$5`,
      [p.resultado_docuware ?? null, p.fecha_docuware ?? null, p.estado_final ?? null, p.carpeta_imap ?? null, p.id_transaccion]
    ),
  },

  updatePdfFilename: {
    run: async (id, pdf_filename, detected_pdf_name) => pool.query(
      `UPDATE facturas SET pdf_filename=$1, detected_pdf_name=$2, updated_at=now() WHERE id=$3`,
      [pdf_filename, detected_pdf_name, id]
    ),
  },

  getUserByUsername: {
    get: async (username) => {
      const { rows } = await pool.query('SELECT * FROM usuarios WHERE username = $1', [username]);
      return rows[0];
    },
  },
  getAllUsers: {
    all: async () => {
      const { rows } = await pool.query('SELECT id,username,nombre,rol,created_at FROM usuarios ORDER BY nombre');
      return rows;
    },
  },

  insertUser: {
    // Postgres ya expone el unique-violation como err.code === '23505' — server.js lo traduce.
    run: async (p) => pool.query(
      'INSERT INTO usuarios (username, password, nombre, rol) VALUES ($1,$2,$3,$4)',
      [p.username, p.password, p.nombre, p.rol]
    ),
  },

  deleteUser: {
    run: async (id) => pool.query(`DELETE FROM usuarios WHERE id=$1 AND rol <> 'admin'`, [id]),
  },

  insertLog: {
    run: async (fid, uid, accion, detalle) => pool.query(
      'INSERT INTO log_acciones (factura_id, usuario_id, accion, detalle) VALUES ($1,$2,$3,$4)',
      [fid, uid, accion, detalle]
    ),
  },
  getLogFactura: {
    // Historial de auditoría (quién/cuándo/qué) para mostrar directo en el detalle,
    // no solo saber que existe en la tabla log_acciones sin que nadie lo vea nunca.
    all: async (facturaId) => {
      const { rows } = await pool.query(
        `SELECT l.accion, l.detalle, l.created_at, u.nombre AS usuario_nombre
         FROM log_acciones l LEFT JOIN usuarios u ON l.usuario_id = u.id
         WHERE l.factura_id = $1 ORDER BY l.created_at DESC`,
        [facturaId]
      );
      return rows;
    },
  },

  getStats: {
    // Mismo rango de fechas que getFacturas.all — sin esto, los contadores de las
    // pestañas mostraban el total global aunque hubiera un filtro de fechas activo.
    get: async ({ desde, hasta } = {}) => {
      const where = [];
      const params = [];
      if (desde) { params.push(desde); where.push(`factura_fecha >= $${params.length}`); }
      if (hasta) { params.push(hasta); where.push(`factura_fecha <= $${params.length}`); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const { rows } = await pool.query(`SELECT estado, count(*)::int AS n FROM facturas ${whereSql} GROUP BY estado`, params);
      const byEstado = Object.fromEntries(rows.map(r => [r.estado, r.n]));
      const total = rows.reduce((sum, r) => sum + r.n, 0);
      return {
        total,
        pendientes: byEstado.pendiente || 0,
        aprobadas: byEstado.aprobada || 0,
        rechazadas: byEstado.rechazada || 0,
      };
    },
  },
};

module.exports = { init, queries, uploadPdf, downloadPdf, sesionesGet, sesionesSet, sesionesDestroy };
