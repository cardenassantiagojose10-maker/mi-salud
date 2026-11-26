import {
  buildDemoSeed,
  deleteAttachmentFile,
  getAttachmentFile,
  loadState,
  saveAttachmentFile,
  saveState
} from './storage.js';
import {
  addDaysISO,
  buildICS,
  calcBMI,
  downloadFile,
  escapeHtml,
  formatDateLongEs,
  formatDateShortEs,
  formatFrequencyEs,
  formatRemainingMsEs,
  formatTimeEs,
  getCountdownLabel,
  getTimePeriodInfo,
  isMedScheduledForDate,
  parseLocalDate,
  parseLocalDateTime,
  playChime,
  toLocalDateISO,
  toLocalTimeHM,
  uid
} from './utils.js';

let state = loadState();
let activeView = 'today';
let selectedDateISO = toLocalDateISO();
let lastPoppedDoseKey = '';
let quickSelectedJoints = new Set();
let quickCheckinSyncedDate = '';
let medFilter = 'active';
let consultFilter = 'all';
let deferredInstallPrompt = null;
let pendingConsultAttachments = [];
const REMINDER_RUNTIME_KEY = 'mi_salud_arj_reminder_runtime_v1';
const BASE_TITLE = 'Mi Salud — Seguimiento de tratamiento';

function loadReminderRuntime() {
  try {
    const raw = localStorage.getItem(REMINDER_RUNTIME_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      lastNotifiedAt: parsed.lastNotifiedAt || {},
      snoozedUntil: parsed.snoozedUntil || {},
      consultNotified: parsed.consultNotified || {},
      consultDismissed: parsed.consultDismissed || {}
    };
  } catch {
    return { lastNotifiedAt: {}, snoozedUntil: {}, consultNotified: {}, consultDismissed: {} };
  }
}

let reminderRuntime = loadReminderRuntime();

function saveReminderRuntime() {
  try {
    localStorage.setItem(REMINDER_RUNTIME_KEY, JSON.stringify(reminderRuntime));
  } catch {
    // Ignore quota errors
  }
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showToast(msg) {
  const box = $('#toastContainer');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function persist() {
  saveState(state);
}

/* ---------------- Navigation & Theme ---------------- */
function setView(viewName) {
  activeView = viewName;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${viewName}`));
  $$('[data-view]').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === viewName));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  renderCurrentView();
}

function applyTheme() {
  const dark = Boolean(state.settings.darkMode);
  document.body.classList.toggle('dark', dark);
  $('#themeLabel').textContent = dark ? 'Modo claro' : 'Modo oscuro';
}

/* ---------------- Scheduled Doses Engine ---------------- */
function getScheduledDosesForDate(dateISO) {
  const doses = [];
  for (const med of state.medications) {
    if (!isMedScheduledForDate(med, dateISO)) continue;
    const times = Array.isArray(med.times) && med.times.length ? med.times : ['08:00'];
    for (const timeHM of times) {
      const log = state.doseLogs.find(
        (l) => l.medId === med.id && l.dateISO === dateISO && l.scheduledTime === timeHM
      );
      doses.push({
        med,
        dateISO,
        timeHM,
        log: log || null
      });
    }
  }
  doses.sort((a, b) => a.timeHM.localeCompare(b.timeHM));
  return doses;
}

function toggleDoseStatus(medId, dateISO, timeHM, targetStatus = 'taken') {
  const existingIdx = state.doseLogs.findIndex(
    (l) => l.medId === medId && l.dateISO === dateISO && l.scheduledTime === timeHM
  );
  const med = state.medications.find((m) => m.id === medId);

  if (existingIdx >= 0) {
    const prev = state.doseLogs[existingIdx];
    // Restore stock if unmarking a taken dose
    if (prev.status === 'taken' && med && typeof med.stock === 'number') {
      med.stock += 1;
    }
    state.doseLogs.splice(existingIdx, 1);
    showToast('Registro de toma deshecho.');
  } else {
    state.doseLogs.push({
      id: uid('log'),
      medId,
      dateISO,
      scheduledTime: timeHM,
      status: targetStatus,
      takenAtISO: new Date().toISOString()
    });
    if (targetStatus === 'taken' && med && typeof med.stock === 'number' && med.stock > 0) {
      med.stock -= 1;
    }
    if (targetStatus === 'taken') {
      lastPoppedDoseKey = `${medId}|${dateISO}|${timeHM}`;
    }
    showToast(targetStatus === 'taken' ? `Toma registrada: ${med?.name || 'Medicamento'}` : 'Toma omitida.');
  }

  const doseKey = `${medId}|${dateISO}|${timeHM}`;
  delete reminderRuntime.lastNotifiedAt[doseKey];
  delete reminderRuntime.snoozedUntil[doseKey];
  saveReminderRuntime();

  const alertModal = $('#reminderAlertModal');
  if (alertModal?.open) alertModal.close();

  persist();
  renderAll();
}

function logPrnDose(medId) {
  const med = state.medications.find((m) => m.id === medId);
  if (!med) return;
  const now = new Date();
  state.doseLogs.push({
    id: uid('prn'),
    medId,
    dateISO: toLocalDateISO(now),
    scheduledTime: toLocalTimeHM(now),
    status: 'taken',
    isPrn: true,
    takenAtISO: now.toISOString()
  });
  if (typeof med.stock === 'number' && med.stock > 0) {
    med.stock -= 1;
  }
  persist();
  showToast(`Registrada toma SOS de ${med.name}`);
  renderAll();
}

/* ---------------- Notifications & Real-time Reminders ---------------- */
function updateNotificationUI() {
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  const dot = $('#notifDot');
  const txt = $('#notifStatusText');
  const desc = $('#notifPermDesc');
  const btn = $('#btnEnableNotifications');

  if (!supported) {
    dot.classList.remove('on');
    txt.textContent = 'Sin notif.';
    desc.textContent = 'Este navegador no soporta notificaciones del sistema. Verás las alertas dentro de la app.';
    btn.disabled = true;
    return;
  }

  if (perm === 'granted') {
    dot.classList.add('on');
    txt.textContent = 'Alertas activas';
    desc.textContent = 'Permiso concedido. Recibirás avisos mientras la app esté abierta o en segundo plano.';
    btn.textContent = 'Activas';
    btn.disabled = true;
  } else if (perm === 'denied') {
    dot.classList.remove('on');
    txt.textContent = 'Bloqueadas';
    desc.textContent = 'Las notificaciones están bloqueadas en la configuración del navegador. Habilítalas desde el candado de la barra de dirección.';
    btn.textContent = 'Bloqueado';
    btn.disabled = true;
  } else {
    dot.classList.remove('on');
    txt.textContent = 'Activar alertas';
    desc.textContent = 'Activa el permiso para recibir recordatorios a la hora exacta de tus medicamentos.';
    btn.textContent = 'Activar';
    btn.disabled = false;
  }
}

async function requestNotifPermission() {
  if (!('Notification' in window)) {
    showToast('Tu navegador no soporta notificaciones nativas.');
    return;
  }
  const result = await Notification.requestPermission();
  state.settings.notificationsEnabled = result === 'granted';
  persist();
  updateNotificationUI();
  if (result === 'granted') {
    showToast('¡Notificaciones activadas!');
    sendSystemNotification('Mi Salud', 'Los recordatorios de medicamentos están activos.');
  } else {
    showToast('No se concedió permiso de notificaciones.');
  }
}

async function sendSystemNotification(title, body, data = null) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        const opts = {
          body,
          icon: './icons/icon-192.png',
          badge: './icons/icon-192.png',
          tag: data ? `med-${data.medId}-${data.timeHM}` : 'mi-salud-arj-med',
          renotify: true,
          requireInteraction: true,
          data: data || {}
        };
        if (data?.medId) {
          opts.actions = [
            { action: 'take', title: 'Ya me la tomé' },
            { action: 'snooze', title: 'En 10 min' }
          ];
        }
        await reg.showNotification(title, opts);
        return;
      }
    }
    new Notification(title, { body, icon: './icons/icon-192.png', requireInteraction: true });
  } catch {
    // Fallback ignored
  }
}

function snoozeDose(medId, dateISO, timeHM, minutes = 10) {
  const key = `${medId}|${dateISO}|${timeHM}`;
  reminderRuntime.snoozedUntil[key] = Date.now() + minutes * 60 * 1000;
  reminderRuntime.lastNotifiedAt[key] = Date.now();
  saveReminderRuntime();
  const modal = $('#reminderAlertModal');
  if (modal?.open) modal.close();
  showToast(`Pospuesto ${minutes} min. Te volveré a recordar hasta que la marques tomada.`);
  checkDueReminders();
}

function openReminderAlertModal(dose, repeatMin) {
  const modal = $('#reminderAlertModal');
  const openOther = $$('dialog[open]').some((d) => d.id !== 'reminderAlertModal');
  if (openOther) return;

  const { med, dateISO, timeHM } = dose;
  const repeatNote =
    repeatMin > 0
      ? `Si cierras este aviso sin marcarla tomada, volveré a recordarte cada ${repeatMin} minutos.`
      : 'Puedes posponerla 10 minutos o marcarla como tomada cuando la tomes.';

  $('#reminderAlertBody').innerHTML = `
    <div class="reminder-highlight" style="--med-color:${escapeHtml(med.color || '#5b46f6')}">
      <h4>${escapeHtml(med.name)} · ${escapeHtml(med.dose)}</h4>
      <p class="panel-sub">Hora programada: <strong>${escapeHtml(formatTimeEs(timeHM))}</strong> · ${escapeHtml(med.form)}</p>
      ${med.instructions ? `<p class="mt-sm">${escapeHtml(med.instructions)}</p>` : ''}
    </div>
    <p class="setting-desc">${escapeHtml(repeatNote)}</p>
  `;

  $('#reminderAlertFooter').innerHTML = `
    <div class="dose-actions">
      <button class="btn btn-ghost btn-sm" type="button" data-skip-dose="${escapeHtml(med.id)}|${escapeHtml(dateISO)}|${escapeHtml(timeHM)}">Omitir hoy</button>
      <button class="btn btn-secondary btn-sm" type="button" data-snooze-dose="${escapeHtml(med.id)}|${escapeHtml(dateISO)}|${escapeHtml(timeHM)}">⏰ En 10 min</button>
    </div>
    <button class="btn btn-primary" type="button" data-take-dose="${escapeHtml(med.id)}|${escapeHtml(dateISO)}|${escapeHtml(timeHM)}">
      ✅ Ya me la tomé
    </button>
  `;

  if (!modal.open) modal.showModal();
}

function checkConsultationReminders(nowMs) {
  const upcoming = state.consultations.filter((c) => c.status === 'upcoming' && c.dateISO);
  const activeAlerts = [];

  for (const c of upcoming) {
    const timeHM = c.timeHM || '09:00';
    const apptMs = parseLocalDateTime(c.dateISO, timeHM).getTime();
    const diffMs = apptMs - nowMs;

    // 10 min before (from 10 min before until 5 min past)
    // 1 hour before (from 60 min before until 10 min before)
    // 1 day before (from 24h before until 60 min before)
    let milestone = '';
    let labelTitle = '';
    if (diffMs <= 10 * 60 * 1000 && diffMs >= -5 * 60 * 1000) {
      milestone = '10m';
      labelTitle = `🚨 En ${Math.max(1, Math.ceil(diffMs / 60000))} min es tu consulta de ${c.specialty}`;
    } else if (diffMs <= 60 * 60 * 1000 && diffMs > 10 * 60 * 1000) {
      milestone = '1h';
      labelTitle = `⏰ En ~${Math.ceil(diffMs / 60000)} min tienes consulta de ${c.specialty}`;
    } else if (diffMs <= 24 * 60 * 60 * 1000 && diffMs > 60 * 60 * 1000) {
      milestone = '1d';
      labelTitle = `📅 Mañana tienes consulta de ${c.specialty} (${formatTimeEs(timeHM)})`;
    }

    if (!milestone) continue;

    const mKey = `${c.id}|${milestone}`;
    if (!reminderRuntime.consultNotified[mKey]) {
      reminderRuntime.consultNotified[mKey] = nowMs;
      saveReminderRuntime();

      if (state.settings.soundEnabled) playChime();
      const bodyParts = [
        `${formatDateShortEs(c.dateISO)} a las ${formatTimeEs(timeHM)}`,
        c.doctor ? `Con ${c.doctor}` : '',
        c.clinic ? `Lugar: ${c.clinic}` : ''
      ].filter(Boolean);
      sendSystemNotification(labelTitle, bodyParts.join(' · '));
    }

    if (!reminderRuntime.consultDismissed[mKey]) {
      activeAlerts.push({ consult: c, milestone, mKey, labelTitle, timeHM });
    }
  }

  return activeAlerts;
}

function checkDueReminders() {
  const todayISO = toLocalDateISO();
  const nowHM = toLocalTimeHM();
  const nowMs = Date.now();
  const doses = getScheduledDosesForDate(todayISO);

  const duePending = doses.filter((d) => !d.log && d.timeHM <= nowHM);
  const consultAlerts = checkConsultationReminders(nowMs);
  const bannerBox = $('#dueBannerContainer');

  const totalAlerts = duePending.length + consultAlerts.length;
  if (!totalAlerts) {
    bannerBox.innerHTML = '';
    document.title = BASE_TITLE;
    return;
  }

  document.title = `(${totalAlerts}) ⏰ Recordatorio pendiente — Mi Salud`;

  const repeatMin = Number(state.settings.repeatIntervalMin ?? 5);
  const repeatMs = repeatMin > 0 ? repeatMin * 60 * 1000 : 0;
  let triggeredDose = null;

  for (const d of duePending) {
    const key = `${d.med.id}|${d.dateISO}|${d.timeHM}`;
    const snoozedUntil = reminderRuntime.snoozedUntil[key] || 0;
    if (nowMs < snoozedUntil) continue;

    const lastAt = reminderRuntime.lastNotifiedAt[key] || 0;
    const isFirstAlert = lastAt === 0;
    const isRepeatDue = repeatMs > 0 && nowMs - lastAt >= repeatMs;

    if (isFirstAlert || isRepeatDue) {
      reminderRuntime.lastNotifiedAt[key] = nowMs;
      delete reminderRuntime.snoozedUntil[key];
      saveReminderRuntime();

      if (!triggeredDose) triggeredDose = d;

      if (state.settings.soundEnabled) playChime();
      const titlePrefix = isFirstAlert ? '⏰ Hora de tu medicamento' : '🔔 Sigue pendiente tu medicamento';
      sendSystemNotification(
        `${titlePrefix}: ${d.med.name} (${d.med.dose})`,
        d.med.instructions || 'Ábrela y marca "Ya me la tomé" para detener los recordatorios.',
        { medId: d.med.id, dateISO: d.dateISO, timeHM: d.timeHM }
      );
    }
  }

  if (triggeredDose) {
    openReminderAlertModal(triggeredDose, repeatMin);
  }

  const banners = [];

  for (const alert of consultAlerts) {
    const c = alert.consult;
    banners.push(`
      <div class="due-banner consult-alert">
        <div>
          <div>
            <strong>${escapeHtml(alert.labelTitle)}</strong>
          </div>
          <div class="due-banner-sub">
            ${escapeHtml(formatDateLongEs(c.dateISO))} · ${escapeHtml(formatTimeEs(alert.timeHM))}
            ${c.doctor ? ` · ${escapeHtml(c.doctor)}` : ''}
            ${c.clinic ? ` · ${escapeHtml(c.clinic)}` : ''}
          </div>
        </div>
        <div class="dose-actions">
          <button class="btn btn-primary btn-sm" type="button" data-open-consult="${escapeHtml(c.id)}">Ver cita</button>
          <button class="btn btn-ghost btn-sm" type="button" data-dismiss-consult-alert="${escapeHtml(alert.mKey)}">Entendido</button>
        </div>
      </div>
    `);
  }

  if (duePending.length) {
    const first = duePending[0];
    const firstKey = `${first.med.id}|${first.dateISO}|${first.timeHM}`;
    const snoozedUntil = reminderRuntime.snoozedUntil[firstKey] || 0;
    const extraCount = duePending.length - 1;

    let statusLine = '';
    if (nowMs < snoozedUntil) {
      const minsLeft = Math.max(1, Math.ceil((snoozedUntil - nowMs) / 60000));
      statusLine = `Pospuesto · volverá a sonar en ~${minsLeft} min si no la marcas.`;
    } else if (repeatMin > 0) {
      const lastAt = reminderRuntime.lastNotifiedAt[firstKey] || nowMs;
      const minsLeft = Math.max(1, Math.ceil((lastAt + repeatMs - nowMs) / 60000));
      statusLine = `Modo insistente activo: volverá a recordarte en ~${minsLeft} min hasta que la marques tomada.`;
    } else {
      statusLine = 'Marca "Ya me la tomé" cuando completes esta dosis.';
    }

    banners.push(`
      <div class="due-banner">
        <div>
          <div>
            <span class="pulse-dot" aria-hidden="true"></span>
            <strong>Recordatorio pendiente (${escapeHtml(formatTimeEs(first.timeHM))}):</strong>
            ${escapeHtml(first.med.name)} — ${escapeHtml(first.med.dose)}
            ${extraCount > 0 ? `<span class="pill pill-warn">+${extraCount} más</span>` : ''}
          </div>
          <div class="due-banner-sub">${escapeHtml(statusLine)}</div>
        </div>
        <div class="dose-actions">
          <button class="btn btn-primary btn-sm" type="button" data-take-dose="${escapeHtml(first.med.id)}|${escapeHtml(first.dateISO)}|${escapeHtml(first.timeHM)}">
            ✅ Ya me la tomé
          </button>
          <button class="btn btn-secondary btn-sm" type="button" data-snooze-dose="${escapeHtml(first.med.id)}|${escapeHtml(first.dateISO)}|${escapeHtml(first.timeHM)}">
            ⏰ +10 min
          </button>
          <button class="btn btn-ghost btn-sm" type="button" data-open-reminder-modal="${escapeHtml(first.med.id)}|${escapeHtml(first.dateISO)}|${escapeHtml(first.timeHM)}">
            Ver
          </button>
        </div>
      </div>
    `);
  }

  bannerBox.innerHTML = banners.join('');
}

/* ---------------- Rendering ---------------- */
function renderSidebarAndHeader() {
  const p = state.profile;
  const initials = (p.fullName || 'SC')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

  $('#sidebarAvatar').textContent = initials || '··';
  $('#sidebarName').textContent = p.fullName || 'Tu perfil';
  const metaBits = [
    p.age ? `${p.age} años` : null,
    p.heightCm ? `${p.heightCm} cm` : null,
    p.weightKg ? `${p.weightKg} kg` : null
  ].filter(Boolean);
  $('#sidebarMeta').textContent = metaBits.length ? metaBits.join(' · ') : 'Completa tus datos';
  $('#topbarDate').textContent = formatDateLongEs(toLocalDateISO());

  const todayDoses = getScheduledDosesForDate(toLocalDateISO());
  const pendingCount = todayDoses.filter((d) => !d.log).length;
  const badge = $('#navTodayBadge');
  badge.textContent = pendingCount;
  badge.hidden = pendingCount === 0;
}

function computeAdherenceStreak(todayISO) {
  let streak = 0;
  for (let offset = 0; offset < 60; offset += 1) {
    const dISO = addDaysISO(todayISO, -offset);
    const doses = getScheduledDosesForDate(dISO);
    if (!doses.length) {
      if (offset === 0) continue;
      break;
    }
    const allTaken = doses.every((d) => d.log?.status === 'taken');
    if (allTaken) {
      streak += 1;
    } else if (offset === 0) {
      // Today might still have pending doses later today
      continue;
    } else {
      break;
    }
  }
  return streak;
}

function renderWeekStrip(todayISO) {
  const strip = $('#weekStrip');
  const days = [];
  for (let offset = -2; offset <= 4; offset += 1) {
    const dISO = addDaysISO(todayISO, offset);
    const dt = parseLocalDate(dISO);
    const shortName = new Intl.DateTimeFormat('es-CO', { weekday: 'short' }).format(dt).replace('.', '');
    const doses = getScheduledDosesForDate(dISO);
    let dotClass = '';
    if (doses.length) {
      if (dISO > todayISO) {
        dotClass = 'future';
      } else if (doses.every((d) => d.log?.status === 'taken')) {
        dotClass = 'ok';
      } else {
        dotClass = 'warn';
      }
    }
    days.push(`
      <button
        type="button"
        class="week-day-btn ${dISO === selectedDateISO ? 'selected' : ''} ${dISO === todayISO ? 'today' : ''}"
        data-select-day="${escapeHtml(dISO)}"
      >
        <span class="week-day-name">${dISO === todayISO ? 'Hoy' : escapeHtml(shortName)}</span>
        <span class="week-day-num">${dt.getDate()}</span>
        <span class="week-dot ${dotClass}" title="${doses.length ? `${doses.length} dosis` : 'Sin dosis fijas'}"></span>
      </button>
    `);
  }
  strip.innerHTML = days.join('');
}

function renderTodayView() {
  const todayISO = toLocalDateISO();
  const nowHM = toLocalTimeHM();
  const nowMs = Date.now();
  const isViewingToday = selectedDateISO === todayISO;
  const firstName = (state.profile.fullName || '').trim().split(' ')[0];
  $('#todayHeading').textContent = firstName ? `Hola, ${firstName}` : 'Hola';

  const diagnosis = (state.profile.diagnosis || '').trim();
  $('#todayDiagnosisBadge').textContent = diagnosis ? `${diagnosis} · Panel Diario` : 'Panel Diario';

  renderWeekStrip(todayISO);

  // Hero metrics always reflect today's adherence & streak
  const todayDoses = getScheduledDosesForDate(todayISO);
  const todayTaken = todayDoses.filter((d) => d.log?.status === 'taken').length;
  const todayTotal = todayDoses.length;
  const pct = todayTotal ? Math.round((todayTaken / todayTotal) * 100) : 0;

  $('#todayAdherenceText').textContent = `${todayTaken}/${todayTotal}`;
  $('#todayAdherencePct').textContent = `${pct}%`;
  const circumference = 207.35;
  const ring = $('#adherenceRingCircle');
  if (ring) {
    ring.style.strokeDashoffset = String(circumference - (pct / 100) * circumference);
  }

  const streak = computeAdherenceStreak(todayISO);
  $('#todayStreakBadge').textContent = streak === 1 ? '🔥 1 día de racha' : `🔥 ${streak} días de racha`;

  // Next dose countdown
  const nextPendingToday = todayDoses.find((d) => !d.log);
  const nextDosePill = $('#nextDoseCountdown');
  if (nextPendingToday) {
    const targetMs = parseLocalDateTime(todayISO, nextPendingToday.timeHM).getTime();
    const diffMs = targetMs - nowMs;
    nextDosePill.hidden = false;
    nextDosePill.textContent =
      diffMs <= 0
        ? `⏰ Toma pendiente ahora: ${nextPendingToday.med.name} (${formatTimeEs(nextPendingToday.timeHM)})`
        : `⏳ Próxima toma en ${formatRemainingMsEs(diffMs)}: ${nextPendingToday.med.name} (${formatTimeEs(nextPendingToday.timeHM)})`;
  } else {
    nextDosePill.hidden = true;
  }

  if (!todayTotal) {
    $('#todaySubtitle').textContent = 'No tienes dosis fijas programadas para hoy. Puedes agregar tus medicamentos cuando quieras.';
  } else if (todayTaken === todayTotal) {
    $('#todaySubtitle').textContent = '¡Excelente! Completaste todas tus tomas programadas para hoy.';
  } else {
    const remaining = todayTotal - todayTaken;
    $('#todaySubtitle').textContent = `Te ${remaining === 1 ? 'falta 1 toma' : `faltan ${remaining} tomas`} programadas hoy para tu tratamiento.`;
  }

  // Next upcoming consultation
  const upcoming = state.consultations
    .filter((c) => c.status === 'upcoming')
    .sort((a, b) => `${a.dateISO} ${a.timeHM}`.localeCompare(`${b.dateISO} ${b.timeHM}`));

  if (upcoming.length) {
    const next = upcoming[0];
    $('#nextConsultShort').textContent = `${formatDateShortEs(next.dateISO)} (${getCountdownLabel(next.dateISO, todayISO)})`;
    $('#nextConsultSub').textContent = `${next.specialty}${next.doctor ? ` · ${next.doctor}` : ''}`;
  } else {
    $('#nextConsultShort').textContent = 'Sin agendar';
    $('#nextConsultSub').textContent = 'Registra tu próximo control';
  }

  // Doses list for selectedDateISO
  $('#todayScheduleTitle').textContent = isViewingToday ? 'Tomas programadas hoy' : 'Tomas del día seleccionado';
  $('#todayScheduleDate').textContent = formatDateLongEs(selectedDateISO);
  $('#btnResetToToday').hidden = isViewingToday;

  const doses = isViewingToday ? todayDoses : getScheduledDosesForDate(selectedDateISO);
  const dosesBox = $('#todayDosesList');

  if (!doses.length) {
    const hasAnyMeds = state.medications.length > 0;
    dosesBox.innerHTML = `
      <div class="empty-state">
        <strong>${hasAnyMeds ? 'Sin tomas programadas para este día' : 'Aún no has agregado medicamentos'}</strong>
        <p>${hasAnyMeds ? 'Tus medicamentos semanales o de otro intervalo no corresponden a esta fecha.' : 'Agrega tus medicamentos diarios, semanales o según necesidad para activar tus recordatorios.'}</p>
        <div class="empty-actions">
          <button class="btn btn-primary btn-sm" type="button" id="emptyAddMedBtn">+ Agregar medicamento</button>
          ${!hasAnyMeds ? '<button class="btn btn-soft btn-sm" type="button" id="emptyDemoBtn">Ver con ejemplos</button>' : ''}
        </div>
      </div>
    `;
    $('#emptyAddMedBtn')?.addEventListener('click', () => openMedModal());
    $('#emptyDemoBtn')?.addEventListener('click', loadDemoSeed);
  } else {
    const isFutureDay = selectedDateISO > todayISO;
    let currentPeriod = '';
    dosesBox.innerHTML = doses
      .map(({ med, dateISO, timeHM, log }) => {
        const period = getTimePeriodInfo(timeHM);
        const periodHeader =
          period.id !== currentPeriod
            ? ((currentPeriod = period.id), `<div class="period-group-title">${period.icon} ${period.label}</div>`)
            : '';

        const isTaken = log?.status === 'taken';
        const isSkipped = log?.status === 'skipped';
        const isOverdue = !log && (dateISO < todayISO || (dateISO === todayISO && timeHM < nowHM));
        const takenTimeStr = log?.takenAtISO
          ? formatTimeEs(toLocalTimeHM(new Date(log.takenAtISO)))
          : '';
        const doseKey = `${med.id}|${dateISO}|${timeHM}`;
        const isPopped = doseKey === lastPoppedDoseKey;
        if (isPopped) lastPoppedDoseKey = '';

        return `
          ${periodHeader}
          <div class="dose-item ${isTaken ? 'taken' : ''} ${isOverdue ? 'overdue' : ''} ${isPopped ? 'dose-pop' : ''}" style="--med-color:${escapeHtml(med.color || '#5b46f6')}">
            <div class="dose-main">
              <div class="dose-top">
                <span class="dose-time">${escapeHtml(formatTimeEs(timeHM))}</span>
                <span class="dose-title">${escapeHtml(med.name)} · ${escapeHtml(med.dose)}</span>
                ${isTaken ? `<span class="pill pill-ok">✓ Tomada ${escapeHtml(takenTimeStr)}</span>` : ''}
                ${isSkipped ? `<span class="pill">Omitida</span>` : ''}
                ${isOverdue ? `<span class="pill pill-warn">Pendiente</span>` : ''}
                ${isFutureDay && !log ? `<span class="pill">Programada</span>` : ''}
              </div>
              <div class="dose-meta">
                ${escapeHtml(med.form)}${med.instructions ? ` · ${escapeHtml(med.instructions)}` : ''}
              </div>
            </div>
            <div class="dose-actions">
              ${
                isFutureDay
                  ? '<span class="panel-sub">Próxima</span>'
                  : log
                  ? `<button class="btn btn-ghost btn-sm" type="button" data-take-dose="${escapeHtml(med.id)}|${escapeHtml(dateISO)}|${escapeHtml(timeHM)}">Deshacer</button>`
                  : `<button class="btn btn-primary btn-sm" type="button" data-take-dose="${escapeHtml(med.id)}|${escapeHtml(dateISO)}|${escapeHtml(timeHM)}">Tomar</button>
                     <button class="btn btn-ghost btn-sm" type="button" data-skip-dose="${escapeHtml(med.id)}|${escapeHtml(dateISO)}|${escapeHtml(timeHM)}" title="Omitir esta toma">Omitir</button>`
              }
            </div>
          </div>
        `;
      })
      .join('');
  }

  // PRN medications
  const prnMeds = state.medications.filter((m) => m.active !== false && m.frequency === 'prn');
  const prnBox = $('#todayPrnList');
  if (!prnMeds.length) {
    prnBox.innerHTML = `<p class="panel-sub">No tienes medicamentos SOS configurados.</p>`;
  } else {
    prnBox.innerHTML = prnMeds
      .map((med) => {
        const lastLog = [...state.doseLogs]
          .filter((l) => l.medId === med.id && l.status === 'taken')
          .sort((a, b) => (b.takenAtISO || '').localeCompare(a.takenAtISO || ''))[0];
        const lastText = lastLog
          ? `Última toma: ${formatDateShortEs(lastLog.dateISO)} ${formatTimeEs(lastLog.scheduledTime)}`
          : 'Sin tomas registradas aún';
        return `
          <div class="dose-item" style="--med-color:${escapeHtml(med.color || '#e11d48')}">
            <div class="dose-main">
              <div class="dose-top">
                <span class="dose-title">${escapeHtml(med.name)} · ${escapeHtml(med.dose)}</span>
              </div>
              <div class="dose-meta">${escapeHtml(lastText)}</div>
            </div>
            <button class="btn btn-soft btn-sm" type="button" data-prn-take="${escapeHtml(med.id)}">+ Registrar toma</button>
          </div>
        `;
      })
      .join('');
  }

  // Today symptom summary
  const todaySym = state.symptomLogs.find((s) => s.dateISO === todayISO);
  const symBox = $('#todaySymptomSummary');
  if (!todaySym) {
    symBox.innerHTML = `<p class="panel-sub">Aún no has registrado cómo amanecieron tus articulaciones hoy.</p>`;
  } else {
    symBox.innerHTML = `
      <div class="med-tags">
        <span class="pill pill-teal">Dolor: ${todaySym.pain}/10</span>
        <span class="pill">Rigidez: ${todaySym.stiffnessMin} min</span>
        <span class="pill">Fatiga: ${todaySym.fatigue}/10</span>
      </div>
      ${todaySym.joints?.length ? `<p class="panel-sub mt-sm">Zonas: ${escapeHtml(todaySym.joints.join(', '))}</p>` : ''}
      ${todaySym.note ? `<p class="panel-sub mt-sm">${escapeHtml(todaySym.note)}</p>` : ''}
    `;
  }
}

function renderMedsView() {
  const q = ($('#medSearchInput').value || '').trim().toLowerCase();
  const filtered = state.medications.filter((m) => {
    const isActive = m.active !== false;
    if (medFilter === 'active' && !isActive) return false;
    if (medFilter === 'paused' && isActive) return false;
    if (!q) return true;
    return `${m.name} ${m.dose} ${m.form} ${m.instructions || ''}`.toLowerCase().includes(q);
  });

  const grid = $('#medsGrid');
  if (!filtered.length) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <strong>No hay medicamentos en esta vista</strong>
        <p>Agrega tus medicamentos (diarios, semanales o SOS) para llevar tus recordatorios e inventario.</p>
        <div class="empty-actions">
          <button class="btn btn-primary btn-sm" type="button" id="emptyMedsNewBtn">+ Nuevo medicamento</button>
        </div>
      </div>
    `;
    $('#emptyMedsNewBtn')?.addEventListener('click', () => openMedModal());
    return;
  }

  grid.innerHTML = filtered
    .map((med) => {
      const isActive = med.active !== false;
      const timesText = med.frequency === 'prn'
        ? 'Según necesidad'
        : (med.times || []).map(formatTimeEs).join(', ') || 'Sin horario';
      const lowStock = typeof med.stock === 'number' && med.stock <= (med.lowStockAlert ?? 4);

      return `
        <article class="med-card ${isActive ? '' : 'paused'}" style="--med-color:${escapeHtml(med.color || '#5b46f6')}">
          <div class="med-card-head">
            <div>
              <h3>${escapeHtml(med.name)}</h3>
              <div class="med-dose-sub">${escapeHtml(med.dose)} · ${escapeHtml(med.form)}</div>
            </div>
            <span class="pill ${isActive ? 'pill-teal' : ''}">${isActive ? 'Activo' : 'Pausado'}</span>
          </div>

          <div class="med-tags">
            <span class="pill">${escapeHtml(formatFrequencyEs(med))}</span>
            <span class="pill">⏰ ${escapeHtml(timesText)}</span>
          </div>

          ${med.instructions ? `<div class="med-instructions">${escapeHtml(med.instructions)}</div>` : ''}

          ${
            typeof med.stock === 'number'
              ? `<div class="stock-row">
                  <span>Inventario: <strong>${med.stock}</strong> ${lowStock ? '<span class="pill pill-danger">Bajo stock</span>' : ''}</span>
                  <div class="stock-controls">
                    <button class="btn btn-secondary btn-xs" type="button" data-stock-delta="${escapeHtml(med.id)}|-1">−1</button>
                    <button class="btn btn-secondary btn-xs" type="button" data-stock-delta="${escapeHtml(med.id)}|1">+1</button>
                  </div>
                </div>`
              : ''
          }

          <div class="card-footer-actions">
            <button class="btn btn-soft btn-xs" type="button" data-edit-med="${escapeHtml(med.id)}">Editar</button>
            <button class="btn btn-secondary btn-xs" type="button" data-toggle-med="${escapeHtml(med.id)}">${isActive ? 'Pausar' : 'Reanudar'}</button>
            ${med.frequency !== 'prn' ? `<button class="btn btn-ghost btn-xs" type="button" data-ics-med="${escapeHtml(med.id)}">Calendario (.ics)</button>` : ''}
            <button class="btn btn-danger-ghost btn-xs" type="button" data-del-med="${escapeHtml(med.id)}">Eliminar</button>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderConsultsView() {
  const q = ($('#consultSearchInput').value || '').trim().toLowerCase();
  const spec = $('#consultSpecialtyFilter').value;

  const list = state.consultations
    .filter((c) => {
      if (consultFilter !== 'all' && c.status !== consultFilter) return false;
      if (spec !== 'all' && c.specialty !== spec) return false;
      if (!q) return true;
      return `${c.specialty} ${c.doctor} ${c.clinic} ${c.reason} ${c.findings} ${c.plan} ${c.labs} ${c.questions}`
        .toLowerCase()
        .includes(q);
    })
    .sort((a, b) => `${b.dateISO} ${b.timeHM || ''}`.localeCompare(`${a.dateISO} ${a.timeHM || ''}`));

  const container = $('#consultsList');
  if (!list.length) {
    container.innerHTML = `
      <div class="empty-state">
        <strong>Sin consultas registradas aquí</strong>
        <p>Guarda aquí cada cita de reumatología, oftalmología, fisioterapia, resultados de exámenes e indicaciones médicas.</p>
        <div class="empty-actions">
          <button class="btn btn-primary btn-sm" type="button" id="emptyConsultNewBtn">+ Registrar consulta</button>
        </div>
      </div>
    `;
    $('#emptyConsultNewBtn')?.addEventListener('click', () => openConsultModal());
    return;
  }

  const todayISO = toLocalDateISO();
  container.innerHTML = list
    .map((c) => {
      const dt = parseLocalDate(c.dateISO);
      const day = String(dt.getDate()).padStart(2, '0');
      const month = new Intl.DateTimeFormat('es-CO', { month: 'short' }).format(dt);
      const year = dt.getFullYear();
      const isUpcoming = c.status === 'upcoming';
      const countdown = isUpcoming ? getCountdownLabel(c.dateISO, todayISO) : '';
      const summaryText = isUpcoming
        ? c.reason || c.questions || 'Cita próxima programada (avisos 1 día, 1 h y 10 min antes)'
        : c.findings || c.plan || c.reason || 'Sin notas registradas';
      const attCount = c.attachmentIds?.length || 0;
      const qCount = c.checklistQuestions?.length || 0;

      return `
        <article class="consult-card" data-open-consult="${escapeHtml(c.id)}">
          <div class="consult-date-box">
            <span class="day">${day}</span>
            <span class="month">${escapeHtml(month)}</span>
            <span class="year">${year}</span>
          </div>
          <div class="consult-info">
            <div class="consult-title-row">
              <strong>${escapeHtml(c.specialty)}</strong>
              <span class="pill ${isUpcoming ? 'pill-warn' : 'pill-ok'}">${isUpcoming ? `Próxima · ${escapeHtml(countdown)}` : 'Realizada'}</span>
              ${c.timeHM ? `<span class="pill">${escapeHtml(formatTimeEs(c.timeHM))}</span>` : ''}
              ${qCount ? `<span class="pill">❓ ${qCount}</span>` : ''}
              ${attCount ? `<span class="pill">📎 ${attCount}</span>` : ''}
            </div>
            <div class="consult-meta-line">
              ${c.doctor ? escapeHtml(c.doctor) : 'Médico sin especificar'}${c.clinic ? ` · ${escapeHtml(c.clinic)}` : ''}
            </div>
            <p class="consult-snippet">${escapeHtml(summaryText)}</p>
          </div>
          <div class="dose-actions">
            ${
              isUpcoming
                ? `<button class="btn btn-primary btn-sm" type="button" data-complete-consult="${escapeHtml(c.id)}">Anotar resultado</button>`
                : '<button class="btn btn-soft btn-sm" type="button">Ver detalle</button>'
            }
          </div>
        </article>
      `;
    })
    .join('');
}

function updateQuickCheckinVisuals() {
  const pain = Number($('#quickSymPain')?.value || 0);
  const fatigue = Number($('#quickSymFatigue')?.value || 0);
  if ($('#quickPainLabel')) $('#quickPainLabel').textContent = `${pain} / 10`;
  if ($('#quickFatigueLabel')) $('#quickFatigueLabel').textContent = `${fatigue} / 10`;

  const badge = $('#quickMoodBadge');
  if (badge) {
    if (pain <= 2) {
      badge.textContent = '😊 Muy bien';
      badge.className = 'pill pill-ok';
    } else if (pain <= 5) {
      badge.textContent = '🙂 Molestia leve';
      badge.className = 'pill pill-teal';
    } else if (pain <= 7) {
      badge.textContent = '😣 Dolor moderado';
      badge.className = 'pill pill-warn';
    } else {
      badge.textContent = '😫 Brote fuerte';
      badge.className = 'pill pill-danger';
    }
  }

  $$('#interactiveBodySvg .joint-node').forEach((node) => {
    node.classList.toggle('active', quickSelectedJoints.has(node.dataset.joint));
  });
  $$('#quickJointChips .joint-chip-btn').forEach((btn) => {
    btn.classList.toggle('active', quickSelectedJoints.has(btn.dataset.quickJoint));
  });
}

function syncQuickCheckinFromToday(force = false) {
  const todayISO = toLocalDateISO();
  if (!force && quickCheckinSyncedDate === todayISO) {
    updateQuickCheckinVisuals();
    return;
  }
  quickCheckinSyncedDate = todayISO;
  const existing = state.symptomLogs.find((s) => s.dateISO === todayISO);
  if ($('#quickCheckinDateLabel')) {
    $('#quickCheckinDateLabel').textContent = formatDateLongEs(todayISO);
  }
  if ($('#quickSymPain')) $('#quickSymPain').value = existing?.pain ?? 2;
  if ($('#quickSymFatigue')) $('#quickSymFatigue').value = existing?.fatigue ?? 3;
  if ($('#quickSymStiffness')) $('#quickSymStiffness').value = existing?.stiffnessMin ?? 10;
  if ($('#quickSymNote')) $('#quickSymNote').value = existing?.note || '';
  quickSelectedJoints = new Set(existing?.joints || []);
  updateQuickCheckinVisuals();
}

function renderSymptomsView() {
  syncQuickCheckinFromToday();
  const sortedDesc = [...state.symptomLogs].sort((a, b) => b.dateISO.localeCompare(a.dateISO));
  const chartBox = $('#symptomChartBox');
  const historyBox = $('#symptomHistoryList');

  const recentAsc = [...sortedDesc].slice(0, 14).reverse();
  if (recentAsc.length < 2) {
    chartBox.innerHTML = `
      <div class="empty-state">
        <strong>Registra al menos 2 días para ver la gráfica</strong>
        <p>Ideal para mostrar la evolución de dolor y rigidez en tu cita de reumatología.</p>
      </div>
    `;
  } else {
    const w = 520;
    const h = 190;
    const padX = 34;
    const padY = 20;
    const innerW = w - padX * 2;
    const innerH = h - padY * 2;
    const stepX = innerW / (recentAsc.length - 1);

    const toPoints = (key) =>
      recentAsc
        .map((item, idx) => {
          const x = padX + idx * stepX;
          const y = padY + innerH - ((Number(item[key]) || 0) / 10) * innerH;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');

    const painPts = toPoints('pain');
    const fatiguePts = toPoints('fatigue');

    chartBox.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;overflow:visible" role="img" aria-label="Gráfica de dolor y fatiga">
        ${[0, 5, 10]
          .map((val) => {
            const y = padY + innerH - (val / 10) * innerH;
            return `<line x1="${padX}" y1="${y}" x2="${w - padX}" y2="${y}" stroke="var(--border)" stroke-dasharray="4 4"/>
                    <text x="6" y="${y + 4}" font-size="11" fill="var(--text-soft)">${val}</text>`;
          })
          .join('')}
        <polyline fill="none" stroke="#5b46f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${painPts}"/>
        <polyline fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round" points="${fatiguePts}"/>
        ${recentAsc
          .map((item, idx) => {
            const x = padX + idx * stepX;
            const yP = padY + innerH - ((Number(item.pain) || 0) / 10) * innerH;
            return `<circle cx="${x}" cy="${yP}" r="4" fill="#5b46f6"><title>${escapeHtml(formatDateShortEs(item.dateISO))}: Dolor ${item.pain}/10</title></circle>`;
          })
          .join('')}
      </svg>
      <div class="med-tags mt-sm">
        <span class="pill pill-teal">● Dolor articular (0-10)</span>
        <span class="pill pill-warn">┄ Fatiga (0-10)</span>
      </div>
    `;
  }

  if (!sortedDesc.length) {
    historyBox.innerHTML = `
      <div class="empty-state">
        <strong>Sin registros de bienestar todavía</strong>
        <p>Anota en 15 segundos tu dolor, rigidez matutina y articulaciones afectadas.</p>
      </div>
    `;
    return;
  }

  historyBox.innerHTML = sortedDesc
    .map(
      (s) => `
      <div class="symptom-row">
        <div class="symptom-row-top">
          <strong>${escapeHtml(formatDateLongEs(s.dateISO))}</strong>
          <button class="btn btn-danger-ghost btn-xs" type="button" data-del-symptom="${escapeHtml(s.id)}">Eliminar</button>
        </div>
        <div class="med-tags">
          <span class="pill pill-teal">Dolor: ${s.pain}/10</span>
          <span class="pill">Rigidez: ${s.stiffnessMin} min</span>
          <span class="pill">Fatiga: ${s.fatigue}/10</span>
        </div>
        ${s.joints?.length ? `<div class="dose-meta">Articulaciones: ${escapeHtml(s.joints.join(', '))}</div>` : ''}
        ${s.note ? `<div class="dose-meta">${escapeHtml(s.note)}</div>` : ''}
      </div>
    `
    )
    .join('');
}

function renderProfileView() {
  const p = state.profile;
  const bmi = calcBMI(p.weightKg, p.heightCm);

  const bmiBadge = $('#cardBmiBadge');
  bmiBadge.textContent = `IMC ${bmi.value} · ${bmi.category}`;
  bmiBadge.className = `pill ${bmi.tone === 'ok' ? 'pill-ok' : bmi.tone === 'warn' ? 'pill-warn' : 'pill-teal'}`;

  const activeMeds = state.medications.filter((m) => m.active !== false);
  $('#medicalCardContent').innerHTML = `
    <div class="card-kv-grid">
      <div class="kv-item"><span>Paciente</span><strong>${escapeHtml(p.fullName || 'Sin especificar')}</strong></div>
      <div class="kv-item"><span>Edad</span><strong>${p.age ? escapeHtml(p.age) + ' años' : 'Sin especificar'}</strong></div>
      <div class="kv-item"><span>Estatura / Peso</span><strong>${p.heightCm || p.weightKg ? `${p.heightCm ? escapeHtml(p.heightCm) + ' cm' : '—'} · ${p.weightKg ? escapeHtml(p.weightKg) + ' kg' : '—'}` : 'Sin especificar'}</strong></div>
      <div class="kv-item"><span>Diagnóstico</span><strong>${escapeHtml(p.diagnosis || 'Sin especificar')}</strong></div>
      <div class="kv-item"><span>Grupo sanguíneo</span><strong>${escapeHtml(p.bloodType || 'Sin especificar')}</strong></div>
      <div class="kv-item"><span>EPS / Seguro</span><strong>${escapeHtml(p.insurance || 'Sin especificar')}</strong></div>
      <div class="kv-item"><span>Alergias</span><strong>${escapeHtml(p.allergies || 'Ninguna registrada')}</strong></div>
      <div class="kv-item"><span>Contacto emergencia</span><strong>${escapeHtml(p.emergencyContact || 'Sin especificar')}</strong></div>
    </div>
    ${p.rheumatologist ? `<p class="panel-sub"><strong>Reumatólogo tratante:</strong> ${escapeHtml(p.rheumatologist)}</p>` : ''}
    ${p.notes ? `<p class="panel-sub mt-sm"><strong>Notas clínicas:</strong> ${escapeHtml(p.notes)}</p>` : ''}
    <div class="card-meds-summary mt-sm">
      <strong>Medicación activa actual (${activeMeds.length}):</strong>
      ${
        activeMeds.length
          ? `<ul>${activeMeds
              .map(
                (m) =>
                  `<li><strong>${escapeHtml(m.name)}</strong> (${escapeHtml(m.dose)}) — ${escapeHtml(formatFrequencyEs(m))}</li>`
              )
              .join('')}</ul>`
          : `<p class="panel-sub">Sin medicamentos activos registrados.</p>`
      }
    </div>
  `;

  // Populate form
  const form = $('#profileForm');
  Object.keys(p).forEach((key) => {
    if (form.elements[key]) {
      form.elements[key].value = p[key] ?? '';
    }
  });
  $('#chkSoundEnabled').checked = Boolean(state.settings.soundEnabled);
  $('#selectRepeatInterval').value = String(state.settings.repeatIntervalMin ?? 5);
  updateNotificationUI();
}

function renderCurrentView() {
  renderSidebarAndHeader();
  if (activeView === 'today') renderTodayView();
  if (activeView === 'meds') renderMedsView();
  if (activeView === 'consults') renderConsultsView();
  if (activeView === 'symptoms') renderSymptomsView();
  if (activeView === 'profile') renderProfileView();
}

function renderAll() {
  renderCurrentView();
  checkDueReminders();
}

/* ---------------- Modals: Medications ---------------- */
function renderMedTimeSlots(times = ['08:00']) {
  const box = $('#medTimesList');
  box.innerHTML = times
    .map(
      (t) => `
      <div class="time-slot-chip">
        <input type="time" class="med-time-input" value="${escapeHtml(t)}" required />
        <button type="button" class="btn btn-ghost btn-xs remove-time-btn" title="Quitar hora">✕</button>
      </div>
    `
    )
    .join('');

  box.querySelectorAll('.remove-time-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (box.children.length > 1) btn.parentElement.remove();
    });
  });
}

function syncMedFrequencyVisibility() {
  const freq = $('#medFrequencySelect').value;
  $('#medWeeklyBox').hidden = freq !== 'weekly';
  $('#medIntervalBox').hidden = freq !== 'interval';
  $('#medTimesBox').hidden = freq === 'prn';
}

function openMedModal(medId = null) {
  const form = $('#medForm');
  form.reset();
  const med = medId ? state.medications.find((m) => m.id === medId) : null;

  $('#medModalTitle').textContent = med ? 'Editar medicamento' : 'Nuevo medicamento';
  form.elements.id.value = med?.id || '';
  form.elements.name.value = med?.name || '';
  form.elements.dose.value = med?.dose || '';
  form.elements.form.value = med?.form || 'Tableta';
  form.elements.frequency.value = med?.frequency || 'daily';
  form.elements.intervalDays.value = med?.intervalDays || 14;
  form.elements.startDate.value = med?.startDate || toLocalDateISO();
  form.elements.color.value = med?.color || '#5b46f6';
  form.elements.stock.value = typeof med?.stock === 'number' ? med.stock : '';
  form.elements.lowStockAlert.value = med?.lowStockAlert ?? 4;
  form.elements.instructions.value = med?.instructions || '';

  const selectedDays = new Set((med?.daysOfWeek || []).map(Number));
  $$('#medWeekdayPills input').forEach((chk) => {
    chk.checked = selectedDays.has(Number(chk.value));
  });

  renderMedTimeSlots(med?.times?.length ? med.times : ['08:00']);
  syncMedFrequencyVisibility();
  $('#medModal').showModal();
}

function exportMedICS(medId) {
  const med = state.medications.find((m) => m.id === medId);
  if (!med) return;
  const timeHM = (med.times && med.times[0]) || '08:00';
  let rrule = 'FREQ=DAILY';
  if (med.frequency === 'weekly') {
    const map = { 0: 'SU', 1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA' };
    const byDay = (med.daysOfWeek || []).map((d) => map[Number(d)]).filter(Boolean);
    rrule = byDay.length ? `FREQ=WEEKLY;BYDAY=${byDay.join(',')}` : 'FREQ=WEEKLY';
  } else if (med.frequency === 'interval') {
    rrule = `FREQ=DAILY;INTERVAL=${Math.max(1, Number(med.intervalDays) || 14)}`;
  }

  const ics = buildICS({
    title: `Tomar ${med.name} (${med.dose})`,
    description: med.instructions || 'Recordatorio de medicación — Mi Salud',
    dateISO: med.startDate || toLocalDateISO(),
    timeHM,
    durationMin: 15,
    rrule
  });
  downloadFile(`recordatorio-${med.name.toLowerCase().replace(/\s+/g, '-')}.ics`, ics, 'text/calendar');
  showToast('Evento de calendario (.ics) descargado.');
}

/* ---------------- Modals: Consultations ---------------- */
function renderPendingAttachments() {
  const box = $('#consultPendingFiles');
  if (!pendingConsultAttachments.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = pendingConsultAttachments
    .map(
      (att, idx) => `
      <span class="pill">
        📎 ${escapeHtml(att.name)}
        <button type="button" class="btn btn-ghost btn-xs" data-remove-pending-att="${idx}">✕</button>
      </span>
    `
    )
    .join('');
}

function openConsultModal(consultId = null, forceCompleted = false) {
  const form = $('#consultForm');
  form.reset();
  const c = consultId ? state.consultations.find((item) => item.id === consultId) : null;

  $('#consultModalTitle').textContent = forceCompleted
    ? 'Completar consulta y anotar hallazgos'
    : c
    ? 'Editar consulta médica'
    : 'Registrar consulta médica';
  form.elements.id.value = c?.id || '';
  form.elements.dateISO.value = c?.dateISO || toLocalDateISO();
  form.elements.timeHM.value = c?.timeHM || '09:00';
  form.elements.status.value = forceCompleted ? 'completed' : c?.status || 'upcoming';
  form.elements.specialty.value = c?.specialty || 'Reumatología';
  form.elements.doctor.value = c?.doctor || state.profile.rheumatologist || '';
  form.elements.clinic.value = c?.clinic || '';
  form.elements.reason.value = c?.reason || '';
  form.elements.findings.value = c?.findings || '';
  form.elements.plan.value = c?.plan || '';
  form.elements.labs.value = c?.labs || '';
  form.elements.questions.value = c?.questions || '';
  form.elements.nextControlDate.value = c?.nextControlDate || '';

  pendingConsultAttachments = Array.isArray(c?.attachmentIds) ? [...c.attachmentIds] : [];
  renderPendingAttachments();
  $('#consultModal').showModal();
}

function renderDetailChecklist(c) {
  const items = Array.isArray(c.checklistQuestions) ? c.checklistQuestions : [];
  const listHtml = items.length
    ? items
        .map(
          (q) => `
          <div class="checklist-item">
            <label class="checklist-label">
              <input type="checkbox" ${q.done ? 'checked' : ''} data-toggle-q="${escapeHtml(c.id)}|${escapeHtml(q.id)}" />
              <span>${escapeHtml(q.text)}</span>
            </label>
            <button type="button" class="btn btn-ghost btn-xs" data-del-q="${escapeHtml(c.id)}|${escapeHtml(q.id)}" aria-label="Quitar pregunta">✕</button>
          </div>
        `
        )
        .join('')
    : '<p class="panel-sub">Agrega dudas puntuales para ir tachándolas durante tu consulta.</p>';

  return `
    <div class="detail-block">
      <h4>Checklist de preguntas para el médico</h4>
      <div class="checklist-box" id="detailChecklistBox">
        ${listHtml}
        <div class="checklist-add-row">
          <input type="text" id="detailNewQInput" class="input" placeholder="Ej. ¿Puedo hacer natación esta semana?" />
          <button type="button" class="btn btn-soft btn-sm" id="detailAddQBtn">+ Añadir</button>
        </div>
      </div>
    </div>
  `;
}

async function openConsultDetail(consultId) {
  const c = state.consultations.find((item) => item.id === consultId);
  if (!c) return;
  if (!Array.isArray(c.checklistQuestions)) c.checklistQuestions = [];

  $('#detailConsultTitle').textContent = `${c.specialty} · ${formatDateShortEs(c.dateISO)}`;

  const block = (label, val) =>
    val
      ? `<div class="detail-block"><h4>${label}</h4><div class="detail-box">${escapeHtml(val)}</div></div>`
      : '';

  let attachmentsHtml = '';
  if (c.attachmentIds?.length) {
    const loaded = await Promise.all(c.attachmentIds.map((meta) => getAttachmentFile(meta.id)));
    const valid = loaded.filter(Boolean);
    if (valid.length) {
      attachmentsHtml = `
        <div class="detail-block">
          <h4>Archivos adjuntos</h4>
          <div class="attachment-chips">
            ${valid
              .map(
                (file) => `
              <a class="btn btn-secondary btn-sm" href="${file.dataUrl}" download="${escapeHtml(file.name)}" target="_blank" rel="noopener">
                📎 ${escapeHtml(file.name)}
              </a>
            `
              )
              .join('')}
          </div>
        </div>
      `;
    }
  }

  $('#detailConsultBody').innerHTML = `
    <div class="med-tags" style="margin-bottom:14px;">
      <span class="pill ${c.status === 'upcoming' ? 'pill-warn' : 'pill-ok'}">${c.status === 'upcoming' ? `Próxima cita · ${escapeHtml(getCountdownLabel(c.dateISO))}` : 'Realizada'}</span>
      ${c.timeHM ? `<span class="pill">⏰ ${escapeHtml(formatTimeEs(c.timeHM))}</span>` : ''}
      ${c.doctor ? `<span class="pill">👨‍⚕️ ${escapeHtml(c.doctor)}</span>` : ''}
      ${c.clinic ? `<span class="pill">🏥 ${escapeHtml(c.clinic)}</span>` : ''}
    </div>
    ${block('Motivo / Síntomas reportados', c.reason)}
    ${block('Evaluación / Hallazgos del médico', c.findings)}
    ${block('Indicaciones / Cambios en medicación / Plan', c.plan)}
    ${block('Resultados de laboratorio / Exámenes', c.labs)}
    ${block('Notas previas de preguntas', c.questions)}
    ${renderDetailChecklist(c)}
    ${c.nextControlDate ? `<p class="panel-sub"><strong>Próximo control recomendado:</strong> ${escapeHtml(formatDateLongEs(c.nextControlDate))}</p>` : ''}
    ${attachmentsHtml}
  `;

  $('#detailAddQBtn').onclick = () => {
    const input = $('#detailNewQInput');
    const txt = (input.value || '').trim();
    if (!txt) return;
    c.checklistQuestions.push({ id: uid('q'), text: txt, done: false });
    persist();
    openConsultDetail(c.id);
    renderConsultsView();
  };
  $('#detailNewQInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      $('#detailAddQBtn').click();
    }
  });

  $('#detailConsultFooter').innerHTML = `
    <button class="btn btn-danger-ghost btn-sm" type="button" id="detailDeleteBtn">Eliminar</button>
    <button class="btn btn-ghost btn-sm" type="button" id="detailCopyBtn">Copiar resumen</button>
    <button class="btn btn-secondary btn-sm" type="button" id="detailIcsBtn">Calendario 3 alarmas (.ics)</button>
    <button class="btn btn-primary btn-sm" type="button" id="detailEditBtn">Editar</button>
  `;

  $('#detailEditBtn').onclick = () => {
    $('#consultDetailModal').close();
    openConsultModal(c.id);
  };
  $('#detailIcsBtn').onclick = () => {
    const checklistText = (c.checklistQuestions || []).map((q) => `- [${q.done ? 'x' : ' '}] ${q.text}`).join('\n');
    const ics = buildICS({
      title: `Cita ${c.specialty}${c.doctor ? ` - ${c.doctor}` : ''}`,
      description: [c.reason, c.questions ? `Preguntas: ${c.questions}` : '', checklistText].filter(Boolean).join('\n'),
      location: c.clinic || '',
      dateISO: c.dateISO,
      timeHM: c.timeHM || '09:00',
      durationMin: 45,
      alarms: ['-P1D', '-PT1H', '-PT10M']
    });
    downloadFile(`cita-${c.specialty.toLowerCase()}-${c.dateISO}.ics`, ics, 'text/calendar');
    showToast('Cita exportada con alarmas: 1 día, 1 hora y 10 min antes.');
  };
  $('#detailCopyBtn').onclick = async () => {
    const summary = [
      `Consulta ${c.specialty} — ${formatDateLongEs(c.dateISO)} ${c.timeHM ? formatTimeEs(c.timeHM) : ''}`,
      c.doctor ? `Médico: ${c.doctor}` : '',
      c.clinic ? `Lugar: ${c.clinic}` : '',
      c.reason ? `Motivo: ${c.reason}` : '',
      c.findings ? `Hallazgos: ${c.findings}` : '',
      c.plan ? `Indicaciones: ${c.plan}` : '',
      c.labs ? `Laboratorios: ${c.labs}` : ''
    ]
      .filter(Boolean)
      .join('\n');
    await navigator.clipboard?.writeText(summary);
    showToast('Resumen de consulta copiado.');
  };
  $('#detailDeleteBtn').onclick = async () => {
    if (!confirm('¿Eliminar esta consulta médica?')) return;
    if (c.attachmentIds?.length) {
      await Promise.all(c.attachmentIds.map((att) => deleteAttachmentFile(att.id).catch(() => {})));
    }
    state.consultations = state.consultations.filter((item) => item.id !== c.id);
    persist();
    $('#consultDetailModal').close();
    renderAll();
    showToast('Consulta eliminada.');
  };

  $('#consultDetailModal').showModal();
}

/* ---------------- Modals: Symptoms ---------------- */
function openSymptomModal() {
  const form = $('#symptomForm');
  form.reset();
  const todayISO = toLocalDateISO();
  const existing = state.symptomLogs.find((s) => s.dateISO === todayISO);

  form.elements.dateISO.value = todayISO;
  form.elements.pain.value = existing?.pain ?? 2;
  form.elements.fatigue.value = existing?.fatigue ?? 3;
  form.elements.stiffnessMin.value = existing?.stiffnessMin ?? 10;
  form.elements.note.value = existing?.note || '';

  $('#painValBadge').textContent = `${form.elements.pain.value} / 10`;
  $('#fatigueValBadge').textContent = `${form.elements.fatigue.value} / 10`;

  const selected = new Set(existing?.joints || []);
  $$('#jointChips input').forEach((chk) => {
    chk.checked = selected.has(chk.value);
  });
  $('#symptomModal').showModal();
}

/* ---------------- Demo / Backup ---------------- */
function loadDemoSeed() {
  const seed = buildDemoSeed();
  // Avoid duplicating demo items if already present
  state.medications = [...state.medications.filter((m) => !m.isDemo), ...seed.medications];
  state.consultations = [...state.consultations.filter((c) => !c.isDemo), ...seed.consultations];
  state.symptomLogs = [...state.symptomLogs.filter((s) => !s.isDemo), ...seed.symptomLogs];
  persist();
  renderAll();
  showToast('Ejemplos de prueba cargados.');
}

function clearDemoSeed() {
  state.medications = state.medications.filter((m) => !m.isDemo);
  state.consultations = state.consultations.filter((c) => !c.isDemo);
  state.symptomLogs = state.symptomLogs.filter((s) => !s.isDemo);
  persist();
  renderAll();
  showToast('Ejemplos de prueba eliminados.');
}

/* ---------------- Event Wiring ---------------- */
function initEvents() {
  // Navigation
  $$('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  // Close modal buttons
  $$('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => $(`#${btn.dataset.closeModal}`).close());
  });

  // Theme toggle
  $('#btnToggleTheme').addEventListener('click', () => {
    state.settings.darkMode = !state.settings.darkMode;
    persist();
    applyTheme();
  });

  // Quick action buttons
  $('#btnQuickAddMed').addEventListener('click', () => openMedModal());
  $('#btnNewMed').addEventListener('click', () => openMedModal());
  $('#btnAddMedFromToday').addEventListener('click', () => openMedModal());
  $('#btnQuickAddConsult').addEventListener('click', () => openConsultModal());
  $('#btnNewConsult').addEventListener('click', () => openConsultModal());
  $('#btnResetToToday').addEventListener('click', () => {
    selectedDateISO = toLocalDateISO();
    renderTodayView();
  });
  $('#btnLogSymptomToday').addEventListener('click', () => setView('symptoms'));
  $('#btnNewSymptom').addEventListener('click', openSymptomModal);

  // Interactive Body Map & Quick Check-in controls
  const toggleJointSelection = (joint) => {
    if (!joint) return;
    if (quickSelectedJoints.has(joint)) {
      quickSelectedJoints.delete(joint);
    } else {
      quickSelectedJoints.add(joint);
    }
    updateQuickCheckinVisuals();
  };
  $('#interactiveBodySvg').addEventListener('click', (e) => {
    const node = e.target.closest('.joint-node');
    if (node) toggleJointSelection(node.dataset.joint);
  });
  $('#interactiveBodySvg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const node = e.target.closest('.joint-node');
      if (node) {
        e.preventDefault();
        toggleJointSelection(node.dataset.joint);
      }
    }
  });
  $('#quickJointChips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quick-joint]');
    if (btn) toggleJointSelection(btn.dataset.quickJoint);
  });
  $('#btnClearBodyJoints').addEventListener('click', () => {
    quickSelectedJoints.clear();
    updateQuickCheckinVisuals();
  });
  $('#quickSymPain').addEventListener('input', updateQuickCheckinVisuals);
  $('#quickSymFatigue').addEventListener('input', updateQuickCheckinVisuals);
  $$('[data-stiff-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('#quickSymStiffness').value = btn.dataset.stiffPreset;
    });
  });
  $('#btnSaveQuickSymptom').addEventListener('click', () => {
    const todayISO = toLocalDateISO();
    const record = {
      id: uid('sym'),
      dateISO: todayISO,
      pain: Number($('#quickSymPain').value),
      fatigue: Number($('#quickSymFatigue').value),
      stiffnessMin: Number($('#quickSymStiffness').value) || 0,
      joints: [...quickSelectedJoints],
      note: String($('#quickSymNote').value || '').trim()
    };
    const existingIdx = state.symptomLogs.findIndex((s) => s.dateISO === todayISO);
    if (existingIdx >= 0) {
      state.symptomLogs[existingIdx] = { ...record, id: state.symptomLogs[existingIdx].id };
    } else {
      state.symptomLogs.push(record);
    }
    persist();
    renderAll();
    showToast('Chequeo de bienestar de hoy guardado.');
  });
  $('#btnNotifPill').addEventListener('click', () => {
    if ('Notification' in window && Notification.permission === 'default') {
      requestNotifPermission();
    } else {
      setView('profile');
    }
  });

  // Delegated clicks for dynamic lists
  document.body.addEventListener('click', (e) => {
    const dayBtn = e.target.closest('[data-select-day]');
    if (dayBtn) {
      selectedDateISO = dayBtn.dataset.selectDay;
      renderTodayView();
      return;
    }

    const dismissConsultBtn = e.target.closest('[data-dismiss-consult-alert]');
    if (dismissConsultBtn) {
      reminderRuntime.consultDismissed[dismissConsultBtn.dataset.dismissConsultAlert] = true;
      saveReminderRuntime();
      checkDueReminders();
      return;
    }

    const completeConsultBtn = e.target.closest('[data-complete-consult]');
    if (completeConsultBtn) {
      e.stopPropagation();
      openConsultModal(completeConsultBtn.dataset.completeConsult, true);
      return;
    }

    const toggleQ = e.target.closest('[data-toggle-q]');
    if (toggleQ) {
      const [cId, qId] = toggleQ.dataset.toggleQ.split('|');
      const consult = state.consultations.find((item) => item.id === cId);
      const qItem = consult?.checklistQuestions?.find((q) => q.id === qId);
      if (qItem) {
        qItem.done = toggleQ.checked;
        persist();
      }
      return;
    }

    const delQBtn = e.target.closest('[data-del-q]');
    if (delQBtn) {
      const [cId, qId] = delQBtn.dataset.delQ.split('|');
      const consult = state.consultations.find((item) => item.id === cId);
      if (consult?.checklistQuestions) {
        consult.checklistQuestions = consult.checklistQuestions.filter((q) => q.id !== qId);
        persist();
        openConsultDetail(cId);
        renderConsultsView();
      }
      return;
    }

    const takeBtn = e.target.closest('[data-take-dose]');
    if (takeBtn) {
      const [medId, dateISO, timeHM] = takeBtn.dataset.takeDose.split('|');
      toggleDoseStatus(medId, dateISO, timeHM, 'taken');
      return;
    }

    const skipBtn = e.target.closest('[data-skip-dose]');
    if (skipBtn) {
      const [medId, dateISO, timeHM] = skipBtn.dataset.skipDose.split('|');
      toggleDoseStatus(medId, dateISO, timeHM, 'skipped');
      return;
    }

    const snoozeBtn = e.target.closest('[data-snooze-dose]');
    if (snoozeBtn) {
      const [medId, dateISO, timeHM] = snoozeBtn.dataset.snoozeDose.split('|');
      snoozeDose(medId, dateISO, timeHM, 10);
      return;
    }

    const openRemBtn = e.target.closest('[data-open-reminder-modal]');
    if (openRemBtn) {
      const [medId, dateISO, timeHM] = openRemBtn.dataset.openReminderModal.split('|');
      const med = state.medications.find((m) => m.id === medId);
      if (med) {
        openReminderAlertModal({ med, dateISO, timeHM }, Number(state.settings.repeatIntervalMin ?? 5));
      }
      return;
    }

    const prnBtn = e.target.closest('[data-prn-take]');
    if (prnBtn) {
      logPrnDose(prnBtn.dataset.prnTake);
      return;
    }

    const editMedBtn = e.target.closest('[data-edit-med]');
    if (editMedBtn) {
      openMedModal(editMedBtn.dataset.editMed);
      return;
    }

    const toggleMedBtn = e.target.closest('[data-toggle-med]');
    if (toggleMedBtn) {
      const med = state.medications.find((m) => m.id === toggleMedBtn.dataset.toggleMed);
      if (med) {
        med.active = med.active === false;
        persist();
        renderAll();
        showToast(med.active ? `${med.name} reanudado.` : `${med.name} pausado.`);
      }
      return;
    }

    const icsMedBtn = e.target.closest('[data-ics-med]');
    if (icsMedBtn) {
      exportMedICS(icsMedBtn.dataset.icsMed);
      return;
    }

    const delMedBtn = e.target.closest('[data-del-med]');
    if (delMedBtn) {
      const id = delMedBtn.dataset.delMed;
      if (!confirm('¿Eliminar este medicamento de tu lista?')) return;
      state.medications = state.medications.filter((m) => m.id !== id);
      persist();
      renderAll();
      showToast('Medicamento eliminado.');
      return;
    }

    const stockBtn = e.target.closest('[data-stock-delta]');
    if (stockBtn) {
      const [id, deltaStr] = stockBtn.dataset.stockDelta.split('|');
      const med = state.medications.find((m) => m.id === id);
      if (med && typeof med.stock === 'number') {
        med.stock = Math.max(0, med.stock + Number(deltaStr));
        persist();
        renderMedsView();
      }
      return;
    }

    const consultCard = e.target.closest('[data-open-consult]');
    if (consultCard) {
      openConsultDetail(consultCard.dataset.openConsult);
      return;
    }

    const delSymBtn = e.target.closest('[data-del-symptom]');
    if (delSymBtn) {
      const id = delSymBtn.dataset.delSymptom;
      state.symptomLogs = state.symptomLogs.filter((s) => s.id !== id);
      persist();
      renderAll();
      showToast('Registro eliminado.');
      return;
    }

    const removePendingAtt = e.target.closest('[data-remove-pending-att]');
    if (removePendingAtt) {
      const idx = Number(removePendingAtt.dataset.removePendingAtt);
      pendingConsultAttachments.splice(idx, 1);
      renderPendingAttachments();
    }
  });

  // Med filters & form
  $$('[data-med-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      medFilter = btn.dataset.medFilter;
      $$('[data-med-filter]').forEach((b) => b.classList.toggle('active', b === btn));
      renderMedsView();
    });
  });
  $('#medSearchInput').addEventListener('input', renderMedsView);
  $('#medFrequencySelect').addEventListener('change', syncMedFrequencyVisibility);
  $('#btnAddTimeSlot').addEventListener('click', () => {
    const current = $$('.med-time-input').map((i) => i.value || '08:00');
    renderMedTimeSlots([...current, '20:00']);
  });

  $('#medForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const frequency = fd.get('frequency');
    const daysOfWeek = $$('#medWeekdayPills input:checked').map((i) => Number(i.value));

    if (frequency === 'weekly' && !daysOfWeek.length) {
      showToast('Selecciona al menos un día de la semana.');
      return;
    }

    const times = frequency === 'prn'
      ? []
      : $$('.med-time-input')
          .map((i) => i.value)
          .filter(Boolean)
          .sort();

    const stockRaw = String(fd.get('stock') || '').trim();
    const existingId = fd.get('id');
    const existing = existingId ? state.medications.find((m) => m.id === existingId) : null;

    const medData = {
      id: existingId || uid('med'),
      name: String(fd.get('name')).trim(),
      dose: String(fd.get('dose')).trim(),
      form: fd.get('form'),
      frequency,
      daysOfWeek,
      intervalDays: Number(fd.get('intervalDays')) || 14,
      startDate: fd.get('startDate') || toLocalDateISO(),
      times: times.length ? times : frequency === 'prn' ? [] : ['08:00'],
      color: fd.get('color') || '#5b46f6',
      stock: stockRaw === '' ? null : Math.max(0, Number(stockRaw)),
      lowStockAlert: Number(fd.get('lowStockAlert')) || 4,
      instructions: String(fd.get('instructions') || '').trim(),
      active: existing ? existing.active !== false : true
    };

    if (existing) {
      const idx = state.medications.findIndex((m) => m.id === existingId);
      state.medications[idx] = medData;
      showToast('Medicamento actualizado.');
    } else {
      state.medications.push(medData);
      showToast('Medicamento agregado.');
    }

    persist();
    $('#medModal').close();
    renderAll();
  });

  // Consult filters & form
  $$('[data-consult-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      consultFilter = btn.dataset.consultFilter;
      $$('[data-consult-filter]').forEach((b) => b.classList.toggle('active', b === btn));
      renderConsultsView();
    });
  });
  $('#consultSpecialtyFilter').addEventListener('change', renderConsultsView);
  $('#consultSearchInput').addEventListener('input', renderConsultsView);

  $('#consultFileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      if (file.size > 6 * 1024 * 1024) {
        showToast(`"${file.name}" supera 6 MB.`);
        continue;
      }
      try {
        const meta = await saveAttachmentFile(file);
        pendingConsultAttachments.push(meta);
      } catch {
        showToast(`No se pudo adjuntar "${file.name}".`);
      }
    }
    e.target.value = '';
    renderPendingAttachments();
  });

  $('#consultForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const existingId = fd.get('id');
    const existing = existingId ? state.consultations.find((c) => c.id === existingId) : null;
    const consultId = existingId || uid('con');

    const consultData = {
      id: consultId,
      dateISO: fd.get('dateISO'),
      timeHM: fd.get('timeHM') || '09:00',
      status: fd.get('status'),
      specialty: fd.get('specialty'),
      doctor: String(fd.get('doctor') || '').trim(),
      clinic: String(fd.get('clinic') || '').trim(),
      reason: String(fd.get('reason') || '').trim(),
      findings: String(fd.get('findings') || '').trim(),
      plan: String(fd.get('plan') || '').trim(),
      labs: String(fd.get('labs') || '').trim(),
      questions: String(fd.get('questions') || '').trim(),
      checklistQuestions: existing?.checklistQuestions || [],
      nextControlDate: fd.get('nextControlDate') || '',
      attachmentIds: [...pendingConsultAttachments]
    };

    // Reset milestone notifications if upcoming appointment date/time was edited
    ['1d', '1h', '10m'].forEach((m) => {
      delete reminderRuntime.consultNotified[`${consultId}|${m}`];
      delete reminderRuntime.consultDismissed[`${consultId}|${m}`];
    });
    saveReminderRuntime();

    if (existing) {
      const idx = state.consultations.findIndex((c) => c.id === existingId);
      if (idx >= 0) state.consultations[idx] = consultData;
      showToast(
        consultData.status === 'upcoming'
          ? 'Cita actualizada (avisos: 1 día, 1 h y 10 min antes).'
          : 'Consulta actualizada.'
      );
    } else {
      state.consultations.push(consultData);
      showToast(
        consultData.status === 'upcoming'
          ? 'Próxima cita guardada. Te avisaré 1 día antes, 1 hora antes y 10 min antes.'
          : 'Consulta registrada.'
      );
    }

    persist();
    $('#consultModal').close();
    renderAll();
  });

  // Symptoms form
  const symForm = $('#symptomForm');
  symForm.elements.pain.addEventListener('input', (e) => {
    $('#painValBadge').textContent = `${e.target.value} / 10`;
  });
  symForm.elements.fatigue.addEventListener('input', (e) => {
    $('#fatigueValBadge').textContent = `${e.target.value} / 10`;
  });

  symForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const dateISO = fd.get('dateISO');
    const joints = $$('#jointChips input:checked').map((i) => i.value);

    const record = {
      id: uid('sym'),
      dateISO,
      pain: Number(fd.get('pain')),
      fatigue: Number(fd.get('fatigue')),
      stiffnessMin: Number(fd.get('stiffnessMin')) || 0,
      joints,
      note: String(fd.get('note') || '').trim()
    };

    const existingIdx = state.symptomLogs.findIndex((s) => s.dateISO === dateISO);
    if (existingIdx >= 0) {
      state.symptomLogs[existingIdx] = { ...record, id: state.symptomLogs[existingIdx].id };
    } else {
      state.symptomLogs.push(record);
    }

    quickCheckinSyncedDate = '';
    persist();
    $('#symptomModal').close();
    renderAll();
    showToast('Bienestar del día guardado.');
  });

  // Profile form & actions
  $('#profileForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    state.profile = {
      ...state.profile,
      fullName: String(fd.get('fullName')).trim(),
      age: Number(fd.get('age')) || 21,
      heightCm: Number(fd.get('heightCm')) || 171,
      weightKg: Number(fd.get('weightKg')) || 62,
      diagnosis: String(fd.get('diagnosis') || '').trim(),
      bloodType: fd.get('bloodType'),
      insurance: String(fd.get('insurance') || '').trim(),
      allergies: String(fd.get('allergies') || '').trim(),
      rheumatologist: String(fd.get('rheumatologist') || '').trim(),
      emergencyContact: String(fd.get('emergencyContact') || '').trim(),
      notes: String(fd.get('notes') || '').trim()
    };
    persist();
    renderAll();
    showToast('Perfil clínico actualizado.');
  });

  $('#btnPrintCard').addEventListener('click', () => window.print());
  $('#btnCopyCard').addEventListener('click', async () => {
    const p = state.profile;
    const bmi = calcBMI(p.weightKg, p.heightCm);
    const meds = state.medications
      .filter((m) => m.active !== false)
      .map((m) => `- ${m.name} (${m.dose}) · ${formatFrequencyEs(m)}`)
      .join('\n');
    const text = [
      `FICHA MÉDICA PERSONAL`,
      `Nombre: ${p.fullName}`,
      `Edad: ${p.age} años | Estatura: ${p.heightCm} cm | Peso: ${p.weightKg} kg (IMC ${bmi.value})`,
      `Diagnóstico: ${p.diagnosis}`,
      p.bloodType ? `Grupo sanguíneo: ${p.bloodType}` : '',
      p.allergies ? `Alergias: ${p.allergies}` : '',
      p.insurance ? `EPS/Seguro: ${p.insurance}` : '',
      p.rheumatologist ? `Reumatólogo: ${p.rheumatologist}` : '',
      p.emergencyContact ? `Contacto emergencia: ${p.emergencyContact}` : '',
      `\nMedicación activa:\n${meds || 'Sin medicamentos registrados'}`
    ]
      .filter(Boolean)
      .join('\n');

    await navigator.clipboard?.writeText(text);
    showToast('Ficha médica copiada al portapapeles.');
  });

  // Settings & Backup
  $('#btnEnableNotifications').addEventListener('click', requestNotifPermission);
  $('#btnTestNotification').addEventListener('click', () => {
    if (state.settings.soundEnabled) playChime();
    sendSystemNotification('Prueba de recordatorio', 'Así se verán tus alertas de medicamentos en Mi Salud.');
    showToast('Prueba ejecutada.');
  });
  $('#chkSoundEnabled').addEventListener('change', (e) => {
    state.settings.soundEnabled = e.target.checked;
    persist();
  });
  $('#selectRepeatInterval').addEventListener('change', (e) => {
    state.settings.repeatIntervalMin = Number(e.target.value);
    persist();
    checkDueReminders();
    showToast(
      state.settings.repeatIntervalMin > 0
        ? `Recordará cada ${state.settings.repeatIntervalMin} min hasta que marques la toma.`
        : 'Repetición automática desactivada.'
    );
  });
  $('#btnReminderDismissKeepGoing').addEventListener('click', () => {
    $('#reminderAlertModal').close();
    const repeatMin = Number(state.settings.repeatIntervalMin ?? 5);
    if (repeatMin > 0) {
      showToast(`Aviso cerrado, pero seguiré recordándote cada ${repeatMin} min hasta que la tomes.`);
    }
  });

  $('#btnExportJson').addEventListener('click', () => {
    const payload = JSON.stringify(state, null, 2);
    downloadFile(`respaldo-mi-salud-arj-${toLocalDateISO()}.json`, payload, 'application/json');
    showToast('Respaldo JSON descargado.');
  });

  $('#inputImportJson').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!imported || !imported.profile || !Array.isArray(imported.medications)) {
        throw new Error('Formato inválido');
      }
      state = imported;
      persist();
      applyTheme();
      renderAll();
      showToast('Respaldo restaurado correctamente.');
    } catch {
      showToast('El archivo seleccionado no es un respaldo válido.');
    } finally {
      e.target.value = '';
    }
  });

  $('#btnLoadDemo').addEventListener('click', loadDemoSeed);
  $('#btnClearDemo').addEventListener('click', clearDemoSeed);

  // PWA install buttons
  const triggerInstall = async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $('#btnInstallPwa').hidden = true;
    $('#btnInstallPwaSidebar').hidden = true;
  };
  $('#btnInstallPwa').addEventListener('click', triggerInstall);
  $('#btnInstallPwaSidebar').addEventListener('click', triggerInstall);
}

/* ---------------- PWA Bootstrap ---------------- */
function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.type !== 'NOTIFICATION_ACTION') return;
      const { medId, dateISO, timeHM } = msg.data || {};
      if (!medId || !dateISO || !timeHM) return;
      if (msg.action === 'take') {
        const alreadyLogged = state.doseLogs.some(
          (l) => l.medId === medId && l.dateISO === dateISO && l.scheduledTime === timeHM
        );
        if (!alreadyLogged) toggleDoseStatus(medId, dateISO, timeHM, 'taken');
      } else if (msg.action === 'snooze') {
        snoozeDose(medId, dateISO, timeHM, 10);
      }
    });
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    $('#btnInstallPwa').hidden = false;
    $('#btnInstallPwaSidebar').hidden = false;
  });
}

/* ---------------- Boot ---------------- */
applyTheme();
initEvents();
initPWA();
renderAll();
setInterval(checkDueReminders, 20000);
