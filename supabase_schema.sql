create table if not exists usuarios (
  id serial primary key,
  username text not null unique,
  password text not null,
  nombre text not null,
  rol text not null default 'revisor',
  created_at timestamptz default now()
);

create table if not exists facturas (
  id serial primary key,
  token text not null unique,
  estado text not null default 'pendiente',
  factura_numero text,
  factura_fecha text,
  proveedor_nombre text,
  proveedor_cif text,
  importe_total real,
  base_imponible real,
  forma_pago_detalle text,
  concepto text,
  hotel_nombre_odoo text,
  hotel_nombre_editado text,
  codigo_hotel text,
  dw_hotel text,
  dw_fpago text,
  dw_fpago_editado text,
  sociedad text,
  es_costes_generales integer default 0,
  email_remitente text,
  asunto_email text,
  detected_pdf_name text,
  errores_graves text default '[]',
  errores_leves text default '[]',
  motivo_revision text,
  pdf_filename text,
  n8n_webhook_url text,
  solo_enlace integer default 0,
  enlace_descarga text,
  enlaces_detectados text default '[]',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  revisado_por integer references usuarios(id),
  revisado_at timestamptz,
  nota_revisor text
);

create index if not exists idx_facturas_estado on facturas(estado);
create index if not exists idx_facturas_created_at on facturas(created_at desc);

create table if not exists log_acciones (
  id serial primary key,
  factura_id integer,
  usuario_id integer,
  accion text not null,
  detalle text,
  created_at timestamptz default now()
);

-- ── Migración para bases de datos ya desplegadas ────────────────────────────
-- Ejecuta esto en el SQL Editor de Supabase si la tabla `facturas` ya existía
-- antes de estos cambios (CREATE TABLE IF NOT EXISTS no altera tablas existentes).
alter table facturas add column if not exists dw_fpago_editado text;
alter table facturas add column if not exists solo_enlace integer default 0;
alter table facturas add column if not exists enlace_descarga text;
alter table facturas add column if not exists enlaces_detectados text default '[]';
create index if not exists idx_facturas_estado on facturas(estado);
create index if not exists idx_facturas_created_at on facturas(created_at desc);
