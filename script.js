var SQL = null;
var db = null;
var currentUser = null;
var currentTarget = 75;
var dayAttendance = {};   // date -> lecture_mask (0-255)
var saturdayPrefs = {};   // date -> 0 or 1
var currentMonthIndex = 0;

var SEMESTER_START = '2026-08-21';
var SEMESTER_END = '2026-12-31';

/* Best-effort transcription of the named (non-Sunday) holidays from the
   uploaded RKGIT 1st-Year ODD-Semester 2026-27 calendar, cross-checked
   against the real 2026 festival dates. Sundays are handled separately
   below, and every Saturday goes through the "is this a working day"
   prompt rather than being hard-coded here. */
var HOLIDAYS = {
  '2026-08-15': 'Independence Day',
  '2026-08-26': 'Eid-e-Milad',
  '2026-08-28': 'Raksha Bandhan',
  '2026-09-04': 'Janmashtami',
  '2026-10-02': 'Gandhi Jayanti',
  '2026-10-19': 'Mahanavami',
  '2026-10-20': 'Dussehra',
  '2026-11-06': 'Dhanteras',
  '2026-11-08': 'Diwali (Deepawali)',
  '2026-11-10': 'Govardhan Puja',
  '2026-11-11': 'Bhai Dooj',
  '2026-11-24': 'Guru Nanak Jayanti',
  '2026-12-25': 'Christmas Day'
};

var MONTHS = [
  { year: 2026, month: 8, label: 'August' },
  { year: 2026, month: 9, label: 'September' },
  { year: 2026, month: 10, label: 'October' },
  { year: 2026, month: 11, label: 'November' },
  { year: 2026, month: 12, label: 'December' }
];

var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* ---------------- helpers ---------------- */

function formatDate(d) {
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function formatDateLong(dateStr) {
  var parts = dateStr.split('-');
  var y = parseInt(parts[0], 10), m = parseInt(parts[1], 10), d = parseInt(parts[2], 10);
  return MONTH_NAMES[m - 1] + ' ' + d + ', ' + y;
}

function popcount(n) {
  var count = 0;
  while (n) { count += (n & 1); n >>= 1; }
  return count;
}

function showScreen(name) {
  document.getElementById('authScreen').classList.remove('active');
  document.getElementById('dashboardScreen').classList.remove('active');
  document.getElementById(name).classList.add('active');
}

/* ---------------- SQL helpers ---------------- */

function queryOne(sql, params) {
  var stmt = db.prepare(sql);
  stmt.bind(params || []);
  var result = null;
  if (stmt.step()) { result = stmt.getAsObject(); }
  stmt.free();
  return result;
}

function queryAll(sql, params) {
  var stmt = db.prepare(sql);
  stmt.bind(params || []);
  var rows = [];
  while (stmt.step()) { rows.push(stmt.getAsObject()); }
  stmt.free();
  return rows;
}

/* ---------------- auth ---------------- */

function handleContinue(name) {
  var errorEl = document.getElementById('nameError');
  errorEl.textContent = '';
  name = (name || '').trim();
  if (!name) { errorEl.textContent = 'Enter your name to continue.'; return; }
  var existing = queryOne('SELECT username FROM users WHERE username = ?', [name]);
  if (!existing) {
    db.run('INSERT INTO users (username) VALUES (?)', [name]);
    db.run('INSERT INTO user_settings (username, target) VALUES (?, 75)', [name]);
  }
  currentUser = name;
  enterDashboard();
}

function logout() {
  currentUser = null;
  closeModal();
  showScreen('authScreen');
}

/* ---------------- dashboard entry ---------------- */

function enterDashboard() {
  document.getElementById('userLabel').textContent = currentUser;
  document.getElementById('nameInput').value = '';

  var settings = queryOne('SELECT target FROM user_settings WHERE username = ?', [currentUser]);
  currentTarget = settings ? settings.target : 75;
  document.getElementById('targetInput').value = currentTarget;

  loadUserData();
  currentMonthIndex = getDefaultMonthIndex();
  initMonthTabs();
  renderCalendar();
  renderStats();
  showScreen('dashboardScreen');
}

function loadUserData() {
  dayAttendance = {};
  saturdayPrefs = {};
  queryAll('SELECT date, lecture_mask FROM day_attendance WHERE username = ?', [currentUser]).forEach(function (r) {
    dayAttendance[r.date] = r.lecture_mask;
  });
  queryAll('SELECT date, is_working FROM saturday_prefs WHERE username = ?', [currentUser]).forEach(function (r) {
    saturdayPrefs[r.date] = r.is_working;
  });
}

function getDefaultMonthIndex() {
  var today = new Date();
  for (var i = 0; i < MONTHS.length; i++) {
    if (today.getFullYear() === MONTHS[i].year && (today.getMonth() + 1) === MONTHS[i].month) {
      return i;
    }
  }
  return 0;
}

/* ---------------- month tabs ---------------- */

function initMonthTabs() {
  var tabsEl = document.getElementById('monthTabs');
  tabsEl.innerHTML = '';
  MONTHS.forEach(function (m, idx) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'month-tab' + (idx === currentMonthIndex ? ' active' : '');
    btn.textContent = m.label;
    btn.addEventListener('click', function () {
      currentMonthIndex = idx;
      var tabs = document.querySelectorAll('.month-tab');
      tabs.forEach(function (t, i2) { t.classList.toggle('active', i2 === idx); });
      renderCalendar();
    });
    tabsEl.appendChild(btn);
  });
}

/* ---------------- calendar rendering ---------------- */

function dayEligibility(ds, dow) {
  // returns {blocked: bool, reason: string|null, isSaturdayPending: bool}
  if (HOLIDAYS[ds]) return { blocked: true, reason: HOLIDAYS[ds] };
  if (dow === 0) return { blocked: true, reason: 'Sunday' };
  if (dow === 6) {
    var pref = saturdayPrefs[ds];
    if (pref === 0) return { blocked: true, reason: 'You marked this Saturday as off' };
    if (pref === undefined) return { blocked: false, pending: true };
    return { blocked: false };
  }
  return { blocked: false };
}

function renderCalendar() {
  var info = MONTHS[currentMonthIndex];
  var year = info.year, month = info.month;
  var firstDay = new Date(year, month - 1, 1);
  var daysInMonth = new Date(year, month, 0).getDate();
  var startWeekday = firstDay.getDay();

  document.getElementById('calMonthTitle').textContent = info.label + ' ' + year;

  var grid = document.getElementById('calendarGrid');
  grid.innerHTML = '';

  for (var i = 0; i < startWeekday; i++) {
    var blank = document.createElement('div');
    blank.className = 'cal-cell cal-blank';
    grid.appendChild(blank);
  }

  var todayStr = formatDate(new Date());

  for (var day = 1; day <= daysInMonth; day++) {
    var dateObj = new Date(year, month - 1, day);
    var ds = formatDate(dateObj);
    var dow = dateObj.getDay();

    var cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-cell';

    var dayNum = document.createElement('div');
    dayNum.className = 'cal-daynum';
    dayNum.textContent = day;
    cell.appendChild(dayNum);

    var isBeforeStart = ds < SEMESTER_START;
    var isFuture = ds > todayStr;
    var ariaLabel = formatDateLong(ds);

    if (isBeforeStart) {
      cell.classList.add('cal-outside');
      ariaLabel += ', before term start';
    } else if (isFuture) {
      cell.classList.add('cal-future');
      ariaLabel += ', upcoming';
    } else {
      var elig = dayEligibility(ds, dow);
      if (elig.blocked) {
        cell.classList.add('cal-holiday');
        var tag = document.createElement('div');
        tag.className = 'cal-tag';
        tag.textContent = dow === 0 ? 'Sunday' : (dow === 6 ? 'Off' : 'Holiday');
        cell.appendChild(tag);
        ariaLabel += ', ' + elig.reason;
        cell.addEventListener('click', (function (reason) {
          return function () { showHolidayReason(reason); };
        })(elig.reason));
      } else {
        if (dow === 6) {
          cell.classList.add('cal-saturday');
        }
        var mask = dayAttendance[ds];
        if (elig.pending) {
          ariaLabel += ', Saturday, tap to set as working day or not';
        } else if (mask === undefined) {
          ariaLabel += ', not marked yet';
        } else {
          var c = popcount(mask);
          if (c === 8) { cell.classList.add('cal-full'); ariaLabel += ', full day present'; }
          else if (c === 0) { cell.classList.add('cal-absent'); ariaLabel += ', marked absent'; }
          else {
            cell.classList.add('cal-partial');
            var pTag = document.createElement('div');
            pTag.className = 'cal-tag';
            pTag.textContent = c + '/8';
            cell.appendChild(pTag);
            ariaLabel += ', ' + c + ' of 8 lectures attended';
          }
        }
        attachLongPress(cell, (function (dstr) {
          return function () { handleDayClick(dstr); };
        })(ds), (function (dstr) {
          return function () { handleDayLongPress(dstr); };
        })(ds));
      }
    }

    cell.setAttribute('aria-label', ariaLabel);
    grid.appendChild(cell);
  }
}

/* ---------------- long press ---------------- */

function attachLongPress(el, onShortClick, onLongPress) {
  var timer = null;
  var longPressed = false;
  var threshold = 500;

  el.addEventListener('pointerdown', function () {
    longPressed = false;
    timer = setTimeout(function () {
      longPressed = true;
      onLongPress();
    }, threshold);
  });
  el.addEventListener('pointerup', function () {
    clearTimeout(timer);
    if (!longPressed) { onShortClick(); }
  });
  el.addEventListener('pointerleave', function () { clearTimeout(timer); });
  el.addEventListener('pointercancel', function () { clearTimeout(timer); });
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
}

/* ---------------- day interaction ---------------- */

function handleDayClick(ds) {
  var dow = new Date(ds + 'T00:00:00').getDay();
  if (dow === 6 && saturdayPrefs[ds] === undefined) {
    askSaturdayWorking(ds, function () { handleDayClick(ds); });
    return;
  }
  if (dayAttendance[ds] !== undefined) {
    clearDayAttendance(ds);
  } else {
    saveDayAttendance(ds, 255);
  }
  renderCalendar();
  renderStats();
}

function handleDayLongPress(ds) {
  var dow = new Date(ds + 'T00:00:00').getDay();
  if (dow === 6 && saturdayPrefs[ds] === undefined) {
    askSaturdayWorking(ds, function () { openLectureEditor(ds); });
    return;
  }
  openLectureEditor(ds);
}

function saveDayAttendance(ds, mask) {
  dayAttendance[ds] = mask;
  db.run('INSERT INTO day_attendance (username, date, lecture_mask) VALUES (?, ?, ?) ' +
    'ON CONFLICT(username, date) DO UPDATE SET lecture_mask = excluded.lecture_mask', [currentUser, ds, mask]);
}

function clearDayAttendance(ds) {
  delete dayAttendance[ds];
  db.run('DELETE FROM day_attendance WHERE username = ? AND date = ?', [currentUser, ds]);
}

function setSaturdayPref(ds, val) {
  saturdayPrefs[ds] = val;
  db.run('INSERT INTO saturday_prefs (username, date, is_working) VALUES (?, ?, ?) ' +
    'ON CONFLICT(username, date) DO UPDATE SET is_working = excluded.is_working', [currentUser, ds, val]);
}

/* ---------------- modal ---------------- */

function openModal(html) {
  document.getElementById('modalBox').innerHTML = html;
  document.getElementById('modalOverlay').style.display = 'flex';
}
function closeModal() {
  document.getElementById('modalOverlay').style.display = 'none';
  document.getElementById('modalBox').innerHTML = '';
}

function showHolidayReason(reason) {
  openModal(
    '<h3 class="modal-title">Not a class day</h3>' +
    '<p class="modal-text">' + reason + '. Attendance can\'t be logged on this day.</p>' +
    '<button type="button" class="btn" id="modalCloseBtn">Got it</button>'
  );
  document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
}

function askSaturdayWorking(ds, onYes) {
  openModal(
    '<h3 class="modal-title">' + formatDateLong(ds) + '</h3>' +
    '<p class="modal-text">Is Saturday a working day for you?</p>' +
    '<div class="modal-actions">' +
    '<button type="button" class="btn" id="satYesBtn">Yes, it is</button>' +
    '<button type="button" class="btn-text" id="satNoBtn">No, it\'s off</button>' +
    '</div>'
  );
  document.getElementById('satYesBtn').addEventListener('click', function () {
    setSaturdayPref(ds, 1);
    closeModal();
    onYes();
  });
  document.getElementById('satNoBtn').addEventListener('click', function () {
    setSaturdayPref(ds, 0);
    closeModal();
    renderCalendar();
    renderStats();
  });
}

function openLectureEditor(ds) {
  var mask = dayAttendance[ds];
  if (mask === undefined) mask = 255;
  var html = '<h3 class="modal-title">' + formatDateLong(ds) + '</h3>';
  html += '<p class="modal-text">Deselect any lecture you missed.</p>';
  html += '<div class="lecture-grid">';
  for (var i = 0; i < 8; i++) {
    var checked = (mask & (1 << i)) ? ' checked' : '';
    html += '<label class="lecture-box"><input type="checkbox" data-bit="' + i + '"' + checked + '> Lecture ' + (i + 1) + '</label>';
  }
  html += '</div>';
  html += '<button type="button" class="btn" id="saveLecturesBtn">Save</button>';
  openModal(html);

  document.getElementById('saveLecturesBtn').addEventListener('click', function () {
    var newMask = 0;
    document.querySelectorAll('.lecture-box input[type=checkbox]').forEach(function (cb) {
      if (cb.checked) { newMask |= (1 << parseInt(cb.getAttribute('data-bit'), 10)); }
    });
    saveDayAttendance(ds, newMask);
    closeModal();
    renderCalendar();
    renderStats();
  });
}

/* ---------------- stats ---------------- */

function countsTowardStats(ds, dow) {
  // Stricter than dayEligibility: a Saturday only counts toward the
  // percentage once the user has explicitly confirmed it's a working day.
  // "Not asked yet" is treated the same as "no", not counted either way.
  if (HOLIDAYS[ds]) return false;
  if (dow === 0) return false;
  if (dow === 6) return saturdayPrefs[ds] === 1;
  return true;
}

function computeStats() {
  var todayStr = formatDate(new Date());
  var cutoff = todayStr < SEMESTER_END ? todayStr : SEMESTER_END;

  var conductedDays = 0, attended = 0, absentDays = 0;

  if (cutoff >= SEMESTER_START) {
    var d = new Date(SEMESTER_START + 'T00:00:00');
    var end = new Date(cutoff + 'T00:00:00');
    while (d <= end) {
      var ds = formatDate(d);
      var dow = d.getDay();
      if (countsTowardStats(ds, dow)) {
        conductedDays++;
        var mask = dayAttendance[ds];
        if (mask === undefined) {
          absentDays++;
        } else {
          var c = popcount(mask);
          attended += c;
          if (c === 0) absentDays++;
        }
      }
      d.setDate(d.getDate() + 1);
    }
  }

  var conducted = conductedDays * 8;
  return { conducted: conducted, attended: attended, missed: conducted - attended, absentDays: absentDays };
}

function renderStats() {
  var stats = computeStats();
  var emptyState = document.getElementById('summaryEmpty');
  var filledState = document.getElementById('summaryFilled');

  if (stats.conducted === 0) {
    emptyState.style.display = 'block';
    filledState.style.display = 'none';
    return;
  }
  emptyState.style.display = 'none';
  filledState.style.display = 'block';

  document.getElementById('statConducted').textContent = stats.conducted;
  document.getElementById('statAttended').textContent = stats.attended;
  document.getElementById('statMissed').textContent = stats.missed;
  document.getElementById('statAbsentDays').textContent = stats.absentDays;

  var pct = (stats.attended / stats.conducted) * 100;
  var rounded = Math.round(pct * 10) / 10;
  var percentText = document.getElementById('percentText');
  percentText.textContent = rounded.toFixed(1) + '%';

  var isSafe = pct >= currentTarget;
  var statusColor = isSafe ? 'var(--stamp-green)' : 'var(--pen-red)';
  percentText.style.color = statusColor;
  var statusLabel = document.getElementById('statusLabel');
  statusLabel.textContent = isSafe ? 'On track' : 'Below target';
  statusLabel.style.color = statusColor;

  var circle = document.getElementById('progressRing');
  var circumference = 2 * Math.PI * 70;
  var offset = circumference * (1 - Math.min(pct, 100) / 100);
  circle.style.stroke = statusColor;
  circle.style.strokeDashoffset = offset;

  var targetFraction = currentTarget / 100;
  var msgEl = document.getElementById('targetMessage');
  var subEl = document.getElementById('targetSubMessage');
  msgEl.style.color = statusColor;

  if (isSafe) {
    var maxSkip = Math.max(0, Math.floor(stats.attended / targetFraction - stats.conducted));
    if (maxSkip > 0) {
      msgEl.textContent = 'You can miss the next ' + maxSkip + ' lecture' + (maxSkip === 1 ? '' : 's') + ' and stay at or above ' + currentTarget + '%.';
      var daysEqSkip = maxSkip / 8;
      subEl.textContent = "That's about " + daysEqSkip.toFixed(1) + ' full day' + (daysEqSkip === 1 ? '' : 's') + ' of classes.';
    } else {
      msgEl.textContent = "You're exactly at " + currentTarget + '% \u2014 one more miss will drop you below it.';
      subEl.textContent = '';
    }
  } else {
    if (targetFraction >= 1) {
      msgEl.textContent = "You've already missed a lecture, so 100% isn't reachable anymore this term.";
      subEl.textContent = '';
    } else {
      var needed = Math.ceil((targetFraction * stats.conducted - stats.attended) / (1 - targetFraction));
      msgEl.textContent = 'Attend the next ' + needed + ' lecture' + (needed === 1 ? '' : 's') + ' in a row to reach ' + currentTarget + '%.';
      var daysEqNeed = needed / 8;
      subEl.textContent = "That's about " + daysEqNeed.toFixed(1) + ' full day' + (daysEqNeed === 1 ? '' : 's') + ' of classes.';
    }
  }
}

function updateTarget() {
  var t = parseFloat(document.getElementById('targetInput').value);
  t = (isNaN(t) || t <= 0) ? 75 : Math.min(t, 100);
  currentTarget = t;
  db.run('INSERT INTO user_settings (username, target) VALUES (?, ?) ' +
    'ON CONFLICT(username) DO UPDATE SET target = excluded.target', [currentUser, t]);
  renderStats();
}

/* ---------------- backup / restore ---------------- */

function downloadBackup() {
  var data = db.export();
  var blob = new Blob([data], { type: 'application/x-sqlite3' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'attendance-ledger-backup.sqlite';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function restoreBackup(file) {
  var statusEl = document.getElementById('restoreStatus');
  if (!SQL) {
    statusEl.style.color = 'var(--pen-red)';
    statusEl.textContent = 'Still loading \u2014 try again in a moment.';
    return;
  }
  var reader = new FileReader();
  reader.onload = function (e) {
    try {
      var uint8 = new Uint8Array(e.target.result);
      var restored = new SQL.Database(uint8);
      restored.exec('SELECT username FROM users LIMIT 1');
      restored.run('PRAGMA foreign_keys = ON;');
      db = restored;
      statusEl.style.color = 'var(--stamp-green)';
      statusEl.textContent = 'Backup restored \u2014 enter a name from that file to continue.';
    } catch (err) {
      statusEl.style.color = 'var(--pen-red)';
      statusEl.textContent = "That doesn't look like a valid backup file.";
    }
  };
  reader.onerror = function () {
    statusEl.style.color = 'var(--pen-red)';
    statusEl.textContent = 'Could not read that file.';
  };
  reader.readAsArrayBuffer(file);
}

/* ---------------- wiring ---------------- */

document.getElementById('nameFormEl').addEventListener('submit', function (e) {
  e.preventDefault();
  handleContinue(document.getElementById('nameInput').value);
});
document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('downloadBtn').addEventListener('click', downloadBackup);
document.getElementById('restoreInput').addEventListener('change', function (e) {
  if (e.target.files && e.target.files[0]) { restoreBackup(e.target.files[0]); }
});
document.getElementById('targetInput').addEventListener('input', updateTarget);
document.getElementById('modalOverlay').addEventListener('click', function (e) {
  if (e.target === this) { closeModal(); }
});
document.getElementById('prevMonthBtn').addEventListener('click', function () {
  if (currentMonthIndex > 0) {
    currentMonthIndex--;
    document.querySelectorAll('.month-tab').forEach(function (t, i) { t.classList.toggle('active', i === currentMonthIndex); });
    renderCalendar();
  }
});
document.getElementById('nextMonthBtn').addEventListener('click', function () {
  if (currentMonthIndex < MONTHS.length - 1) {
    currentMonthIndex++;
    document.querySelectorAll('.month-tab').forEach(function (t, i) { t.classList.toggle('active', i === currentMonthIndex); });
    renderCalendar();
  }
});

(function initRing() {
  var circle = document.getElementById('progressRing');
  var circumference = 2 * Math.PI * 70;
  circle.style.strokeDasharray = circumference;
  circle.style.strokeDashoffset = circumference;
})();

async function initApp() {
  SQL = await initSqlJs({
    locateFile: function (file) { return 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/' + file; }
  });
  db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON;');
  db.run('CREATE TABLE users (username TEXT PRIMARY KEY);');
  db.run('CREATE TABLE user_settings (username TEXT PRIMARY KEY REFERENCES users(username), target REAL NOT NULL DEFAULT 75);');
  db.run('CREATE TABLE day_attendance (username TEXT NOT NULL REFERENCES users(username), date TEXT NOT NULL, lecture_mask INTEGER NOT NULL, PRIMARY KEY (username, date));');
  db.run('CREATE TABLE saturday_prefs (username TEXT NOT NULL REFERENCES users(username), date TEXT NOT NULL, is_working INTEGER NOT NULL, PRIMARY KEY (username, date));');
  document.getElementById('initStatus').style.display = 'none';
  document.getElementById('nameFormEl').style.display = 'block';
}

initApp().catch(function (err) {
  var statusEl = document.getElementById('initStatus');
  statusEl.style.color = 'var(--pen-red)';
  statusEl.textContent = 'Could not load the database engine. Check your connection and reload.';
  console.error(err);
});
