'use strict';
/* ============================================================
   Shekel Sense — private Hebrew budgeting ledger
   All data lives in this browser's localStorage. No servers.
   ============================================================ */

/* ---------------- utils ---------------- */
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const moneyFmt = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS' });
const fmtMoney = (n) => moneyFmt.format(Number(n) || 0);
// Signed variant: let the he-IL locale place +/- itself (suffix ₪, locale-correct
// sign position) instead of hand-prepending '+'/'−', which is bidi-fragile.
const moneyFmtSigned = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', signDisplay: 'exceptZero' });
const fmtSigned = (n) => moneyFmtSigned.format(Number(n) || 0);

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const monthKeyOf = (iso) => (iso || '').slice(0, 7);
const HEB_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
function hebMonthLabel(mk) {
  const [y, m] = mk.split('-').map(Number);
  return HEB_MONTHS[m - 1] + ' ' + y;
}
function shiftMonth(mk, delta) {
  let [y, m] = mk.split('-').map(Number);
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return y + '-' + String(m).padStart(2, '0');
}
function fmtDateIL(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return d + '/' + m + '/' + y;
}
const HEB_DAYS_SHORT = ['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳'];

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  // Clear the live-region text when the toast hides so no stale message
  // lingers in the accessibility tree after the toast disappears.
  toastTimer = setTimeout(() => { t.classList.remove('show'); t.textContent = ''; }, 2600);
}

/* ---------------- categories ---------------- */
const CATS = [
  { id: 'food',     he: 'מזון וסופר',      color: '#7fb98a' },
  { id: 'dining',   he: 'מסעדות ובתי קפה', color: '#e3c98f' },
  { id: 'transport',he: 'תחבורה',          color: '#8aa8d1' },
  { id: 'housing',  he: 'דיור',            color: '#b09ad1' },
  { id: 'bills',    he: 'חשבונות',         color: '#d1a48a' },
  { id: 'health',   he: 'בריאות',          color: '#8ad1c2' },
  { id: 'fun',      he: 'בידור ופנאי',     color: '#d18ab5' },
  { id: 'shopping', he: 'קניות',           color: '#a8c256' },
  { id: 'edu',      he: 'חינוך ולימודים',  color: '#7ea8d1' },
  { id: 'saving',   he: 'חיסכון',          color: '#c9a96a' },
  { id: 'other',    he: 'אחר',             color: '#97907e' },
];
const catById = (id) => CATS.find(c => c.id === id) || CATS[CATS.length - 1];

/* ---------------- store (localStorage, namespaced) ---------------- */
const K = { tx: 'ss.tx', rules: 'ss.rules', budgets: 'ss.budgets', recurring: 'ss.recurring', settings: 'ss.settings' };
const DB = {
  data: { tx: [], rules: {}, budgets: {}, recurring: [], settings: {} },
  load() {
    try {
      const raw = localStorage.getItem(K.tx);         if (raw) this.data.tx = JSON.parse(raw);
      const r2 = localStorage.getItem(K.rules);       if (r2) this.data.rules = JSON.parse(r2);
      const r3 = localStorage.getItem(K.budgets);     if (r3) this.data.budgets = JSON.parse(r3);
      const r4 = localStorage.getItem(K.recurring);   if (r4) this.data.recurring = JSON.parse(r4);
      const r5 = localStorage.getItem(K.settings);   if (r5) this.data.settings = JSON.parse(r5);
    } catch (e) { /* corrupted storage -> start clean */ }
    if (!Array.isArray(this.data.tx)) this.data.tx = [];
  },
  save() {
    try {
      localStorage.setItem(K.tx, JSON.stringify(this.data.tx));
      localStorage.setItem(K.rules, JSON.stringify(this.data.rules));
      localStorage.setItem(K.budgets, JSON.stringify(this.data.budgets));
      localStorage.setItem(K.recurring, JSON.stringify(this.data.recurring));
      localStorage.setItem(K.settings, JSON.stringify(this.data.settings));
    } catch (e) { toast('שמירה נכשלה — אחסון מלא או חסום'); }
  }
};

/* ---------------- merchant learning ---------------- */
function normMerchant(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/["'`״׳]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/(סניף|סנ\.?|branch|store|#)\s*\d+/gi, '')
    .trim();
}
function guessCategory(merchant) {
  const n = normMerchant(merchant);
  if (!n) return 'other';
  if (DB.data.rules[n]) return DB.data.rules[n];
  // keyword fallbacks (Hebrew + English)
  const KW = [
    [/סופר|שופרסל|רמי לוי|יינות ביתן|חצי חינם|am:pm|טיב טעם|ויקטורי|fresh|market|grocery/i, 'food'],
    [/קפה|ארומה|קפית|מסעדה|פיצה|המבורגר|סושי|בית קפה|coffee|restaurant|pizza/i, 'dining'],
    [/דלק|פז|סונול|דור אלון|חניה|pango|פנגו|רכבת|אגד|דן |מונית|uber|gett|fuel|parking/i, 'transport'],
    [/חשמל|מים|ארנונה|גז|אינטרנט|סלקום|פרטנר|פלאפון|הוט|yes|בזק/i, 'bills'],
    [/סופר-פארם|מכבי|כללית|מאוחדת|תרופה|בית מרקחת|pharmacy/i, 'health'],
    [/סינמה|קולנוע|תיאטרון|הופעה|נטפליקס|ספוטיפיי|disney|netflix|spotify/i, 'fun'],
  ];
  for (const [re, cat] of KW) if (re.test(merchant)) return cat;
  return 'other';
}
function learnRule(merchant, catId) {
  const n = normMerchant(merchant);
  if (n) { DB.data.rules[n] = catId; DB.save(); }
}

/* ---------------- derived data ---------------- */
function txInMonth(mk) {
  return DB.data.tx.filter(t => monthKeyOf(t.date) === mk);
}
function monthTotals(mk) {
  let exp = 0, inc = 0;
  for (const t of txInMonth(mk)) {
    if (t.type === 'income') inc += Number(t.amount) || 0;
    else exp += Number(t.amount) || 0;
  }
  return { exp, inc, net: inc - exp };
}
function detectSubscriptions() {
  // group expenses by normalized merchant across months
  const groups = {};
  for (const t of DB.data.tx) {
    if (t.type !== 'expense') continue;
    const n = normMerchant(t.merchant);
    if (!n) continue;
    (groups[n] = groups[n] || []).push(t);
  }
  const subs = [];
  for (const n in groups) {
    const list = groups[n];
    const months = new Set(list.map(t => monthKeyOf(t.date)));
    if (months.size < 2) continue;
    const amounts = list.map(t => Number(t.amount) || 0);
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const stable = avg > 0 && amounts.every(a => Math.abs(a - avg) / avg <= 0.25);
    if (!stable) continue;
    subs.push({
      merchant: list[0].merchant,
      category: list[0].category,
      months: months.size,
      avg, annual: avg * 12, count: list.length
    });
  }
  return subs.sort((a, b) => b.avg - a.avg);
}

/* ---------------- router ---------------- */
const ROUTES = ['dashboard', 'transactions', 'add', 'budgets', 'insights', 'import', 'settings'];
let route = 'dashboard';
let dashMonth = monthKeyOf(todayISO());
let txSearch = '';
let txMonth = monthKeyOf(todayISO());

function go(r) {
  route = ROUTES.includes(r) ? r : 'dashboard';
  render();
  window.scrollTo(0, 0);
}
function render() {
  const v = $('#view');
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.route === route));
  if (route === 'dashboard') vDashboard(v);
  else if (route === 'transactions') vTransactions(v);
  else if (route === 'add') vAdd(v);
  else if (route === 'budgets') vBudgets(v);
  else if (route === 'insights') vInsights(v);
  else if (route === 'import') vImport(v);
  else if (route === 'settings') vSettings(v);
  bindCommon(v);
}
function bindCommon(v) {
  $$('[data-go]', v).forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
}

/* ---------------- shared bits ---------------- */
function txRow(t, showDel) {
  const c = catById(t.category);
  const isInc = t.type === 'income';
  const dotColor = isInc ? '#7fb98a' : c.color;
  const catLabel = isInc ? 'הכנסה' : c.he;
  return `<div class="tx-row" data-id="${t.id}">
    <span class="tx-dot" style="background:${dotColor}"></span>
    <div class="tx-main">
      <div class="tx-merchant">${esc(t.merchant) || '<span class="muted">ללא שם</span>'}</div>
      <div class="tx-sub">${esc(catLabel)} · ${fmtDateIL(t.date)}${t.notes ? ' · ' + esc(t.notes) : ''}</div>
    </div>
    <div class="tx-amount ${t.type}">${fmtSigned(t.type === 'income' ? t.amount : -t.amount)}</div>
    ${showDel ? `<button class="tx-del" data-del="${t.id}" aria-label="מחיקה">×</button>` : ''}
  </div>`;
}
function bindDelete(scope) {
  $$('[data-del]', scope).forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!confirm('למחוק את העסקה?')) return;
    DB.data.tx = DB.data.tx.filter(t => t.id !== b.dataset.del);
    DB.save(); render(); toast('נמחק');
  }));
}

/* ---------------- dashboard ---------------- */
function vDashboard(v) {
  const mk = dashMonth;
  const { exp, inc, net } = monthTotals(mk);
  const list = txInMonth(mk).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 8);
  // planned (not-yet-applied) recurring templates for this month — display only,
  // never counted in totals or budgets
  const planned = plannedForMonth(mk);
  const pExp = planned.reduce((a, r) => a + ((r.type || 'expense') === 'expense' ? Number(r.amount) || 0 : 0), 0);
  const pInc = planned.reduce((a, r) => a + (r.type === 'income' ? Number(r.amount) || 0 : 0), 0);
  const plannedCard = planned.length ? `
      <div class="card">
        <h3>מתוכנן לחודש <span class="pill">${planned.length}</span></h3>
        <div class="kv"><span class="k">הוצאות צפויות</span><span>${fmtMoney(pExp)}</span></div>
        <div class="kv"><span class="k">הכנסות צפויות</span><span>${fmtMoney(pInc)}</span></div>
        <div style="margin-top:6px">${planned.map(plannedRowHTML).join('')}</div>
        <p class="small muted" style="margin-top:8px">סכומים מתוכננים אינם נכללים בסיכומים ובתקציבים — עד שיוחלו או שיגיע מועדם.</p>
      </div>` : '';
  // category breakdown (expenses)
  const byCat = {};
  for (const t of txInMonth(mk)) {
    if (t.type !== 'expense') continue;
    byCat[t.category] = (byCat[t.category] || 0) + Number(t.amount);
  }
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxCat = catRows.length ? catRows[0][1] : 1;

  v.innerHTML = `
    <div class="month-nav">
      <button class="nav-btn" id="m-prev" aria-label="חודש קודם">‹</button>
      <div class="m-label">${hebMonthLabel(mk)}</div>
      <button class="nav-btn" id="m-next" aria-label="חודש הבא">›</button>
    </div>
    <div class="summary-grid">
      <div class="summary-box"><div class="label">הוצאות</div><div class="value expense">${fmtMoney(exp)}</div></div>
      <div class="summary-box"><div class="label">הכנסות</div><div class="value income">${fmtMoney(inc)}</div></div>
      <div class="summary-box"><div class="label">מאזן</div><div class="value ${net >= 0 ? 'income' : 'expense'}">${fmtMoney(net)}</div></div>
    </div>
    ${plannedCard}
    ${DB.data.tx.length === 0 ? `
      <div class="empty">
        <div class="big">ברוכים הבאים ל־Shekel Sense</div>
        <div>עוד לא נרשמה אף עסקה.<br>הוסיפו עסקה ראשונה, או ייבאו דף חשבון — והקסם מתחיל.</div>
        <div class="btn-row" style="margin-top:14px">
          <button class="btn" data-go="add">הוספת הוצאה</button>
          <button class="btn btn-ghost" data-go="import">ייבוא</button>
        </div>
      </div>` : `
      ${catRows.length ? `<div class="card"><h3>הוצאות לפי קטגוריה</h3>
        ${catRows.map(([cid, sum]) => { const c = catById(cid); return `
          <div class="budget-row">
            <div class="budget-top"><span>${esc(c.he)}</span><span class="muted">${fmtMoney(sum)}</span></div>
            <div class="bar"><i style="width:${Math.round(sum / maxCat * 100)}%;background:${c.color}"></i></div>
          </div>`; }).join('')}
      </div>` : ''}
      <div class="card"><h3>עסקאות אחרונות</h3>
        ${list.length ? list.map(t => txRow(t, false)).join('') : '<div class="muted">אין עסקאות החודש.</div>'}
        <button class="btn btn-ghost" data-go="transactions" style="margin-top:12px">כל העסקאות</button>
      </div>`}
  `;
  $('#m-prev').addEventListener('click', () => { dashMonth = shiftMonth(dashMonth, -1); render(); });
  $('#m-next').addEventListener('click', () => { dashMonth = shiftMonth(dashMonth, 1); render(); });
  bindDelete(v);
}

/* ---------------- transactions ---------------- */
function vTransactions(v) {
  const q = txSearch.trim().toLowerCase();
  let list = DB.data.tx.filter(t => monthKeyOf(t.date) === txMonth);
  if (q) list = DB.data.tx.filter(t =>
    (t.merchant || '').toLowerCase().includes(q) ||
    (t.notes || '').toLowerCase().includes(q) ||
    catById(t.category).he.includes(txSearch.trim()));
  list = list.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt - a.createdAt));

  v.innerHTML = `
    <h2 class="section-title">עסקאות</h2>
    <div class="card">
      <div class="field" style="margin-bottom:10px">
        <input type="text" id="tx-q" class="searchbar" placeholder="חיפוש עסק, הערה או קטגוריה…" value="${esc(txSearch)}">
      </div>
      <div class="month-nav" style="margin-bottom:6px">
        <button class="nav-btn" id="t-prev">‹</button>
        <div class="m-label" style="font-size:1rem">${q ? 'כל התקופות' : hebMonthLabel(txMonth)}</div>
        <button class="nav-btn" id="t-next">›</button>
      </div>
    </div>
    <div class="card">
      ${list.length ? list.map(t => txRow(t, true)).join('') : '<div class="muted">לא נמצאו עסקאות.</div>'}
    </div>
  `;
  $('#tx-q').addEventListener('input', (e) => { txSearch = e.target.value; render(); const el = $('#tx-q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  $('#t-prev').addEventListener('click', () => { txMonth = shiftMonth(txMonth, -1); render(); });
  $('#t-next').addEventListener('click', () => { txMonth = shiftMonth(txMonth, 1); render(); });
  bindDelete(v);
}

/* ---------------- add expense ---------------- */
let addType = 'expense';
function vAdd(v) {
  v.innerHTML = `
    <h2 class="section-title">הוספת ${addType === 'expense' ? 'הוצאה' : 'הכנסה'}</h2>
    <div class="card">
      <div class="type-toggle">
        <button id="tt-exp" class="${addType === 'expense' ? 'on-expense' : ''}">הוצאה</button>
        <button id="tt-inc" class="${addType === 'income' ? 'on-income' : ''}">הכנסה</button>
      </div>
      <div class="field">
        <label>סכום (₪)</label>
        <input type="number" id="f-amount" class="amount-input" inputmode="decimal" min="0" step="0.01" placeholder="0">
      </div>
      <div class="field">
        <label>עסק / תיאור</label>
        <input type="text" id="f-merchant" list="merchant-list" placeholder="${addType === 'income' ? 'למשל: מעסיק' : 'למשל: שופרסל'}" autocomplete="off">
        <datalist id="merchant-list">${[...new Set(DB.data.tx.map(t => t.merchant).filter(Boolean))].slice(0, 60).map(m => `<option value="${esc(m)}">`).join('')}</datalist>
      </div>
      ${addType === 'income' ? '' : `
      <div class="field">
        <label>קטגוריה <span class="muted small" id="cat-hint"></span></label>
        <div class="chip-row" id="cat-chips">
          ${CATS.map(c => `<button class="chip" data-cat="${c.id}"><span class="dot" style="background:${c.color}"></span>${c.he}</button>`).join('')}
        </div>
      </div>`}
      <div class="field">
        <label>תאריך</label>
        <input type="date" id="f-date" value="${todayISO()}">
      </div>
      <div class="field">
        <label>הערה (אופציונלי)</label>
        <input type="text" id="f-notes" placeholder="">
      </div>
      <button class="btn" id="f-save">שמירה</button>
    </div>
  `;
  let selCat = 'other';
  const chips = $$('#cat-chips .chip');
  const pick = (id) => { selCat = id; chips.forEach(ch => ch.classList.toggle('selected', ch.dataset.cat === id)); };
  chips.forEach(ch => ch.addEventListener('click', () => pick(ch.dataset.cat)));
  $('#tt-exp').addEventListener('click', () => { addType = 'expense'; render(); });
  $('#tt-inc').addEventListener('click', () => { addType = 'income'; render(); });
  const mInput = $('#f-merchant');
  mInput.addEventListener('input', () => {
    const g = guessCategory(mInput.value);
    const hint = $('#cat-hint');
    if (mInput.value.trim().length > 1) {
      pick(g);
      const known = DB.data.rules[normMerchant(mInput.value)];
      if (hint) hint.textContent = known ? '· נלמד ממך' : '· ניחוש אוטומטי';
    } else if (hint) { hint.textContent = ''; }
  });
  $('#f-save').addEventListener('click', () => {
    const amount = parseFloat($('#f-amount').value);
    if (!amount || amount <= 0) { toast('נא להזין סכום תקין'); return; }
    const merchant = mInput.value.trim();
    const t = {
      id: uid(), type: addType, amount: Math.round(amount * 100) / 100,
      merchant, category: addType === 'income' ? 'income' : selCat,
      date: $('#f-date').value || todayISO(),
      notes: $('#f-notes').value.trim(), source: 'manual', createdAt: Date.now()
    };
    DB.data.tx.push(t);
    if (t.type === 'expense' && merchant) learnRule(merchant, t.category); else DB.save();
    toast('נשמר ✓');
    go('dashboard');
  });
  setTimeout(() => $('#f-amount').focus(), 60);
}

/* ---------------- budgets ---------------- */
function vBudgets(v) {
  const mk = dashMonth;
  const spent = {};
  for (const t of txInMonth(mk)) {
    if (t.type !== 'expense') continue;
    spent[t.category] = (spent[t.category] || 0) + Number(t.amount);
  }
  const rows = CATS.map(c => {
    const b = Number(DB.data.budgets[c.id]) || 0;
    const s = spent[c.id] || 0;
    return { c, b, s, pct: b > 0 ? Math.min(100, Math.round(s / b * 100)) : 0 };
  }).filter(r => r.b > 0 || r.s > 0);

  v.innerHTML = `
    <h2 class="section-title">תקציבים · ${hebMonthLabel(mk)}</h2>
    <div class="card">
      <div class="field" style="margin-bottom:6px">
        <label>הגדרת תקציב חודשי לקטגוריה</label>
        <div class="copy-row">
          <select id="b-cat" style="flex:1">${CATS.map(c => `<option value="${c.id}">${c.he}</option>`).join('')}</select>
          <input type="number" id="b-amount" inputmode="decimal" min="0" placeholder="₪" style="max-width:120px">
          <button class="btn" id="b-save">שמור</button>
        </div>
      </div>
    </div>
    <div class="card">
      ${rows.length ? rows.map(({ c, b, s, pct }) => `
        <div class="budget-row">
          <div class="budget-top">
            <span><span class="tx-dot" style="background:${c.color};display:inline-block;margin-left:6px"></span>${esc(c.he)}</span>
            <span class="muted">${fmtMoney(s)}${b ? ' / ' + fmtMoney(b) : ''}</span>
          </div>
          ${b ? `<div class="bar ${s > b ? 'over' : ''}"><i style="width:${pct}%"></i></div>
          <div class="small ${s > b ? '' : 'muted'}" style="margin-top:4px;color:${s > b ? 'var(--red)' : 'var(--muted)'}">
            ${s > b ? 'חריגה של ' + fmtMoney(s - b) : 'נותרו ' + fmtMoney(b - s)}
          </div>` : `<div class="small muted">אין תקציב מוגדר</div>`}
        </div>`).join('') : '<div class="empty"><div class="big">עוד אין תקציבים</div><div>הגדירו תקציב חודשי לכל קטגוריה — הפס יראה כמה נשאר.</div></div>'}
    </div>
    <div class="card">
      <h3>תבניות קבועות</h3>
      <p class="small muted" style="margin-top:-6px">הוצאות או הכנסות שחוזרות כל חודש — שכר דירה, משכורת, מנויים.</p>
      <div id="rec-list">${recurringListHTML()}</div>
      <hr class="divider">
      <div class="type-toggle" id="r-type" style="margin-bottom:12px">
        <button data-rt="expense" class="on-expense">הוצאה קבועה</button>
        <button data-rt="income">הכנסה קבועה</button>
      </div>
      <div class="field"><label>עסק / תיאור</label><input type="text" id="r-merchant" placeholder="למשל: שכר דירה"></div>
      <button class="btn btn-ghost" id="r-salary" style="margin-top:-6px;margin-bottom:14px">מילוי מהיר: משכורת</button>
      <div class="btn-row">
        <div class="field" style="flex:1;margin:0"><label>סכום</label><input type="number" id="r-amount" inputmode="decimal" min="0"></div>
        <div class="field" style="flex:1;margin:0"><label>יום בחודש</label><input type="number" id="r-day" min="1" max="28" value="1"></div>
      </div>
      <div class="field" id="r-cat-field" style="margin-top:10px"><label>קטגוריה</label>
        <select id="r-cat">${CATS.map(c => `<option value="${c.id}">${c.he}</option>`).join('')}</select>
      </div>
      <button class="btn btn-ghost" id="r-add">הוספת תבנית קבועה</button>
      <button class="btn" id="r-apply" style="margin-top:10px">החלת החודש (${hebMonthLabel(monthKeyOf(todayISO()))})</button>
    </div>
  `;
  $('#b-save').addEventListener('click', () => {
    const cid = $('#b-cat').value, amt = parseFloat($('#b-amount').value);
    if (!amt || amt <= 0) { toast('נא להזין סכום'); return; }
    DB.data.budgets[cid] = Math.round(amt * 100) / 100;
    DB.save(); render(); toast('התקציב נשמר');
  });
  let recType = 'expense';
  const rtBtns = $$('#r-type button');
  const setRecType = (t) => {
    recType = t;
    rtBtns.forEach(b => {
      b.classList.remove('on-expense', 'on-income');
      if (b.dataset.rt === t) b.classList.add(t === 'income' ? 'on-income' : 'on-expense');
    });
    const cf = $('#r-cat-field');
    if (cf) cf.style.display = t === 'income' ? 'none' : '';
  };
  rtBtns.forEach(b => b.addEventListener('click', () => setRecType(b.dataset.rt)));
  $('#r-salary').addEventListener('click', () => {
    $('#r-merchant').value = 'משכורת';
    setRecType('income');
    $('#r-amount').focus();
    toast('מלאו סכום ויום בחודש');
  });
  $('#r-add').addEventListener('click', () => {
    const merchant = $('#r-merchant').value.trim(), amount = parseFloat($('#r-amount').value);
    const day = Math.min(28, Math.max(1, parseInt($('#r-day').value) || 1));
    if (!merchant || !amount || amount <= 0) { toast('נא למלא עסק וסכום'); return; }
    DB.data.recurring.push({ id: uid(), type: recType, merchant, amount: Math.round(amount * 100) / 100, category: recType === 'income' ? 'income' : $('#r-cat').value, day, active: true });
    DB.save(); render(); toast('התבנית נוספה');
  });
  $('#r-apply').addEventListener('click', applyRecurring);
  $$('#rec-list [data-rdel]').forEach(b => b.addEventListener('click', () => {
    DB.data.recurring = DB.data.recurring.filter(r => r.id !== b.dataset.rdel);
    DB.save(); render();
  }));
}
function recurringListHTML() {
  if (!DB.data.recurring.length) return '<div class="muted">אין תבניות עדיין.</div>';
  return DB.data.recurring.map(r => {
    const type = r.type || 'expense';
    const isInc = type === 'income';
    const c = catById(r.category);
    return `
    <div class="tx-row">
      <span class="tx-dot" style="background:${isInc ? '#7fb98a' : c.color}"></span>
      <div class="tx-main"><div class="tx-merchant">${esc(r.merchant)}</div>
      <div class="tx-sub">כל חודש ביום ${r.day} · ${isInc ? 'הכנסה' : 'הוצאה'}</div></div>
      <div class="tx-amount ${type}">${fmtSigned(isInc ? r.amount : -r.amount)}</div>
      <button class="tx-del" data-rdel="${r.id}" aria-label="מחיקת תבנית">×</button>
    </div>`;
  }).join('');
}
function applyRecurring() {
  const mk = monthKeyOf(todayISO());
  const [y, m] = mk.split('-').map(Number);
  let added = 0;
  for (const r of DB.data.recurring) {
    if (!r.active) continue;
    const type = r.type || 'expense';
    const date = `${y}-${String(m).padStart(2, '0')}-${String(r.day).padStart(2, '0')}`;
    const exists = DB.data.tx.some(t => t.source === 'recurring:' + r.id && monthKeyOf(t.date) === mk);
    if (exists) continue;
    DB.data.tx.push({ id: uid(), type, amount: r.amount, merchant: r.merchant, category: type === 'income' ? 'income' : r.category, date, notes: type === 'income' ? 'הכנסה קבועה' : 'הוצאה קבועה', source: 'recurring:' + r.id, createdAt: Date.now() });
    if (type === 'expense' && r.merchant) learnRule(r.merchant, r.category);
    added++;
  }
  DB.save(); render();
  toast(added ? `נוספו ${added} עסקאות קבועות` : 'כל התבניות כבר הוחלו החודש');
}

/* ---------------- planned (not-yet-applied) recurring ---------------- */
// Templates for the viewed month that have no actual transaction yet.
// Shown on the dashboard as "planned" from the 1st of the month,
// regardless of their day-of-month. Never counted in totals/budgets.
function plannedForMonth(mk) {
  // past months are closed history — no planned items there
  if (mk < monthKeyOf(todayISO())) return [];
  const out = [];
  for (const r of DB.data.recurring) {
    if (!r.active) continue;
    const type = r.type || 'expense';
    // already applied via החלת החודש?
    const applied = DB.data.tx.some(t => t.source === 'recurring:' + r.id && monthKeyOf(t.date) === mk);
    if (applied) continue;
    // already recorded manually this month? (same merchant + amount)
    const manual = DB.data.tx.some(t =>
      monthKeyOf(t.date) === mk &&
      !(t.source || '').startsWith('recurring:') &&
      t.type === type &&
      Math.abs(Number(t.amount) - Number(r.amount)) < 0.005 &&
      normMerchant(t.merchant) === normMerchant(r.merchant));
    if (manual) continue;
    out.push(r);
  }
  return out;
}
function plannedRowHTML(r) {
  const type = r.type || 'expense';
  const isInc = type === 'income';
  const c = catById(r.category);
  return `
  <div class="tx-row planned">
    <span class="tx-dot" style="background:${isInc ? '#7fb98a' : c.color}"></span>
    <div class="tx-main">
      <div class="tx-merchant">${esc(r.merchant)}<span class="badge-planned">מתוכנן</span></div>
      <div class="tx-sub">כל חודש ביום ${r.day} · ${isInc ? 'הכנסה' : 'הוצאה'}</div>
    </div>
    <div class="tx-amount ${type}">${fmtSigned(isInc ? r.amount : -r.amount)}</div>
  </div>`;
}

/* ---------------- insights ---------------- */
function vInsights(v) {
  const mk = monthKeyOf(todayISO());
  const prev = shiftMonth(mk, -1);
  const cur = monthTotals(mk), prv = monthTotals(prev);
  const delta = cur.exp - prv.exp;
  const deltaPct = prv.exp > 0 ? Math.round(delta / prv.exp * 100) : (cur.exp > 0 ? 100 : 0);

  // top merchants this month
  const byMerch = {};
  for (const t of txInMonth(mk)) {
    if (t.type !== 'expense') continue;
    const n = normMerchant(t.merchant) || '(ללא שם)';
    byMerch[n] = byMerch[n] || { name: t.merchant || 'ללא שם', sum: 0 };
    byMerch[n].sum += Number(t.amount);
  }
  const top = Object.values(byMerch).sort((a, b) => b.sum - a.sum).slice(0, 5);
  const maxTop = top.length ? top[0].sum : 1;

  // spending by weekday (all time expenses)
  const wd = [0, 0, 0, 0, 0, 0, 0];
  for (const t of DB.data.tx) {
    if (t.type !== 'expense' || !t.date) continue;
    const d = new Date(t.date + 'T12:00:00');
    if (!isNaN(d)) wd[d.getDay()] += Number(t.amount) || 0;
  }
  const maxWd = Math.max(1, ...wd);

  const subs = detectSubscriptions();
  const subsMonthly = subs.reduce((a, s) => a + s.avg, 0);

  v.innerHTML = `
    <h2 class="section-title">תובנות</h2>
    ${DB.data.tx.length === 0 ? '<div class="empty"><div class="big">עוד אין נתונים</div><div>הוסיפו כמה עסקאות — התובנות יופיעו כאן מעצמן.</div></div>' : `
    <div class="card">
      <h3>החודש מול חודש שעבר</h3>
      <div class="kv"><span class="k">${hebMonthLabel(prev)}</span><span>${fmtMoney(prv.exp)}</span></div>
      <div class="kv"><span class="k">${hebMonthLabel(mk)}</span><span>${fmtMoney(cur.exp)}</span></div>
      <div class="kv"><span class="k">שינוי בהוצאות</span>
        <span style="color:${delta <= 0 ? 'var(--green)' : 'var(--red)'}">${fmtSigned(delta)} (${deltaPct > 0 ? '+' : ''}${deltaPct}%)</span></div>
      <div class="kv"><span class="k">הכנסות החודש</span><span>${fmtMoney(cur.inc)}</span></div>
      <div class="kv"><span class="k">מאזן (הכנסות פחות הוצאות)</span>
        <span style="color:${cur.net >= 0 ? 'var(--green)' : 'var(--red)'}">${fmtMoney(cur.net)}</span></div>
    </div>
    <div class="card">
      <h3>עסקים מובילים החודש</h3>
      ${top.length ? top.map(m => `
        <div class="budget-row">
          <div class="budget-top"><span>${esc(m.name)}</span><span class="muted">${fmtMoney(m.sum)}</span></div>
          <div class="bar"><i style="width:${Math.round(m.sum / maxTop * 100)}%"></i></div>
        </div>`).join('') : '<div class="muted">אין הוצאות החודש.</div>'}
    </div>
    <div class="card">
      <h3>הוצאות לפי יום בשבוע</h3>
      <div class="weekday-chart">
        ${wd.map((sum, i) => `
          <div class="weekday-col">
            <div class="weekday-bar" style="height:${Math.max(3, Math.round(sum / maxWd * 88))}px" title="${fmtMoney(sum)}"></div>
            <div class="weekday-lbl">${HEB_DAYS_SHORT[i]}</div>
          </div>`).join('')}
      </div>
      <div class="small muted" style="margin-top:6px">סה״כ מצטבר לכל יום, מאז ההתחלה.</div>
    </div>
    <div class="card">
      <h3>מנויים והוצאות חוזרות <span class="pill">${fmtMoney(subsMonthly)} לחודש</span></h3>
      ${subs.length ? subs.map(s => `
        <div class="kv"><span class="k">${esc(s.merchant)} <span class="muted small">· ${s.months} חודשים</span></span>
        <span>${fmtMoney(s.avg)}<span class="muted small"> / ${fmtMoney(s.annual)} לשנה</span></span></div>`).join('')
        : '<div class="muted">לא זוהו תשלומים חוזרים. ככל שיירשמו יותר חודשים — הזיהוי ישתפר.</div>'}
    </div>`}
  `;
}

/* ---------------- CSV import ---------------- */
function parseCSV(text) {
  // detect delimiter
  const firstLine = text.split(/\r?\n/).find(l => l.trim()) || '';
  const semis = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const delim = semis > commas ? ';' : ',';
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (field !== '' || row.length) { row.push(field); rows.push(row); }
      row = []; field = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}
function parseAmountLoose(s) {
  if (s == null) return NaN;
  let t = String(s).trim().replace(/[₪$€\s]/g, '').replace(/"/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  // he-IL thousands: 1,234.56 or 1.234,56
  if (t.indexOf(',') > -1 && t.indexOf('.') > -1) {
    t = t.lastIndexOf('.') > t.lastIndexOf(',') ? t.replace(/,/g, '') : t.replace(/\./g, '').replace(',', '.');
  } else if (t.indexOf(',') > -1) {
    const parts = t.split(',');
    t = parts.length === 2 && parts[1].length <= 2 ? parts.join('.') : t.replace(/,/g, '');
  }
  const n = parseFloat(t);
  return isNaN(n) ? NaN : (neg ? -n : n);
}
function parseDateLoose(s) {
  if (!s) return null;
  const t = String(s).trim().slice(0, 10);
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) {
    let y = m[3]; if (y.length === 2) y = '20' + y;
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}
let csvState = null;
function vImport(v) {
  v.innerHTML = `
    <h2 class="section-title">ייבוא וגיבוי</h2>
    <div class="card">
      <h3>ייבוא מקובץ CSV</h3>
      <p class="small muted">מתאים לייצוא מדפי בנק וחברות אשראי ישראליות. בחרו קובץ, מפו את העמודות, ובדקו לפני הייבוא.</p>
      <button class="btn btn-ghost" id="csv-pick">בחר קובץ CSV</button>
      <input type="file" id="csv-file" accept=".csv,.txt" style="display:none">
      <div class="small muted file-name" id="csv-name"></div>
      <div id="csv-map"></div>
      <div id="csv-preview"></div>
    </div>
    <div class="card">
      <h3>סנכרון Gmail</h3>
      <p class="small muted">מוצא קבלות בתיבת המייל ושולח אותן למסך בדיקה לפני הייבוא. דורש הגדרה חד־פעמית בהגדרות.</p>
      <button class="btn btn-ghost" id="gmail-go">סנכרון Gmail</button>
      <div id="gmail-status" class="small muted" style="margin-top:8px"></div>
    </div>
    <div class="card">
      <h3>גיבוי</h3>
      <div class="btn-row">
        <button class="btn btn-ghost" id="bk-export">ייצוא גיבוי (JSON)</button>
        <button class="btn btn-ghost" id="bk-import-btn">ייבוא גיבוי</button>
      </div>
      <input type="file" id="bk-import" accept=".json" style="display:none">
      <p class="small muted" style="margin-top:10px">הגיבוי כולל את כל העסקאות, התקציבים, החוקים והתבניות. שמרו אותו במקום בטוח.</p>
    </div>
  `;
  $('#csv-pick').addEventListener('click', () => $('#csv-file').click());
  $('#csv-file').addEventListener('change', (e) => {
    const f = e.target.files[0];
    $('#csv-name').textContent = f ? 'קובץ נבחר: ' + f.name : '';
    onCsvFile(e);
  });
  $('#bk-export').addEventListener('click', exportBackup);
  $('#bk-import-btn').addEventListener('click', () => $('#bk-import').click());
  $('#bk-import').addEventListener('change', onBackupFile);
  $('#gmail-go').addEventListener('click', gmailSync);
}
function onCsvFile(e) {
  const f = e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    let text = String(rd.result || '');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = parseCSV(text);
    if (rows.length < 2) { toast('הקובץ ריק או לא תקין'); return; }
    const header = rows[0];
    const hasHeader = header.some(c => /[א-תa-zA-Z]/.test(c) && isNaN(parseAmountLoose(c)));
    const dataRows = hasHeader ? rows.slice(1) : rows;
    csvState = { rows: dataRows, header, map: { date: -1, desc: -1, amount: -1 } };
    // auto-guess mapping
    const cols = header.length;
    for (let c = 0; c < cols; c++) {
      const sample = dataRows.slice(0, 8).map(r => r[c]);
      if (csvState.map.date < 0 && sample.some(x => parseDateLoose(x))) csvState.map.date = c;
      if (csvState.map.amount < 0 && sample.filter(x => !isNaN(parseAmountLoose(x))).length >= 4) csvState.map.amount = c;
    }
    if (csvState.map.desc < 0) {
      let best = -1, bestScore = -1;
      for (let c = 0; c < cols; c++) {
        if (c === csvState.map.date || c === csvState.map.amount) continue;
        const score = dataRows.slice(0, 8).filter(r => /[א-תa-zA-Z]{3,}/.test(r[c] || '')).length;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      csvState.map.desc = best;
    }
    renderCsvMap();
  };
  rd.readAsText(f, 'utf-8');
}
function renderCsvMap() {
  const st = csvState;
  const opts = (sel) => st.header.map((h, i) =>
    `<option value="${i}" ${st.map[sel] === i ? 'selected' : ''}>עמודה ${i + 1}${h ? ': ' + esc(String(h).slice(0, 24)) : ''}</option>`).join('');
  $('#csv-map').innerHTML = `
    <div class="field"><label>עמודת תאריך</label><select id="cm-date">${opts('date')}</select></div>
    <div class="field"><label>עמודת תיאור</label><select id="cm-desc">${opts('desc')}</select></div>
    <div class="field"><label>עמודת סכום</label><select id="cm-amount">${opts('amount')}</select></div>
    <button class="btn" id="csv-do">ייבוא ${st.rows.length} שורות</button>
    <div class="small muted" style="margin-top:8px">תצוגה מקדימה (5 ראשונות):</div>
    <div class="small" style="overflow-x:auto"><table style="width:100%;font-size:0.8rem">
      ${st.rows.slice(0, 5).map(r => `<tr>${r.map(c => `<td style="padding:4px;border-bottom:1px solid var(--line)">${esc(String(c).slice(0, 30))}</td>`).join('')}</tr>`).join('')}
    </table></div>`;
  $('#cm-date').addEventListener('change', (e) => st.map.date = +e.target.value);
  $('#cm-desc').addEventListener('change', (e) => st.map.desc = +e.target.value);
  $('#cm-amount').addEventListener('change', (e) => st.map.amount = +e.target.value);
  $('#csv-do').addEventListener('click', doCsvImport);
}
function doCsvImport() {
  const st = csvState;
  if (st.map.date < 0 || st.map.amount < 0) { toast('נא למפות תאריך וסכום'); return; }
  let added = 0, skipped = 0;
  const seen = new Set(DB.data.tx.map(t => t.date + '|' + t.amount + '|' + normMerchant(t.merchant)));
  for (const r of st.rows) {
    const date = parseDateLoose(r[st.map.date]);
    const amount = parseAmountLoose(r[st.map.amount]);
    if (!date || isNaN(amount) || amount === 0) { skipped++; continue; }
    const merchant = st.map.desc >= 0 ? String(r[st.map.desc] || '').trim().slice(0, 80) : '';
    const key = date + '|' + Math.abs(amount) + '|' + normMerchant(merchant);
    if (seen.has(key)) { skipped++; continue; }
    const type = amount < 0 ? 'expense' : 'income';
    const cat = type === 'expense' ? guessCategory(merchant) : 'income';
    DB.data.tx.push({ id: uid(), type, amount: Math.abs(Math.round(amount * 100) / 100), merchant, category: cat, date, notes: '', source: 'csv', createdAt: Date.now() });
    if (type === 'expense' && merchant) learnRule(merchant, cat);
    seen.add(key); added++;
  }
  DB.save(); csvState = null; render();
  toast(`יובאו ${added} עסקאות${skipped ? `, דולגו ${skipped}` : ''}`);
}
function exportBackup() {
  const blob = new Blob([JSON.stringify(DB.data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'shekel-sense-backup-' + todayISO() + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('הגיבוי יוצא');
}
function onBackupFile(e) {
  const f = e.target.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const d = JSON.parse(String(rd.result));
      if (!d || !Array.isArray(d.tx)) throw new Error('bad');
      if (!confirm('הייבוא יחליף את כל הנתונים הנוכחיים. להמשיך?')) return;
      DB.data = {
        tx: d.tx || [], rules: d.rules || {}, budgets: d.budgets || {},
        recurring: d.recurring || [], settings: d.settings || {}
      };
      DB.save(); render(); toast('הגיבוי שוחזר');
    } catch (err) { toast('קובץ הגיבוי לא תקין'); }
  };
  rd.readAsText(f, 'utf-8');
}

/* ---------------- Gmail import (Google Identity Services popup) ---------------- */
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_ORIGIN = 'https://ohrmich-png.github.io';
let gapiToken = null;

function gmailEnsureScript(cb) {
  if (window.google && google.accounts && google.accounts.oauth2) { cb(); return; }
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true; s.defer = true;
  s.onload = cb;
  s.onerror = () => toast('טעינת Google נכשלה — בדקו חיבור לאינטרנט');
  document.head.appendChild(s);
}
function gmailSync() {
  const clientId = (DB.data.settings.clientId || '').trim();
  if (!clientId) {
    gmailSetupOpen = true; gmailStep = 1;
    go('settings');
    toast('חברו את Gmail קודם — הגדרה חד־פעמית של כ־10 דקות');
    return;
  }
  const status = $('#gmail-status');
  if (status) status.textContent = 'מתחבר ל־Gmail…';
  gmailEnsureScript(() => {
    try {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: GMAIL_SCOPE,
        callback: (resp) => {
          if (resp && resp.access_token) {
            gapiToken = resp.access_token;
            gmailSearch(status);
          } else {
            if (status) status.textContent = 'החיבור נדחה או נכשל.';
          }
        },
      });
      client.requestAccessToken({ prompt: 'select_account' });
    } catch (e) {
      if (status) status.textContent = 'שגיאה בפתיחת החיבור.';
    }
  });
}
async function gmailSearch(status) {
  try {
    if (status) status.textContent = 'מחפש קבלות…';
    const q = encodeURIComponent('newer_than:60d (subject:קבלה OR subject:receipt OR subject:חשבונית OR subject:invoice OR subject:תשלום OR subject:payment)');
    const lr = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=20`, {
      headers: { Authorization: 'Bearer ' + gapiToken }
    });
    if (!lr.ok) throw new Error('list failed');
    const lj = await lr.json();
    const msgs = lj.messages || [];
    if (!msgs.length) { if (status) status.textContent = 'לא נמצאו קבלות ב־60 הימים האחרונים.'; return; }
    const cands = [];
    for (const m of msgs.slice(0, 20)) {
      const gr = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, {
        headers: { Authorization: 'Bearer ' + gapiToken }
      });
      if (!gr.ok) continue;
      const gj = await gr.json();
      const cand = gmailParseMessage(gj);
      if (cand) cands.push(cand);
    }
    if (status) status.textContent = '';
    gmailReview(cands);
  } catch (e) {
    if (status) status.textContent = 'החיפוש נכשל. נסו שוב.';
  }
}
function gmailParseMessage(gj) {
  const headers = {};
  (gj.payload && gj.payload.headers || []).forEach(h => headers[h.name.toLowerCase()] = h.value);
  const subject = headers.subject || '';
  const from = headers.from || '';
  const dateMs = Number(gj.internalDate) || Date.now();
  const d = new Date(dateMs);
  const date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const snippet = gj.snippet || '';
  const pats = [
    /₪\s*([\d,]+(?:\.\d{1,2})?)/,
    /([\d,]+(?:\.\d{1,2})?)\s*₪/,
    /סה["׳”כ]*\s*[:\-]?\s*₪?\s*([\d,]+(?:\.\d{1,2})?)/,
    /total\s*[:\-]?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\bILS\s*([\d,]+(?:\.\d{1,2})?)/
  ];
  let amount = NaN;
  for (const p of pats) {
    const m = (subject + ' ' + snippet).match(p);
    if (m) { amount = parseAmountLoose(m[1]); if (!isNaN(amount) && amount > 0) break; }
  }
  if (isNaN(amount) || amount <= 0) return null;
  let merchant = from.replace(/<.*>/, '').replace(/["']/g, '').trim().slice(0, 60) || subject.slice(0, 60);
  return { merchant, amount: Math.round(amount * 100) / 100, date, subject: subject.slice(0, 80) };
}
function gmailReview(cands) {
  const v = $('#view');
  v.innerHTML = `
    <h2 class="section-title">בדיקת קבלות מ־Gmail</h2>
    <div class="card">
      <p class="small muted">נמצאו ${cands.length} קבלות אפשריות. סמנו את מה לייבא — שום דבר לא נכנס לספר לפני אישורכם.</p>
      ${cands.length ? cands.map((c, i) => `
        <label class="check-row">
          <input type="checkbox" data-gi="${i}" checked>
          <div class="tx-main">
            <div class="tx-merchant">${esc(c.merchant)}</div>
            <div class="tx-sub">${esc(c.subject)} · ${fmtDateIL(c.date)}</div>
          </div>
          <div class="tx-amount expense">${fmtMoney(c.amount)}</div>
        </label>`).join('') : '<div class="muted">לא זוהו סכומים בקבלות שנמצאו.</div>'}
      <div class="btn-row" style="margin-top:12px">
        <button class="btn" id="gi-import">ייבוא מסומנים</button>
        <button class="btn btn-ghost" data-go="import">ביטול</button>
      </div>
    </div>`;
  bindCommon(v);
  $('#gi-import').addEventListener('click', () => {
    const checked = $$('#view [data-gi]:checked').map(el => cands[+el.dataset.gi]);
    const seen = new Set(DB.data.tx.map(t => t.date + '|' + t.amount + '|' + normMerchant(t.merchant)));
    let added = 0;
    for (const c of checked) {
      const key = c.date + '|' + c.amount + '|' + normMerchant(c.merchant);
      if (seen.has(key)) continue;
      const cat = guessCategory(c.merchant);
      DB.data.tx.push({ id: uid(), type: 'expense', amount: c.amount, merchant: c.merchant, category: cat, date: c.date, notes: c.subject, source: 'gmail', createdAt: Date.now() });
      learnRule(c.merchant, cat);
      seen.add(key); added++;
    }
    DB.save();
    toast(`יובאו ${added} קבלות`);
    go('dashboard');
  });
}

/* ---------------- Gmail guided setup ---------------- */
let gmailSetupOpen = false;
let gmailStep = 1;

function gmailStepsHTML() {
  const steps = [
    {
      title: 'צרו פרויקט והפעילו את Gmail API',
      body: `
        <ol class="steps">
          <li>פתחו בדפדפן: <code class="inline" dir="ltr">console.cloud.google.com</code> והתחברו עם חשבון הגוגל שלכם.</li>
          <li>צרו פרויקט חדש — קראו לו למשל <b>Shekel Sense</b>.</li>
          <li>בתפריט הצד: <b>APIs &amp; Services</b> ← <b>Library</b>.</li>
          <li>חפשו <b>Gmail API</b> ולחצו <b>Enable</b>.</li>
        </ol>`
    },
    {
      title: 'אשרו את מסך ההסכמה',
      body: `
        <ol class="steps">
          <li>בתפריט: <b>APIs &amp; Services</b> ← <b>OAuth consent screen</b>.</li>
          <li>בחרו <b>External</b> ולחצו <b>Create</b>.</li>
          <li>מלאו שם אפליקציה (<b>Shekel Sense</b>) וכתובת מייל — שלכם.</li>
          <li>הוסיפו את ההרשאה <code class="inline" dir="ltr">gmail.readonly</code> — קריאת מיילים בלבד, שום דבר לא נשלח.</li>
          <li>הוסיפו את כתובת הג׳ימייל שלכם תחת <b>Test users</b> ושמרו.</li>
        </ol>`
    },
    {
      title: 'צרו מפתח והדביקו אותו כאן',
      body: `
        <ol class="steps">
          <li>בתפריט: <b>APIs &amp; Services</b> ← <b>Credentials</b>.</li>
          <li><b>Create Credentials</b> ← <b>OAuth client ID</b> ← סוג <b>Web application</b>.</li>
          <li>תחת <b>Authorized JavaScript origins</b> הוסיפו בדיוק את הכתובת הזו:<br><code class="inline" dir="ltr">${GMAIL_ORIGIN}</code></li>
          <li>לחצו <b>Create</b> והעתיקו את ה־<b>Client ID</b> שהתקבל.</li>
        </ol>
        <div class="field" style="margin-top:12px">
          <label>הדביקו כאן את ה־Client ID</label>
          <input type="text" id="g-client" dir="ltr" placeholder="xxxx.apps.googleusercontent.com" value="${esc(DB.data.settings.clientId || '')}">
        </div>`
    }
  ];
  const s = steps[gmailStep - 1];
  return `<div class="gstep"><h4>${s.title}</h4>${s.body}</div>`;
}

function gmailCardHTML() {
  const cid = (DB.data.settings.clientId || '').trim();
  if (cid && !gmailSetupOpen) {
    return `
      <div class="kv"><span class="k">סטטוס</span><span style="color:var(--green)">מחובר ✓</span></div>
      <button class="btn" id="g-sync2">סנכרן Gmail</button>
      <div id="gmail-status" class="small muted" style="margin-top:8px"></div>
      <button class="btn btn-ghost" id="g-disconnect" style="margin-top:10px">ניתוק החיבור</button>`;
  }
  if (!gmailSetupOpen) {
    return `
      <p>מוצא קבלות אוטומטית מתיבת המייל — בלי להקליד.</p>
      <p class="small muted">נדרשת הגדרה חד־פעמית של כ־10 דקות מול גוגל (בחינם). אחריה — סנכרון בלחיצה אחת, לתמיד. ההרשאה היא קריאה בלבד; שום מייל לא נשלח ושום דבר לא נמחק.</p>
      <button class="btn" id="g-connect">חבר Gmail</button>`;
  }
  return `
    <div class="small muted" style="margin-bottom:10px">שלב ${gmailStep} מתוך 3 · הגדרה חד־פעמית, כ־10 דקות</div>
    <div class="steps-dots" aria-hidden="true">${[1, 2, 3].map(i => `<span class="sdot ${i <= gmailStep ? 'on' : ''}"></span>`).join('')}</div>
    ${gmailStepsHTML()}
    <div class="btn-row" style="margin-top:14px">
      ${gmailStep > 1 ? '<button class="btn btn-ghost" id="g-back">הקודם</button>' : ''}
      ${gmailStep < 3 ? '<button class="btn" id="g-next">הבא</button>' : '<button class="btn" id="g-save3">שמירה וחיבור</button>'}
    </div>
    <button class="btn btn-ghost" id="g-cancel" style="margin-top:10px">ביטול</button>`;
}

function renderGmailCard() {
  const host = $('#gmail-card');
  if (!host) return;
  host.innerHTML = `<h3>חיבור Gmail</h3>` + gmailCardHTML();
  const q = (id) => document.getElementById(id);
  if (q('g-connect')) q('g-connect').addEventListener('click', () => { gmailSetupOpen = true; gmailStep = 1; renderGmailCard(); });
  if (q('g-cancel')) q('g-cancel').addEventListener('click', () => { gmailSetupOpen = false; renderGmailCard(); });
  if (q('g-next')) q('g-next').addEventListener('click', () => { gmailStep = Math.min(3, gmailStep + 1); renderGmailCard(); });
  if (q('g-back')) q('g-back').addEventListener('click', () => { gmailStep = Math.max(1, gmailStep - 1); renderGmailCard(); });
  if (q('g-save3')) q('g-save3').addEventListener('click', () => {
    const v = q('g-client').value.trim();
    if (!v) { toast('נא להדביק את ה־Client ID'); return; }
    DB.data.settings.clientId = v;
    DB.save();
    gmailSetupOpen = false;
    renderGmailCard();
    toast('Gmail מחובר ✓');
  });
  if (q('g-sync2')) q('g-sync2').addEventListener('click', () => gmailSync());
  if (q('g-disconnect')) q('g-disconnect').addEventListener('click', () => {
    if (!confirm('לנתק את חיבור Gmail?')) return;
    DB.data.settings.clientId = '';
    DB.save();
    gmailSetupOpen = false;
    renderGmailCard();
    toast('החיבור נותק');
  });
}

/* ---------------- settings ---------------- */
function vSettings(v) {
  const s = DB.data.settings;
  v.innerHTML = `
    <h2 class="section-title">הגדרות</h2>
    <div class="card" id="gmail-card"></div>
    <div class="card">
      <h3>ניהול נתונים</h3>
      <p class="small muted">כל הנתונים נשמרים מקומית בדפדפן הזה בלבד. שום דבר לא עוזב את המכשיר.</p>
      <div class="kv"><span class="k">עסקאות</span><span>${DB.data.tx.length}</span></div>
      <div class="kv"><span class="k">חוקי עסקים נלמדים</span><span>${Object.keys(DB.data.rules).length}</span></div>
      <div class="kv"><span class="k">תבניות קבועות</span><span>${DB.data.recurring.length}</span></div>
      <button class="btn btn-danger" id="s-wipe" style="margin-top:12px">מחיקת כל הנתונים</button>
    </div>
    <div class="card small muted">
      Shekel Sense · גרסה 1.0 · קוד פתוח — הנתונים שלך נשארים אצלך.
    </div>
  `;
  renderGmailCard();
  $('#s-wipe').addEventListener('click', () => {
    if (!confirm('למחוק את כל הנתונים? אין דרך חזרה.')) return;
    Object.values(K).forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
    DB.data = { tx: [], rules: {}, budgets: {}, recurring: [], settings: {} };
    render(); toast('הכל נמחק');
  });
}

/* ---------------- init ---------------- */
function init() {
  DB.load();
  $$('.tab').forEach(b => b.addEventListener('click', () => go(b.dataset.route)));
  $('#btn-import').addEventListener('click', () => go('import'));
  $('#btn-settings').addEventListener('click', () => go('settings'));
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#/', '');
    if (ROUTES.includes(h) && h !== route) go(h);
  });
  const h0 = location.hash.replace('#/', '');
  route = ROUTES.includes(h0) ? h0 : 'dashboard';
  render();
}
document.addEventListener('DOMContentLoaded', init);
