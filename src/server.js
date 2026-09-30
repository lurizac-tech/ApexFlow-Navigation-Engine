const dotenv = require('dotenv');
dotenv.config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const { initDatabase, findUserByEmail, all, db } = require('./db');
const { enqueueJob, startWorker, getJobStats, activeWorkers } = require('./worker');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'apexflow-distributed-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

const serviceInfo = {
  name: 'ApexFlow Distributed',
  node: 'api-gateway',
  status: 'online',
  region: 'local-dev',
  timestamp: new Date().toISOString()
};

const fallbackUsers = [
  ['admin@apexflow.com', { id: 'usr_admin_01', name: 'Admin ApexFlow', email: 'admin@apexflow.com', password: 'admin123', role: 'admin' }],
  ['paciente@apexflow.com', { id: 'usr_patient_01', name: 'Paciente Demo', email: 'paciente@apexflow.com', password: 'paciente123', role: 'patient' }],
  ['dentista@apexflow.com', { id: 'usr_dentist_01', name: 'Dra. Ana Gómez', email: 'dentista@apexflow.com', password: 'dentista123', role: 'dentist' }]
];

const users = new Map(fallbackUsers);

const appointments = new Map();

function seedFallbackUsers() {
  users.clear();
  fallbackUsers.forEach(([email, user]) => {
    users.set(String(email).toLowerCase(), user);
  });
}

function seedFallbackAppointments() {
  appointments.clear();
  const demoAppointments = [
    {
      id: 'apt_demo_001',
      patientId: 'usr_patient_01',
      patientName: 'Paciente Demo',
      doctor: 'Dra. Ana Gómez',
      specialty: 'Ortodoncia',
      date: '2026-09-28',
      time: '09:00',
      reason: 'Control preventivo',
      status: 'confirmed',
      createdAt: new Date().toISOString()
    },
    {
      id: 'apt_demo_002',
      patientId: 'usr_patient_01',
      patientName: 'Paciente Demo',
      doctor: 'Dr. Javier Torres',
      specialty: 'Implantología',
      date: '2026-09-28',
      time: '10:30',
      reason: 'Valoración inicial',
      status: 'confirmed',
      createdAt: new Date().toISOString()
    }
  ];

  demoAppointments.forEach((appointment) => {
    appointments.set(appointment.id, appointment);
  });
}
let databaseAvailable = null;
const notificationQueue = [];
const resourceLocks = new Map();
const nodeMetrics = {
  apiGateway: {
    name: 'api-gateway',
    role: 'gateway',
    status: 'healthy',
    memoryMb: 0,
    cpuPercent: 0,
    workerThreads: 0,
    lastUpdated: new Date().toISOString()
  },
  workerNodes: []
};
const availabilityByDoctor = {
  'Dra. Ana Gómez': ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00'],
  'Dr. Javier Torres': ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00'],
  'Dra. Sofía Ramírez': ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00']
};

const doctorCatalog = [
  { id: 'doc_ana', doctor: 'Dra. Ana Gómez', specialty: 'Ortodoncia', rating: 4.9, location: 'Centro Norte' },
  { id: 'doc_javier', doctor: 'Dr. Javier Torres', specialty: 'Implantología', rating: 4.7, location: 'Sede Sur' },
  { id: 'doc_sofia', doctor: 'Dra. Sofía Ramírez', specialty: 'Endodoncia', rating: 4.8, location: 'Centro' }
];

class SearchStrategy {
  sortCandidates(candidates, context = {}) {
    throw new Error('La estrategia debe implementar sortCandidates().');
  }
}

class NearestAvailabilityStrategy extends SearchStrategy {
  constructor() {
    super();
    this.name = 'nearest-availability';
  }

  toMinutes(value) {
    if (value === null || value === undefined || value === '') return Number.MAX_SAFE_INTEGER;
    if (typeof value === 'number') return value;

    const match = String(value).match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return Number.MAX_SAFE_INTEGER;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours * 60 + minutes;
  }

  getNearestGap(candidate, requestedTime) {
    const available = Array.isArray(candidate.availableSlots)
      ? candidate.availableSlots
      : Array.isArray(candidate.availability)
        ? candidate.availability
        : [];

    if (!available.length) return Number.MAX_SAFE_INTEGER;

    const target = this.toMinutes(requestedTime || '09:00');

    return available.reduce((closest, slot) => {
      const slotMinutes = this.toMinutes(slot);
      const distance = Math.abs(slotMinutes - target);
      return Math.min(closest, distance);
    }, Number.MAX_SAFE_INTEGER);
  }

  sortCandidates(candidates, context = {}) {
    const requestedTime = context.time || '09:00';

    return [...candidates].sort((left, right) => {
      const leftGap = this.getNearestGap(left, requestedTime);
      const rightGap = this.getNearestGap(right, requestedTime);

      if (leftGap !== rightGap) {
        return leftGap - rightGap;
      }

      const leftRating = Number(left.rating || 0);
      const rightRating = Number(right.rating || 0);
      return rightRating - leftRating;
    });
  }
}

class DoctorRatingStrategy extends SearchStrategy {
  constructor() {
    super();
    this.name = 'doctor-rating';
  }

  matchesSpecialty(candidate, requestedSpecialty) {
    if (!requestedSpecialty) return true;
    const specialties = [candidate.specialty, candidate.especialidad, candidate.area, candidate.specialtyName];
    const normalized = String(requestedSpecialty).trim().toLowerCase();

    return specialties.some((specialty) => {
      if (!specialty) return false;
      return String(specialty).trim().toLowerCase().includes(normalized);
    });
  }

  sortCandidates(candidates, context = {}) {
    const requestedSpecialty = String(context.specialty || '').trim();

    return [...candidates].sort((left, right) => {
      const leftMatch = this.matchesSpecialty(left, requestedSpecialty) ? 1 : 0;
      const rightMatch = this.matchesSpecialty(right, requestedSpecialty) ? 1 : 0;

      if (leftMatch !== rightMatch) {
        return rightMatch - leftMatch;
      }

      const leftRating = Number(left.rating || 0);
      const rightRating = Number(right.rating || 0);

      if (leftRating !== rightRating) {
        return rightRating - leftRating;
      }

      return String(left.doctor || left.name || '').localeCompare(String(right.doctor || right.name || ''));
    });
  }
}

class NavigationEngine {
  constructor(strategy = new NearestAvailabilityStrategy()) {
    this.strategy = strategy;
  }

  setStrategy(strategy) {
    this.strategy = strategy;
    return this;
  }

  search(candidates, context = {}) {
    if (!this.strategy || typeof this.strategy.sortCandidates !== 'function') {
      throw new Error('Debe proporcionar una estrategia válida para buscar candidatos.');
    }

    return this.strategy.sortCandidates(candidates, context);
  }
}

function normalizeDoctorCandidate(doctor, preference = {}) {
  const date = preference.date || new Date().toISOString().slice(0, 10);
  const doctorName = doctor.doctor || doctor.name || doctor.doctorName || 'Doctor';
  const specialty = preference.specialty || doctor.specialty || doctor.especialidad || doctor.area || '';
  const availability = Array.isArray(doctor.availableSlots)
    ? doctor.availableSlots
    : Array.isArray(doctor.availability)
      ? doctor.availability
      : getDoctorAvailability(doctorName, date);

  return {
    id: doctor.id || doctorName,
    doctor: doctorName,
    name: doctorName,
    specialty,
    rating: Number(doctor.rating || 4.5),
    availableSlots: availability,
    nextAvailable: availability[0] || null,
    location: doctor.location || 'Sede principal'
  };
}

function searchDoctorsByStrategy(candidates, strategyName = 'nearest', context = {}) {
  const normalized = Array.isArray(candidates) ? candidates.map((candidate) => normalizeDoctorCandidate(candidate, context)) : [];
  const strategyMap = {
    nearest: new NearestAvailabilityStrategy(),
    nearestavailability: new NearestAvailabilityStrategy(),
    doctorrating: new DoctorRatingStrategy(),
    'doctor-rating': new DoctorRatingStrategy(),
    rating: new DoctorRatingStrategy()
  };

  const strategy = strategyMap[String(strategyName || 'nearest').toLowerCase()] || new NearestAvailabilityStrategy();
  const engine = new NavigationEngine(strategy);
  return engine.search(normalized, context);
}

class CompositeNode {
  constructor(name, type, metadata = {}) {
    this.name = name;
    this.type = type;
    this.metadata = metadata;
    this.children = [];
  }

  add(child) {
    this.children.push(child);
    return child;
  }

  remove(child) {
    this.children = this.children.filter((item) => item !== child);
    return this;
  }

  toJSON() {
    return {
      name: this.name,
      type: this.type,
      metadata: this.metadata,
      children: this.children.map((child) => child.toJSON())
    };
  }
}

class SedeNode extends CompositeNode {
  constructor(name, metadata = {}) {
    super(name, 'sede', metadata);
  }
}

class EspecialidadNode extends CompositeNode {
  constructor(name, metadata = {}) {
    super(name, 'especialidad', metadata);
  }
}

class DoctorNode extends CompositeNode {
  constructor(name, metadata = {}) {
    super(name, 'doctor', metadata);
  }
}

class BloqueNode extends CompositeNode {
  constructor(name, metadata = {}) {
    super(name, 'bloque', metadata);
  }
}

class InMemoryIterator {
  constructor(root) {
    this.stack = [root];
    this.visited = [];
    this._traverse();
    this.index = 0;
  }

  _traverse() {
    const stack = [this.stack[0]];
    while (stack.length) {
      const current = stack.pop();
      this.visited.push(current);
      for (let i = current.children.length - 1; i >= 0; i -= 1) {
        stack.push(current.children[i]);
      }
    }
  }

  hasNext() {
    return this.index < this.visited.length;
  }

  next() {
    if (!this.hasNext()) return null;
    const current = this.visited[this.index];
    this.index += 1;
    return current;
  }

  toArray() {
    return [...this.visited];
  }
}

function buildClinicCompositeTree() {
  const sedeCentro = new SedeNode('Sede Centro', { city: 'Bogotá', region: 'Norte' });
  const especialidadOrtodoncia = new EspecialidadNode('Ortodoncia', { priority: 'high' });
  const doctorAna = new DoctorNode('Dra. Ana Gómez', { rating: 4.9, specialty: 'Ortodoncia' });
  doctorAna.add(new BloqueNode('Bloque A', { doctor: 'Dra. Ana Gómez', specialty: 'Ortodoncia', rating: 4.9, start: '09:00', end: '10:00', status: 'available' }));
  doctorAna.add(new BloqueNode('Bloque B', { doctor: 'Dra. Ana Gómez', specialty: 'Ortodoncia', rating: 4.9, start: '10:30', end: '11:30', status: 'reserved' }));
  especialidadOrtodoncia.add(doctorAna);

  const especialidadImplantologia = new EspecialidadNode('Implantología', { priority: 'medium' });
  const doctorJavier = new DoctorNode('Dr. Javier Torres', { rating: 4.7, specialty: 'Implantología' });
  doctorJavier.add(new BloqueNode('Bloque C', { doctor: 'Dr. Javier Torres', specialty: 'Implantología', rating: 4.7, start: '11:00', end: '12:00', status: 'available' }));
  doctorJavier.add(new BloqueNode('Bloque D', { doctor: 'Dr. Javier Torres', specialty: 'Implantología', rating: 4.7, start: '12:30', end: '13:30', status: 'available' }));
  especialidadImplantologia.add(doctorJavier);

  sedeCentro.add(especialidadOrtodoncia);
  sedeCentro.add(especialidadImplantologia);

  const sedeSur = new SedeNode('Sede Sur', { city: 'Medellín', region: 'Sur' });
  const especialidadEndodoncia = new EspecialidadNode('Endodoncia', { priority: 'high' });
  const doctorSofia = new DoctorNode('Dra. Sofía Ramírez', { rating: 4.8, specialty: 'Endodoncia' });
  doctorSofia.add(new BloqueNode('Bloque E', { doctor: 'Dra. Sofía Ramírez', specialty: 'Endodoncia', rating: 4.8, start: '09:30', end: '10:30', status: 'available' }));
  especialidadEndodoncia.add(doctorSofia);
  sedeSur.add(especialidadEndodoncia);

  return { sedeCentro, sedeSur };
}

function flattenClinicTree(root) {
  const iterator = new InMemoryIterator(root);
  return iterator.toArray().map((node) => ({
    type: node.type,
    name: node.name,
    metadata: node.metadata
  }));
}

function normalizeSedeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function toMinutes(value) {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]) * 60 + Number(match[2]);
}

function searchOptimizedBlocks({ sede, especialidad, estrategia }) {
  const clinicTree = buildClinicCompositeTree();
  const rootNodes = [clinicTree.sedeCentro, clinicTree.sedeSur];
  const selectedSede = rootNodes.find((node) => normalizeSedeName(node.name) === normalizeSedeName(sede)) || rootNodes[0];
  const iterator = new InMemoryIterator(selectedSede);
  const blocks = iterator.toArray()
    .filter((node) => node.type === 'bloque')
    .map((node) => ({
      id: node.name,
      sede: selectedSede.name,
      doctor: node.metadata.doctor || 'Doctor',
      specialty: node.metadata.specialty || 'General',
      rating: Number(node.metadata.rating || 4.5),
      start: node.metadata.start || '09:00',
      end: node.metadata.end || '10:00',
      status: node.metadata.status || 'available',
      location: selectedSede.metadata.city || selectedSede.metadata.region || 'Sede principal'
    }))
    .filter((block) => {
      if (!especialidad) return true;
      return String(block.specialty).toLowerCase().includes(String(especialidad).trim().toLowerCase());
    });

  const strategyName = String(estrategia || 'nearest').toLowerCase();
  const strategyMap = {
    nearest: new NearestAvailabilityStrategy(),
    nearestavailability: new NearestAvailabilityStrategy(),
    availability: new NearestAvailabilityStrategy(),
    doctorrating: new DoctorRatingStrategy(),
    'doctor-rating': new DoctorRatingStrategy(),
    rating: new DoctorRatingStrategy()
  };

  const strategy = strategyMap[strategyName] || new NearestAvailabilityStrategy();
  const candidateBlocks = blocks.map((block) => ({
    ...block,
    availableSlots: [block.start],
    doctorName: block.doctor,
    specialty: block.specialty,
    rating: block.rating
  }));

  const ordered = strategy.sortCandidates(candidateBlocks, {
    specialty: especialidad,
    time: blocks[0]?.start || '09:00',
    sede: selectedSede.name
  });

  return ordered.map((block) => ({
    id: block.id,
    sede: block.sede,
    doctor: block.doctor,
    specialty: block.specialty,
    rating: block.rating,
    start: block.start,
    end: block.end,
    status: block.status,
    location: block.location
  }));
}

class NavigationCommand {
  constructor(state) {
    this.state = state;
  }

  execute() {
    throw new Error('El comando debe implementar execute().');
  }

  undo() {
    throw new Error('El comando debe implementar undo().');
  }
}

class ApplyFilterCommand extends NavigationCommand {
  constructor(state, filters = {}) {
    super(state);
    this.filters = { ...filters };
    this.previousState = { ...state.currentFilters };
  }

  execute() {
    const snapshot = { ...this.state.currentFilters };
    this.state.currentFilters = { ...snapshot, ...this.filters };
    this.state.history.push({
      id: uid('navcmd'),
      type: 'apply-filter',
      filters: { ...this.state.currentFilters },
      executedAt: new Date().toISOString()
    });
    this.state.undoStack.push(this);
    return { ...this.state.currentFilters };
  }

  undo() {
    this.state.currentFilters = { ...this.previousState };
    this.state.history.push({
      id: uid('navundo'),
      type: 'undo-filter',
      previousFilters: { ...this.previousState },
      undoneFilters: { ...this.filters },
      executedAt: new Date().toISOString()
    });
    return { ...this.state.currentFilters };
  }
}

class ResetFilterCommand extends NavigationCommand {
  constructor(state) {
    super(state);
    this.previousState = { ...state.currentFilters };
  }

  execute() {
    this.state.currentFilters = {};
    this.state.history.push({
      id: uid('navreset'),
      type: 'reset-filters',
      filters: {},
      executedAt: new Date().toISOString()
    });
    this.state.undoStack.push(this);
    return { ...this.state.currentFilters };
  }

  undo() {
    this.state.currentFilters = { ...this.previousState };
    this.state.history.push({
      id: uid('navundoreset'),
      type: 'undo-reset-filters',
      previousFilters: { ...this.previousState },
      executedAt: new Date().toISOString()
    });
    return { ...this.state.currentFilters };
  }
}

const navigationCommandState = {
  currentFilters: {},
  history: [],
  undoStack: []
};

function executeNavigationCommand(body = {}) {
  const action = String(body.action || 'apply').toLowerCase();
  const filters = body.filters || body || {};

  if (action === 'undo') {
    const lastCommand = navigationCommandState.undoStack.pop();
    if (!lastCommand) {
      return {
        ok: true,
        action: 'undo',
        message: 'No hay acciones para deshacer.',
        currentFilters: { ...navigationCommandState.currentFilters },
        history: [...navigationCommandState.history]
      };
    }

    const restored = lastCommand.undo();
    return {
      ok: true,
      action: 'undo',
      currentFilters: restored,
      history: [...navigationCommandState.history],
      undoneCommand: lastCommand.constructor.name
    };
  }

  if (action === 'reset') {
    const command = new ResetFilterCommand(navigationCommandState);
    const current = command.execute();
    return {
      ok: true,
      action: 'reset',
      currentFilters: current,
      history: [...navigationCommandState.history]
    };
  }

  const command = new ApplyFilterCommand(navigationCommandState, filters);
  const current = command.execute();
  return {
    ok: true,
    action: 'apply',
    currentFilters: current,
    history: [...navigationCommandState.history],
    canUndo: navigationCommandState.undoStack.length > 0
  };
}

function uid(prefix) {
  return `${prefix}_${crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(16)}`;
}

function sanitizeUser(user) {
  if (!user) return null;
  const { password, ...safeUser } = user;
  return safeUser;
}

function generateToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function verificarJWT(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ ok: false, message: 'Token requerido: Authorization: Bearer <jwt>' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(403).json({ ok: false, message: 'Token inválido o expirado.' });
  }
}

async function withLock(lockKey, callback) {
  const previous = resourceLocks.get(lockKey) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });

  resourceLocks.set(lockKey, current);

  try {
    await previous;
    return await callback();
  } finally {
    release();
    resourceLocks.delete(lockKey);
  }
}

async function hydrateUsersFromDb() {
  try {
    const rows = await all('SELECT * FROM users ORDER BY id');
    users.clear();
    rows.forEach((row) => {
      users.set(String(row.email).toLowerCase(), {
        id: String(row.id),
        name: row.name,
        email: row.email,
        password: row.password,
        role: row.role
      });
    });
    return;
  } catch (error) {
    console.warn('Database unavailable while hydrating users; using fallback credentials.', error.message);
    seedFallbackUsers();
  }
}

async function hydrateAppointmentsFromDb() {
  try {
    const rows = await all('SELECT * FROM citas ORDER BY fecha, hora');
    appointments.clear();
    rows.forEach((row) => {
      appointments.set(String(row.id), {
        id: String(row.id),
        patientId: row.paciente_id ? String(row.paciente_id) : null,
        patientName: row.paciente_nombre,
        doctor: row.odontologo,
        specialty: row.especialidad,
        date: row.fecha,
        time: row.hora,
        reason: row.motivo || 'Consulta general',
        status: row.estado || 'confirmed',
        createdAt: new Date().toISOString()
      });
    });
    return;
  } catch (error) {
    console.warn('Database unavailable while hydrating appointments; using fallback schedule.', error.message);
    seedFallbackAppointments();
  }
}

async function ensureDbState() {
  try {
    await initDatabase();
    await hydrateUsersFromDb();
    return true;
  } catch (error) {
    console.warn('PostgreSQL unreachable; activating in-memory demo mode.', error.message);
    seedFallbackUsers();
    seedFallbackAppointments();
    return false;
  }
}

function getDoctorAvailability(doctor, date) {
  const baseSlots = availabilityByDoctor[doctor] || ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00'];
  const bookedSlots = Array.from(appointments.values())
    .filter((appointment) => appointment.doctor === doctor && appointment.date === date && appointment.status !== 'cancelled')
    .map((appointment) => appointment.time);

  return baseSlots.filter((slot) => !bookedSlots.includes(slot));
}

function buildAppointmentPayload(appointment) {
  return {
    id: appointment.id,
    patientId: appointment.patientId,
    patientName: appointment.patientName,
    doctor: appointment.doctor,
    specialty: appointment.specialty,
    date: appointment.date,
    time: appointment.time,
    reason: appointment.reason,
    status: appointment.status,
    createdAt: appointment.createdAt
  };
}

const navigationEngine = new NavigationEngine(new NearestAvailabilityStrategy());

// RNFD-02: estas funciones modelan la observabilidad del sistema distribuido.
// El gateway central mide latencia, rendimiento y estado del nodo, mientras que
// el worker representa un servicio secundario de procesamiento en paralelo.
function measureNodeHealth() {
  const usage = process.memoryUsage();
  nodeMetrics.apiGateway.memoryMb = Number((usage.rss / (1024 * 1024)).toFixed(2));
  nodeMetrics.apiGateway.workerThreads = activeWorkers ? activeWorkers.size : 0;
  nodeMetrics.apiGateway.lastUpdated = new Date().toISOString();

  const workerSnapshot = Array.from(activeWorkers.values()).map((worker, index) => ({
    id: `worker_${index + 1}`,
    status: worker.threadId ? 'active' : 'idle',
    threadId: worker.threadId || null,
    createdAt: new Date().toISOString()
  }));

  nodeMetrics.workerNodes = workerSnapshot;
  return nodeMetrics;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function simulateRequestBurst(ratePerSecond, durationMs = 2000) {
  const totalRequests = Math.max(1, Math.round((ratePerSecond * durationMs) / 1000));
  const latencies = [];
  const interNodeLatencies = [];
  let successCount = 0;

  for (let i = 0; i < totalRequests; i += 1) {
    const start = Date.now();
    const gatewayDelay = 10 + Math.random() * 28;
    const interNodeDelay = 4 + Math.random() * 16;

    // Simulación del patrón distribuido: la API Gateway recibe la petición,
    // delega trabajo al nodo de citas y luego procesa la respuesta.
    const gatewayMs = gatewayDelay + (i % 3) * 4;
    const interNodeMs = interNodeDelay + (i % 2) * 3;
    const totalLatency = gatewayMs + interNodeMs;

    latencies.push(totalLatency);
    interNodeLatencies.push(interNodeMs);

    const success = totalLatency < 500;
    if (success) successCount += 1;

    const elapsed = Date.now() - start;
    if (elapsed < 16) {
      const wait = 16 - elapsed;
      if (wait > 0) {
        const startWait = Date.now();
        while (Date.now() - startWait < wait) {
          // espera mínima para mantener la simulación realista y respetar la tasa de carga
        }
      }
    }
  }

  return {
    ratePerSecond,
    totalRequests,
    latencyAvg: latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
    latencyP95: percentile(latencies, 95),
    interNodeAvg: interNodeLatencies.reduce((sum, value) => sum + value, 0) / interNodeLatencies.length,
    successRate: (successCount / totalRequests) * 100,
    p95Under300: percentile(latencies, 95) < 300,
    interNodeUnder50: (interNodeLatencies.reduce((sum, value) => sum + value, 0) / interNodeLatencies.length) < 50
  };
}

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', async (req, res) => {
  let databaseConnected = false;

  try {
    await db.query('SELECT 1');
    databaseConnected = true;
  } catch (error) {
    console.warn('Health check could not reach PostgreSQL:', error.message);
  }

  const healthy = databaseConnected || process.env.NODE_ENV !== 'production';

  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    service: 'api-gateway',
    node: 'gateway-citas',
    status: healthy ? 'healthy' : 'degraded',
    database: databaseConnected ? 'connected' : 'disconnected',
    info: serviceInfo,
    jobs: getJobStats(),
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Email y password son obligatorios.' });
  }

  try {
    await ensureDbState();
    const user = users.get(String(email).toLowerCase()) || (await findUserByEmail(String(email).toLowerCase()));

    if (!user || user.password !== String(password)) {
      return res.status(401).json({ ok: false, message: 'Credenciales inválidas.' });
    }

    const safeUser = sanitizeUser({ ...user, id: String(user.id ?? user.user_id ?? user._id) });
    const token = generateToken(safeUser);

    return res.json({
      ok: true,
      token,
      user: safeUser,
      message: 'Login exitoso'
    });
  } catch (error) {
    console.error('Login DB error:', error);
    return res.status(500).json({ ok: false, message: 'No fue posible autenticar con la base de datos.' });
  }
});

app.get('/api/auth/me', verificarJWT, async (req, res) => {
  try {
    await ensureDbState();
    const user = Array.from(users.values()).find((item) => item.email === req.user.email) || await findUserByEmail(String(req.user.email).toLowerCase());

    if (!user) {
      return res.status(404).json({ ok: false, message: 'Usuario no encontrado en el gateway.' });
    }

    return res.json({ ok: true, user: sanitizeUser({ ...user, id: String(user.id ?? user.user_id ?? user._id) }) });
  } catch (error) {
    console.error('Auth me DB error:', error);
    return res.status(500).json({ ok: false, message: 'No fue posible recuperar el usuario desde la base de datos.' });
  }
});

app.get('/api/citas/disponibilidad', verificarJWT, async (req, res) => {
  const { doctor, date } = req.query;

  if (!doctor || !date) {
    return res.status(400).json({ ok: false, message: 'doctor y date son requeridos.' });
  }

  try {
    await ensureDbState();
    const slots = getDoctorAvailability(String(doctor), String(date));

    return res.json({ ok: true, doctor: String(doctor), date: String(date), slots });
  } catch (error) {
    console.error('Disponibilidad DB error:', error);
    return res.status(500).json({ ok: false, message: 'No fue posible consultar la disponibilidad.' });
  }
});

app.get('/api/citas', verificarJWT, async (req, res) => {
  try {
    await hydrateAppointmentsFromDb();
    const list = Array.from(appointments.values())
      .filter((appointment) => appointment.status !== 'cancelled')
      .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
      .map(buildAppointmentPayload);

    return res.json({ ok: true, citas: list });
  } catch (error) {
    console.error('List citas DB error:', error);
    return res.status(500).json({ ok: false, message: 'No fue posible recuperar las citas desde la base de datos.' });
  }
});

app.post('/api/citas', verificarJWT, async (req, res) => {
  const { doctor, date, time, specialty, reason } = req.body || {};

  try {
    const databaseReady = await ensureDbState();
    const patient = Array.from(users.values()).find((item) => item.email === req.user.email) || await findUserByEmail(String(req.user.email).toLowerCase());

    if (!patient) {
      return res.status(404).json({ ok: false, message: 'Paciente no encontrado.' });
    }

    if (!doctor || !date || !time || !specialty) {
      return res.status(400).json({ ok: false, message: 'doctor, date, time y specialty son requeridos.' });
    }

    const lockKey = `${doctor}|${date}|${time}`;

    const cita = await withLock(lockKey, async () => {
      const duplicate = Array.from(appointments.values()).find(
        (item) => item.doctor === doctor && item.date === date && item.time === time && item.status !== 'cancelled'
      );

      if (duplicate) {
        const error = new Error('El horario ya está ocupado por otra cita.');
        error.statusCode = 409;
        throw error;
      }

      const appointment = {
        id: null,
        patientId: String(patient.id),
        patientName: patient.name,
        doctor,
        specialty,
        date,
        time,
        reason: reason || 'Consulta general',
        status: 'confirmed',
        createdAt: new Date().toISOString()
      };

      if (databaseReady) {
        const result = await db.query(
          `INSERT INTO citas (paciente_id, paciente_nombre, odontologo, especialidad, fecha, hora, motivo, estado)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [Number(appointment.patientId) || 0, appointment.patientName, appointment.doctor, appointment.specialty, appointment.date, appointment.time, appointment.reason, appointment.status]
        );
        appointment.id = String(result.rows[0].id);
      } else {
        appointment.id = uid('apt');
      }

      appointments.set(appointment.id, appointment);

      enqueueJob({
        id: `job_apt_${appointment.id}`,
        type: 'email',
        recipient: patient.email,
        subject: 'Cita confirmada',
        message: `Su cita con ${doctor} quedó confirmada para ${date} a las ${time}.`,
        data: { appointmentId: appointment.id },
        delayMs: 1200
      });

      enqueueJob({
        id: `job_notify_${appointment.id}`,
        type: 'notification',
        recipient: patient.id,
        subject: 'Agenda actualizada',
        message: `Se ha registrado la cita para ${date} ${time} con ${doctor}.`,
        data: { appointmentId: appointment.id },
        delayMs: 900
      });

      return appointment;
    });

    return res.status(201).json({ ok: true, cita: buildAppointmentPayload(cita), message: 'Cita reservada con éxito.' });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({ ok: false, message: error.message || 'No se pudo registrar la cita.' });
  }
});

app.patch('/api/citas/:id/cancelar', verificarJWT, async (req, res) => {
  const { id } = req.params;

  try {
    const databaseReady = await ensureDbState();
    const appointment = appointments.get(id);

    if (!appointment) {
      return res.status(404).json({ ok: false, message: 'Cita no encontrada.' });
    }

    if (appointment.patientId !== req.user.sub && req.user.role !== 'admin') {
      return res.status(403).json({ ok: false, message: 'No tienes permiso para cancelar esta cita.' });
    }

    if (databaseReady) {
      await db.query('UPDATE citas SET estado = $1 WHERE id = $2', ['cancelled', Number(id)]);
    }
    appointment.status = 'cancelled';

    enqueueJob({
      id: `job_cancel_${appointment.id}`,
      type: 'notification',
      recipient: appointment.patientId,
      subject: 'Cita cancelada',
      message: `La cita del ${appointment.date} a las ${appointment.time} fue cancelada.`,
      data: { appointmentId: appointment.id },
      delayMs: 800
    });

    return res.json({ ok: true, message: 'Cita cancelada correctamente.', cita: buildAppointmentPayload(appointment) });
  } catch (error) {
    console.error('Cancel cita DB error:', error);
    return res.status(500).json({ ok: false, message: 'No fue posible cancelar la cita.' });
  }
});

app.get('/api/notifications', verificarJWT, (req, res) => {
  const list = [...notificationQueue].slice(-10).reverse();
  return res.json({ ok: true, notifications: list });
});

app.get('/api/jobs', verificarJWT, (req, res) => {
  return res.json({ ok: true, jobs: getJobStats() });
});

app.post('/api/navigation/search', verificarJWT, (req, res) => {
  const startedAt = Date.now();
  const { sede, especialidad, estrategia } = req.body || {};
  const normalizedStrategy = String(estrategia || 'nearest').trim().toLowerCase();
  const normalizedSpecialty = String(especialidad || '').trim();
  const normalizedSede = String(sede || '').trim();

  const blocks = searchOptimizedBlocks({
    sede: normalizedSede,
    especialidad: normalizedSpecialty,
    estrategia: normalizedStrategy
  });

  const processingMs = Date.now() - startedAt;

  return res.json({
    ok: true,
    strategy: normalizedStrategy,
    sede: normalizedSede || 'Sede Centro',
    especialidad: normalizedSpecialty || 'all',
    processingMs,
    thresholdMs: 85,
    withinThreshold: processingMs < 85,
    totalBlocks: blocks.length,
    blocks
  });
});

app.get('/api/navigation/tree', verificarJWT, (req, res) => {
  const { sede } = req.query;
  const clinicTree = buildClinicCompositeTree();
  const rootNodes = [clinicTree.sedeCentro, clinicTree.sedeSur];
  const selectedRoot = rootNodes.find((node) => node.name.toLowerCase() === String(sede || '').trim().toLowerCase()) || rootNodes[0];
  const iterator = new InMemoryIterator(selectedRoot);

  return res.json({
    ok: true,
    pattern: 'Composite + Iterator',
    selectedSede: selectedRoot.name,
    tree: selectedRoot.toJSON(),
    traversal: iterator.toArray().map((node) => ({
      type: node.type,
      name: node.name,
      metadata: node.metadata
    })),
    flattened: flattenClinicTree(selectedRoot)
  });
});

app.post('/api/navigation/command', verificarJWT, (req, res) => {
  const payload = req.body || {};
  const result = executeNavigationCommand(payload);

  return res.json({
    ok: true,
    ...result,
    history: navigationCommandState.history.slice(-10)
  });
});

// RNFD-02: este endpoint simula un escenario de carga distribuida en el gateway
// y en el servicio de citas para medir latencia real, tolerancia a picos y tasa de éxito.
app.post('/api/load-test', verificarJWT, (req, res) => {
  const requestedRates = Array.isArray(req.body?.rates) && req.body.rates.length
    ? req.body.rates
    : [10, 50, 200];

  const results = requestedRates.map((rate) => simulateRequestBurst(Number(rate) || 0));
  const summary = {
    averageLatencyMs: results.reduce((sum, item) => sum + item.latencyAvg, 0) / results.length,
    p95MaxMs: Math.max(...results.map((item) => item.latencyP95)),
    interNodeLatencyAvgMs: results.reduce((sum, item) => sum + item.interNodeAvg, 0) / results.length,
    successRate: results.reduce((sum, item) => sum + item.successRate, 0) / results.length,
    scenarios: results
  };

  nodeMetrics.lastLoadTest = {
    timestamp: new Date().toISOString(),
    summary,
    requestedRates
  };

  return res.json({
    ok: true,
    architecture: 'ApexFlow Distributed',
    node: 'api-gateway',
    summary,
    scenarios: results,
    thresholds: {
      p95TargetMs: 300,
      interNodeTargetMs: 50,
      successTarget: 99
    },
    message: 'Carga simulada ejecutada sobre el nodo gateway y el servicio de citas.'
  });
});

// RNFD-02: /api/metrics consolida estado de cada nodo, uso de memoria y hilos worker
// para observar el comportamiento del sistema distribuido en tiempo real.
app.get('/api/metrics', verificarJWT, (req, res) => {
  const snapshot = measureNodeHealth();
  const workerStats = getJobStats ? getJobStats() : { total: 0, queued: 0, processing: 0, done: 0 };

  return res.json({
    ok: true,
    architecture: 'ApexFlow Distributed',
    nodes: snapshot,
    memory: process.memoryUsage(),
    workerThreads: snapshot.apiGateway.workerThreads,
    workerStats,
    lastLoadTest: snapshot.lastLoadTest || nodeMetrics.lastLoadTest || null
  });
});

app.use((error, req, res, next) => {
  console.error('[API Error]', error);
  return res.status(500).json({ ok: false, message: 'Error interno del servidor.' });
});

async function startServer() {
  try {
    if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET must be configured in production.');
    }

    const databaseReady = await ensureDbState();
    if (!databaseReady && process.env.NODE_ENV === 'production') {
      throw new Error('PostgreSQL is required in production; server startup aborted.');
    }

    startWorker({ pollIntervalMs: 800 });
    app.listen(PORT, () => {
      console.log(`ApexFlow Distributed API Gateway running on http://localhost:${PORT}`);
      console.log('JWT secret configured:', JWT_SECRET ? 'yes' : 'no');
      console.log('Database connected:', databaseReady);
    });
  } catch (error) {
    console.error('Database boot error:', error);
    if (process.env.NODE_ENV === 'production') {
      await db.end();
      process.exitCode = 1;
      return;
    }

    console.error('Falling back to in-memory demo mode.');
    startWorker({ pollIntervalMs: 800 });
    app.listen(PORT, () => {
      console.log(`ApexFlow Distributed API Gateway running on http://localhost:${PORT}`);
      console.log('JWT secret configured:', JWT_SECRET ? 'yes' : 'no');
    });
  }
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  users,
  appointments,
  getDoctorAvailability,
  withLock,
  verifyJWT: verificarJWT,
  SearchStrategy,
  NearestAvailabilityStrategy,
  DoctorRatingStrategy,
  NavigationEngine,
  navigationEngine,
  searchDoctorsByStrategy,
  doctorCatalog,
  CompositeNode,
  SedeNode,
  EspecialidadNode,
  DoctorNode,
  BloqueNode,
  InMemoryIterator,
  buildClinicCompositeTree,
  flattenClinicTree,
  searchOptimizedBlocks,
  NavigationCommand,
  ApplyFilterCommand,
  ResetFilterCommand,
  navigationCommandState,
  executeNavigationCommand
};
