export const PAIRS = ["USD/JPY", "EUR/USD", "USD/CHF", "EUR/JPY", "CHF/JPY"];
export const RULE_VERSION = "MK裁量 実トレード検証版 V1.1";
export const SCREENER_VERSION = "V0.2";

export function computeR(pnlYen, riskYen) {
  const pnl = Number(pnlYen);
  const risk = Number(riskYen);
  if (pnlYen === "" || pnlYen == null || riskYen === "" || riskYen == null || !Number.isFinite(pnl) || !Number.isFinite(risk) || risk <= 0) return null;
  return Math.round((pnl / risk) * 10000) / 10000;
}

export function initialStopStatus(sl, noStop) {
  if (noStop) return "なし";
  if (sl == null || sl === "") return "未記録";
  if (!Number.isFinite(Number(sl)) || Number(sl) <= 0) throw new Error("初期Stopは正の価格で入力してください");
  return "設定あり";
}

export function sameRecord(a, b) {
  const sorted = value => JSON.stringify(Object.keys(value).sort().map(key => [key, value[key]]));
  return sorted(a) === sorted(b);
}

export function jstNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function newId(prefix) {
  const random = globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(36).slice(2, 10);
  return `${prefix}-${jstNow().replace(/[-:T]/g, "")}-${random}`;
}

export function csvEscape(value) {
  const text = Array.isArray(value) ? value.join(" / ") : value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function toCsv(rows, columns) {
  return "\uFEFF" + columns.map(([label]) => csvEscape(label)).join(",") + "\r\n" + rows.map(row => columns.map(([, key]) => csvEscape(row[key])).join(",")).join("\r\n") + (rows.length ? "\r\n" : "");
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export const candidateColumns = [["候補ID", "id"], ["ルール版", "ruleVersion"], ["スクリーナー版", "screenerVersion"], ["候補発生日時_JST", "candidateTime"], ["通貨ペア", "pair"], ["方向", "direction"], ["起点", "origin"], ["候補発生理由", "reasons"], ["D1認識", "d1View"], ["H4認識", "h4View"], ["H1認識", "h1View"], ["H4の役割", "h4Role"], ["セットアップ種類", "setup"], ["最終判断時間足", "decisionTf"], ["最終トリガー", "trigger"], ["MK判断", "judgment"], ["判断時コメント", "decisionComment"], ["画像件数", "imageCount"], ["作成日時", "createdAt"], ["更新日時", "updatedAt"]];
export const tradeColumns = [["トレードID", "id"], ["候補ID", "candidateId"], ["ルール版", "ruleVersion"], ["スクリーナー版", "screenerVersion"], ["実取引デモ", "accountType"], ["通貨ペア", "pair"], ["方向", "direction"], ["エントリー日時_JST", "entryTime"], ["エントリー価格_履歴照合用", "entryPrice"], ["初期Stop状態", "stopStatus"], ["初期Stop価格", "sl"], ["Limit予定", "tp"], ["トレーリング予定", "trailingPlanned"], ["初期リスク量_円_履歴照合用", "riskYen"], ["ルール遵守", "compliance"], ["エントリー時コメント", "entryComment"], ["決済日時_JST", "exitTime"], ["決済価格_履歴照合用", "exitPrice"], ["円損益_履歴照合用", "pnlYen"], ["損益R_履歴照合用", "pnlR"], ["決済時の理由", "exitReason"], ["決済後レビュー", "postReview"], ["画像件数", "imageCount"], ["作成日時", "createdAt"], ["更新日時", "updatedAt"]];

