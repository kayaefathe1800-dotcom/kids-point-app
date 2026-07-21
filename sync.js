"use strict";

// ===== Supabase設定（Task 0で発行したプロジェクトの値に置き換え済み） =====
const SUPABASE_URL = "https://rpdbvzscrzdjlbargoza.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_JI8LoszRPoWoauzRz4ckIA_kzdr9yvy";

let sb = null;
let realtimeChannel = null;

// ===== モード判定 =====
function getFamilyCode() {
  return localStorage.getItem("kids-point-app-family-code");
}

function isCloudMode() {
  return getFamilyCode() !== null;
}

function initSupabase() {
  if (!sb) sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return sb;
}

// ===== 家族コード =====
function generateFamilyCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 0/O, 1/I等の紛らわしい文字を除外
  const part = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${part()}-${part()}`;
}

async function createFamily() {
  initSupabase();
  const code = generateFamilyCode();
  const { error } = await sb.from("families").insert({ code });
  if (error) {
    alert("家族コードの発行に失敗しました: " + error.message);
    return null;
  }
  const { error: settingsError } = await sb.from("family_settings").insert({ family_code: code });
  if (settingsError) {
    alert("初期設定の作成に失敗しました: " + settingsError.message);
    return null;
  }
  localStorage.setItem("kids-point-app-family-code", code);
  return code;
}

async function joinFamily(code) {
  initSupabase();
  const { data, error } = await sb.from("families").select("code").eq("code", code).maybeSingle();
  if (error) {
    alert("確認に失敗しました: " + error.message);
    return false;
  }
  if (!data) {
    alert("そのコードは見つかりません");
    return false;
  }
  localStorage.setItem("kids-point-app-family-code", code);
  return true;
}

// ===== クラウドからstate形式で全件取得 =====
async function fetchCloudState(familyCode) {
  initSupabase();
  const [settingsRes, tasksRes, completionsRes, rewardsRes, historyRes] = await Promise.all([
    sb.from("family_settings").select("*").eq("family_code", familyCode).maybeSingle(),
    sb.from("tasks").select("*").eq("family_code", familyCode),
    sb.from("task_completions").select("*").eq("family_code", familyCode),
    sb.from("rewards").select("*").eq("family_code", familyCode),
    sb.from("point_history").select("*").eq("family_code", familyCode),
  ]);
  for (const res of [settingsRes, tasksRes, completionsRes, rewardsRes, historyRes]) {
    if (res.error) throw new Error(res.error.message);
  }
  const settingsRow = settingsRes.data;
  const completionsByTask = {};
  for (const c of completionsRes.data) {
    (completionsByTask[c.task_id] ??= []).push({
      date: c.date, completedAt: c.completed_at, pointsAwarded: c.points_awarded,
    });
  }
  return {
    version: 1,
    settings: {
      parentPinHash: settingsRow ? settingsRow.parent_pin_hash : null,
      childName: settingsRow ? settingsRow.child_name : "",
      lastOpenedDate: todayStr(),
    },
    points: 0,
    tasks: tasksRes.data.map((t) => ({
      id: t.id, title: t.title, points: t.points, type: t.type,
      recurrence: t.type === "recurring" ? { frequency: t.frequency, weekdays: t.weekdays || [] } : null,
      dueDate: t.due_date, status: t.status, createdBy: t.created_by,
      createdAt: t.created_at, updatedAt: t.updated_at,
      completions: completionsByTask[t.id] || [],
    })),
    rewards: rewardsRes.data.map((r) => ({
      id: r.id, title: r.title, cost: r.cost, status: r.status,
      createdAt: r.created_at, updatedAt: r.updated_at,
    })),
    pointHistory: historyRes.data.map((h) => ({
      id: h.id, type: h.type, amount: h.amount, taskId: h.task_id, rewardId: h.reward_id,
      title: h.title, note: h.note, date: h.date, createdAt: h.created_at,
    })),
  };
}
