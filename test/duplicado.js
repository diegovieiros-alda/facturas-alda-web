// Chequeo mínimo de queries.findDuplicado — sin framework, se corre con `npm test`.
// Requiere DATABASE_URL (usa la misma base que la app; limpia sus propias filas al terminar).
const assert = require('assert');
const { Pool } = require('pg');
const { queries } = require('../src/db');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TOKENS = ['token-a-test-dup', 'token-b-test-dup'];

async function limpiar() {
  await pool.query('DELETE FROM facturas WHERE token = ANY($1)', [TOKENS]);
}

async function main() {
  await limpiar();
  const numero = `TEST-DUP-${Date.now()}`;
  const proveedor = 'Proveedor De Prueba S.L.';

  // Sin nada insertado todavía, no hay duplicado.
  let dup = await queries.findDuplicado.get(numero, proveedor, TOKENS[0]);
  assert.strictEqual(dup, null, 'no debería encontrar duplicado antes de insertar nada');

  await queries.insertFactura.run({ token: TOKENS[0], estado: 'pendiente', factura_numero: numero, proveedor_nombre: proveedor });

  // Mismo número+proveedor, otro token -> debe detectarlo.
  dup = await queries.findDuplicado.get(numero, proveedor, TOKENS[1]);
  assert.ok(dup, 'debería encontrar el duplicado por número+proveedor');
  assert.strictEqual(dup.estado, 'pendiente');

  // Mismo token que el ya existente -> no cuenta como duplicado (es la misma factura).
  dup = await queries.findDuplicado.get(numero, proveedor, TOKENS[0]);
  assert.strictEqual(dup, null, 'no debería marcarse a sí misma como duplicado');

  // Mayúsculas/espacios distintos deben seguir matcheando.
  dup = await queries.findDuplicado.get(`  ${numero.toLowerCase()}  `, proveedor.toUpperCase(), TOKENS[1]);
  assert.ok(dup, 'la comparación debe ignorar mayúsculas y espacios');

  console.log('✅ duplicado.js OK');
}

main()
  .catch(e => { console.error('❌', e); process.exitCode = 1; })
  .finally(() => limpiar())
  // db.js abre su propio pool (no expuesto) que si no, mantiene vivo el proceso — se fuerza salida.
  .finally(() => process.exit(process.exitCode || 0));
