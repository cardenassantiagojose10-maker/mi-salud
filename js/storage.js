import { toLocalDateISO, uid } from './utils.js';

const STORAGE_KEY = 'mi_salud_arj_state_v1';
const DB_NAME = 'mi_salud_arj_db';
const DB_STORE = 'attachments';

export function getDefaultProfile() {
  return {
    fullName: '',
    age: '',
    heightCm: '',
    weightKg: '',
    diagnosis: '',
    bloodType: '',
    allergies: '',
    rheumatologist: '',
    rheumatologistPhone: '',
    emergencyContact: '',
    insurance: '',
    notes: ''
  };
}

export function getDefaultSettings() {
  return {
    soundEnabled: true,
    notificationsEnabled: false,
    darkMode: false,
    repeatIntervalMin: 5
  };
}

export function getInitialState() {
  return {
    version: 1,
    profile: getDefaultProfile(),
    settings: getDefaultSettings(),
    medications: [],
    doseLogs: [], // { id, medId, dateISO, scheduledTime, status: 'taken'|'skipped', takenAtISO, note }
    consultations: [], // { id, dateISO, timeHM, specialty, doctor, clinic, status: 'completed'|'upcoming', reason, findings, plan, labs, nextControlDate, questions, attachmentIds: [] }
    symptomLogs: [] // { id, dateISO, pain: 0-10, stiffnessMin: number, fatigue: 0-10, joints: [], note }
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const fresh = getInitialState();
      saveState(fresh);
      return fresh;
    }
    const parsed = JSON.parse(raw);
    const base = getInitialState();
    return {
      ...base,
      ...parsed,
      profile: { ...base.profile, ...(parsed.profile || {}) },
      settings: { ...base.settings, ...(parsed.settings || {}) },
      medications: Array.isArray(parsed.medications) ? parsed.medications : [],
      doseLogs: Array.isArray(parsed.doseLogs) ? parsed.doseLogs : [],
      consultations: Array.isArray(parsed.consultations) ? parsed.consultations : [],
      symptomLogs: Array.isArray(parsed.symptomLogs) ? parsed.symptomLogs : []
    };
  } catch {
    return getInitialState();
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Error guardando estado en localStorage:', err);
  }
}

export function buildDemoSeed() {
  const today = toLocalDateISO();
  const d = new Date();
  const past1 = new Date(d);
  past1.setDate(d.getDate() - 28);
  const next1 = new Date(d);
  next1.setDate(d.getDate() + 14);
  const yest = new Date(d);
  yest.setDate(d.getDate() - 1);

  return {
    medications: [
      {
        id: uid('med'),
        name: 'Metotrexato',
        dose: '15 mg',
        form: 'Tableta',
        frequency: 'weekly',
        daysOfWeek: [6], // Sábado
        intervalDays: 7,
        times: ['20:00'],
        instructions: 'Tomar después de cenar con abundante agua.',
        color: '#5b46f6',
        stock: 12,
        lowStockAlert: 4,
        startDate: today,
        active: true,
        isDemo: true
      },
      {
        id: uid('med'),
        name: 'Ácido Fólico',
        dose: '5 mg',
        form: 'Tableta',
        frequency: 'weekly',
        daysOfWeek: [0], // Domingo (día siguiente)
        intervalDays: 7,
        times: ['09:00'],
        instructions: 'Tomar al día siguiente del Metotrexato.',
        color: '#d97706',
        stock: 20,
        lowStockAlert: 5,
        startDate: today,
        active: true,
        isDemo: true
      },
      {
        id: uid('med'),
        name: 'Vitamina D3',
        dose: '2000 UI',
        form: 'Cápsula',
        frequency: 'daily',
        daysOfWeek: [],
        intervalDays: 1,
        times: ['08:00'],
        instructions: 'Tomar con el desayuno.',
        color: '#2563eb',
        stock: 28,
        lowStockAlert: 5,
        startDate: today,
        active: true,
        isDemo: true
      },
      {
        id: uid('med'),
        name: 'Naproxeno',
        dose: '500 mg',
        form: 'Tableta',
        frequency: 'prn',
        daysOfWeek: [],
        intervalDays: 1,
        times: [],
        instructions: 'Solo si hay dolor o inflamación intensa, con comida.',
        color: '#e11d48',
        stock: 10,
        lowStockAlert: 3,
        startDate: today,
        active: true,
        isDemo: true
      }
    ],
    consultations: [
      {
        id: uid('con'),
        dateISO: toLocalDateISO(past1),
        timeHM: '10:30',
        specialty: 'Reumatología',
        doctor: 'Dra. Laura Mendoza',
        clinic: 'Unidad de Reumatología',
        status: 'completed',
        reason: 'Control trimestral de ARJ y revisión de laboratorios.',
        findings: 'Articulaciones sin sinovitis activa en rodillas. Leve rigidez matutina en muñeca derecha (~15 min).',
        plan: 'Continuar esquema actual. Realizar hemograma, transaminasas (AST/ALT), PCR y VSG antes del próximo control.',
        labs: 'PCR: 3.1 mg/L | VSG: 12 mm/h | Transaminasas normales.',
        nextControlDate: toLocalDateISO(next1),
        questions: 'Preguntar si puedo retomar natación 3 veces por semana.',
        attachmentIds: [],
        isDemo: true
      },
      {
        id: uid('con'),
        dateISO: toLocalDateISO(next1),
        timeHM: '09:00',
        specialty: 'Oftalmología',
        clinic: 'Centro Oftalmológico',
        doctor: 'Dr. Andrés Gómez',
        status: 'upcoming',
        reason: 'Control preventivo anual (tamizaje de uveítis asociada a ARJ).',
        findings: '',
        plan: 'Llevar resumen de medicación actual.',
        labs: '',
        nextControlDate: '',
        questions: 'Confirmar fecha del siguiente chequeo con lámpara de hendidura.',
        attachmentIds: [],
        isDemo: true
      }
    ],
    symptomLogs: [
      {
        id: uid('sym'),
        dateISO: toLocalDateISO(yest),
        pain: 3,
        stiffnessMin: 15,
        fatigue: 4,
        joints: ['Muñeca der.', 'Rodilla izq.'],
        note: 'Algo de rigidez al despertar, mejoró tras estiramientos.',
        isDemo: true
      },
      {
        id: uid('sym'),
        dateISO: today,
        pain: 2,
        stiffnessMin: 10,
        fatigue: 3,
        joints: ['Muñeca der.'],
        note: 'Buen día en general.',
        isDemo: true
      }
    ]
  };
}

// IndexedDB helpers for storing consultation file attachments (images / PDFs)
function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB no disponible'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveAttachmentFile(file) {
  const db = await openDB();
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const record = {
    id: uid('att'),
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    dataUrl,
    createdAt: new Date().toISOString()
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return { id: record.id, name: record.name, type: record.type, size: record.size };
}

export async function getAttachmentFile(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteAttachmentFile(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
