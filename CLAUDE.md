# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Mi Salud ARJ" — a personal, single-user PWA (in Spanish) for tracking medication reminders, symptoms, and medical consultations for Juvenile Rheumatoid Arthritis (ARJ). It is a static, no-build, vanilla JS app: plain HTML/CSS/JS loaded directly by the browser, with no package manager, bundler, framework, or test suite.

## Running it

There is no build step and no `package.json`. To develop:

- Serve the folder with any static file server from the project root and open `index.html` (a real HTTP origin is required — `file://` breaks ES module imports, the Service Worker, and IndexedDB). E.g. `npx serve .` or VS Code's Live Server.
- Since `js/app.js` is loaded as `type="module"`, changes to `js/*.js` take effect on a browser reload — no compilation needed.
- There is no linter, formatter, or automated test suite configured. Verify changes manually in the browser.
- The Service Worker (`sw.js`) caches assets under `CACHE_NAME`. If you edit any cached file (`index.html`, `styles.css`, `js/*.js`, etc.), bump `CACHE_NAME` (e.g. `mi-salud-arj-v4`) so installed/offline clients pick up the update, and keep the `ASSETS` list in sync with any new/renamed files.

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
- **Consultations** can be `completed` or `upcoming`, support file attachments stored in IndexedDB, and can export `.ics` calendar reminders.
