"use strict";

// ===== 定数・グローバル =====
const STORAGE_KEY = "kids-point-app";
const ROLE_KEY = "kids-point-app-role"; // 端末ロール。stateとは独立してlocalStorageに直接保存
let state = null;
let parentUnlocked = false; // メモリ上のみ。localStorageには保存しない
let persistAllowed = true; // 破損データ保護: falseの間はlocalStorageへ一切書き込まない
let calendarYear = new Date().getFullYear();  // ホーム画面カレンダーの表示中の年（一時的な状態。保存しない）
let calendarMonth = new Date().getMonth();    // 0-indexed。同上
let sessionRoleOverride = false; // メモリ上のみ。子ども端末でのPINによる一時的な保護者モード昇格

// ===== 日付・ユーティリティ =====
// 注意: toISOString()はUTC基準のため日付判定に使用禁止（設計書 §3）
function todayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function nowISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

function uuid() {
  return crypto.randomUUID();
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ===== state管理 =====
function defaultState() {
  return {
    version: 1,
    settings: { parentPinHash: null, childName: "", lastOpenedDate: todayStr() },
    points: 0,
    tasks: [],
    rewards: [],
    pointHistory: [],
  };
}

// 残高は必ず履歴から導出する（設計書の不変条件）
function recalcPoints() {
  state.points = state.pointHistory.reduce((sum, h) => sum + h.amount, 0);
}

// ポイント増減の唯一の入口。pointsを直接変更してはならない
function addHistory({ type, amount, taskId = null, rewardId = null, title, note = null }) {
  state.pointHistory.push({
    id: uuid(), type, amount, taskId, rewardId, title, note,
    date: todayStr(), createdAt: nowISO(),
  });
  recalcPoints();
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    state = defaultState();
    saveState();
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    if (confirm("保存データが壊れています。初期化しますか？\n（キャンセルすると空の状態で起動しますが保存はされません）")) {
      state = defaultState();
      saveState();
    } else {
      state = defaultState(); // メモリ上のみ。壊れたデータは上書きしない
      persistAllowed = false;
    }
    return;
  }
  if (parsed.version !== 1) {
    alert("対応していないデータバージョンです: " + parsed.version);
    state = defaultState();
    persistAllowed = false; // 未知バージョンのデータを上書きしない
    return;
  }
  state = parsed;
  recalcPoints(); // 履歴を正として残高を再計算
}

function saveState() {
  if (!persistAllowed) return; // 破損データ保護モード中は書き込まない
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    // 保存に失敗したら、メモリ上の変更を確定せず最後に保存できた状態へ巻き戻す（設計書 §3）
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        state = JSON.parse(raw);
        recalcPoints();
        renderAll();
      } catch { /* 巻き戻し不能な場合はメモリ状態を維持 */ }
    }
    alert("データの保存に失敗しました: " + e.message);
    throw e;
  }
}

// ===== PIN =====
// 位置づけは誤操作・イタズラ防止（設計書 §5）。認証状態はメモリ上のみ
async function hashPin(pin) {
  const data = new TextEncoder().encode("kids-point-app:" + pin);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function changePin() {
  if (state.settings.parentPinHash) {
    const current = prompt("現在のPINを入力してください");
    if (current === null) return;
    if ((await hashPin(current)) !== state.settings.parentPinHash) {
      alert("PINが違います");
      return;
    }
  }
  const p1 = prompt("新しいPIN（4桁の数字）を入力してください");
  if (p1 === null) return;
  if (!/^\d{4}$/.test(p1)) {
    alert("4桁の数字で入力してください");
    return;
  }
  const p2 = prompt("確認のためもう一度入力してください");
  if (p1 !== p2) {
    alert("一致しません");
    return;
  }
  const hash = await hashPin(p1);
  if (isCloudMode()) {
    try {
      await cloudUpdateSettings({ parent_pin_hash: hash });
      alert("PINを設定しました");
    } catch (e) {
      alert("ネットに繋がっていません。接続後にもう一度お試しください。");
    }
    return;
  }
  state.settings.parentPinHash = hash;
  saveState();
  alert("PINを設定しました");
}

// 親機能の入口。未設定なら初回設定を促す
async function requireParent() {
  if (parentUnlocked) return true;
  if (!state.settings.parentPinHash) {
    alert("最初に親用PINを設定します");
    await changePin();
    if (!state.settings.parentPinHash) return false;
    parentUnlocked = true;
    return true;
  }
  const pin = prompt("親用PINを入力してください");
  if (pin === null) return false;
  if ((await hashPin(pin)) === state.settings.parentPinHash) {
    parentUnlocked = true;
    return true;
  }
  alert("PINが違います");
  return false;
}

// ===== 端末ロール（保護者用/子ども用） =====
// ロールは家族データ(state)とは独立した端末固有の設定。localStorageに直接保存する
function getBaseRole() {
  const r = localStorage.getItem(ROLE_KEY);
  return r === "parent" || r === "child" ? r : null;
}

function setBaseRole(role) {
  localStorage.setItem(ROLE_KEY, role);
}

// sessionRoleOverrideが立っている間は端末の基本ロールに関わらず保護者として扱う
function effectiveRole() {
  if (sessionRoleOverride) return "parent";
  return getBaseRole() || "child";
}

// 有効ロールに応じてボトムナビの表示/非表示を切り替える
function applyRoleUI() {
  const isParent = effectiveRole() === "parent";
  document.querySelector('#bottom-nav button[data-tab="tasks"]').hidden = !isParent;
  document.querySelector('#bottom-nav button[data-tab="settings"]').hidden = !isParent;
  document.getElementById("parent-mode-link").hidden = isParent;
  const current = document.querySelector("#bottom-nav button.active");
  if (current && current.hidden) {
    switchTab("home");
  }
}

// 初回選択ダイアログでのロール決定
async function chooseRole(role) {
  if (role === "parent") {
    if (!(await requireParent())) return;
    setBaseRole("parent");
  } else {
    setBaseRole("child");
  }
  document.getElementById("role-choice-dialog").close();
  applyRoleUI();
}

// 子どもロールのホームにある「保護者の方はこちら」リンクからの一時昇格
async function requestParentOverride() {
  if (!(await requireParent())) return;
  sessionRoleOverride = true;
  applyRoleUI();
  switchTab("settings");
}

// 設定タブ内での端末ロールの明示的な切り替え（設定タブ自体が既にPIN解除済みの文脈なので追加のPIN確認は不要）
function setDeviceRole(role) {
  setBaseRole(role);
  applyRoleUI();
  renderDeviceRoleSetting();
}

function renderDeviceRoleSetting() {
  document.getElementById("device-role-label").textContent =
    effectiveRole() === "parent" ? "保護者用" : "子ども用";
}

// ===== タブ切り替え =====
function switchTab(name) {
  const current = document.querySelector("#bottom-nav button.active");
  if (current && current.dataset.tab === name) return; // 同一タブの再タップでは何もしない
  parentUnlocked = false; // タブ移動で親ロックに戻す（設計書 §5）
  document.querySelectorAll(".tab").forEach((s) => s.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  document.querySelectorAll("#bottom-nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  renderAll();
}

// ===== タスク判定（リセット処理なし・その場判定。設計書 §3） =====
function isTaskForToday(task) {
  if (task.status !== "active") return false;
  if (task.type === "oneoff") return task.dueDate !== null && task.dueDate <= todayStr();
  if (task.recurrence.frequency === "daily") return true;
  return task.recurrence.weekdays.includes(new Date().getDay());
}

function isCompletedToday(task) {
  return Array.isArray(task.completions) && task.completions.some((c) => c.date === todayStr());
}

// ===== タスク完了（設計書 §3「タスク完了処理の詳細」） =====
async function completeTask(taskId, btn) {
  btn.disabled = true; // 連打防止
  const task = state.tasks.find((t) => t.id === taskId);
  const today = todayStr();
  // taskId + date の一意制約: 同日完了済みなら何もしない
  if (!task || task.completions.some((c) => c.date === today)) return;
  if (isCloudMode()) {
    try {
      const ok = await cloudInsertTaskCompletion(task, {
        date: today, completedAt: nowISO(), pointsAwarded: task.points,
      });
      if (ok) showPointGain(task.points);
      // stateへの反映はRealtime経由（applyRealtimeChange）で行われる
    } catch (e) {
      alert("ネットに繋がっていません。接続後にもう一度お試しください。");
      btn.disabled = false;
    }
    return;
  }
  task.completions.push({ date: today, completedAt: nowISO(), pointsAwarded: task.points });
  if (task.type === "oneoff") task.status = "completed";
  task.updatedAt = nowISO();
  addHistory({ type: "task", amount: task.points, taskId: task.id, title: task.title });
  saveState();
  showPointGain(task.points);
  renderAll();
}

function showPointGain(points) {
  const el = document.createElement("div");
  el.className = "point-gain";
  el.textContent = `+${points}pt`;
  document.body.append(el);
  setTimeout(() => el.remove(), 1200);
}

// ===== 描画ディスパッチ（各renderは後続タスクで実装） =====
function renderAll() {
  renderHome();
  renderTasks();
  renderRewards();
  renderSettings();
}
function renderHome() {
  document.getElementById("home-points").textContent = state.points;
  renderNextRewardHint();
  const container = document.getElementById("today-tasks");
  container.innerHTML = "";
  const todo = [], done = [];
  for (const task of state.tasks) {
    if (!isTaskForToday(task)) continue;
    (isCompletedToday(task) ? done : todo).push(task);
  }
  // 達成率・カレンダーは「今日のタスクなし」の早期returnより前に描画する
  // （today-tasks欄の中身とは独立して、常に表示・更新されるべきもののため）
  renderAchievement(todo, done);
  renderCalendar();
  if (todo.length === 0 && done.length === 0) {
    container.innerHTML = '<p class="empty">今日のタスクはありません</p>';
    return;
  }
  if (todo.length === 0) {
    const p = document.createElement("p");
    p.className = "all-done";
    p.textContent = "🎉 今日は全部完了！";
    container.append(p);
  }
  for (const task of todo) container.append(homeTaskItem(task, false));
  for (const task of done) container.append(homeTaskItem(task, true));
}

function homeTaskItem(task, completed) {
  const div = document.createElement("div");
  div.className = "task-card" + (completed ? " completed" : "");
  const info = document.createElement("div");
  info.className = "item-main";
  info.innerHTML =
    `<div class="item-title">${escapeHtml(task.title)}</div>` +
    `<div class="item-sub">${task.points}pt</div>`;
  div.append(info);
  const btn = document.createElement("button");
  btn.className = "btn-complete";
  if (completed) {
    btn.textContent = "✔ 完了";
    btn.disabled = true;
  } else {
    btn.textContent = "やった！";
    btn.addEventListener("click", () => completeTask(task.id, btn));
  }
  div.append(btn);
  return div;
}

// 「あと◯pt」欄の3状態（設計書 §4 ホーム）
function renderNextRewardHint() {
  const el = document.getElementById("next-reward-hint");
  const active = state.rewards.filter((r) => r.status === "active");
  if (active.length === 0) {
    el.hidden = true; // ごほうび未登録なら欄ごと非表示
    return;
  }
  el.hidden = false;
  const unaffordable = active.filter((r) => r.cost > state.points);
  if (unaffordable.length === 0) {
    el.textContent = "交換できるごほうびがあります 🎁";
    return;
  }
  const nearest = unaffordable.reduce((a, b) => (a.cost <= b.cost ? a : b));
  el.textContent = `あと ${nearest.cost - state.points}pt で「${nearest.title}」と交換できる`;
}

// ===== 達成率表示（今日のタスク進捗。ポイント基準） =====
function renderAchievement(todoTasks, doneTasks) {
  const totalPoints = [...todoTasks, ...doneTasks].reduce((sum, t) => sum + t.points, 0);
  const earnedPoints = doneTasks.reduce((sum, t) => sum + t.points, 0);
  const wrap = document.getElementById("achievement-wrap");
  if (totalPoints === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  // earnedPoints は理論上totalPointsを超えないが、念のため上限処理する
  const clampedEarned = Math.min(earnedPoints, totalPoints);
  const percentage = Math.round((clampedEarned / totalPoints) * 100);
  document.getElementById("achievement-text").textContent = `今日 ${clampedEarned}/${totalPoints}pt 獲得`;
  document.getElementById("achievement-pct").textContent = `${percentage}%`;
  document.getElementById("achievement-fill").style.width = `${percentage}%`;
}

// ===== カレンダー履歴 =====
// 注意: toISOString()は使用禁止（UTC基準のため日付がずれる。設計書 §3と同じ理由）
function formatLocalDate(year, month, day) {
  return [year, String(month + 1).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
}

function formatDisplayDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${y}年${m}月${d}日`;
}

function renderCalendar() {
  const year = calendarYear;
  const month = calendarMonth; // 0-indexed
  document.getElementById("cal-month-label").textContent = `${year}年${month + 1}月`;

  const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}`;
  const pointsByDate = new Map(); // date -> その日の獲得ポイント合計
  for (const task of state.tasks || []) {
    // completionsが配列でない（古い・破損データ等の）場合でもカレンダー描画を止めない
    const completions = Array.isArray(task.completions) ? task.completions : [];
    for (const c of completions) {
      // c.dateは通常"YYYY-MM-DD"形式だが、形式が壊れていても無視するだけにする
      const completionDate = String(c?.date || "").slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(completionDate) && completionDate.startsWith(monthPrefix)) {
        const awarded = Number(c?.pointsAwarded) || 0;
        pointsByDate.set(completionDate, (pointsByDate.get(completionDate) || 0) + awarded);
      }
    }
  }

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayStr();

  let cells = "";
  for (const d of ["日", "月", "火", "水", "木", "金", "土"]) {
    cells += `<div class="cal-head">${d}</div>`;
  }
  for (let i = 0; i < firstDay; i++) cells += "<div></div>";
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = formatLocalDate(year, month, d);
    const dayPoints = pointsByDate.get(dateStr) || 0;
    const isToday = dateStr === today;
    cells += `<div class="cal-day${dayPoints > 0 ? " cal-done" : ""}${isToday ? " cal-today" : ""}" data-date="${dateStr}">` +
      `<span class="cal-day-num">${d}</span>` +
      (dayPoints > 0 ? `<span class="cal-day-pts">${dayPoints}pt</span>` : "") +
      `</div>`;
  }
  document.getElementById("home-calendar").innerHTML = `<div class="cal-grid">${cells}</div>`;
}

// ===== カレンダー日別内訳ダイアログ =====
function showDayDetail(dateStr) {
  const items = [];
  let total = 0;
  for (const task of state.tasks || []) {
    const completions = Array.isArray(task.completions) ? task.completions : [];
    for (const c of completions) {
      const completionDate = String(c?.date || "").slice(0, 10);
      if (completionDate === dateStr) {
        const pts = Number(c?.pointsAwarded) || 0;
        items.push({ title: task.title, points: pts });
        total += pts;
      }
    }
  }
  if (items.length === 0) return; // 実績のない日はタップしても何も起きない
  document.getElementById("day-detail-title").textContent = formatDisplayDate(dateStr);
  const list = document.getElementById("day-detail-list");
  list.innerHTML = "";
  for (const item of items) {
    const div = document.createElement("div");
    div.className = "list-item";
    div.innerHTML =
      `<div class="item-main">「${escapeHtml(item.title)}」達成で <span class="plus">${item.points}pt</span> ゲット</div>`;
    list.append(div);
  }
  document.getElementById("day-detail-total").textContent = `合計: ${total}pt`;
  document.getElementById("day-detail-dialog").showModal();
}

function changeCalendarMonth(delta) {
  const target = new Date(calendarYear, calendarMonth + delta, 1);
  calendarYear = target.getFullYear();
  calendarMonth = target.getMonth();
  renderCalendar();
}

function goToCurrentCalendarMonth() {
  const now = new Date();
  calendarYear = now.getFullYear();
  calendarMonth = now.getMonth();
  renderCalendar();
}
// ===== タスク管理 =====
function describeRecurrence(task) {
  if (task.type === "oneoff") return task.dueDate ? `期限 ${task.dueDate}` : "単発";
  if (task.recurrence.frequency === "daily") return "毎日";
  const names = ["日", "月", "火", "水", "木", "金", "土"];
  return "毎週 " + task.recurrence.weekdays.map((d) => names[d]).join("・");
}

function smallButton(label, onClick) {
  const b = document.createElement("button");
  b.className = "btn-small";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function renderTasks() {
  const view = document.querySelector('input[name="task-view"]:checked').value;
  const rec = document.getElementById("recurring-tasks");
  const one = document.getElementById("oneoff-tasks");
  rec.innerHTML = "";
  one.innerHTML = "";
  for (const task of state.tasks) {
    const archived = task.status === "archived";
    if (view === "active" ? archived : !archived) continue;
    const item = document.createElement("div");
    item.className = "list-item";
    const main = document.createElement("div");
    main.className = "item-main";
    main.innerHTML =
      `<div class="item-title">${escapeHtml(task.title)}${task.status === "completed" ? "（完了）" : ""}</div>` +
      `<div class="item-sub">${task.points}pt ・ ${describeRecurrence(task)} ・ 完了${task.completions.length}回</div>`;
    item.append(main);
    const buttons = document.createElement("div");
    buttons.append(smallButton("履歴", () => showTaskHistory(task.id)));
    if (view === "active") {
      buttons.append(smallButton("編集", () => openTaskDialog(task.id)));
      buttons.append(smallButton("アーカイブ", () => archiveTask(task.id)));
    } else {
      buttons.append(smallButton("復元", () => restoreTask(task.id)));
    }
    item.append(buttons);
    (task.type === "recurring" ? rec : one).append(item);
  }
  if (!rec.children.length) rec.innerHTML = '<p class="empty">なし</p>';
  if (!one.children.length) one.innerHTML = '<p class="empty">なし</p>';
}

// Task completion history display (Design spec §4)
function showTaskHistory(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) return;
  if (t.completions.length === 0) {
    alert(`「${t.title}」の完了履歴はまだありません`);
    return;
  }
  const lines = [...t.completions].reverse().slice(0, 30)
    .map((c) => `${c.date}  +${c.pointsAwarded}pt`);
  alert(`「${t.title}」の完了履歴（直近${lines.length}件）\n\n${lines.join("\n")}`);
}

async function openTaskDialog(taskId = null) {
  if (!(await requireParent())) return; // 追加・編集は親PIN必須（設計書 §4）
  const task = taskId ? state.tasks.find((t) => t.id === taskId) : null;
  document.getElementById("task-dialog-title").textContent = task ? "タスクを編集" : "タスクを追加";
  document.getElementById("task-id").value = task ? task.id : "";
  document.getElementById("task-title").value = task ? task.title : "";
  document.getElementById("task-points").value = task ? task.points : 10;
  document.getElementById("task-type").value = task ? task.type : "recurring";
  document.getElementById("task-frequency").value =
    task && task.type === "recurring" ? task.recurrence.frequency : "daily";
  document.querySelectorAll(".weekday-cb").forEach((cb) => {
    cb.checked = !!(task && task.type === "recurring" &&
      task.recurrence.weekdays.includes(Number(cb.value)));
  });
  document.getElementById("task-duedate").value =
    task && task.dueDate ? task.dueDate : todayStr();
  updateTaskFormVisibility();
  document.getElementById("task-dialog").showModal();
}

function updateTaskFormVisibility() {
  const type = document.getElementById("task-type").value;
  const freq = document.getElementById("task-frequency").value;
  document.getElementById("recurrence-fields").hidden = type !== "recurring";
  document.getElementById("oneoff-fields").hidden = type !== "oneoff";
  document.getElementById("weekday-fields").hidden = type !== "recurring" || freq !== "weekly";
}

async function saveTaskFromForm(e) {
  e.preventDefault();
  const id = document.getElementById("task-id").value;
  const type = document.getElementById("task-type").value;
  const freq = document.getElementById("task-frequency").value;
  const weekdays = [...document.querySelectorAll(".weekday-cb:checked")].map((cb) => Number(cb.value));
  if (type === "recurring" && freq === "weekly" && weekdays.length === 0) {
    alert("曜日を1つ以上選んでください");
    return;
  }
  const fields = {
    title: document.getElementById("task-title").value.trim(),
    points: Number(document.getElementById("task-points").value),
    type,
    recurrence: type === "recurring"
      ? { frequency: freq, weekdays: freq === "weekly" ? weekdays : [] }
      : null,
    dueDate: type === "oneoff" ? document.getElementById("task-duedate").value : null,
    updatedAt: nowISO(),
  };
  if (isCloudMode()) {
    const existing = id ? state.tasks.find((t) => t.id === id) : null;
    const task = existing
      ? { ...existing, ...fields }
      : { id: uuid(), ...fields, status: "active", createdBy: "parent", createdAt: nowISO(), completions: [] };
    try {
      await cloudUpsertTask(task);
      // stateへの反映はRealtime経由
    } catch (e) {
      alert("ネットに繋がっていません。接続後にもう一度お試しください。");
      return;
    }
  } else {
    if (id) {
      Object.assign(state.tasks.find((t) => t.id === id), fields);
    } else {
      state.tasks.push({
        id: uuid(), ...fields,
        status: "active", createdBy: "parent",
        createdAt: nowISO(), completions: [],
      });
    }
    saveState();
  }
  document.getElementById("task-dialog").close();
  renderAll();
}

async function archiveTask(id) {
  if (!(await requireParent())) return;
  if (isCloudMode()) {
    try {
      await cloudUpdateTaskStatus(id, "archived");
    } catch (e) {
      alert("ネットに繋がっていません。接続後にもう一度お試しください。");
    }
    return;
  }
  const t = state.tasks.find((t) => t.id === id);
  t.status = "archived";
  t.updatedAt = nowISO();
  saveState();
  renderAll();
}

async function restoreTask(id) {
  if (!(await requireParent())) return;
  const t = state.tasks.find((t) => t.id === id);
  // 完了済み単発タスクの復元は completed に戻す（今日のタスクに再表示しない）
  const newStatus = t.type === "oneoff" && t.completions.length > 0 ? "completed" : "active";
  if (isCloudMode()) {
    try {
      await cloudUpdateTaskStatus(id, newStatus);
    } catch (e) {
      alert("ネットに繋がっていません。接続後にもう一度お試しください。");
    }
    return;
  }
  t.status = newStatus;
  t.updatedAt = nowISO();
  saveState();
  renderAll();
}
// ===== ごほうび =====
function renderRewards() {
  const view = document.querySelector('input[name="reward-view"]:checked').value;
  const list = document.getElementById("reward-list");
  list.innerHTML = "";
  for (const reward of state.rewards) {
    const archived = reward.status === "archived";
    if (view === "active" ? archived : !archived) continue;
    const div = document.createElement("div");
    div.className = "list-item";
    const main = document.createElement("div");
    main.className = "item-main";
    main.innerHTML =
      `<div class="item-title">${escapeHtml(reward.title)}</div>` +
      `<div class="item-sub">${reward.cost}pt</div>`;
    div.append(main);
    const buttons = document.createElement("div");
    if (view === "active") {
      const ex = document.createElement("button");
      ex.className = "btn-primary btn-small";
      ex.textContent = "交換する";
      ex.disabled = state.points < reward.cost; // 残高不足なら無効
      ex.addEventListener("click", () => exchangeReward(reward.id, ex));
      buttons.append(ex);
      buttons.append(smallButton("編集", () => openRewardDialog(reward.id)));
      buttons.append(smallButton("アーカイブ", () => archiveReward(reward.id)));
    } else {
      buttons.append(smallButton("復元", () => restoreReward(reward.id)));
    }
    div.append(buttons);
    list.append(div);
  }
  if (!list.children.length) list.innerHTML = '<p class="empty">ごほうびがありません</p>';
  renderExchangeHistory();
}

// 交換は押した時点で成立。PIN不要（設計書 §4）
async function exchangeReward(id, btn) {
  btn.disabled = true; // 連打防止
  recalcPoints();      // 残高を再確認してから減算（設計書の処理ルール）
  const reward = state.rewards.find((r) => r.id === id);
  if (!reward || state.points < reward.cost) {
    alert("ポイントが足りません");
    renderAll();
    return;
  }
  if (!confirm(`「${reward.title}」を${reward.cost}ポイントで交換します。\n交換後は取り消せません。`)) {
    renderAll();
    return;
  }
  if (isCloudMode()) {
    try {
      await cloudInsertExchange(reward);
      alert(`「${reward.title}」と交換しました！`);
      // stateへの反映はRealtime経由
    } catch (e) {
      alert("ネットに繋がっていません。接続後にもう一度お試しください。");
      renderAll();
    }
    return;
  }
  addHistory({ type: "exchange", amount: -reward.cost, rewardId: reward.id, title: reward.title });
  saveState();
  renderAll();
  alert(`「${reward.title}」と交換しました！`);
}

function renderExchangeHistory() {
  const container = document.getElementById("exchange-history");
  container.innerHTML = "";
  const exchanges = state.pointHistory.filter((h) => h.type === "exchange").reverse();
  if (exchanges.length === 0) {
    container.innerHTML = '<p class="empty">まだ交換していません</p>';
    return;
  }
  for (const h of exchanges) {
    const div = document.createElement("div");
    div.className = "list-item";
    div.innerHTML =
      `<div class="item-main"><div class="item-title">${escapeHtml(h.title)}</div>` +
      `<div class="item-sub">${h.date} ・ <span class="minus">${h.amount}pt</span></div></div>`;
    container.append(div);
  }
}

async function openRewardDialog(rewardId = null) {
  if (!(await requireParent())) return; // 追加・編集は親PIN必須
  const reward = rewardId ? state.rewards.find((r) => r.id === rewardId) : null;
  document.getElementById("reward-dialog-title").textContent =
    reward ? "ごほうびを編集" : "ごほうびを追加";
  document.getElementById("reward-id").value = reward ? reward.id : "";
  document.getElementById("reward-title").value = reward ? reward.title : "";
  document.getElementById("reward-cost").value = reward ? reward.cost : 50;
  document.getElementById("reward-dialog").showModal();
}

async function saveRewardFromForm(e) {
  e.preventDefault();
  const id = document.getElementById("reward-id").value;
  const fields = {
    title: document.getElementById("reward-title").value.trim(),
    cost: Number(document.getElementById("reward-cost").value),
    updatedAt: nowISO(),
  };
  if (isCloudMode()) {
    const existing = id ? state.rewards.find((r) => r.id === id) : null;
    const reward = existing
      ? { ...existing, ...fields }
      : { id: uuid(), ...fields, status: "active", createdAt: nowISO() };
    try {
      await cloudUpsertReward(reward);
      // stateへの反映はRealtime経由
    } catch (e) {
      alert("ネットに繋がっていません。接続後にもう一度お試しください。");
      return;
    }
  } else {
    if (id) {
      Object.assign(state.rewards.find((r) => r.id === id), fields);
    } else {
      state.rewards.push({ id: uuid(), ...fields, status: "active", createdAt: nowISO() });
    }
    saveState();
  }
  document.getElementById("reward-dialog").close();
  renderAll();
}

async function archiveReward(id) {
  if (!(await requireParent())) return;
  if (isCloudMode()) {
    try {
      await cloudUpdateRewardStatus(id, "archived");
    } catch (e) {
      alert("ネットに繋がっていません。接続後にもう一度お試しください。");
    }
    return;
  }
  const r = state.rewards.find((r) => r.id === id);
  r.status = "archived";
  r.updatedAt = nowISO();
  saveState();
  renderAll();
}

async function restoreReward(id) {
  if (!(await requireParent())) return;
  if (isCloudMode()) {
    try {
      await cloudUpdateRewardStatus(id, "active");
    } catch (e) {
      alert("ネットに繋がっていません。接続後にもう一度お試しください。");
    }
    return;
  }
  const r = state.rewards.find((r) => r.id === id);
  r.status = "active";
  r.updatedAt = nowISO();
  saveState();
  renderAll();
}
// ===== 設定 =====
function renderSettings() {
  const locked = !parentUnlocked;
  document.getElementById("settings-locked").hidden = !locked;
  document.getElementById("settings-content").hidden = locked;
  if (locked) return;
  document.getElementById("child-name").value = state.settings.childName;
  renderPointHistory();
  renderSyncStatus();
  renderDeviceRoleSetting();
}

// 共有設定の表示・インポートボタンの無効化（設計書§6・§7）
function renderSyncStatus() {
  const statusEl = document.getElementById("sync-status");
  const actionsEl = document.getElementById("sync-offline-actions");
  if (isCloudMode()) {
    statusEl.textContent = `現在の状態: クラウド同期モード（家族コード: ${getFamilyCode()}）`;
    actionsEl.hidden = true;
  } else {
    statusEl.textContent = "現在の状態: オフラインモード（この端末のみ）";
    actionsEl.hidden = false;
  }
  const importBtn = document.getElementById("btn-import");
  importBtn.disabled = isCloudMode();
  importBtn.title = isCloudMode() ? "クラウド同期モード中は使用できません" : "";
}

async function unlockSettings() {
  if (!(await requireParent())) return;
  renderSettings();
}

function renderPointHistory() {
  const container = document.getElementById("point-history");
  container.innerHTML = "";
  if (state.pointHistory.length === 0) {
    container.innerHTML = '<p class="empty">履歴がありません</p>';
    return;
  }
  const typeLabel = { task: "タスク", exchange: "交換", adjustment: "調整" };
  for (const h of [...state.pointHistory].reverse()) {
    const div = document.createElement("div");
    div.className = "list-item";
    const sign = h.amount >= 0 ? "+" : "";
    div.innerHTML =
      `<div class="item-main">` +
      `<div class="item-title">${escapeHtml(h.title)} ` +
      `<span class="${h.amount >= 0 ? "plus" : "minus"}">${sign}${h.amount}pt</span></div>` +
      `<div class="item-sub">${h.date} ・ ${typeLabel[h.type] ?? h.type}` +
      `${h.note ? " ・ " + escapeHtml(h.note) : ""}</div></div>`;
    container.append(div);
  }
}

async function saveChildName() {
  const name = document.getElementById("child-name").value.trim();
  if (isCloudMode()) {
    try {
      await cloudUpdateSettings({ child_name: name });
      alert("保存しました");
    } catch (e) {
      alert("ネットに繋がっていません。接続後にもう一度お試しください。");
    }
    return;
  }
  state.settings.childName = name;
  saveState();
  alert("保存しました");
}

async function adjustPoints() {
  const amount = Number(document.getElementById("adjust-amount").value);
  const note = document.getElementById("adjust-note").value.trim();
  if (!amount) { alert("ポイント数を入力してください"); return; }
  if (!note) { alert("理由を入力してください"); return; }
  if (isCloudMode()) {
    try {
      await cloudInsertAdjustment(amount, note);
    } catch (e) {
      alert("ネットに繋がっていません。接続後にもう一度お試しください。");
      return;
    }
  } else {
    addHistory({ type: "adjustment", amount, title: "手動調整", note });
    saveState();
    renderAll();
  }
  document.getElementById("adjust-amount").value = "";
  document.getElementById("adjust-note").value = "";
}

// ===== 共有設定（クラウド同期） =====
async function handleCreateFamily() {
  if (!confirm("新しい家族コードを発行します。クラウドは空の状態から始まります。よろしいですか？")) return;
  const code = await createFamily();
  if (!code) return;
  const ok = await startCloudMode(code);
  if (!ok) return;
  alert(`家族コードを発行しました: ${code}\nもう一台の端末でこのコードを入力してください。`);
}

async function handleJoinFamily() {
  const code = prompt("家族コードを入力してください（例: A3F9-K2M1）");
  if (code === null) return;
  const trimmed = code.trim().toUpperCase();
  if (!trimmed) return;
  if (!confirm("家族コードに参加すると、この端末のデータは削除され共有データに置き換わります。よろしいですか？")) return;
  const joined = await joinFamily(trimmed);
  if (!joined) return;
  const ok = await startCloudMode(trimmed);
  if (!ok) return;
  alert("参加しました。共有データを読み込みます。");
}

// 成功時true・失敗時false を返す。取得失敗時はクラウドモードに入らず、
// isCloudMode()の状態と実際の同期状況が食い違わないようにする
async function startCloudMode(familyCode) {
  try {
    state = await fetchCloudState(familyCode);
    recalcPoints();
  } catch (e) {
    localStorage.removeItem("kids-point-app-family-code");
    alert("データの取得に失敗しました。もう一度お試しください: " + e.message);
    renderAll();
    return false;
  }
  subscribeRealtime(familyCode);
  renderAll();
  return true;
}

// ===== バックアップ（設計書 §6） =====
function exportData() {
  const envelope = { appName: "kids-point-app", exportedAt: nowISO(), data: state };
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `kids-point-app-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function validateImport(obj) {
  if (!obj || obj.appName !== "kids-point-app") return "このアプリのバックアップではありません";
  const d = obj.data;
  if (!d || d.version !== 1) return "対応していないバージョンです";
  for (const key of ["settings", "points", "tasks", "rewards", "pointHistory"]) {
    if (!(key in d)) return `必須項目 ${key} がありません`;
  }
  if (!Array.isArray(d.tasks) || !Array.isArray(d.rewards) || !Array.isArray(d.pointHistory)) {
    return "データ形式が不正です";
  }
  return null;
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let obj;
    try {
      obj = JSON.parse(reader.result);
    } catch {
      alert("JSONとして読み込めませんでした");
      return;
    }
    const error = validateImport(obj);
    if (error) { alert("読み込めません: " + error); return; }
    const d = obj.data;
    const summary = [
      `子どもの名前: ${d.settings.childName || "（未設定）"}`,
      `ポイント残高: ${d.pointHistory.reduce((s, h) => s + h.amount, 0)}pt`,
      `タスク数: ${d.tasks.length}`,
      `ごほうび数: ${d.rewards.length}`,
      `履歴件数: ${d.pointHistory.length}`,
      `バックアップ日時: ${obj.exportedAt}`,
    ].join("\n");
    if (!confirm(`このデータを読み込みますか？現在のデータは上書きされます。\n\n${summary}`)) return;
    // 誤ファイル対策: 現在データを一時バックアップしてから上書き
    localStorage.setItem(STORAGE_KEY + "-backup-before-import", localStorage.getItem(STORAGE_KEY) ?? "");
    persistAllowed = true; // 明示的な同意（確認ダイアログOK）で保護モードを解除
    state = d;
    recalcPoints();
    saveState();
    renderAll();
    alert("読み込みました");
  };
  reader.readAsText(file);
}

function resetAll() {
  if (!confirm("全データを初期化します。よろしいですか？")) return;
  if (!confirm("本当に初期化しますか？この操作は取り消せません。")) return;
  persistAllowed = true; // 明示的な同意（二重確認OK）で保護モードを解除
  state = defaultState();
  parentUnlocked = false;
  saveState();
  switchTab("home");
}

// ===== イベント登録 =====
function setupEvents() {
  document.querySelectorAll("#bottom-nav button").forEach((b) => {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  });
  // ボタンだけでなくバナー全体をタップしても反応するようにする（モバイルでの誤タップ対策）
  document.getElementById("update-banner").addEventListener("click", () => location.reload());
  // ホーム（カレンダー月移動）
  document.getElementById("btn-cal-prev").addEventListener("click", () => changeCalendarMonth(-1));
  document.getElementById("btn-cal-next").addEventListener("click", () => changeCalendarMonth(1));
  document.getElementById("btn-cal-today").addEventListener("click", goToCurrentCalendarMonth);
  // カレンダーのセルは月移動のたびに再生成されるため、セル個別ではなく
  // 親要素にイベント委譲で1回だけ登録する（設計書§4）
  document.getElementById("home-calendar").addEventListener("click", (e) => {
    const cell = e.target.closest(".cal-day");
    if (!cell || !cell.classList.contains("cal-done")) return;
    showDayDetail(cell.dataset.date);
  });
  document.getElementById("btn-day-detail-close").addEventListener("click", () => {
    document.getElementById("day-detail-dialog").close();
  });
  // タスク
  document.getElementById("btn-add-task").addEventListener("click", () => openTaskDialog());
  document.getElementById("task-form").addEventListener("submit", saveTaskFromForm);
  document.getElementById("btn-task-cancel").addEventListener("click", () => {
    document.getElementById("task-dialog").close();
  });
  document.getElementById("task-type").addEventListener("change", updateTaskFormVisibility);
  document.getElementById("task-frequency").addEventListener("change", updateTaskFormVisibility);
  document.querySelectorAll('input[name="task-view"]').forEach((r) => {
    r.addEventListener("change", renderTasks);
  });
  // ごほうび
  document.getElementById("btn-add-reward").addEventListener("click", () => openRewardDialog());
  document.getElementById("reward-form").addEventListener("submit", saveRewardFromForm);
  document.getElementById("btn-reward-cancel").addEventListener("click", () => {
    document.getElementById("reward-dialog").close();
  });
  document.querySelectorAll('input[name="reward-view"]').forEach((r) => {
    r.addEventListener("change", renderRewards);
  });
  // 設定
  document.getElementById("btn-create-family").addEventListener("click", handleCreateFamily);
  document.getElementById("btn-join-family").addEventListener("click", handleJoinFamily);
  document.getElementById("btn-unlock-settings").addEventListener("click", unlockSettings);
  document.getElementById("btn-save-name").addEventListener("click", saveChildName);
  document.getElementById("btn-change-pin").addEventListener("click", changePin);
  document.getElementById("btn-adjust").addEventListener("click", adjustPoints);
  document.getElementById("btn-export").addEventListener("click", exportData);
  document.getElementById("btn-import").addEventListener("click", () => {
    document.getElementById("import-file").click();
  });
  document.getElementById("import-file").addEventListener("change", (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("btn-reset").addEventListener("click", resetAll);
}

// ===== 初期化 =====
async function init() {
  setupEvents();
  if (isCloudMode()) {
    const familyCode = getFamilyCode();
    try {
      state = await fetchCloudState(familyCode);
      recalcPoints();
    } catch (e) {
      alert("クラウドデータの取得に失敗しました。ネット接続をご確認ください: " + e.message);
      state = defaultState(); // 画面表示のための最低限の空状態（保存はしない）
    }
    subscribeRealtime(familyCode);
    renderAll();
  } else {
    loadState();
    state.settings.lastOpenedDate = todayStr();
    saveState();
    renderAll();
  }
  if ("serviceWorker" in navigator) {
    // ページ読み込み時点で既に別バージョンのSWに制御されていたかを先に記録する。
    // これが真の場合だけ、controllerchangeを「新バージョンへの切り替わり」とみなす
    // （初回インストール時にもcontrollerchangeが発火しうるため、誤ってバナーを出さないための判定）
    const hadController = !!navigator.serviceWorker.controller;
    // updateViaCache: "none" を指定し、sw.js自体をHTTP/CDNキャッシュ経由ではなく
    // 常にネットワークから取得させる（GitHub PagesのCDNがsw.jsをmax-age=600で
    // キャッシュしており、これが新バージョン検知の遅延・失敗の原因だったため）
    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(() => {
      // 登録失敗してもアプリ自体は動作する
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController) {
        document.getElementById("update-banner").hidden = false;
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", init);
