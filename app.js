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
function renderTasks() {}
function renderRewards() {}
function renderSettings() {}

// ===== イベント登録 =====
function setupEvents() {
  document.querySelectorAll("#bottom-nav button").forEach((b) => {
    b.addEventListener("click", () => switchTab(b.dataset.tab));
  });
}

// ===== 初期化 =====
function init() {
  loadState();
  state.settings.lastOpenedDate = todayStr();
  saveState();
  setupEvents();
  renderAll();
}

document.addEventListener("DOMContentLoaded", init);
