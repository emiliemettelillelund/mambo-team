/* Mambo Team Hub — reads live from the "Horario Mambo" Google Sheet via the public gviz endpoint. */

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
// JSONP fetch against the public gviz endpoint (no server, no CORS issues).
// ---------------------------------------------------------------------------
function fetchGviz(gid) {
  return new Promise((resolve, reject) => {
    const cbName = 'gvizCb_' + gid + '_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    const script = document.createElement('script');
    let settled = false;

    const cleanup = () => {
      delete window[cbName];
      script.remove();
    };

    window[cbName] = (data) => {
      settled = true;
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('No se pudo conectar con Google Sheets'));
      }
    };

    script.src =
      `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
      `?gid=${gid}&tqx=out:json;responseHandler:${cbName}&_=${Date.now()}`;

    document.body.appendChild(script);

    setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('Tiempo de espera agotado'));
      }
    }, 15000);
  });
}

// ---------------------------------------------------------------------------
// Horario Semanal parsing
// ---------------------------------------------------------------------------
const DAY_START_COLS = [2, 4, 6, 8, 10, 12, 14]; // C E G I K M O
const DAY_END_COLS = [3, 5, 7, 9, 11, 13, 15]; // D F H J L N P
const SKIP_LABELS = new Set(['PAX POR DÍA:', 'HORARIO APERTURA/CIERRE CLIENTE']);

function cellText(row, idx) {
  if (!row || !row.c || !row.c[idx]) return null;
  const c = row.c[idx];
  if (c.f !== undefined && c.f !== null && c.f !== '') return String(c.f).trim();
  if (c.v !== undefined && c.v !== null) return String(c.v).trim();
  return null;
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

function parseHorario(table) {
  const rows = table.rows;
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
  if (/BAJA|AUSENCIA/i.test(text)) return 'shift-note';
  const m = text.match(/^(\d{1,2}):(\d{2})/);
  if (m) {
    const h = parseInt(m[1], 10);
    if (h >= 17 || h < 5) return 'shift-night';
    return 'shift-day';
  }
  return 'shift-note';
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
function parsePropinas(table) {
  const cols = table.cols;
  const rows = table.rows;

  const employees = [];
  for (let idx = 2; idx < cols.length; idx += 3) {
    const label = cols[idx] && cols[idx].label ? cols[idx].label.replace(/\s*HORAS\s*$/i, '').replace(/\s*PAX\s*$/i, '').trim() : null;
    if (!label) break;
    employees.push({ name: label, horasIdx: idx, propinasIdx: idx + 1, estadoIdx: idx + 2 });
  }

  const weeks = [];
  for (const row of rows) {
    if (!row.c || !row.c[0] || row.c[0].v == null) continue;
    const weekLabel = String(row.c[0].v).trim();
    const wm = weekLabel.match(/(\d+)/);
    const weekNum = wm ? parseInt(wm[1], 10) : null;
    const totalCell = row.c[1];
    const total = totalCell && totalCell.v != null ? totalCell.v : 0;

    const perEmployee = {};
    let anyData = false;
    employees.forEach((emp) => {
      const h = row.c[emp.horasIdx];
      const p = row.c[emp.propinasIdx];
      const e = row.c[emp.estadoIdx];
      const propinas = p && p.v != null ? p.v : 0;
      const estado = e && e.v != null ? String(e.v).trim() : null;
      const horasVal = h ? (h.v != null ? h.v : h.f) : null;
      if (toNum(propinas) > 0 || toNum(horasVal) > 0) anyData = true;
      perEmployee[emp.name] = {
        horas: h ? (h.v != null ? h.v : h.f) : null,
        propinas,
        estado,
      };
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

  const summaryEl = document.getElementById('summaryStrip');
  let totalPaid = 0;
  let totalPending = 0;
  weeksWithData.forEach((w) => {
    data.employees.forEach((emp) => {
      const rec = w.perEmployee[emp];
      if (!rec) return;
      if (/ya entregado/i.test(rec.estado || '')) totalPaid += rec.propinas;
      else if (rec.propinas) totalPending += rec.propinas;
    });
  });
  summaryEl.innerHTML = `
    <div class="summary-tile"><div class="label">Propinas entregadas</div><div class="value">${fmtEuro(totalPaid)}</div></div>
    <div class="summary-tile pending"><div class="label">Pendiente de entregar</div><div class="value">${fmtEuro(totalPending)}</div></div>
    <div class="summary-tile"><div class="label">Semanas registradas</div><div class="value">${weeksWithData.length}</div></div>
  `;

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
    const [horarioJson, propinasJson] = await Promise.all([fetchGviz(GID_HORARIO), fetchGviz(GID_PROPINAS)]);

    state.horarioBlocks = parseHorario(horarioJson.table);
    state.currentWeekIdx = keepWeekDate
      ? findWeekIndexForDate(state.horarioBlocks, keepWeekDate)
      : findWeekIndexForDate(state.horarioBlocks, new Date());

    state.propinas = parsePropinas(propinasJson.table);

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
