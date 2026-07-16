"use strict";

// ===== 定数・グローバル =====
const STORAGE_KEY = "kids-point-app";
let state = null;
let parentUnlocked = false; // メモリ上のみ。localStorageには保存しない

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
    }
    return;
  }
  if (parsed.version !== 1) {
    alert("対応していないデータバージョンです: " + parsed.version);
    state = defaultState();
    return;
  }
  state = parsed;
  recalcPoints(); // 履歴を正として残高を再計算
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
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
  state.settings.parentPinHash = await hashPin(p1);
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

// ===== タブ切り替え =====
function switchTab(name) {
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
  return task.completions.some((c) => c.date === todayStr());
}

// ===== タスク完了（設計書 §3「タスク完了処理の詳細」） =====
function completeTask(taskId, btn) {
  btn.disabled = true; // 連打防止
  const task = state.tasks.find((t) => t.id === taskId);
  const today = todayStr();
  // taskId + date の一意制約: 同日完了済みなら何もしない
  if (!task || task.completions.some((c) => c.date === today)) return;
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

function saveTaskFromForm(e) {
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
  document.getElementById("task-dialog").close();
  renderAll();
}

async function archiveTask(id) {
  if (!(await requireParent())) return;
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
  t.status = t.type === "oneoff" && t.completions.length > 0 ? "completed" : "active";
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
function exchangeReward(id, btn) {
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

function saveRewardFromForm(e) {
  e.preventDefault();
  const id = document.getElementById("reward-id").value;
  const fields = {
    title: document.getElementById("reward-title").value.trim(),
    cost: Number(document.getElementById("reward-cost").value),
    updatedAt: nowISO(),
  };
  if (id) {
    Object.assign(state.rewards.find((r) => r.id === id), fields);
  } else {
    state.rewards.push({ id: uuid(), ...fields, status: "active", createdAt: nowISO() });
  }
  saveState();
  document.getElementById("reward-dialog").close();
  renderAll();
}

async function archiveReward(id) {
  if (!(await requireParent())) return;
  const r = state.rewards.find((r) => r.id === id);
  r.status = "archived";
  r.updatedAt = nowISO();
  saveState();
  renderAll();
}

async function restoreReward(id) {
  if (!(await requireParent())) return;
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

function saveChildName() {
  state.settings.childName = document.getElementById("child-name").value.trim();
  saveState();
  alert("保存しました");
}

function adjustPoints() {
  const amount = Number(document.getElementById("adjust-amount").value);
  const note = document.getElementById("adjust-note").value.trim();
  if (!amount) { alert("ポイント数を入力してください"); return; }
  if (!note) { alert("理由を入力してください"); return; }
  addHistory({ type: "adjustment", amount, title: "手動調整", note });
  saveState();
  renderAll();
  document.getElementById("adjust-amount").value = "";
  document.getElementById("adjust-note").value = "";
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
function init() {
  loadState();
  state.settings.lastOpenedDate = todayStr();
  saveState();
  setupEvents();
  renderAll();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // 登録失敗してもアプリ自体は動作する
    });
  }
}

document.addEventListener("DOMContentLoaded", init);
