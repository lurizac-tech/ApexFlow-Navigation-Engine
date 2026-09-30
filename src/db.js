const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/apexflow';
const useExternalSsl = Boolean(process.env.DATABASE_URL) || process.env.NODE_ENV === 'production';

const db = new Pool({
  connectionString,
  ssl: useExternalSsl ? { rejectUnauthorized: false } : false
});

async function run(sql, params = []) {
  const query = sql.trim();
  const isInsert = /^INSERT\b/i.test(query);
  const finalQuery = isInsert && !/\bRETURNING\b/i.test(query) ? `${query} RETURNING id` : query;

  const result = await db.query(finalQuery, params);

  if (isInsert) {
    return {
      id: result.rows[0] ? result.rows[0].id : null,
      changes: result.rowCount || 0
    };
  }

  return {
    id: null,
    changes: result.rowCount || 0
  };
}

async function get(sql, params = []) {
  const result = await db.query(sql, params);
  return result.rows[0] || null;
}

async function all(sql, params = []) {
  const result = await db.query(sql, params);
  return result.rows;
}

async function ensureSeedUsers() {
  const totals = await all('SELECT role, COUNT(*)::int AS total FROM users GROUP BY role');
  const byRole = Object.fromEntries(totals.map((row) => [row.role, Number(row.total)]));

  const defaultUsers = [
    ['Admin ApexFlow', 'admin@apexflow.com', 'admin123', 'admin'],
    ['Paciente Demo', 'paciente@apexflow.com', 'paciente123', 'patient'],
    ['Dra. Ana Gómez', 'dentista@apexflow.com', 'dentista123', 'dentist'],
    ['Admin Operaciones', 'admin1@apexflow.com', 'admin456', 'admin'],
    ['Admin Financiero', 'admin2@apexflow.com', 'admin789', 'admin'],
    ['Admin Soporte', 'admin3@apexflow.com', 'admin101', 'admin'],
    ['Admin Calidad', 'admin4@apexflow.com', 'admin202', 'admin'],
    ['María López', 'paciente1@apexflow.com', 'paciente123', 'patient'],
    ['Carlos Ruiz', 'paciente2@apexflow.com', 'paciente456', 'patient'],
    ['Lucía García', 'paciente3@apexflow.com', 'paciente789', 'patient'],
    ['Mateo Silva', 'paciente4@apexflow.com', 'paciente101', 'patient'],
    ['Sofía Díaz', 'paciente5@apexflow.com', 'paciente202', 'patient'],
    ['Dr. Javier Torres', 'dentista1@apexflow.com', 'dentista456', 'dentist'],
    ['Dra. Sofía Ramírez', 'dentista2@apexflow.com', 'dentista789', 'dentist'],
    ['Dr. Daniel Ruiz', 'dentista3@apexflow.com', 'dentista101', 'dentist'],
    ['Dra. Valeria León', 'dentista4@apexflow.com', 'dentista202', 'dentist']
  ];

  const existingEmails = new Set((await all('SELECT email FROM users')).map((row) => row.email));

  for (const [name, email, password, role] of defaultUsers) {
    if (!existingEmails.has(email)) {
      await db.query(
        `INSERT INTO users (name, email, password, role)
         VALUES ($1, $2, $3, $4)`,
        [name, email, password, role]
      );
      existingEmails.add(email);
    }
  }

  const finalTotals = await all('SELECT role, COUNT(*)::int AS total FROM users GROUP BY role');
  const finalByRole = Object.fromEntries(finalTotals.map((row) => [row.role, Number(row.total)]));

  for (const role of ['admin', 'patient', 'dentist']) {
    if (!finalByRole[role] || finalByRole[role] < 5) {
      console.log(`Role ${role} tiene menos de 5 usuarios; se mantiene la semilla base.`);
    }
  }
}

async function ensureSeedAppointments() {
  const count = await get('SELECT COUNT(*)::int AS total FROM citas');
  if (count && count.total >= 5) {
    return;
  }

  const patients = await all("SELECT id, name, email FROM users WHERE role = 'patient' ORDER BY id LIMIT 5");
  const dentists = await all("SELECT id, name, email FROM users WHERE role = 'dentist' ORDER BY id LIMIT 5");

  const sampleAppointments = [
    { patient: patients[0], doctor: dentists[0], especialidad: 'Limpieza', fecha: '2026-09-20', hora: '09:00', motivo: 'Control preventivo', estado: 'Confirmada' },
    { patient: patients[1], doctor: dentists[1], especialidad: 'Endodoncia', fecha: '2026-09-20', hora: '10:15', motivo: 'Dolor persistente', estado: 'Confirmada' },
    { patient: patients[2], doctor: dentists[2], especialidad: 'Ortodoncia', fecha: '2026-09-21', hora: '11:00', motivo: 'Seguimiento', estado: 'Pendiente' },
    { patient: patients[3], doctor: dentists[3], especialidad: 'Implantología', fecha: '2026-09-21', hora: '12:30', motivo: 'Valoración inicial', estado: 'Confirmada' },
    { patient: patients[4], doctor: dentists[4], especialidad: 'Rehabilitación', fecha: '2026-09-22', hora: '14:00', motivo: 'Revisión de restauraciones', estado: 'Confirmada' }
  ];

  const existing = await all('SELECT paciente_id, odontologo, fecha, hora FROM citas');
  const usedKeys = new Set(existing.map((c) => `${c.paciente_id}|${c.odontologo}|${c.fecha}|${c.hora}`));

  for (const item of sampleAppointments) {
    const key = `${item.patient.id}|${item.doctor.name}|${item.fecha}|${item.hora}`;
    if (usedKeys.has(key)) {
      continue;
    }

    await db.query(
      `INSERT INTO citas (paciente_id, paciente_nombre, odontologo, especialidad, fecha, hora, motivo, estado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        item.patient.id,
        item.patient.name,
        item.doctor.name,
        item.especialidad,
        item.fecha,
        item.hora,
        item.motivo,
        item.estado
      ]
    );

    usedKeys.add(key);
  }
}

async function ensureSeedHistory() {
  const count = await get('SELECT COUNT(*)::int AS total FROM historial');
  if (count && count.total >= 5) {
    return;
  }

  const patients = await all("SELECT id, name FROM users WHERE role = 'patient' ORDER BY id LIMIT 3");
  const dentists = await all("SELECT id, name FROM users WHERE role = 'dentist' ORDER BY id LIMIT 3");

  if (patients.length < 1 || dentists.length < 1) return;

  const sampleHistory = [
    { paciente: patients[0].name, paciente_id: patients[0].id, odontologo: dentists[0].name, odontologo_id: dentists[0].id, diagnostico: 'Gingivitis leve', observaciones: 'Se recomienda limpieza profunda y cambio de técnica de cepillado.' },
    { paciente: patients[1].name, paciente_id: patients[1].id, odontologo: dentists[1].name, odontologo_id: dentists[1].id, diagnostico: 'Caries en molar 36', observaciones: 'Se realiza obturación con resina. Próxima cita para control en 6 meses.' },
    { paciente: patients[2].name, paciente_id: patients[2].id, odontologo: dentists[2].name, odontologo_id: dentists[2].id, diagnostico: 'Maloclusión Clase I', observaciones: 'Inicio de tratamiento de ortodoncia. Se instalan brackets superiores.' },
    { paciente: patients[0].name, paciente_id: patients[0].id, odontologo: dentists[1].name, odontologo_id: dentists[1].id, diagnostico: 'Extracción de cordal 48', observaciones: 'Cirugía sin complicaciones. Se receta analgésicos.' },
    { paciente: patients[1].name, paciente_id: patients[1].id, odontologo: dentists[0].name, odontologo_id: dentists[0].id, diagnostico: 'Blanqueamiento dental', observaciones: 'Se completa primera sesión. Sensibilidad dental leve reportada.' }
  ];

  for (const item of sampleHistory) {
    await db.query(
      `INSERT INTO historial (paciente, paciente_id, odontologo, odontologo_id, diagnostico, observaciones)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [item.paciente, item.paciente_id, item.odontologo, item.odontologo_id, item.diagnostico, item.observaciones]
    );
  }
}

async function initDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'patient'
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS citas (
      id SERIAL PRIMARY KEY,
      paciente_id INTEGER NOT NULL,
      paciente_nombre TEXT NOT NULL,
      odontologo TEXT NOT NULL,
      especialidad TEXT NOT NULL,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      motivo TEXT,
      estado TEXT NOT NULL DEFAULT 'Confirmada'
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS historial (
      id SERIAL PRIMARY KEY,
      paciente TEXT NOT NULL,
      paciente_id INTEGER,
      odontologo TEXT NOT NULL,
      odontologo_id INTEGER NOT NULL,
      diagnostico TEXT NOT NULL,
      observaciones TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await ensureSeedUsers();
  await ensureSeedAppointments();
  await ensureSeedHistory();
}

async function findUserByEmail(email) {
  return get('SELECT * FROM users WHERE email = $1', [email]);
}

module.exports = { db, initDatabase, run, get, all, findUserByEmail };
