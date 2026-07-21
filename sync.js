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

// ===== クラウド書き込み =====
async function cloudInsertTaskCompletion(task, completion) {
  const familyCode = getFamilyCode();
  const { error } = await sb.from("task_completions").insert({
    id: uuid(), task_id: task.id, family_code: familyCode,
    date: completion.date, completed_at: completion.completedAt, points_awarded: completion.pointsAwarded,
  });
  if (error) {
    if (error.code === "23505") return false; // unique制約違反＝他端末が既に完了済み。正常系
    throw error;
  }
  if (task.type === "oneoff") {
    await sb.from("tasks").update({ status: "completed", updated_at: nowISO() }).eq("id", task.id);
  }
  const { error: historyError } = await sb.from("point_history").insert({
    id: uuid(), family_code: familyCode, type: "task", amount: task.points,
    task_id: task.id, reward_id: null, title: task.title, note: null,
    date: completion.date, created_at: completion.completedAt,
  });
  if (historyError) throw historyError;
  return true;
}

async function cloudInsertExchange(reward) {
  const familyCode = getFamilyCode();
  const { error } = await sb.from("point_history").insert({
    id: uuid(), family_code: familyCode, type: "exchange", amount: -reward.cost,
    task_id: null, reward_id: reward.id, title: reward.title, note: null,
    date: todayStr(), created_at: nowISO(),
  });
  if (error) throw error;
}

async function cloudInsertAdjustment(amount, note) {
  const familyCode = getFamilyCode();
  const { error } = await sb.from("point_history").insert({
    id: uuid(), family_code: familyCode, type: "adjustment", amount,
    task_id: null, reward_id: null, title: "手動調整", note,
    date: todayStr(), created_at: nowISO(),
  });
  if (error) throw error;
}

async function cloudUpsertTask(task) {
  const familyCode = getFamilyCode();
  const { error } = await sb.from("tasks").upsert({
    id: task.id, family_code: familyCode, title: task.title, points: task.points,
    type: task.type,
    frequency: task.type === "recurring" ? task.recurrence.frequency : null,
    weekdays: task.type === "recurring" ? task.recurrence.weekdays : null,
    due_date: task.dueDate, status: task.status, created_by: task.createdBy,
    created_at: task.createdAt, updated_at: task.updatedAt,
  });
  if (error) throw error;
}

async function cloudUpdateTaskStatus(taskId, status) {
  const { error } = await sb.from("tasks").update({ status, updated_at: nowISO() }).eq("id", taskId);
  if (error) throw error;
}

async function cloudUpsertReward(reward) {
  const familyCode = getFamilyCode();
  const { error } = await sb.from("rewards").upsert({
    id: reward.id, family_code: familyCode, title: reward.title, cost: reward.cost,
    status: reward.status, created_at: reward.createdAt, updated_at: reward.updatedAt,
  });
  if (error) throw error;
}

async function cloudUpdateRewardStatus(rewardId, status) {
  const { error } = await sb.from("rewards").update({ status, updated_at: nowISO() }).eq("id", rewardId);
  if (error) throw error;
}

async function cloudUpdateSettings(fields) {
  const familyCode = getFamilyCode();
  const { error } = await sb.from("family_settings").update({ ...fields, updated_at: nowISO() }).eq("family_code", familyCode);
  if (error) throw error;
}
