export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function uid(prefix = 'id') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function toLocalDateISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function toLocalTimeHM(date = new Date()) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export function parseLocalDate(dateISO) {
  if (!dateISO) return new Date();
  const [y, m, d] = dateISO.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function daysBetween(startISO, endISO) {
  const a = parseLocalDate(startISO);
  const b = parseLocalDate(endISO);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((b.getTime() - a.getTime()) / msPerDay);
}

export function formatDateLongEs(dateISO) {
  if (!dateISO) return '—';
  const d = parseLocalDate(dateISO);
  return new Intl.DateTimeFormat('es-CO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  }).format(d);
}

export function formatDateShortEs(dateISO) {
  if (!dateISO) return '—';
  const d = parseLocalDate(dateISO);
  return new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(d);
}

export function formatTimeEs(timeHM) {
  if (!timeHM) return '';
  const [hh, mm] = timeHM.split(':').map(Number);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return timeHM;
  const suffix = hh >= 12 ? 'p. m.' : 'a. m.';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

export function calcBMI(weightKg, heightCm) {
  const w = Number(weightKg);
  const hM = Number(heightCm) / 100;
  if (!w || !hM || hM <= 0) {
    return { value: '—', category: 'Sin datos', tone: 'neutral' };
  }
  const bmi = w / (hM * hM);
  const rounded = bmi.toFixed(1);
  if (bmi < 18.5) return { value: rounded, category: 'Bajo peso', tone: 'warn' };
  if (bmi < 25) return { value: rounded, category: 'Rango saludable', tone: 'ok' };
  if (bmi < 30) return { value: rounded, category: 'Sobrepeso', tone: 'warn' };
  return { value: rounded, category: 'Obesidad', tone: 'alert' };
}

// Catalogo base de especialidades. El usuario puede agregar las suyas
// desde su perfil; estas solo siembran los selectores.
export const SPECIALTIES_ES = [
  'Medicina General',
  'Odontología',
  'Reumatología',
  'Oftalmología',
  'Dermatología',
  'Ginecología',
  'Endocrinología',
  'Gastroenterología',
  'Cardiología',
  'Neurología',
  'Ortopedia',
  'Otorrinolaringología',
  'Psicología',
  'Psiquiatría',
  'Nutrición',
  'Fisioterapia',
  'Laboratorio',
  'Otra'
];

// Une el catalogo base con las especialidades que el usuario registro en su
// perfil y con las que ya aparecen en su historial, sin duplicar.
export function buildSpecialtyOptions(profileSpecialties = [], consultations = []) {
  const seen = new Map();
  const add = (name) => {
    const clean = String(name || '').trim();
    if (!clean) return;
    const key = clean.toLocaleLowerCase('es');
    if (!seen.has(key)) seen.set(key, clean);
  };
  profileSpecialties.forEach((sp) => add(sp.name));
  consultations.forEach((c) => add(c.specialty));
  SPECIALTIES_ES.forEach(add);
  const all = [...seen.values()];
  // "Otra" siempre va de ultima
  return [...all.filter((n) => n !== 'Otra').sort((a, b) => a.localeCompare(b, 'es')), ...all.filter((n) => n === 'Otra')];
}

export const WEEKDAYS_ES = [
  { id: 1, short: 'Lun', full: 'Lunes' },
  { id: 2, short: 'Mar', full: 'Martes' },
  { id: 3, short: 'Mié', full: 'Miércoles' },
  { id: 4, short: 'Jue', full: 'Jueves' },
  { id: 5, short: 'Vie', full: 'Viernes' },
  { id: 6, short: 'Sáb', full: 'Sábado' },
  { id: 0, short: 'Dom', full: 'Domingo' }
];

export function formatFrequencyEs(med) {
  if (!med) return '';
  if (med.frequency === 'daily') {
    const count = (med.times || []).length;
    return count > 1 ? `Todos los días (${count} tomas)` : 'Todos los días';
  }
  if (med.frequency === 'weekly') {
    const names = (med.daysOfWeek || [])
      .map((id) => WEEKDAYS_ES.find((w) => w.id === Number(id))?.short)
      .filter(Boolean);
    return names.length ? `Semanal: ${names.join(', ')}` : 'Semanal';
  }
  if (med.frequency === 'interval') {
    const days = Number(med.intervalDays) || 14;
    return `Cada ${days} días`;
  }
  if (med.frequency === 'prn') {
    return 'Según necesidad (SOS)';
  }
  return 'Personalizado';
}

export function isMedScheduledForDate(med, dateISO) {
  if (!med || med.active === false) return false;
  if (med.startDate && dateISO < med.startDate) return false;
  if (med.endDate && dateISO > med.endDate) return false;

  if (med.frequency === 'daily') return true;
  if (med.frequency === 'weekly') {
    const weekday = parseLocalDate(dateISO).getDay();
    return Array.isArray(med.daysOfWeek) && med.daysOfWeek.map(Number).includes(weekday);
  }
  if (med.frequency === 'interval') {
    const baseDate = med.startDate || toLocalDateISO();
    const diff = daysBetween(baseDate, dateISO);
    const interval = Math.max(1, Number(med.intervalDays) || 14);
    return diff >= 0 && diff % interval === 0;
  }
  return false;
}

export function playChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const notes = [587.33, 880]; // D5 -> A5 gentle chime
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.16);
      gain.gain.setValueAtTime(0.001, now + idx * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.14, now + idx * 0.16 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.16 + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.16);
      osc.stop(now + idx * 0.16 + 0.5);
    });
  } catch {
    // Ignore audio errors if autoplay policy blocks sound
  }
}

export function downloadFile(filename, content, mimeType = 'application/json') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeICS(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

export function buildICS({
  title,
  description,
  location = '',
  dateISO,
  timeHM = '09:00',
  durationMin = 30,
  rrule = '',
  alarms = ['-PT10M']
}) {
  const [y, m, d] = dateISO.split('-');
  const [hh, mm] = (timeHM || '09:00').split(':');
  const start = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), 0);
  const end = new Date(start.getTime() + durationMin * 60000);

  const fmt = (dt) =>
    `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}T${String(
      dt.getHours()
    ).padStart(2, '0')}${String(dt.getMinutes()).padStart(2, '0')}00`;

  const alarmBlocks = (alarms && alarms.length ? alarms : ['-PT10M']).flatMap((trigger) => [
    'BEGIN:VALARM',
    `TRIGGER:${trigger}`,
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeICS(title)}`,
    'END:VALARM'
  ]);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MiSalud//App//ES',
    'BEGIN:VEVENT',
    `UID:${Date.now()}@misaludarj.local`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${escapeICS(title)}`,
    `DESCRIPTION:${escapeICS(description)}`,
    location ? `LOCATION:${escapeICS(location)}` : null,
    rrule ? `RRULE:${rrule}` : null,
    ...alarmBlocks,
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean);

  return lines.join('\r\n');
}

export function parseLocalDateTime(dateISO, timeHM = '09:00') {
  const dt = parseLocalDate(dateISO);
  const [hh, mm] = (timeHM || '09:00').split(':').map(Number);
  dt.setHours(Number.isNaN(hh) ? 9 : hh, Number.isNaN(mm) ? 0 : mm, 0, 0);
  return dt;
}

export function addDaysISO(dateISO, deltaDays) {
  const dt = parseLocalDate(dateISO);
  dt.setDate(dt.getDate() + deltaDays);
  return toLocalDateISO(dt);
}

export function getCountdownLabel(targetDateISO, todayISO = toLocalDateISO()) {
  const diff = daysBetween(todayISO, targetDateISO);
  if (diff === 0) return '¡Es hoy!';
  if (diff === 1) return 'Mañana';
  if (diff > 1) return `En ${diff} días`;
  if (diff === -1) return 'Ayer';
  return `Hace ${Math.abs(diff)} días`;
}

export function formatDurationShortEs(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m} min ${rem} s` : `${m} min`;
}

export function formatRemainingMsEs(ms) {
  if (ms <= 0) return 'Ahora';
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function getTimePeriodInfo(timeHM) {
  const hh = Number((timeHM || '08:00').split(':')[0]);
  if (hh < 12) return { id: 'morning', label: 'Mañana', icon: '🌅' };
  if (hh < 18) return { id: 'afternoon', label: 'Tarde', icon: '☀️' };
  return { id: 'night', label: 'Noche', icon: '🌙' };
}
