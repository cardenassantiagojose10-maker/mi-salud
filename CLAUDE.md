# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Mi Salud" — a single-user PWA (in Spanish) for tracking medication reminders, symptoms, and medical consultations. Originally built for Juvenile Rheumatoid Arthritis and later de-personalized for general use (chronic treatments and autoimmune conditions); the joint-map wellness view is the one remaining rheumatology-flavored feature. It is a static, no-build, vanilla JS app: plain HTML/CSS/JS loaded directly by the browser, with no package manager, bundler, framework, or test suite.

No profile data is hardcoded: `getDefaultProfile()` returns empty fields and the user fills them in. Only `fullName` is a required form field. Keep it that way — the repo is public, and the diagnosis shown on the dashboard and medical card must come from `state.profile.diagnosis`, never a default.

## Running it

There is no build step and no `package.json`. To develop:

- Serve the folder with any static file server from the project root and open `index.html` (a real HTTP origin is required — `file://` breaks ES module imports, the Service Worker, and IndexedDB). E.g. `npx serve .` or VS Code's Live Server.
- Since `js/app.js` is loaded as `type="module"`, changes to `js/*.js` take effect on a browser reload — no compilation needed.
- There is no linter, formatter, or automated test suite configured. Verify changes manually in the browser.
- The Service Worker (`sw.js`) caches assets under `CACHE_NAME`. If you edit any cached file (`index.html`, `styles.css`, `js/*.js`, etc.), bump `CACHE_NAME` (e.g. `mi-salud-v6`) so installed/offline clients pick up the update, and keep the `ASSETS` list in sync with any new/renamed files.

## Architecture

Everything runs client-side, in-browser, with all data stored locally on the user's device (nothing is sent to a server):

- **`index.html`** — the entire UI shell: all five views (`#view-today`, `#view-meds`, `#view-consults`, `#view-symptoms`, `#view-profile`) and all `<dialog>` modals (med, consult, consult-detail, symptom, reminder-alert) live in this one file as hidden/shown sections, not separate pages. Navigation is client-side only (toggling `.view.active` / `.nav-item.active`), driven by `data-view` attributes on nav buttons.
- **`js/app.js`** — the whole application logic in one module: view rendering (`render*View` functions), event wiring (`initEvents`), the in-memory `state` object (mutated directly, then persisted), dose/reminder scheduling and due-check polling (`checkDueReminders`, run every 20s via `setInterval`), Notification API integration, PWA install prompt handling, and the boot sequence at the bottom of the file (`applyTheme(); initEvents(); initPWA(); renderAll();`). There is no component framework or virtual DOM — views are rendered by building HTML strings/innerHTML and re-attaching event listeners on each render.
- **`js/storage.js`** — the persistence layer and the shape of the data model. `getInitialState()` defines the canonical state shape (`profile`, `settings`, `medications`, `doseLogs`, `consultations`, `symptomLogs`); `loadState()`/`saveState()` serialize the whole state object to/from a single `localStorage` key (`mi_salud_arj_state_v1`), merging over defaults for forward compatibility when new fields are added. Binary consultation attachments (images/PDFs) are stored separately in IndexedDB (`mi_salud_arj_db` / `attachments` store) as data URLs, keyed by id, because they're too large for `localStorage`. `buildDemoSeed()` provides sample data for the "load demo" feature.
- **`js/utils.js`** — pure, side-effect-free helpers shared across the app: date/time formatting in `es-CO` locale, medication scheduling logic (`isMedScheduledForDate`, handles `daily`/`weekly`/`interval`/`prn` frequencies), `.ics` calendar file generation for exporting reminders/consultations, HTML escaping, and misc formatting (BMI, countdowns, chime sound via Web Audio API).
- **`styles.css`** — all styling, including light/dark theme (`settings.darkMode` toggles a class/attribute consumed here) and responsive/mobile-bottom-nav layout.
- **`sw.js`** — network-first Service Worker for offline support and installability; also relays notification-click actions (`take`/`snooze`) back to the page via `postMessage`.
- **`manifest.webmanifest`** — PWA manifest (installable app metadata, icons in `icons/`).

### Data flow

State lives in a single module-level `state` object in `js/app.js`, loaded once at boot from `storage.js`. Any mutation (adding a med, logging a dose, saving a consultation) directly mutates `state`, calls `persist()` to write it back to `localStorage`, then re-renders the affected view(s) (or calls `renderAll()`). There is no event bus, store library, or reactivity system — rendering is pull-based and explicit.

### Key domain concepts

- **Medications** have a `frequency` of `daily`, `weekly` (via `daysOfWeek`), `interval` (via `intervalDays`), or `prn` (as-needed, logged manually via `logPrnDose`), each with one or more `times` per day.
- **Dose logs** record each taken/skipped dose per medication per scheduled time, used to compute adherence streaks and today's schedule.
- **Reminders** are checked on a 20s poll (`checkDueReminders`) against the current time and the day's scheduled doses/consultations, triggering in-app modals, sound (`playChime`), and/or OS notifications (`sendSystemNotification`, requires permission via `requestNotifPermission`).
- **Consultations** can be `completed` or `upcoming`, support file attachments stored in IndexedDB, and can export `.ics` calendar reminders. Note that despite the name, `consultation.attachmentIds` holds metadata *objects* (`{id, name, type, size}`), not bare id strings — the actual file lives in IndexedDB under `.id`.
- **Specialties** (`profile.specialties`) split the profile by medical area: each entry is `{id, name, doctor, phone, clinic, diagnosis, notes}`. They drive the specialty dropdowns (via `buildSpecialtyOptions`, which unions the `SPECIALTIES_ES` catalog with the user's own entries and any specialty already used in a consultation), prefill the doctor/clinic when creating a consultation, and let the medical card be filtered down to one area before printing or copying (`cardSpecialtyFilter`). Specialties are referenced from consultations **by name**, not by id, so deleting a specialty intentionally leaves its consultations untouched.

- **Heart rate sessions** (`state.heartRateSessions`) connect to a BLE chest strap (e.g. Garmin HRM) via the Web Bluetooth API — standard `heart_rate` GATT service, `heart_rate_measurement` characteristic, parsed per the Bluetooth SIG spec (flags bit 0 selects 8-bit vs 16-bit bpm). This only works in Chromium-based browsers on Android/desktop; Safari/iOS has no Web Bluetooth, so the UI feature-detects (`isBluetoothSupported()`) and shows a fallback message instead. Recorded samples are downsampled to 300 points on save (`downsampleHrSamples`) so a long recording doesn't bloat `localStorage`. There is no server-side sync with Garmin Connect — this is a direct device-to-browser connection, consistent with the app's local-only, no-backend design.

### A recurring CSS trap: `[hidden]` losing the cascade

Several `.btn`-class elements are toggled via the `hidden` attribute from JS (`el.hidden = true/false`) rather than a CSS class. Any element styled with an explicit `display` (e.g. `.btn { display: inline-flex }`) at the same specificity as the `[hidden]` UA rule can end up visually shown despite `hidden` being set, because the author stylesheet is applied after the UA stylesheet. This was hit (and fixed once globally, not per-element) with `[hidden] { display: none !important; }` near the top of `styles.css`. If a hidden element still renders, check for a competing `display` rule before assuming the JS toggle is broken.

### Migrations

`loadState()` runs `migrateProfile()` on every boot and writes back when it changed something. The legacy `profile.rheumatologist` / `rheumatologistPhone` fields are folded into a `Reumatología` specialty and then deleted. When you change the profile shape, extend `migrateProfile` rather than bumping a version number — existing users' data lives only in their browser, so a silent drop is unrecoverable.
