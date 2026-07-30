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

async function seedExampleFacturas() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM facturas');
  if (rows[0].n > 0) return;

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
      motivo_revision: 'Revisar datos del proveedor',
    },
  ];

  for (const e of examples) {
    await queries.insertFactura.run(e);
  }
  console.log('✅ Facturas de ejemplo insertadas');
}

async function init() {
  await pool.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  await fs.promises.mkdir(PDF_DIR, { recursive: true });
  await ensureDefaultUser();
  await seedExampleFacturas();
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
];

const queries = {
  insertFactura: {
    run: async (p) => {
      const values = FACTURA_COLS.map(c => p[c] ?? null);
      const placeholders = FACTURA_COLS.map((_, i) => `$${i + 1}`).join(',');
      await pool.query(
        `INSERT INTO facturas (${FACTURA_COLS.join(',')}) VALUES (${placeholders})`,
        values
      );
    },
  },

  // Listado unificado: filtro por estado + búsqueda de texto + paginación.
  getFacturas: {
    all: async ({ estado, q, limit = 50, offset = 0 } = {}) => {
      const where = [];
      const params = [];
      if (estado && estado !== 'all') { params.push(estado); where.push(`f.estado = $${params.length}`); }
      if (q && q.trim()) {
        params.push(`%${q.trim()}%`);
        const i = params.length;
        where.push(`(f.proveedor_nombre ILIKE $${i} OR f.factura_numero ILIKE $${i} OR f.hotel_nombre_odoo ILIKE $${i} OR f.dw_hotel ILIKE $${i})`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      params.push(limit, offset);
      const { rows } = await pool.query(
        `SELECT f.*, u.nombre AS revisor_nombre, count(*) OVER() AS full_count
         FROM facturas f LEFT JOIN usuarios u ON f.revisado_por = u.id
         ${whereSql}
         ORDER BY f.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      const total = rows[0] ? Number(rows[0].full_count) : 0;
      return { items: rows.map(({ full_count, ...f }) => f), total };
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
  getByToken: {
    get: async (token) => {
      const { rows } = await pool.query('SELECT * FROM facturas WHERE token = $1', [token]);
      return rows[0];
    },
  },

  updateEstado: {
    run: async (p) => pool.query(
      `UPDATE facturas SET estado=$1, revisado_por=$2, revisado_at=now(), updated_at=now(),
       hotel_nombre_editado=$3, dw_fpago_editado=$4, nota_revisor=$5 WHERE id=$6`,
      [p.estado, p.usuario_id, p.hotel_nombre_editado, p.dw_fpago_editado, p.nota_revisor, p.id]
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

  getStats: {
    get: async () => {
      const { rows } = await pool.query('SELECT estado, count(*)::int AS n FROM facturas GROUP BY estado');
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
