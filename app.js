// ============================================================
// Firebase
// ============================================================
import { initializeApp }                              from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-app.js';
import { getFirestore, doc, setDoc, onSnapshot }      from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-firestore.js';
import { getAuth, signInWithPopup, GoogleAuthProvider,
         onAuthStateChanged, signOut }                from 'https://www.gstatic.com/firebasejs/12.12.0/firebase-auth.js';

const firebaseConfig = {
  apiKey:            'AIzaSyB2nWcGvEKpbNjl_OW-6pBjHJz_Mwcu5z0',
  authDomain:        'tatuki-78f99.firebaseapp.com',
  projectId:         'tatuki-78f99',
  storageBucket:     'tatuki-78f99.firebasestorage.app',
  messagingSenderId: '954408081181',
  appId:             '1:954408081181:web:62d9122a3245053cd033f4',
};

const fbApp     = initializeApp(firebaseConfig);
const db        = getFirestore(fbApp);
const auth      = getAuth(fbApp);
const gProvider = new GoogleAuthProvider();

// ============================================================
// State
// ============================================================
const today = new Date();
let currentYear  = today.getFullYear();
let currentMonth = today.getMonth();
let selectedDate = null;   // "YYYY-MM-DD" | null
let editingId    = null;   // 編集中のTodo ID | null

// ============================================================
// Storage – Firestore
// ============================================================
let localData      = {};
let currentUser    = null;
let unsubFirestore = null;

function saveToFirestore() {
  if (!currentUser) return;
  setDoc(doc(db, 'todos', currentUser.uid), localData)
    .catch(e => console.error('Save error:', e));
}

function startSync(uid) {
  if (unsubFirestore) unsubFirestore();
  unsubFirestore = onSnapshot(
    doc(db, 'todos', uid),
    snap => {
      localData = snap.exists() ? snap.data() : {};
      render();
      scheduleNotifications();
    },
    err => console.error('Sync error:', err)
  );
}

onAuthStateChanged(auth, user => {
  currentUser = user;
  if (user) {
    document.getElementById('authOverlay').classList.add('hidden');
    startSync(user.uid);
  } else {
    document.getElementById('authOverlay').classList.remove('hidden');
    if (unsubFirestore) { unsubFirestore(); unsubFirestore = null; }
    localData = {};
  }
});

document.getElementById('googleSignIn').addEventListener('click', () => {
  signInWithPopup(auth, gProvider).catch(e => console.error('Sign-in error:', e));
});

function getMonth(ymStr) {
  if (!localData[ymStr]) localData[ymStr] = { monthly: [], weekly: {}, daily: {} };
  localData[ymStr].monthly = localData[ymStr].monthly || [];
  localData[ymStr].weekly  = localData[ymStr].weekly  || {};
  localData[ymStr].daily   = localData[ymStr].daily   || {};
  return localData[ymStr];
}
function saveMonth(ymStr, md) {
  localData[ymStr] = md;
  saveToFirestore();
}

// ============================================================
// Storage – Settings (localStorage)
// ============================================================
const SETTINGS_KEY     = 'todo-settings-v1';
const DEFAULT_SETTINGS = { notifyLeadMinutes: 30 };

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

// ============================================================
// Trash（ごみ箱）
// ============================================================
const TRASH_TTL = 7 * 24 * 60 * 60 * 1000; // 7日

function cleanOldTrash() {
  if (!localData._trash) return;
  const cutoff = Date.now() - TRASH_TTL;
  localData._trash = localData._trash.filter(t => t.deletedAt > cutoff);
}

function addToTrash(item, type, key, ymStr) {
  if (!localData._trash) localData._trash = [];
  cleanOldTrash();
  localData._trash.push({
    ...item,
    deletedAt:    Date.now(),
    originalType: type,
    originalKey:  key,
    originalYm:   ymStr,
  });
}

function restoreFromTrash(id) {
  const trash = localData._trash || [];
  const item  = trash.find(t => t.id === id);
  if (!item) return;
  const { deletedAt, originalType, originalKey, originalYm, ...todoItem } = item;
  const md = getMonth(originalYm);
  if      (originalType === 'monthly') md.monthly.push(todoItem);
  else if (originalType === 'weekly')  { if (!md.weekly[originalKey]) md.weekly[originalKey] = []; md.weekly[originalKey].push(todoItem); }
  else                                 { if (!md.daily[originalKey])  md.daily[originalKey]  = []; md.daily[originalKey].push(todoItem); }
  localData[originalYm] = md;
  localData._trash = trash.filter(t => t.id !== id);
  saveToFirestore();
  render();
  renderSettings();
}

function permanentDeleteFromTrash(id) {
  localData._trash = (localData._trash || []).filter(t => t.id !== id);
  saveToFirestore();
  renderSettings();
}

// ============================================================
// Notifications
// ============================================================
let notifTimers = [];

/** 全角数字・チルダを半角に正規化してから時刻パース */
function parseTime(text) {
  const normalized = text
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[〜～]/g, '~');
  const m = normalized.match(/(\d{1,2})(\d{2})~/);
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return { h, min };
}

function scheduleNotifications() {
  notifTimers.forEach(clearTimeout);
  notifTimers = [];
  if (Notification.permission !== 'granted') return;

  const { notifyLeadMinutes } = loadSettings();
  const now = Date.now();

  // 今日の週範囲
  const todayDate = new Date(TODAY_STR + 'T00:00:00');
  const thisMonday = monday(todayDate);
  const thisSunday = new Date(thisMonday);
  thisSunday.setDate(thisMonday.getDate() + 6);

  function schedule(todo) {
    if (todo.done) return;
    const t = parseTime(todo.text);
    if (!t) return;
    const target = new Date();
    target.setHours(t.h, t.min, 0, 0);
    const delay = target.getTime() - notifyLeadMinutes * 60_000 - now;
    if (delay > 0) {
      notifTimers.push(setTimeout(() => {
        new Notification('📋 Todo リマインダー', { body: todo.text });
      }, delay));
    }
  }

  for (const md of Object.values(localData)) {
    if (typeof md !== 'object' || Array.isArray(md)) continue;

    // 月間: 今月のものだけ
    for (const todo of md.monthly || []) schedule(todo);

    // 週間: 今週の週キーのもののみ
    for (const [wk, list] of Object.entries(md.weekly || {})) {
      const wkDate = new Date(wk + 'T00:00:00');
      if (wkDate >= thisMonday && wkDate <= thisSunday) {
        for (const todo of list) schedule(todo);
      }
    }

    // 日別: 今日の日付のもののみ
    for (const todo of (md.daily || {})[TODAY_STR] || []) schedule(todo);
  }
}

// ============================================================
// Utils
// ============================================================
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function ym() {
  return `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;
}
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const TODAY_STR = toDateStr(today);

function monday(d) {
  const r = new Date(d);
  const dow = r.getDay();
  r.setDate(r.getDate() + (dow === 0 ? -6 : 1 - dow));
  return r;
}
function curWeekKey() { return toDateStr(monday(today)); }

function weeksInMonth(year, month) {
  const first = new Date(year, month, 1);
  const last  = new Date(year, month + 1, 0);
  const weeks = [];
  let mon = monday(first);
  while (mon <= last) {
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    weeks.push({ start: new Date(mon), end: new Date(sun), key: toDateStr(mon) });
    mon = new Date(mon);
    mon.setDate(mon.getDate() + 7);
  }
  return weeks;
}

function weekLabel(start, end) {
  const ms = new Date(currentYear, currentMonth, 1);
  const me = new Date(currentYear, currentMonth + 1, 0);
  const s  = start < ms ? ms : start;
  const e  = end   > me ? me : end;
  return `${s.getMonth()+1}/${s.getDate()} 〜 ${e.getMonth()+1}/${e.getDate()}`;
}

const DOW_JA = ['日','月','火','水','木','金','土'];

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================================
// HTML helpers
// ============================================================
const PENCIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>`;

function progressBarHtml(done, total) {
  if (total === 0) return '';
  const pct   = Math.round((done / total) * 100);
  const color = pct === 100 ? 'bg-green-500' : 'bg-blue-500';
  return `
    <div class="flex items-center gap-2 my-2">
      <div class="flex-1 bg-gray-100 rounded-full h-1.5 overflow-hidden">
        <div class="${color} h-1.5 rounded-full transition-all duration-300" style="width:${pct}%"></div>
      </div>
      <span class="text-xs text-gray-400 w-8 text-right">${done}/${total}</span>
    </div>`;
}

function todoItemHtml(item, type, key) {
  // 編集モード
  if (item.id === editingId) {
    return `
      <div class="flex items-center gap-2 py-1.5">
        <input type="checkbox" class="w-4 h-4 accent-blue-500 flex-shrink-0 opacity-30 cursor-not-allowed" disabled ${item.done ? 'checked' : ''}>
        <input type="text" class="edit-input flex-1 text-sm border border-blue-400 rounded-lg px-2 py-0.5 focus:outline-none"
          value="${esc(item.text)}"
          data-type="${esc(type)}" data-key="${esc(key)}" data-id="${esc(item.id)}">
        <button class="edit-save text-green-500 hover:text-green-700 text-base px-1 flex-shrink-0"
          data-type="${esc(type)}" data-key="${esc(key)}" data-id="${esc(item.id)}">✓</button>
        <button class="edit-cancel text-gray-400 hover:text-gray-600 text-base px-1 flex-shrink-0">✗</button>
      </div>`;
  }

  const done     = item.done;
  const hasTime  = !!parseTime(item.text);
  const timeBadge = hasTime
    ? '<span class="text-orange-400 text-xs flex-shrink-0" title="時間通知あり">🔔</span>'
    : '';
  return `
    <div class="flex items-center gap-2 py-1.5 group">
      <input type="checkbox"
        class="todo-chk w-4 h-4 cursor-pointer accent-blue-500 flex-shrink-0"
        data-type="${esc(type)}" data-key="${esc(key)}" data-id="${esc(item.id)}"
        ${done ? 'checked' : ''}>
      <span class="flex-1 text-sm leading-snug break-all
        ${done ? 'line-through text-gray-400' : 'text-gray-700'}">${esc(item.text)}</span>
      ${timeBadge}
      <button
        class="todo-edit opacity-0 group-hover:opacity-100 text-blue-400 hover:text-blue-600
               text-xs px-1.5 py-0.5 rounded transition-opacity flex-shrink-0"
        data-type="${esc(type)}" data-key="${esc(key)}" data-id="${esc(item.id)}"
        title="編集">${PENCIL_SVG}</button>
      <button
        class="todo-del opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600
               text-xs px-1.5 py-0.5 rounded transition-opacity flex-shrink-0"
        data-type="${esc(type)}" data-key="${esc(key)}" data-id="${esc(item.id)}">✕</button>
    </div>`;
}

function addFormHtml(formId, placeholder) {
  return `
    <div class="flex gap-2 mt-2">
      <input id="inp-${esc(formId)}" type="text"
        class="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5
               focus:outline-none focus:border-blue-400 placeholder-gray-300"
        placeholder="${esc(placeholder)}" maxlength="200" autocomplete="off">
      <button id="btn-${esc(formId)}"
        class="bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white
               text-xs font-medium px-3 py-1.5 rounded-lg transition-colors flex-shrink-0">追加</button>
    </div>`;
}

// ============================================================
// Calendar sidebar
// ============================================================
function renderCalendarSidebar() {
  const ymStr      = ym();
  const md         = getMonth(ymStr);
  const firstDay   = new Date(currentYear, currentMonth, 1);
  const lastDayNum = new Date(currentYear, currentMonth + 1, 0).getDate();
  const startDow   = (firstDay.getDay() + 6) % 7;

  const daysWithTodos = new Set(
    Object.entries(md.daily)
      .filter(([k, list]) => list.length > 0 && k.startsWith(ymStr))
      .map(([k]) => parseInt(k.slice(-2), 10))
  );

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= lastDayNum; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const isCurMon  = currentYear === today.getFullYear() && currentMonth === today.getMonth();
  const todayDate = today.getDate();

  const cellsHtml = cells.map(d => {
    if (!d) return '<div></div>';
    const dateStr    = `${ymStr}-${String(d).padStart(2, '0')}`;
    const isToday    = isCurMon && d === todayDate;
    const isSelected = dateStr === selectedDate;
    const hasTodo    = daysWithTodos.has(d);

    let cls = 'relative flex items-center justify-center w-8 h-8 rounded-full text-xs cursor-pointer select-none transition-colors ';
    if (isSelected)    cls += 'bg-blue-500 text-white font-bold';
    else if (isToday)  cls += 'bg-blue-100 text-blue-700 font-bold hover:bg-blue-200';
    else               cls += 'hover:bg-gray-100 text-gray-700';

    const dot = (hasTodo && !isSelected)
      ? '<span class="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-blue-400"></span>'
      : '';

    return `<div class="${cls}" data-cal-date="${dateStr}">${d}${dot}</div>`;
  }).join('');

  let detailHtml = '';
  if (selectedDate && selectedDate.startsWith(ymStr)) {
    const selD   = new Date(selectedDate + 'T00:00:00');
    const label  = `${selD.getMonth()+1}/${selD.getDate()}(${DOW_JA[selD.getDay()]})`;
    const todos  = md.daily[selectedDate] || [];
    const done   = todos.filter(t => t.done).length;

    const todosHtml = todos.length
      ? todos.map(t => `
          <div class="flex items-center gap-1.5 py-1 group">
            <input type="checkbox"
              class="cal-todo-chk w-3.5 h-3.5 cursor-pointer accent-blue-500 flex-shrink-0"
              data-date="${esc(selectedDate)}" data-id="${esc(t.id)}" ${t.done ? 'checked' : ''}>
            <span class="flex-1 text-xs break-all ${t.done ? 'line-through text-gray-400' : 'text-gray-700'}">${esc(t.text)}</span>
            <button class="cal-todo-del opacity-0 group-hover:opacity-100 text-red-400 text-xs px-1 flex-shrink-0 transition-opacity"
              data-date="${esc(selectedDate)}" data-id="${esc(t.id)}">✕</button>
          </div>`).join('')
      : '<p class="text-xs text-gray-400 py-1">まだありません</p>';

    detailHtml = `
      <div class="mt-3 pt-3 border-t border-gray-100">
        <div class="flex items-center justify-between mb-1">
          <p class="text-xs font-semibold text-gray-700">${label}</p>
          <button id="calClearDate" class="text-xs text-gray-400 hover:text-gray-600 leading-none">✕</button>
        </div>
        ${progressBarHtml(done, todos.length)}
        <div class="max-h-36 overflow-y-auto">${todosHtml}</div>
        <div class="flex gap-1.5 mt-2">
          <input id="calNewText" type="text"
            class="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5
                   focus:outline-none focus:border-blue-400 placeholder-gray-300"
            placeholder="追加…" maxlength="200" autocomplete="off">
          <button id="calNewAdd"
            class="bg-blue-500 hover:bg-blue-600 text-white text-xs px-2 py-1.5
                   rounded-lg transition-colors flex-shrink-0">追加</button>
        </div>
      </div>`;
  }

  document.getElementById('calendarSidebar').innerHTML = `
    <div class="bg-white rounded-2xl shadow-sm p-4 sticky top-4">
      <div class="grid grid-cols-7 gap-1 mb-1">
        ${['月','火','水','木','金','土','日'].map(d =>
          `<div class="flex items-center justify-center text-xs font-semibold text-gray-400 h-6">${d}</div>`
        ).join('')}
      </div>
      <div class="grid grid-cols-7 gap-1">${cellsHtml}</div>
      ${detailHtml}
    </div>`;

  bindCalendarEvents();
}

function bindCalendarEvents() {
  const sidebar = document.getElementById('calendarSidebar');

  sidebar.querySelectorAll('[data-cal-date]').forEach(el => {
    el.addEventListener('click', () => {
      selectedDate = (el.dataset.calDate === selectedDate) ? null : el.dataset.calDate;
      render();
    });
  });

  const clearBtn = document.getElementById('calClearDate');
  if (clearBtn) clearBtn.addEventListener('click', () => { selectedDate = null; render(); });

  sidebar.querySelectorAll('.cal-todo-chk').forEach(el => {
    el.addEventListener('change', () => {
      const ymStr = ym();
      const md    = getMonth(ymStr);
      const list  = md.daily[el.dataset.date] || [];
      const item  = list.find(t => t.id === el.dataset.id);
      if (item) item.done = !item.done;
      saveMonth(ymStr, md);
      scheduleNotifications();
      render();
    });
  });

  sidebar.querySelectorAll('.cal-todo-del').forEach(el => {
    el.addEventListener('click', () => {
      const ymStr = ym();
      const md    = getMonth(ymStr);
      const list  = md.daily[el.dataset.date] || [];
      const item  = list.find(t => t.id === el.dataset.id);
      if (item) addToTrash(item, 'daily', el.dataset.date, ymStr);
      if (md.daily[el.dataset.date]) {
        md.daily[el.dataset.date] = md.daily[el.dataset.date].filter(t => t.id !== el.dataset.id);
      }
      saveMonth(ymStr, md);
      scheduleNotifications();
      render();
    });
  });

  const calAddBtn   = document.getElementById('calNewAdd');
  const calAddInput = document.getElementById('calNewText');
  if (calAddBtn && calAddInput && selectedDate) {
    const doAdd = () => {
      const text = calAddInput.value.trim();
      if (!text) return;
      const ymStr = ym();
      const md    = getMonth(ymStr);
      if (!md.daily[selectedDate]) md.daily[selectedDate] = [];
      md.daily[selectedDate].push({ id: genId(), text, done: false });
      saveMonth(ymStr, md);
      scheduleNotifications();
      render();
    };
    calAddBtn.addEventListener('click', doAdd);
    calAddInput.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
  }
}

// ============================================================
// Todo content (right panel)
// ============================================================
function renderTodoContent() {
  const ymStr    = ym();
  const md       = getMonth(ymStr);
  const isCurMon = (currentYear === today.getFullYear() && currentMonth === today.getMonth());

  // ---- Monthly ----
  const mTodos = md.monthly;
  const mDone  = mTodos.filter(t => t.done).length;
  const monthlyHtml = `
    <section class="bg-white rounded-2xl shadow-sm p-5 mb-4">
      <div class="flex items-center gap-2 mb-1">
        <span class="text-lg">📅</span>
        <h2 class="font-bold text-gray-700 text-base">月間 Todo</h2>
        <span class="ml-auto text-xs text-gray-400">${mTodos.length - mDone} 件残り</span>
      </div>
      ${progressBarHtml(mDone, mTodos.length)}
      <div>
        ${mTodos.length
          ? mTodos.map(t => todoItemHtml(t, 'monthly', '')).join('')
          : '<p class="text-xs text-gray-400 py-2">まだありません</p>'}
      </div>
      ${addFormHtml('monthly', 'この月のTodoを追加…')}
    </section>`;

  // ---- Weekly ----
  const weeks = weeksInMonth(currentYear, currentMonth);
  const cwk   = curWeekKey();
  const weekGroupsHtml = weeks.map(w => {
    const todos  = md.weekly[w.key] || [];
    const done   = todos.filter(t => t.done).length;
    const isNow  = isCurMon && w.key === cwk;
    const badge  = isNow
      ? '<span class="bg-green-500 text-white text-xs rounded-full px-2 py-0.5 ml-1.5">今週</span>'
      : '';
    const border = isNow ? 'border-green-400' : 'border-gray-100';
    return `
      <div class="mb-4 last:mb-0">
        <div class="flex items-center text-xs font-semibold text-gray-500 mb-1">
          ${weekLabel(w.start, w.end)}${badge}
        </div>
        ${progressBarHtml(done, todos.length)}
        <div class="pl-3 border-l-2 ${border}">
          ${todos.length
            ? todos.map(t => todoItemHtml(t, 'weekly', w.key)).join('')
            : '<p class="text-xs text-gray-400 py-1">まだありません</p>'}
          ${addFormHtml(`weekly-${w.key}`, 'この週のTodoを追加…')}
        </div>
      </div>`;
  }).join('');

  const weeklyHtml = `
    <section class="bg-white rounded-2xl shadow-sm p-5 mb-4">
      <div class="flex items-center gap-2 mb-4">
        <span class="text-lg">📆</span>
        <h2 class="font-bold text-gray-700 text-base">週間 Todo</h2>
      </div>
      ${weekGroupsHtml}
    </section>`;

  // ---- Daily ----
  const dailyData = md.daily;

  // Todoがある日付のみ + 選択中の日付
  const dKeySet = new Set(
    Object.keys(dailyData).filter(d => (dailyData[d] || []).length > 0)
  );
  if (selectedDate && selectedDate.startsWith(ymStr)) dKeySet.add(selectedDate);

  // 今日以降→月末、その後1日→昨日 の順
  const sortedDays = [...dKeySet]
    .filter(d => d.startsWith(ymStr))
    .sort((a, b) => {
      if (!isCurMon) return a.localeCompare(b);
      const aFuture = a >= TODAY_STR;
      const bFuture = b >= TODAY_STR;
      if (aFuture === bFuture) return a.localeCompare(b);
      return aFuture ? -1 : 1;
    });

  const defaultDay = (selectedDate && selectedDate.startsWith(ymStr))
    ? selectedDate
    : (isCurMon ? TODAY_STR : `${ymStr}-01`);
  const lastDay = new Date(currentYear, currentMonth + 1, 0).getDate();
  const maxDay  = `${ymStr}-${String(lastDay).padStart(2, '0')}`;

  const dayGroupsHtml = sortedDays.map(ds => {
    const d       = new Date(ds + 'T00:00:00');
    const label   = `${d.getMonth()+1}/${d.getDate()}(${DOW_JA[d.getDay()]})`;
    const isToday = ds === TODAY_STR && isCurMon;
    const isSel   = ds === selectedDate;
    const badge   = isToday
      ? '<span class="bg-blue-500 text-white text-xs rounded-full px-2 py-0.5 ml-1.5">今日</span>'
      : (isSel ? '<span class="bg-indigo-400 text-white text-xs rounded-full px-2 py-0.5 ml-1.5">選択中</span>' : '');
    const border  = isToday ? 'border-blue-400' : isSel ? 'border-indigo-300' : 'border-gray-100';
    const todos   = dailyData[ds] || [];
    const done    = todos.filter(t => t.done).length;
    return `
      <div class="mb-4 last:mb-0">
        <div class="flex items-center text-xs font-semibold text-gray-500 mb-1">
          ${label}${badge}
        </div>
        ${progressBarHtml(done, todos.length)}
        <div class="pl-3 border-l-2 ${border}">
          ${todos.length
            ? todos.map(t => todoItemHtml(t, 'daily', ds)).join('')
            : '<p class="text-xs text-gray-400 py-1">まだありません</p>'}
          ${addFormHtml(`daily-${ds}`, 'この日のTodoを追加…')}
        </div>
      </div>`;
  }).join('');

  const dailyHtml = `
    <section class="bg-white rounded-2xl shadow-sm p-5 mb-4">
      <div class="flex items-center gap-2 mb-4">
        <span class="text-lg">🗓</span>
        <h2 class="font-bold text-gray-700 text-base">日別 Todo</h2>
      </div>
      ${dayGroupsHtml}
      <div class="${sortedDays.length ? 'border-t border-gray-100 pt-4 mt-2' : ''}">
        <p class="text-xs text-gray-400 mb-2">日付を選んで追加</p>
        <div class="flex gap-2 flex-wrap">
          <input type="date" id="newDate"
            class="text-sm border border-gray-200 rounded-lg px-3 py-1.5
                   focus:outline-none focus:border-blue-400"
            value="${defaultDay}" min="${ymStr}-01" max="${maxDay}">
          <input type="text" id="newDayText"
            class="flex-1 min-w-0 text-sm border border-gray-200 rounded-lg px-3 py-1.5
                   focus:outline-none focus:border-blue-400 placeholder-gray-300"
            placeholder="Todoを追加…" maxlength="200" autocomplete="off">
          <button id="newDayAdd"
            class="bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white
                   text-xs font-medium px-3 py-1.5 rounded-lg transition-colors flex-shrink-0">追加</button>
        </div>
      </div>
    </section>`;

  document.getElementById('content').innerHTML = monthlyHtml + weeklyHtml + dailyHtml;
  bindTodoEvents();
}

// ============================================================
// Todo event binding
// ============================================================
function bindAddForm(formId, onAdd) {
  const input = document.getElementById(`inp-${formId}`);
  const btn   = document.getElementById(`btn-${formId}`);
  if (!input || !btn) return;
  const submit = () => { const t = input.value.trim(); if (t) onAdd(t); };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

function bindTodoEvents() {
  const content = document.getElementById('content');
  const ymStr   = ym();

  // チェックボックス
  content.querySelectorAll('.todo-chk').forEach(el => {
    el.addEventListener('change', () => {
      const md = getMonth(ymStr);
      const { type, key, id } = el.dataset;
      let list;
      if      (type === 'monthly') list = md.monthly;
      else if (type === 'weekly')  list = md.weekly[key] || [];
      else                         list = md.daily[key]  || [];
      const item = list.find(t => t.id === id);
      if (item) item.done = !item.done;
      saveMonth(ymStr, md);
      scheduleNotifications();
      render();
    });
  });

  // 削除ボタン（ごみ箱へ）
  content.querySelectorAll('.todo-del').forEach(el => {
    el.addEventListener('click', () => {
      const md = getMonth(ymStr);
      const { type, key, id } = el.dataset;
      let list;
      if      (type === 'monthly') list = md.monthly;
      else if (type === 'weekly')  list = md.weekly[key] || [];
      else                         list = md.daily[key]  || [];
      const item = list.find(t => t.id === id);
      if (item) addToTrash(item, type, key, ymStr);
      if (type === 'monthly') {
        md.monthly = md.monthly.filter(t => t.id !== id);
      } else if (type === 'weekly') {
        if (md.weekly[key]) md.weekly[key] = md.weekly[key].filter(t => t.id !== id);
      } else {
        if (md.daily[key])  md.daily[key]  = md.daily[key].filter(t => t.id !== id);
      }
      saveMonth(ymStr, md);
      scheduleNotifications();
      render();
    });
  });

  // 編集ボタン
  content.querySelectorAll('.todo-edit').forEach(el => {
    el.addEventListener('click', () => {
      editingId = el.dataset.id;
      render();
      // フォーカスをインプットへ
      const input = content.querySelector('.edit-input');
      if (input) { input.focus(); input.select(); }
    });
  });

  // 編集保存・キャンセル
  function saveEdit(type, key, id) {
    const input = content.querySelector(`.edit-input[data-id="${id}"]`);
    if (!input) return;
    const newText = input.value.trim();
    if (!newText) return;
    const md = getMonth(ymStr);
    let list;
    if      (type === 'monthly') list = md.monthly;
    else if (type === 'weekly')  list = md.weekly[key] || [];
    else                         list = md.daily[key]  || [];
    const item = list.find(t => t.id === id);
    if (item) item.text = newText;
    saveMonth(ymStr, md);
    scheduleNotifications();
    editingId = null;
    render();
  }

  content.querySelectorAll('.edit-save').forEach(btn => {
    btn.addEventListener('click', () => saveEdit(btn.dataset.type, btn.dataset.key, btn.dataset.id));
  });
  content.querySelectorAll('.edit-cancel').forEach(btn => {
    btn.addEventListener('click', () => { editingId = null; render(); });
  });
  content.querySelectorAll('.edit-input').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  saveEdit(input.dataset.type, input.dataset.key, input.dataset.id);
      if (e.key === 'Escape') { editingId = null; render(); }
    });
  });

  // 月間追加
  bindAddForm('monthly', text => {
    const md = getMonth(ymStr);
    md.monthly.push({ id: genId(), text, done: false });
    saveMonth(ymStr, md);
    scheduleNotifications();
    render();
  });

  // 週間追加
  weeksInMonth(currentYear, currentMonth).forEach(w => {
    bindAddForm(`weekly-${w.key}`, text => {
      const md = getMonth(ymStr);
      if (!md.weekly[w.key]) md.weekly[w.key] = [];
      md.weekly[w.key].push({ id: genId(), text, done: false });
      saveMonth(ymStr, md);
      scheduleNotifications();
      render();
    });
  });

  // 日別インライン追加
  const isCurMon = (currentYear === today.getFullYear() && currentMonth === today.getMonth());
  const dKeySet  = new Set(Object.keys(getMonth(ymStr).daily).filter(d => (getMonth(ymStr).daily[d] || []).length > 0));
  if (selectedDate && selectedDate.startsWith(ymStr)) dKeySet.add(selectedDate);
  [...dKeySet].filter(d => d.startsWith(ymStr)).forEach(ds => {
    bindAddForm(`daily-${ds}`, text => {
      const md = getMonth(ymStr);
      if (!md.daily[ds]) md.daily[ds] = [];
      md.daily[ds].push({ id: genId(), text, done: false });
      saveMonth(ymStr, md);
      scheduleNotifications();
      render();
    });
  });

  // 日付指定追加
  const newDayAdd  = document.getElementById('newDayAdd');
  const newDateInp = document.getElementById('newDate');
  const newTextInp = document.getElementById('newDayText');
  if (newDayAdd) {
    const doAdd = () => {
      const text = newTextInp.value.trim();
      const ds   = newDateInp.value;
      if (!text || !ds) return;
      const md = getMonth(ymStr);
      if (!md.daily[ds]) md.daily[ds] = [];
      md.daily[ds].push({ id: genId(), text, done: false });
      saveMonth(ymStr, md);
      scheduleNotifications();
      render();
    };
    newDayAdd.addEventListener('click', doAdd);
    newTextInp.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
  }
}

// ============================================================
// Notification schedule panel
// ============================================================
function renderNotificationPanel() {
  const { notifyLeadMinutes } = loadSettings();
  const now    = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const items = [];
  for (const [ymStr, md] of Object.entries(localData)) {
    if (typeof md !== 'object' || Array.isArray(md) || ymStr === '_trash') continue;
    for (const todo of md.monthly || []) {
      if (todo.done) continue;
      const t = parseTime(todo.text);
      if (t) items.push({ todo, t, label: `月間 (${ymStr})` });
    }
    for (const [wk, list] of Object.entries(md.weekly || {})) {
      for (const todo of list) {
        if (todo.done) continue;
        const t = parseTime(todo.text);
        if (t) {
          const d = new Date(wk + 'T00:00:00');
          items.push({ todo, t, label: `週間 ${d.getMonth()+1}/${d.getDate()}〜` });
        }
      }
    }
    for (const [ds, list] of Object.entries(md.daily || {})) {
      for (const todo of list) {
        if (todo.done) continue;
        const t = parseTime(todo.text);
        if (t) {
          const d = new Date(ds + 'T00:00:00');
          items.push({ todo, t, label: `${d.getMonth()+1}/${d.getDate()}(${DOW_JA[d.getDay()]})` });
        }
      }
    }
  }

  items.sort((a, b) => (a.t.h * 60 + a.t.min) - (b.t.h * 60 + b.t.min));

  const fmt2 = n => String(n).padStart(2, '0');
  const notifyTimeStr = t => {
    const total = t.h * 60 + t.min - notifyLeadMinutes;
    const h = Math.floor(((total % 1440) + 1440) % 1440 / 60);
    const m = ((total % 60) + 60) % 60;
    return `${fmt2(h)}:${fmt2(m)}`;
  };
  const schedTimeStr = t => `${fmt2(t.h)}:${fmt2(t.min)}`;

  const itemsHtml = items.length
    ? items.map(({ todo, t, label }) => {
        const notifMin = t.h * 60 + t.min - notifyLeadMinutes;
        const isPast   = notifMin < nowMin;
        return `
          <div class="py-2.5 border-b border-gray-50 last:border-0 ${isPast ? 'opacity-40' : ''}">
            <div class="flex items-center gap-1 mb-0.5">
              <span class="text-xs font-bold ${isPast ? 'text-gray-400' : 'text-orange-500'}">${notifyTimeStr(t)}</span>
              <span class="text-gray-300 text-xs">→</span>
              <span class="text-xs text-gray-500">${schedTimeStr(t)}</span>
              ${isPast
                ? '<span class="ml-auto text-xs text-gray-400 bg-gray-100 rounded px-1">済</span>'
                : '<span class="ml-auto text-xs text-orange-400 bg-orange-50 rounded px-1">予定</span>'}
            </div>
            <p class="text-xs text-gray-700 break-all leading-snug">${esc(todo.text)}</p>
            <p class="text-xs text-gray-400 mt-0.5">${label}</p>
          </div>`;
      }).join('')
    : '<p class="text-xs text-gray-400 py-4 text-center">時刻付きのTodoなし</p>';

  document.getElementById('notificationPanel').innerHTML = `
    <div class="bg-white rounded-2xl shadow-sm p-4 sticky top-4">
      <div class="flex items-center gap-2 mb-3">
        <span class="text-base">🔔</span>
        <h2 class="text-sm font-bold text-gray-700">通知予定</h2>
        <span class="ml-auto text-xs text-gray-400">${notifyLeadMinutes}分前</span>
      </div>
      <div>${itemsHtml}</div>
    </div>`;
}

// ============================================================
// Settings modal
// ============================================================
function renderSettings() {
  const s    = loadSettings();
  const perm = Notification.permission;

  const permStatusHtml = {
    granted: '<span class="text-green-600 font-medium">✓ 許可済み</span>',
    denied:  '<span class="text-red-500 font-medium">✕ ブロック済み（ブラウザ設定から変更してください）</span>',
    default: '<span class="text-gray-500">未設定</span>',
  }[perm];

  const permBtnHtml = perm === 'default'
    ? `<button id="reqPermBtn"
         class="mt-2 text-xs bg-blue-500 hover:bg-blue-600 text-white
                px-3 py-1.5 rounded-lg transition-colors">通知を許可する</button>`
    : '';

  const userHtml = currentUser ? `
    <div class="flex items-center gap-3 p-3 bg-gray-50 rounded-xl mb-5">
      ${currentUser.photoURL
        ? `<img src="${currentUser.photoURL}" class="w-8 h-8 rounded-full flex-shrink-0">`
        : '<div class="w-8 h-8 rounded-full bg-gray-200 flex-shrink-0"></div>'}
      <div class="flex-1 min-w-0">
        <p class="text-xs font-medium text-gray-700 truncate">${currentUser.displayName || ''}</p>
        <p class="text-xs text-gray-400 truncate">${currentUser.email || ''}</p>
      </div>
      <button id="signOutBtn" class="text-xs text-red-400 hover:text-red-600 flex-shrink-0">サインアウト</button>
    </div>` : '';

  // ごみ箱
  cleanOldTrash();
  const trash = (localData._trash || []).sort((a, b) => b.deletedAt - a.deletedAt);
  const trashHtml = trash.length
    ? trash.map(t => {
        const hoursAgo = Math.floor((Date.now() - t.deletedAt) / 3_600_000);
        const timeLabel = hoursAgo < 1 ? 'たった今'
          : hoursAgo < 24 ? `${hoursAgo}時間前`
          : `${Math.floor(hoursAgo / 24)}日前`;
        return `
          <div class="flex items-center gap-2 py-2 border-b border-gray-50 last:border-0">
            <div class="flex-1 min-w-0">
              <p class="text-xs text-gray-600 break-all">${esc(t.text)}</p>
              <p class="text-xs text-gray-400">${timeLabel}</p>
            </div>
            <button class="trash-restore text-xs text-blue-500 hover:text-blue-700 flex-shrink-0 px-1"
              data-id="${esc(t.id)}">戻す</button>
            <button class="trash-perm-delete text-xs text-red-400 hover:text-red-600 flex-shrink-0 px-1"
              data-id="${esc(t.id)}">✕</button>
          </div>`;
      }).join('')
    : '<p class="text-xs text-gray-400 py-3 text-center">削除されたTodoはありません</p>';

  const panel = document.getElementById('settingsPanel');
  panel.innerHTML = `
    <div class="flex items-center justify-between mb-5">
      <h2 class="text-lg font-bold text-gray-800">設定</h2>
      <button id="closeSettings" class="text-gray-400 hover:text-gray-700 text-xl leading-none">✕</button>
    </div>
    ${userHtml}
    <div class="space-y-6">
      <div>
        <h3 class="text-sm font-semibold text-gray-700 mb-3">🔔 通知設定</h3>
        <div class="mb-4">
          <p class="text-xs text-gray-500 mb-1">通知の状態</p>
          <p class="text-sm">${permStatusHtml}</p>
          ${permBtnHtml}
        </div>
        <div>
          <label class="text-xs text-gray-500 mb-1 block">何分前に通知するか</label>
          <div class="flex items-center gap-2">
            <input type="number" id="leadMinInput"
              class="w-20 text-sm border border-gray-200 rounded-lg px-3 py-1.5 text-center
                     focus:outline-none focus:border-blue-400"
              value="${s.notifyLeadMinutes}" min="1" max="120">
            <span class="text-sm text-gray-600">分前</span>
          </div>
          <p class="text-xs text-gray-400 mt-1">タイトルに「1300~」のような時刻が含まれるTodoに適用されます</p>
        </div>
      </div>
      <div>
        <h3 class="text-sm font-semibold text-gray-700 mb-3">🗑 ごみ箱 <span class="text-xs font-normal text-gray-400">（7日間保持）</span></h3>
        <div class="max-h-48 overflow-y-auto">${trashHtml}</div>
      </div>
    </div>
    <div class="mt-6 flex justify-end gap-2">
      <button id="cancelSettings"
        class="text-sm text-gray-500 hover:text-gray-700 px-4 py-2 rounded-lg
               hover:bg-gray-50 transition-colors">キャンセル</button>
      <button id="saveSettings"
        class="text-sm bg-blue-500 hover:bg-blue-600 text-white px-4 py-2
               rounded-lg transition-colors font-medium">保存</button>
    </div>`;

  panel.querySelector('#closeSettings').addEventListener('click', closeSettings);
  panel.querySelector('#cancelSettings').addEventListener('click', closeSettings);
  panel.querySelector('#saveSettings').addEventListener('click', () => {
    const lead = parseInt(panel.querySelector('#leadMinInput').value, 10);
    if (!isNaN(lead) && lead >= 1 && lead <= 120) {
      saveSettings({ ...loadSettings(), notifyLeadMinutes: lead });
      scheduleNotifications();
    }
    closeSettings();
  });

  const reqBtn = panel.querySelector('#reqPermBtn');
  if (reqBtn) {
    reqBtn.addEventListener('click', async () => {
      await Notification.requestPermission();
      renderSettings();
      scheduleNotifications();
    });
  }

  const signOutBtn = panel.querySelector('#signOutBtn');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', () => { signOut(auth); closeSettings(); });
  }

  // ごみ箱操作
  panel.querySelectorAll('.trash-restore').forEach(btn => {
    btn.addEventListener('click', () => restoreFromTrash(btn.dataset.id));
  });
  panel.querySelectorAll('.trash-perm-delete').forEach(btn => {
    btn.addEventListener('click', () => permanentDeleteFromTrash(btn.dataset.id));
  });
}

function openSettings()  { renderSettings(); document.getElementById('settingsModal').classList.remove('hidden'); }
function closeSettings() { document.getElementById('settingsModal').classList.add('hidden'); }

// ============================================================
// Main render
// ============================================================
function render() {
  document.getElementById('monthTitle').textContent = `${currentYear}年${currentMonth + 1}月`;
  renderCalendarSidebar();
  renderTodoContent();
  renderNotificationPanel();
}

// ============================================================
// Month navigation
// ============================================================
document.getElementById('prevMonth').addEventListener('click', () => {
  if (--currentMonth < 0) { currentMonth = 11; currentYear--; }
  selectedDate = null;
  editingId    = null;
  render();
});
document.getElementById('nextMonth').addEventListener('click', () => {
  if (++currentMonth > 11) { currentMonth = 0; currentYear++; }
  selectedDate = null;
  editingId    = null;
  render();
});

// ============================================================
// Settings
// ============================================================
document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('settingsModal').addEventListener('click', e => {
  if (e.target === document.getElementById('settingsModal')) closeSettings();
});

// render() は onAuthStateChanged → startSync → onSnapshot の中で呼ばれる
