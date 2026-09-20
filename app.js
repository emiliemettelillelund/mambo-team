/* Mambo Team Hub — reads live from the "Horario Mambo" Google Sheet via its public CSV export. */

const SHEET_ID = '17eJ5HyWVERHkCdWHL1Kkca0Pqoa1fZaYiXK2wSe9vEY';
const GID_HORARIO = '1406105618';
const GID_PROPINAS = '1341092839';
const REFRESH_MS = 60000;

const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const DAY_NAMES_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

const state = {
  horarioBlocks: [],
  currentWeekIdx: 0,
  propinas: null,
};

// ---------------------------------------------------------------------------
// CSV export fetch. The gviz JSON endpoint silently corrupts or drops cell
// values on this sheet once a query spans enough rows (Google's column
// type-guessing breaks when a column mixes times with text like "BAJA
// MEDICA" or "Apoyo opcional") — the CSV export doesn't type-guess at all,
// so we use that instead, in row-ranged chunks small enough to stay under
// the same corruption threshold (empirically safe up to ~300 rows/request).
// ---------------------------------------------------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // ignore; row break happens on \n
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function fetchCsvRange(gid, a1Range) {
  const url =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export` +
    `?format=csv&gid=${gid}&range=${a1Range}&_=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('No se pudo conectar con Google Sheets');
  const text = await res.text();
  return parseCSV(text);
}

async function fetchCsvChunked(gid, colRange, chunkRows, maxRow) {
  const chunks = [];
  for (let start = 1; start <= maxRow; start += chunkRows) {
    const end = start + chunkRows - 1;
    chunks.push(fetchCsvRange(gid, `A${start}:${colRange}${end}`));
  }
  const results = await Promise.all(chunks);
  return results.flat();
}

// ---------------------------------------------------------------------------
// Horario Semanal parsing
// ---------------------------------------------------------------------------
const DAY_START_COLS = [2, 4, 6, 8, 10, 12, 14]; // C E G I K M O
const DAY_END_COLS = [3, 5, 7, 9, 11, 13, 15]; // D F H J L N P
const SKIP_LABELS = new Set(['PAX POR DÍA:', 'HORARIO APERTURA/CIERRE CLIENTE']);

function cellText(row, idx) {
  if (!row) return null;
  const v = row[idx];
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

function normTime(t) {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t;
  return m[1].padStart(2, '0') + ':' + m[2];
}

function formatShift(start, end) {
  if (!start && !end) return '';
  if (start && start.toUpperCase() === 'OFF') return 'OFF';
  if (start && end) return `${normTime(start)}–${normTime(end)}`;
  if (start) return start;
  return '';
}

function parseHorario(rows) {
  const blocks = [];
  let lastMonth = null;
  let yearOffset = 0;

  for (let i = 0; i < rows.length; i++) {
    if (cellText(rows[i], 1) !== 'TRABAJADOR') continue;

    const dateRow = rows[i + 1];
    if (!dateRow) continue;

    const parsedDates = DAY_START_COLS.map((sc) => {
      const raw = cellText(dateRow, sc);
      const m = raw ? raw.match(/(\d{1,2})\/(\d{1,2})/) : null;
      return m ? { day: parseInt(m[1], 10), month: parseInt(m[2], 10) } : null;
    });

    const anchorIdx = parsedDates.findIndex((d) => d);
    if (anchorIdx === -1) continue;

    const anchorMonth = parsedDates[anchorIdx].month;
    if (lastMonth !== null && anchorMonth < lastMonth - 6) yearOffset++;
    lastMonth = anchorMonth;
    const year = 2026 + yearOffset;

    const anchorDate = new Date(year, parsedDates[anchorIdx].month - 1, parsedDates[anchorIdx].day);
    const weekDates = parsedDates.map((_, idx) => {
      const dt = new Date(anchorDate);
      dt.setDate(anchorDate.getDate() + (idx - anchorIdx));
      return dt;
    });

    const employees = [];
    let lastEmp = null;
    let skipContinuation = false;

    let j = i + 2;
    for (let guard = 0; j < rows.length && guard < 80; j++, guard++) {
      const nm = cellText(rows[j], 1);
      if (nm === 'TRABAJADOR') break;

      if (nm && SKIP_LABELS.has(nm)) {
        skipContinuation = true;
        lastEmp = null;
        continue;
      }

      if (nm) {
        const days = DAY_START_COLS.map((sc, di) =>
          formatShift(cellText(rows[j], sc), cellText(rows[j], DAY_END_COLS[di]))
        );
        const horasRaw = cellText(rows[j], 16);
        const contratoRaw = cellText(rows[j], 18);
        lastEmp = {
          name: nm,
          days,
          horas: horasRaw ? parseFloat(horasRaw.replace(',', '.')) : null,
          contrato: contratoRaw ? parseFloat(contratoRaw.replace(',', '.')) : null,
        };
        employees.push(lastEmp);
        skipContinuation = false;
        continue;
      }

      const hasData = DAY_START_COLS.some((sc, di) => cellText(rows[j], sc) || cellText(rows[j], DAY_END_COLS[di]));
      if (!hasData) {
        skipContinuation = false;
        continue;
      }
      if (skipContinuation) continue;

      if (lastEmp) {
        DAY_START_COLS.forEach((sc, di) => {
          const extra = formatShift(cellText(rows[j], sc), cellText(rows[j], DAY_END_COLS[di]));
          if (extra) {
            lastEmp.days[di] = lastEmp.days[di] ? lastEmp.days[di] + ' · ' + extra : extra;
          }
        });
      }
    }

    if (employees.length) blocks.push({ weekDates, employees });
  }

  return blocks;
}

function shiftClass(text) {
  if (!text) return 'shift-empty';
  if (text === 'OFF') return 'shift-off';
  if (/apoyo|refuerzo/i.test(text)) return 'shift-refuerzo';
  if (/baja|ausencia/i.test(text)) return 'shift-ausencia';
  const m = text.match(/^(\d{1,2}):(\d{2})/);
  if (m) {
    const h = parseInt(m[1], 10);
    if (h < 5) return 'shift-noche-camarero';
    if (h < 11) return 'shift-desayuno';
    if (h < 17) return 'shift-turno-dia';
    if (h < 21) return 'shift-noche-barra';
    return 'shift-noche-camarero';
  }
  return 'shift-ausencia';
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function fmtDayMonth(d) {
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
}

function findWeekIndexForDate(blocks, date) {
  let bestIdx = -1;
  let bestDiff = Infinity;
  blocks.forEach((b, idx) => {
    const start = b.weekDates[0];
    const end = b.weekDates[6];
    if (date >= startOfDay(start) && date <= endOfDay(end)) {
      bestIdx = idx;
      bestDiff = 0;
      return;
    }
    const diff = Math.min(Math.abs(date - start), Math.abs(date - end));
    if (bestDiff !== 0 && diff < bestDiff) {
      bestDiff = diff;
      bestIdx = idx;
    }
  });
  return bestIdx === -1 ? 0 : bestIdx;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function renderHorario() {
  const blocks = state.horarioBlocks;
  const wrap = document.getElementById('horarioContent');
  if (!blocks.length) return;

  const block = blocks[state.currentWeekIdx];
  const today = new Date();
  const todayIdx = block.weekDates.findIndex((d) => sameDay(d, today));

  document.getElementById('weekLabel').textContent =
    `${fmtDayMonth(block.weekDates[0])} – ${fmtDayMonth(block.weekDates[6])}`;
  document.getElementById('weekSub').textContent =
    todayIdx !== -1 ? 'Semana actual' : block.weekDates[0].getFullYear() + '';

  document.getElementById('prevWeek').disabled = state.currentWeekIdx === 0;
  document.getElementById('nextWeek').disabled = state.currentWeekIdx === blocks.length - 1;

  // Desktop table
  const table = document.getElementById('scheduleTable');
  let thead = '<thead><tr><th>Equipo</th>';
  DAY_NAMES.forEach((dn, i) => {
    const isToday = i === todayIdx;
    thead += `<th class="${isToday ? 'today-col' : ''}">${dn}<span class="day-date">${fmtDayMonth(block.weekDates[i])}</span></th>`;
  });
  thead += '<th>Horas</th></tr></thead>';

  let tbody = '<tbody>';
  block.employees.forEach((emp) => {
    tbody += `<tr><td class="name-cell">${escapeHtml(emp.name)}</td>`;
    emp.days.forEach((day, i) => {
      const isToday = i === todayIdx;
      const cls = shiftClass(day);
      const content = day ? `<span class="shift-pill ${cls}">${escapeHtml(day)}</span>` : '<span class="shift-empty">—</span>';
      tbody += `<td class="${isToday ? 'today-col' : ''}">${content}</td>`;
    });
    const hoursText = emp.horas != null ? `${emp.horas}h${emp.contrato != null ? ` / ${emp.contrato}h` : ''}` : '—';
    tbody += `<td class="hours-cell">${hoursText}</td></tr>`;
  });
  tbody += '</tbody>';
  table.innerHTML = thead + tbody;

  wrap.hidden = false;
  document.getElementById('horarioLoading').hidden = true;
  document.getElementById('horarioError').hidden = true;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Propinas parsing
// ---------------------------------------------------------------------------
function parseEuro(str) {
  if (str == null) return 0;
  const cleaned = String(str).replace(/[^\d,.-]/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function parsePropinas(rows) {
  const nameRow = rows[3] || [];

  const employees = [];
  for (let idx = 2; idx < nameRow.length; idx += 3) {
    const name = cellText(nameRow, idx);
    if (!name) continue;
    employees.push({ name, horasIdx: idx, propinasIdx: idx + 1, estadoIdx: idx + 2 });
  }

  const weeks = [];
  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];
    const weekLabel = cellText(row, 0);
    if (!weekLabel) continue;
    const wm = weekLabel.match(/(\d+)/);
    const weekNum = wm ? parseInt(wm[1], 10) : null;
    const total = parseEuro(cellText(row, 1));

    const perEmployee = {};
    let anyData = false;
    employees.forEach((emp) => {
      const horas = cellText(row, emp.horasIdx);
      const propinas = parseEuro(cellText(row, emp.propinasIdx));
      const estado = cellText(row, emp.estadoIdx);
      if (propinas > 0 || toNum(horas) > 0) anyData = true;
      perEmployee[emp.name] = { horas, propinas, estado };
    });

    weeks.push({ weekNum, weekLabel, total, perEmployee, anyData });
  }

  return { employees: employees.map((e) => e.name), weeks };
}

function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function fmtEuro(n) {
  return (n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function toNum(x) {
  if (x == null) return 0;
  if (typeof x === 'number') return x;
  const n = parseFloat(String(x).replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function renderPropinas() {
  const data = state.propinas;
  if (!data) return;

  const currentWeekNum = isoWeekNumber(new Date());
  const weeksWithData = data.weeks.filter((w) => w.anyData || w.weekNum === currentWeekNum);

  // Wide table, laid out like the sheet: Semana | Total | [emp: Horas|Propinas|Estado]...
  const table = document.getElementById('propinasTable');

  let thead = '<thead><tr>';
  thead += '<th class="corner" rowspan="2">Semana</th>';
  thead += '<th rowspan="2">Total</th>';
  data.employees.forEach((emp) => {
    thead += `<th class="emp-group" colspan="3">${escapeHtml(emp)}</th>`;
  });
  thead += '</tr><tr>';
  data.employees.forEach(() => {
    thead += '<th>Horas</th><th>Propinas</th><th>Estado</th>';
  });
  thead += '</tr></thead>';

  const rows = weeksWithData
    .slice()
    .reverse()
    .map((w) => {
      const isCurrent = w.weekNum === currentWeekNum;
      let row = `<tr class="${isCurrent ? 'current-week' : ''}">`;
      row += `<td class="week-cell">${escapeHtml(w.weekLabel)}</td>`;
      row += `<td class="total-cell">${fmtEuro(w.total)}</td>`;
      data.employees.forEach((emp) => {
        const rec = w.perEmployee[emp] || {};
        const isPending = /no entregado/i.test(rec.estado || '');
        const badge = rec.estado
          ? isPending
            ? '<span class="status-badge pending"><span class="dot"></span>No entregado</span>'
            : '<span class="status-badge ok"><span class="dot"></span>Ya entregado</span>'
          : '<span class="status-badge pending"><span class="dot"></span>—</span>';
        row += `<td>${rec.horas != null ? rec.horas : '—'}</td>`;
        row += `<td class="num">${fmtEuro(rec.propinas)}</td>`;
        row += `<td>${badge}</td>`;
      });
      row += '</tr>';
      return row;
    })
    .join('');

  table.innerHTML = thead + `<tbody>${rows}</tbody>`;

  document.getElementById('propinasContent').hidden = false;
  document.getElementById('propinasLoading').hidden = true;
  document.getElementById('propinasError').hidden = true;
}

// ---------------------------------------------------------------------------
// Sync orchestration
// ---------------------------------------------------------------------------
function setSyncState(kind, label) {
  const dot = document.getElementById('syncDot');
  dot.className = 'sync-dot' + (kind === 'stale' ? ' stale' : kind === 'error' ? ' error' : '');
  document.getElementById('syncLabel').textContent = label;
}

async function loadAll(isManualRefresh) {
  const refreshBtn = document.getElementById('refreshBtn');
  if (isManualRefresh) refreshBtn.classList.add('spinning');
  setSyncState('loading', 'Sincronizando…');

  const keepWeekDate = state.horarioBlocks[state.currentWeekIdx]
    ? state.horarioBlocks[state.currentWeekIdx].weekDates[0]
    : null;

  try {
    const [horarioRows, propinasRows] = await Promise.all([
      fetchCsvChunked(GID_HORARIO, 'S', 200, 1400),
      fetchCsvRange(GID_PROPINAS, 'A1:X100'),
    ]);

    state.horarioBlocks = parseHorario(horarioRows);
    state.currentWeekIdx = keepWeekDate
      ? findWeekIndexForDate(state.horarioBlocks, keepWeekDate)
      : findWeekIndexForDate(state.horarioBlocks, new Date());

    state.propinas = parsePropinas(propinasRows);

    renderHorario();
    renderPropinas();

    const now = new Date();
    setSyncState('ok', 'Actualizado a las ' + now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }));
  } catch (err) {
    console.error(err);
    setSyncState('error', 'Error de conexión');
    if (!state.horarioBlocks.length) {
      document.getElementById('horarioLoading').hidden = true;
      const errEl = document.getElementById('horarioError');
      errEl.hidden = false;
      errEl.textContent = 'No se pudo cargar el horario. ' + err.message;
    }
    if (!state.propinas) {
      document.getElementById('propinasLoading').hidden = true;
      const errEl = document.getElementById('propinasError');
      errEl.hidden = false;
      errEl.textContent = 'No se pudieron cargar las propinas. ' + err.message;
    }
  } finally {
    if (isManualRefresh) refreshBtn.classList.remove('spinning');
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
  });
});

document.getElementById('prevWeek').addEventListener('click', () => {
  if (state.currentWeekIdx > 0) {
    state.currentWeekIdx--;
    renderHorario();
  }
});
document.getElementById('nextWeek').addEventListener('click', () => {
  if (state.currentWeekIdx < state.horarioBlocks.length - 1) {
    state.currentWeekIdx++;
    renderHorario();
  }
});
document.getElementById('todayBtn').addEventListener('click', () => {
  state.currentWeekIdx = findWeekIndexForDate(state.horarioBlocks, new Date());
  renderHorario();
});
document.getElementById('refreshBtn').addEventListener('click', () => loadAll(true));

loadAll(false);
setInterval(() => loadAll(false), REFRESH_MS);
