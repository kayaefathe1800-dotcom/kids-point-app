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

// ===== 描画ディスパッチ（各renderは後続タスクで実装） =====
function renderAll() {
  renderHome();
  renderTasks();
  renderRewards();
  renderSettings();
}
function renderHome() {}
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
