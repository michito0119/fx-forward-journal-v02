import { PAIRS, RULE_VERSION, SCREENER_VERSION, jstNow, newId, toCsv, escapeHtml, candidateColumns, tradeColumns, initialStopStatus, sameRecord } from "./utils.mjs";
import { normalizeOandaCsv, bundleOandaRows, planOandaImport, isConfirmedClosed, isTradeOpen } from "./oanda.mjs";

const DB_NAME = "mk-forward-journal-v02";
const DB_VERSION = 4;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
let savedReviewFilter = "all";
try { savedReviewFilter = localStorage.getItem("mk-forward-review-filter") || "all"; } catch {}
const state = { listType: "candidates", reviewFilter: ["all", "win", "loss", "flat", "open", "unmatched"].includes(savedReviewFilter) ? savedReviewFilter : "all", pending: { candidate: [], candidateTrade: [], trade: [], exit: [] }, oandaPreview: null, previewUrls: [], listUrls: [] };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ["candidates", "trades", "images", "shareInbox", "oandaRows", "oandaFiles"]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
    };
    let blocked = false;
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onblocked = () => { blocked = true; reject(new Error("別の古いアプリ画面がデータベースを使用中です。画面を閉じてから開き直してください。記録データの削除は不要です")); };
    request.onerror = () => reject(request.error);
  });
}
const dbReady = openDb();

async function getAll(storeName) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getOne(storeName, id) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveRecord(storeName, record, attachments) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName, "images"], "readwrite");
    tx.objectStore(storeName).put(record);
    for (const { file, kind } of attachments) tx.objectStore("images").add({ id: newId("I"), recordId: record.id, kind, file, name: file.name, mime: file.type, addedAt: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("保存が中断されました"));
  });
}

async function saveCandidateAndTrade(candidate, trade, candidateFiles, entryFiles) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["candidates", "trades", "images"], "readwrite");
    tx.objectStore("candidates").put(candidate);
    tx.objectStore("trades").add(trade);
    for (const [files, recordId, kind] of [[candidateFiles, candidate.id, "candidate"], [entryFiles, trade.id, "trade"]]) {
      for (const file of files) tx.objectStore("images").add({ id: newId("I"), recordId, kind, file, name: file.name, mime: file.type, addedAt: new Date().toISOString() });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("保存が中断されました"));
  });
}

function formValue(form, name) { return form.elements.namedItem(name)?.value?.trim() || ""; }
function formChecked(form, name) { return !!form.elements.namedItem(name)?.checked; }
function numericOrNull(value) { return value === "" ? null : Number(value); }
function jstInputFromIso(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value)).filter(part => part.type !== "literal").map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function enteredTime(form, name, now) {
  return form.elements.namedItem(name).dataset.edited === "true" ? formValue(form, name) : jstInputFromIso(now);
}
function datetimeHistory(previous, key, value, now) {
  const history = [...(previous?.[`${key}History`] || [])];
  if (previous && (previous[key] || "") !== value) history.push({ changedAt: now, from: previous[key] || "", to: value, source: "manual" });
  return history;
}
function setStatus(id, message, error = false) { const el = $(id); el.textContent = message; el.style.color = error ? "#ffad9e" : "#6fe3bc"; }
function showView(name) {
  $$(".tab").forEach(button => { const active = button.dataset.view === name; button.classList.toggle("active", active); if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
  $$(".view").forEach(view => view.classList.toggle("active", view.id === `view-${name}`));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function clearImageHolder(holder) {
  for (const image of holder.querySelectorAll('img[src^="blob:"]')) URL.revokeObjectURL(image.src);
  holder.replaceChildren();
}
function previewButton(file, pending) {
  const url = URL.createObjectURL(file);

  const button = document.createElement("button");
  button.type = "button";
  button.className = `thumb${pending ? " pending" : ""}`;
  button.title = `${pending ? "保存前: " : ""}${file.name || "チャート画像"}`;
  const img = document.createElement("img"); img.src = url; img.alt = button.title;
  button.append(img);
  button.addEventListener("click", () => { $("#fullPhoto").src = url; $("#photoDialog").showModal(); });
  return button;
}

async function renderImages(kind, recordId = "") {
  const holder = $(`#${kind}Images`);
  clearImageHolder(holder);
  const saved = recordId ? (await getAll("images")).filter(item => item.recordId === recordId && item.kind === kind) : [];
  for (const image of saved) holder.append(previewButton(image.file, false));
  for (const file of state.pending[kind]) holder.append(previewButton(file, true));
  if (!saved.length && !state.pending[kind].length) { const note = document.createElement("span"); note.className = "micro"; note.textContent = "画像はまだありません"; holder.append(note); }
}

async function renderLinkedCandidateImages(candidateId = "") {
  const panel = $("#linkedCandidatePanel");
  const holder = $("#linkedCandidateImages");
  panel.hidden = !candidateId;
  clearImageHolder(holder);
  if (!candidateId) return;
  const images = (await getAll("images")).filter(item => item.recordId === candidateId && item.kind === "candidate");
  for (const image of images) holder.append(previewButton(image.file, false));
  if (!images.length) { const note = document.createElement("span"); note.className = "micro"; note.textContent = "候補画像はありません"; holder.append(note); }
}

function syncCandidateTradeFields() {
  const form = $("#candidateForm");
  const enabled = formChecked(form, "recordTrade");
  $("#candidateTradeFields").hidden = !enabled;
  form.elements.namedItem("candidateEntryTime").required = enabled;
  $("#candidateSave").textContent = enabled ? "候補とトレードを保存" : "候補を保存";
  if (enabled && !formValue(form, "candidateEntryTime")) form.elements.namedItem("candidateEntryTime").value = jstNow();
  if (enabled && !formValue(form, "candidateEntryComment")) form.elements.namedItem("candidateEntryComment").value = formValue(form, "decisionComment");
}

function resetForm(kind) {
  const form = $(`#${kind}Form`);
  form.reset(); form.elements.namedItem("id").value = "";
  for (const field of form.querySelectorAll('input[type="datetime-local"]')) delete field.dataset.edited;
  form.elements.namedItem(kind === "candidate" ? "candidateTime" : "entryTime").value = jstNow();
  if (kind === "trade") {
    form.elements.namedItem("sl").disabled = false;
    for (const name of ["accountType", "accountId", "pair", "direction"]) form.elements.namedItem(name).disabled = false;
    $("#tradeDatetimeInfo").textContent = "日時は保存時の登録日時を仮入力します。実際の日時は後から修正できます。";
  }
  state.pending[kind] = [];
  renderImages(kind);
  if (kind === "trade") { state.pending.exit = []; renderImages("exit"); }
  if (kind === "candidate") {
    state.pending.candidateTrade = [];
    renderImages("candidateTrade");
    form.elements.namedItem("candidateSl").disabled = false;
    form.elements.namedItem("recordTrade").disabled = false;
    $("#linkedTradeNotice").hidden = true;
    syncCandidateTradeFields();
  } else renderLinkedCandidateImages();
  setStatus(kind === "candidate" ? "#candidateStatus" : "#tradeStatus", "");
}

async function refresh() {
  const [candidates, trades, images, received] = await Promise.all([getAll("candidates"), getAll("trades"), getAll("images"), getAll("shareInbox")]);
  $("#countCandidates").textContent = candidates.length;
  $("#countTrades").textContent = trades.length;
  $("#countImages").textContent = images.length;
  const select = $("#candidateSelect");
  const chosen = select.value;
  select.replaceChildren(new Option("候補なし・後で紐づける", ""));
  candidates.sort((a, b) => b.candidateTime.localeCompare(a.candidateTime));
  for (const c of candidates) select.add(new Option(`${c.candidateTime.replace("T", " ")} ${c.pair} ${c.direction}・${c.judgment}`, c.id));
  if ([...select.options].some(option => option.value === chosen)) select.value = chosen;
  if ($("#view-records").classList.contains("active")) renderList(candidates, trades, images);
  if ($("#view-holdings").classList.contains("active")) renderHoldings(trades, images);
  if (["records", "inbox"].some(view => $(`#view-${view}`).classList.contains("active"))) renderReceivedImages(received, candidates, trades);
  if ($("#view-review").classList.contains("active")) renderReview(trades, images);
}

function renderReview(trades, images) {
  const matchedClosed = trades.filter(isConfirmedClosed);
  const filtered = trades.filter(row => {
    
    if (state.reviewFilter === "win") return isConfirmedClosed(row) && Number(row.pnlYen) > 0;
    if (state.reviewFilter === "loss") return isConfirmedClosed(row) && Number(row.pnlYen) < 0;
    if (state.reviewFilter === "flat") return isConfirmedClosed(row) && Number(row.pnlYen) === 0;
    if (state.reviewFilter === "open") return isOpenTrade(row);
    if (state.reviewFilter === "unmatched") return !row.oandaTicketId || row.reconciliationStatus === "held";
    return true;
  });
  $("#reviewCount").textContent = `表示 ${filtered.length}件 · 勝敗判定対象 ${matchedClosed.length}件（OANDA照合済み・全決済）`;
  $$("[data-review]").forEach(button => button.classList.toggle("selected", button.dataset.review === state.reviewFilter));
  renderListRows(filtered, images, $("#reviewList"), "trades", trades);
}

function renderReceivedImages(received, candidates, trades) {
  const holder = $("#receivedImageList");
  if (!holder) return;
  clearImageHolder(holder);
  $("#receivedImageCount").textContent = `未割当 ${received.length}枚`;
  if (!received.length) { holder.innerHTML = '<div class="empty">共有した画像はここに保存されます</div>'; return; }
  for (const image of received.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))) {
    const card = document.createElement("article"); card.className = "record-card received-card";
    card.append(previewButton(image.file, false));
    const info = document.createElement("div"); info.className = "record-info";
    info.innerHTML = `<h3>未割当の共有画像</h3><p>受信日時 ${escapeHtml(new Date(image.receivedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }))} JST</p><small>${escapeHtml(image.name)}</small>`;
    const actions = document.createElement("div"); actions.className = "receive-actions";
    const target = document.createElement("select"); target.setAttribute("aria-label", "画像の割当先"); target.innerHTML = '<option value="">割当先を選ぶ</option>';
    for (const row of candidates) target.add(new Option(`候補 · ${row.pair} ${row.direction} · ${row.candidateTime}`, `candidate:${row.id}`));
    for (const row of trades) target.add(new Option(`トレード · ${row.accountType} / ${row.accountId || "口座未設定"} · ${row.pair} ${row.direction} · ${row.entryTime}`, `trade:${row.id}`));
    const kind = document.createElement("select"); kind.setAttribute("aria-label", "画像の区分"); kind.innerHTML = '<option value="candidate">候補</option><option value="trade">エントリー</option><option value="exit">決済</option>';
    const assign = document.createElement("button"); assign.type = "button"; assign.className = "quiet"; assign.textContent = "選んだ記録へ割り当て"; assign.disabled = true;
    target.addEventListener("change", () => { assign.disabled = !target.value; kind.disabled = target.value.startsWith("candidate:"); if (kind.disabled) kind.value = "candidate"; else if (kind.value === "candidate") kind.value = "trade"; });
    assign.addEventListener("click", async () => {
      assign.disabled = true;
      try { await assignReceivedImage(image.id, target.value, kind.value); await refresh(); }
      catch (error) { setStatus("#receiveStatus", `割当できませんでした: ${error.message}`, true); assign.disabled = false; }
    });
    actions.append(target, kind, assign); card.append(info, actions); holder.append(card);
  }
}

async function assignReceivedImage(imageId, targetValue, kind) {
  const [type, recordId] = targetValue.split(":", 2);
  if (!recordId || !["candidate", "trade"].includes(type)) throw new Error("割当先を選んでください");
  if (type === "candidate" && kind !== "candidate") throw new Error("候補には候補画像として割り当ててください");
  if (type === "trade" && !["trade", "exit"].includes(kind)) throw new Error("画像区分が不正です");
  const db = await dbReady;
  await new Promise((resolve, reject) => {
    const storeName = type === "candidate" ? "candidates" : "trades";
    const tx = db.transaction(["images", "shareInbox", storeName], "readwrite");
    let failure;
    const imageRequest = tx.objectStore("shareInbox").get(imageId);
    imageRequest.onsuccess = () => {
      const received = imageRequest.result;
      const recordRequest = tx.objectStore(storeName).get(recordId);
      recordRequest.onsuccess = () => {
        const record = recordRequest.result;
        if (!record || !received) { failure = new Error("画像は割当済みか、割当先が見つかりません"); tx.abort(); return; }
        tx.objectStore("images").add({ id: imageId, receiptId: imageId, recordId, kind, file: received.file, name: received.name, mime: received.mime, addedAt: received.receivedAt, receivedAt: received.receivedAt });
        tx.objectStore("shareInbox").delete(imageId);
        if (kind === "exit" && !record.exitTime) {
          record.exitTime = jstInputFromIso(received.receivedAt);
          record.exitTimeSource = "registration";
          record.exitTimeHistory = record.exitTimeHistory || [];
          record.updatedAt = new Date().toISOString();
          tx.objectStore(storeName).put(record);
        }
      };
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(failure || tx.error || new Error("割当処理が中断されました"));
  });
}

let csvPreviewVersion = 0;
function clearOandaPreview() {
  csvPreviewVersion++;
  state.oandaPreview = null;
  $("#oandaPreview").replaceChildren();
  $("#applyOandaCsv").disabled = true;
}
function dataSnapshot(rows) {
  return JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)));
}
async function previewOandaFile(file) {
  clearOandaPreview();
  if (!file) return;
  const version = csvPreviewVersion;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error("CSVは20MB以下のファイルを選んでください");
    const accountType = $("#oandaAccountType").value;
    const accountId = $("#oandaAccountId").value.trim();
    if (!accountId || accountId.length > 64) throw new Error("口座を区別する固定の名前を64文字以内で入力してください");
    const bytes = await file.arrayBuffer();
    let csvText, encoding = "UTF-8";
    try { csvText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { csvText = new TextDecoder("shift-jis", { fatal: true }).decode(bytes); encoding = "Shift-JIS"; }
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
    const sourceId = JSON.stringify([accountType, accountId, digest]);
    const now = new Date().toISOString();
    const incoming = normalizeOandaCsv(csvText).map(row => ({ ...row, id: JSON.stringify([accountType, accountId, digest, row.id]), accountType, accountId, sourceId, sourceFile: file.name, importedAt: now }));
    if (!incoming.length) throw new Error("CSVに取引明細がありません");
    const saved = await getAll("oandaRows");
    const byId = new Map(saved.map(row => [row.id, row]));
    const rows = [...saved, ...incoming.filter(row => !byId.has(row.id))];
    const affected = new Set(incoming.map(row => row.ticketId));
    const bundles = bundleOandaRows(rows.filter(row => row.accountType === accountType && row.accountId === accountId && affected.has(row.ticketId)));
    const trades = await getAll("trades");
    const proposals = planOandaImport(bundles, trades, accountType, accountId, PAIRS);
    if (version !== csvPreviewVersion) return;
    state.oandaPreview = { rows: incoming, proposals, accountType, accountId,
      tradesSnapshot: dataSnapshot(trades), rowsSnapshot: dataSnapshot(saved),
      source: { id: sourceId, sha256: digest, name: file.name, file, encoding, accountType, accountId, importedAt: now } };
    const safeCount = proposals.filter(row => row.action !== "保留").length;
    $("#oandaPreview").innerHTML = `<p class="micro">${escapeHtml(file.name)} · ${escapeHtml(accountId)} · CSV明細 ${incoming.length}行 · 一括反映対象 ${safeCount}件 · 保留 ${proposals.length - safeCount}件</p>` + proposals.map(row => `<article class="record-card"><div><strong>${escapeHtml(row.action)} · ${escapeHtml(row.status)}</strong><p>${escapeHtml(row.entry?.pair || "ペア未確認")} ${escapeHtml(row.entry?.direction || "")} · チケット ${escapeHtml(row.ticketId || "不明")}</p><small>${escapeHtml(row.note)}</small></div></article>`).join("");
    $("#applyOandaCsv").disabled = false;
    setStatus("#oandaStatus", "全件を確認し、一括反映してください。保留明細と元CSVも端末内へ保存します。");
  } catch (error) {
    if (version !== csvPreviewVersion) return;
    clearOandaPreview();
    setStatus("#oandaStatus", `CSVを読み込めません: ${error.message}`, true);
  }
}

function applyOandaBundle(previous, bundle, accountType, accountId) {
  const entry = bundle.entry;
  const exit = bundle.exit;
  const now = new Date().toISOString();
  const trade = previous ? structuredClone(previous) : { id: newId("T"), candidateId: "", ruleVersion: "未確認（CSV由来）", screenerVersion: SCREENER_VERSION, recordOrigin: "oanda", forwardEligible: false, accountType, accountId, pair: entry.pair, direction: entry.direction, entryTime: entry.entryTime, entryTimeSource: "oanda", entryTimeHistory: [], entryPrice: entry.price, sl: null, stopStatus: "未記録", tp: null, trailingPlanned: false, riskYen: null, compliance: "", entryComment: "", exitTime: "", exitPrice: null, pnlYen: null, pnlR: null, exitReason: "", postReview: "", registeredAt: now, createdAt: now };
  const entryHistory = [...(trade.entryTimeHistory || [])];
  const userEntryTime = trade.entryTimeSource === "manual" ? trade.entryTime : (trade.entryTimeUser || "");
  if (trade.entryTime && trade.entryTime !== entry.entryTime) entryHistory.push({ changedAt: now, from: trade.entryTime, to: entry.entryTime, source: "oanda" });
  trade.entryTimeOriginal ??= trade.entryTime;
  trade.entryTimeUser = userEntryTime;
  trade.entryTime = entry.entryTime;
  trade.entryTimeSource = "oanda";
  trade.entryTimeOanda = entry.datetimeIso;
  trade.entryPrice = entry.price;
  trade.accountId = accountId;
  trade.quantity = entry.quantity;
  trade.reconciliationStatus = exit ? "closed" : "open";
  trade.oandaTicketId = bundle.ticketId;
  trade.oandaEventIds = bundle.items.map(row => row.id);
  trade.entryTimeHistory = entryHistory;
  if (exit) {
    const exitHistory = [...(trade.exitTimeHistory || [])];
    const userExitTime = trade.exitTimeSource === "manual" ? trade.exitTime : (trade.exitTimeUser || "");
    if (trade.exitTime && trade.exitTime !== exit.entryTime) exitHistory.push({ changedAt: now, from: trade.exitTime, to: exit.entryTime, source: "oanda" });
    trade.exitTimeOriginal ??= trade.exitTime;
    trade.exitTimeUser = userExitTime;
    trade.exitTime = exit.entryTime;
    trade.exitTimeSource = "oanda";
    trade.exitTimeOanda = exit.datetimeIso;
    trade.exitPrice = exit.price;
    trade.pnlYen = exit.spotPnlYen;
    trade.swapYen = exit.swapYen;
    trade.feeYen = exit.feeYen;
    const pipSize = entry.pair.endsWith("/JPY") ? 0.01 : 0.0001;
    const rawPips = (exit.price - entry.price) * (entry.direction === "買い" ? 1 : -1) / pipSize;
    trade.pips = Math.round(rawPips * 10) / 10;
    trade.exitTimeHistory = exitHistory;
  }
  trade.updatedAt = now;
  return trade;
}

async function applyOandaImport() {
  const preview = state.oandaPreview;
  const button = $("#applyOandaCsv");
  if (!preview || button.disabled) return;
  button.disabled = true;
  try {
    const db = await dbReady;
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(["trades", "oandaRows", "oandaFiles"], "readwrite");
      const tradeRequest = tx.objectStore("trades").getAll();
      const rowRequest = tx.objectStore("oandaRows").getAll();
      let failure, updated = 0, incoming = 0;
      rowRequest.onsuccess = () => {
        try {
          const trades = tradeRequest.result, rows = rowRequest.result;
          if (dataSnapshot(trades) !== preview.tradesSnapshot || dataSnapshot(rows) !== preview.rowsSnapshot)
            throw new Error("確認後に記録が変更されました。CSVを選び直して照合結果を確認してください");
          const known = new Set(rows.map(row => row.id));
          for (const row of preview.rows) if (!known.has(row.id)) { tx.objectStore("oandaRows").add(row); known.add(row.id); incoming++; }
          for (const proposal of preview.proposals) {
            if (proposal.action === "保留") {
              for (const trade of trades.filter(row => row.accountType === preview.accountType && row.accountId === preview.accountId && row.oandaTicketId === proposal.ticketId))
                tx.objectStore("trades").put({ ...trade, reconciliationStatus: "held", reconciliationNote: proposal.note });
              continue;
            }
            const previous = proposal.tradeId ? trades.find(trade => trade.id === proposal.tradeId) : null;
            tx.objectStore("trades").put(applyOandaBundle(previous, proposal, preview.accountType, preview.accountId));
            updated++;
          }
          tx.objectStore("oandaFiles").put(preview.source);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve({ updated, incoming });
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(failure || tx.error || new Error("CSV反映が中断されました"));
    });
    state.oandaPreview = null;
    await refresh();
    setStatus("#oandaStatus", `反映しました: トレード${result.updated}件・新規明細${result.incoming}行。保留${preview.proposals.length - result.updated}件。元CSVも画像込みバックアップの対象です。`);
  } catch (error) {
    state.oandaPreview = null;
    setStatus("#oandaStatus", `反映できませんでした: ${error.message}`, true);
  }
}

function renderList(candidates, trades, images) {
  const rows = state.listType === "candidates" ? candidates : trades;
  renderListRows(rows, images, $("#recordList"), state.listType, trades);
}

function isOpenTrade(row) { return isTradeOpen(row); }

function renderHoldings(trades, images) {
  const rows = trades.filter(isOpenTrade);
  $("#holdingsCount").textContent = `保有中・決済未確認のトレード ${rows.length}件`;
  renderListRows(rows, images, $("#holdingList"), "trades");
}

function renderListRows(rows, images, holder, type, trades = []) {
  clearImageHolder(holder);
  if (!rows.length) { holder.innerHTML = `<div class="empty">${type === "trades" && holder.id === "holdingList" ? "保有中のトレードはありません" : "まだ記録がありません"}</div>`; return; }
  const imagesByRecord = new Map();
  for (const image of images) {
    if (!imagesByRecord.has(image.recordId)) imagesByRecord.set(image.recordId, []);
    imagesByRecord.get(image.recordId).push(image);
  }
  rows.sort((a, b) => (type === "candidates" ? b.candidateTime.localeCompare(a.candidateTime) : b.entryTime.localeCompare(a.entryTime)));
  for (const row of rows) {
    const card = document.createElement("article"); card.className = "record-card";
    const when = type === "candidates" ? row.candidateTime : row.entryTime;
    const detail = type === "candidates" ? `${row.origin} · ${row.judgment}` : `${row.accountType} / ${row.accountId || "口座未設定"} · ${row.recordOrigin === "oanda" ? "CSV由来・検証対象外" : row.compliance || "遵守保留"}`;
    const recordImages = imagesByRecord.get(row.id) || [];
    const linkedCandidateImages = type === "trades" && row.candidateId ? (imagesByRecord.get(row.candidateId) || []).filter(image => image.kind === "candidate") : [];
    const firstImage = (type === "trades" && recordImages.find(image => image.kind === "trade")) || linkedCandidateImages[0] || recordImages[0];
    if (firstImage && holder.id !== "reviewList") {
      const thumbnail = document.createElement("img");
      thumbnail.className = "record-thumb";
      const url = URL.createObjectURL(firstImage.file);
      thumbnail.src = url; thumbnail.alt = `${row.pair}の添付画像`;
      card.append(thumbnail);
    } else if (!firstImage) {
      const thumbnail = document.createElement("div"); thumbnail.className = "record-thumb no-img"; thumbnail.textContent = "📊"; card.append(thumbnail);
    }
    const imageSummary = type === "trades" ? `候補画像 ${linkedCandidateImages.length}枚 · エントリー追加画像 ${recordImages.filter(image => image.kind === "trade").length}枚 · 決済画像 ${recordImages.filter(image => image.kind === "exit").length}枚` : `画像 ${recordImages.length}枚`;
    const outcome = type === "trades" && isConfirmedClosed(row) ? `売買損益 ${Number(row.pnlYen).toLocaleString()}円 · ${row.pips == null ? "pips未算定" : `${row.pips}pips`}` : "勝敗未判定";
    const linkedTrade = type === "candidates" ? trades.find(trade => trade.candidateId === row.id) : null;
    const candidateAction = type === "candidates" ? (linkedTrade ? `<button type="button" class="quiet" data-open-trade="${escapeHtml(linkedTrade.id)}">トレードを見る</button>` : `<button type="button" class="quiet" data-start-entry="${escapeHtml(row.id)}" aria-label="この候補からエントリーを記録">エントリー</button>`) : "";
    card.insertAdjacentHTML("beforeend", `<div class="record-info"><h3>${escapeHtml(row.pair)} <span class="${row.direction === "買い" ? "buy" : "sell"}">${escapeHtml(row.direction)}</span></h3><p>${escapeHtml(when?.replace("T", " "))} JST · ${escapeHtml(detail)}</p><small>${escapeHtml(imageSummary)} · ${escapeHtml(outcome)} · ${escapeHtml(row.id)}</small></div><div class="record-actions"><button type="button" class="quiet" data-edit="${escapeHtml(row.id)}" data-type="${type}">開く</button>${candidateAction}</div>`);
    if (type === "trades" && holder.id === "reviewList") {
      const gallery = document.createElement("div"); gallery.className = "review-image-grid";
      const reviewImages = [...linkedCandidateImages.map(image => ({ image, label: "候補" })), ...recordImages.filter(image => image.kind === "trade").map(image => ({ image, label: "エントリー" })), ...recordImages.filter(image => image.kind === "exit").map(image => ({ image, label: "決済" }))];
      for (const item of reviewImages) { const cell = document.createElement("div"); cell.className = "review-image-item"; const label = document.createElement("small"); label.textContent = item.label; cell.append(label, previewButton(item.image.file, false)); gallery.append(cell); }
      if (reviewImages.length) card.append(gallery);
    }
    holder.append(card);
  }
}

function fillForm(form, record) {
  for (const element of form.elements) {
    if (!element.name || element.name === "reasons" || element.type === "file") continue;
    if (element.type === "checkbox") element.checked = element.name === "noStop" ? record.stopStatus === "なし" : !!record[element.name];
    else if (element.name in record) element.value = record[element.name] ?? "";
  }
  if (form.getAttribute("id") === "tradeForm") form.elements.namedItem("sl").disabled = formChecked(form, "noStop");
  if (record.reasons) $$("#candidateForm input[name=reasons]").forEach(check => { check.checked = record.reasons.includes(check.value); });
}

async function editRecord(type, id) {
  const kind = type === "candidates" ? "candidate" : "trade";
  const record = await getOne(type, id);
  if (!record) return;
  showView(type);
  $(`#${kind}Form`).reset();
  state.pending[kind] = [];
  if (kind === "trade") state.pending.exit = [];
  else state.pending.candidateTrade = [];
  fillForm($(`#${kind}Form`), record);
  for (const field of $(`#${kind}Form`).querySelectorAll('input[type="datetime-local"]')) delete field.dataset.edited;
  if (kind === "trade") for (const name of ["accountType", "accountId", "pair", "direction"]) $("#tradeForm").elements.namedItem(name).disabled = !!record.oandaTicketId;
  if (kind === "trade") {
    for (const key of ["entryTime", "exitTime"]) if (record[key + "User"] !== undefined) $("#tradeForm").elements.namedItem(key).value = record[key + "User"];
    const registration = record.registeredAt || record.createdAt;
    const history = [...(record.entryTimeHistory || []).map(item => `エントリー日時: ${item.from || "未入力"} → ${item.to} (${item.changedAt})`), ...(record.exitTimeHistory || []).map(item => `決済日時: ${item.from || "未入力"} → ${item.to} (${item.changedAt})`)];
    $("#tradeDatetimeInfo").textContent = `登録日時: ${registration ? new Date(registration).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) + " JST" : "未記録"}。エントリー: ${record.entryTimeSource === "registration" ? "登録日時の仮入力" : record.entryTimeSource === "oanda" ? "CSV約定日時" : "本人記録・未確認"} / 決済: ${record.exitTimeSource === "registration" ? "仮入力・決済未確認" : record.exitTimeSource === "oanda" ? "CSV全決済" : "本人記録・未確認"}。${record.oandaTicketId ? " CSV約定は保持し、日時の修正は本人メモとして別に保存します。" : ""}日時の変更履歴: ${history.length ? history.join(" / ") : "なし"}`;
  }
  await renderImages(kind, id);
  if (kind === "trade") {
    await renderImages("exit", id);
    await renderLinkedCandidateImages(record.candidateId);
  } else {
    await renderImages("candidateTrade");
    const linked = (await getAll("trades")).find(trade => trade.candidateId === id);
    $("#candidateForm").elements.namedItem("recordTrade").disabled = !!linked;
    $("#linkedTradeNotice").hidden = !linked;
    $("#candidateForm").elements.namedItem("candidateSl").disabled = false;
    syncCandidateTradeFields();
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function saveCandidate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) { setStatus("#candidateStatus", "必須項目を入力してください。", true); return; }
  const submit = $("#candidateSave");
  if (submit.disabled) return;
  submit.disabled = true;
  setStatus("#candidateStatus", "保存中…");
  try {
    const id = formValue(form, "id") || newId("C");
    const previous = await getOne("candidates", id);
    const now = new Date().toISOString();
    const candidate = { ...previous, id, ruleVersion: previous?.ruleVersion || RULE_VERSION, screenerVersion: previous?.screenerVersion || SCREENER_VERSION, candidateTime: formValue(form, "candidateTime"), pair: formValue(form, "pair"), direction: formValue(form, "direction"), origin: formValue(form, "origin"), reasons: [...form.querySelectorAll('input[name="reasons"]:checked')].map(el => el.value), d1View: formValue(form, "d1View"), h4View: formValue(form, "h4View"), h1View: formValue(form, "h1View"), h4Role: formValue(form, "h4Role"), setup: formValue(form, "setup"), decisionTf: formValue(form, "decisionTf"), trigger: formValue(form, "trigger"), judgment: formValue(form, "judgment"), decisionComment: formValue(form, "decisionComment"), registeredAt: previous?.registeredAt || previous?.createdAt || now, createdAt: previous?.createdAt || now, updatedAt: now };
    const imageCount = state.pending.candidate.length;
    if (formChecked(form, "recordTrade")) {
      const existing = (await getAll("trades")).find(trade => trade.candidateId === id);
      if (existing) throw new Error("この候補のトレードは記録済みです。履歴から開いてください");
      const noStop = formChecked(form, "candidateNoStop");
      const sl = noStop ? null : numericOrNull(formValue(form, "candidateSl"));
      const candidateEntryTime = enteredTime(form, "candidateEntryTime", now);
      const trade = { id: newId("T"), candidateId: id, ruleVersion: candidate.ruleVersion, screenerVersion: candidate.screenerVersion, accountType: formValue(form, "candidateAccountType"), accountId: formValue(form, "candidateAccountId"), pair: candidate.pair, direction: candidate.direction, entryTime: candidateEntryTime, entryTimeSource: form.elements.namedItem("candidateEntryTime").dataset.edited === "true" ? "manual" : "registration", entryTimeHistory: [], exitTime: "", exitTimeSource: "unrecorded", exitTimeHistory: [], entryPrice: null, sl, stopStatus: initialStopStatus(sl, noStop), tp: numericOrNull(formValue(form, "candidateTp")), trailingPlanned: formChecked(form, "candidateTrailingPlanned"), riskYen: null, compliance: "", entryComment: formValue(form, "candidateEntryComment"), exitPrice: null, pnlYen: null, pnlR: null, exitReason: "", postReview: "", registeredAt: now, createdAt: now, updatedAt: now };
      await saveCandidateAndTrade(candidate, trade, state.pending.candidate, state.pending.candidateTrade);
      const entryImageCount = state.pending.candidateTrade.length;
      resetForm("candidate"); await refresh();
      setStatus("#candidateStatus", `候補とトレードを保存しました。候補画像${imageCount}枚はトレードからも確認できます。エントリー追加画像${entryImageCount}枚。`);
    } else {
      await saveRecord("candidates", candidate, state.pending.candidate.map(file => ({ file, kind: "candidate" })));
      resetForm("candidate"); await refresh(); setStatus("#candidateStatus", `保存しました: ${id}（画像${imageCount}枚）`);
    }
  }
  catch (error) { setStatus("#candidateStatus", `保存できませんでした: ${error.message}`, true); }
  finally { submit.disabled = false; }
}

async function saveTrade(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) { setStatus("#tradeStatus", "必須項目を入力してください。", true); return; }
  const submit = form.querySelector("button[type=submit]");
  if (submit.disabled) return;
  submit.disabled = true;
  setStatus("#tradeStatus", "保存中…");
  try {
    const id = formValue(form, "id") || newId("T");
    const previous = await getOne("trades", id);
    const now = new Date().toISOString();
    const noStop = formChecked(form, "noStop");
    const sl = noStop ? null : numericOrNull(formValue(form, "sl"));
    const stopStatus = initialStopStatus(sl, noStop);
    const keepRisk = previous?.sl === sl && stopStatus === "設定あり";
    const entryTime = previous ? formValue(form, "entryTime") : enteredTime(form, "entryTime", now);
    const exitTime = formValue(form, "exitTime") || (state.pending.exit.length ? jstInputFromIso(now) : "");
    const trade = { ...previous, id, candidateId: formValue(form, "candidateId"), ruleVersion: previous?.ruleVersion || RULE_VERSION, accountType: formValue(form, "accountType"), accountId: formValue(form, "accountId"), pair: formValue(form, "pair"), direction: formValue(form, "direction"), entryTime, entryTimeSource: form.elements.namedItem("entryTime").dataset.edited === "true" ? "manual" : (previous?.entryTimeSource || "registration"), entryTimeHistory: datetimeHistory(previous, "entryTime", entryTime, now), entryPrice: previous?.entryPrice ?? null, sl, stopStatus, tp: numericOrNull(formValue(form, "tp")), trailingPlanned: formChecked(form, "trailingPlanned"), riskYen: keepRisk ? previous.riskYen ?? null : null, compliance: formValue(form, "compliance"), entryComment: formValue(form, "entryComment"), exitTime, exitTimeSource: !exitTime ? "unrecorded" : form.elements.namedItem("exitTime").dataset.edited === "true" ? "manual" : (previous?.exitTimeSource || "registration"), exitTimeHistory: datetimeHistory(previous, "exitTime", exitTime, now), exitPrice: previous?.exitPrice ?? null, pnlYen: previous?.pnlYen ?? null, pnlR: keepRisk ? previous.pnlR ?? null : null, exitReason: formValue(form, "exitReason"), postReview: formValue(form, "postReview"), registeredAt: previous?.registeredAt || previous?.createdAt || now, createdAt: previous?.createdAt || now, updatedAt: now };

    if (previous?.oandaTicketId) {
      for (const name of ["accountType", "accountId", "pair", "direction"]) trade[name] = previous[name];
      for (const key of ["entryTime", "exitTime"]) if (previous[key + "Oanda"]) {
        if (form.elements.namedItem(key).dataset.edited === "true") {
          trade[key + "User"] = formValue(form, key);
          trade[key + "History"] = [...(previous[key + "History"] || []), { changedAt: now, from: previous[key + "User"] || previous[key], to: trade[key + "User"], source: "manual" }];
        } else trade[key + "History"] = previous[key + "History"] || [];
        trade[key] = jstInputFromIso(previous[key + "Oanda"]);
        trade[key + "Source"] = "oanda";
      }
    }
    trade.screenerVersion = previous?.screenerVersion || SCREENER_VERSION;

    const entryImageCount = state.pending.trade.length;
    const exitImageCount = state.pending.exit.length;
    const attachments = [...state.pending.trade.map(file => ({ file, kind: "trade" })), ...state.pending.exit.map(file => ({ file, kind: "exit" }))];
    await saveRecord("trades", trade, attachments); resetForm("trade"); await refresh(); setStatus("#tradeStatus", `保存しました: ${id}（エントリー画像${entryImageCount}枚・決済画像${exitImageCount}枚を追加）`);
  }
  catch (error) { setStatus("#tradeStatus", `保存できませんでした: ${error.message}`, true); }
  finally { submit.disabled = false; }
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function imageToDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }
function dataUrlToBlob(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("画像形式が不正です");
  const binary = atob(match[2]); if (binary.length > MAX_IMAGE_BYTES) throw new Error("25MBを超える画像があります");
  const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}

async function exportBackup() {
  setStatus("#backupStatus", "画像を含むバックアップを作成中…");
  try {
    const [candidates, trades, images, received, oandaRows, oandaFiles] = await Promise.all([getAll("candidates"), getAll("trades"), getAll("images"), getAll("shareInbox"), getAll("oandaRows"), getAll("oandaFiles")]);
    const encoded = [];
    for (const image of images) encoded.push({ id: image.id, recordId: image.recordId, kind: image.kind, receiptId: image.receiptId || null, name: image.name, mime: image.mime, addedAt: image.addedAt, receivedAt: image.receivedAt || null, dataUrl: await imageToDataUrl(image.file) });
    const unassignedImages = [];
    for (const image of received) unassignedImages.push({ id: image.id, name: image.name, mime: image.mime, receivedAt: image.receivedAt, status: "unassigned", dataUrl: await imageToDataUrl(image.file) });
    const sourceFiles = [];
    for (const source of oandaFiles) {
      const { file, ...metadata } = source;
      sourceFiles.push({ ...metadata, dataUrl: await imageToDataUrl(file) });
    }
    const backup = { schema: "mk-forward-v02", ruleVersion: RULE_VERSION, screenerVersion: SCREENER_VERSION, exportedAt: new Date().toISOString(), candidates, trades, images: encoded, unassignedImages, oandaRows, oandaFiles: sourceFiles };
    download(`MK裁量V02_完全バックアップ_${jstNow().slice(0, 10)}.json`, new Blob([JSON.stringify(backup)], { type: "application/json" }));
    setStatus("#backupStatus", `書き出しました: 候補${candidates.length}件・トレード${trades.length}件・添付画像${images.length}枚・未割当画像${received.length}枚・OANDA明細${oandaRows.length}行`);
  } catch (error) { setStatus("#backupStatus", `バックアップ失敗: ${error.message}`, true); }
}

async function importBackup(file) {
  if (!file) return;
  if (file.size > 250 * 1024 * 1024) { setStatus("#backupStatus", "250MBを超えるバックアップは取り込めません", true); return; }
  setStatus("#backupStatus", "バックアップを検査中…");
  try {
    const backup = JSON.parse(await file.text());
    if (backup.schema !== "mk-forward-v02" || backup.screenerVersion !== SCREENER_VERSION || !Array.isArray(backup.candidates) || !Array.isArray(backup.trades) || !Array.isArray(backup.images) || (backup.unassignedImages != null && !Array.isArray(backup.unassignedImages))) throw new Error("V0.2記録アプリのバックアップではありません");
    const incomingReceived = backup.unassignedImages || [];
    const incomingOandaRows = backup.oandaRows || [];
    const incomingSources = backup.oandaFiles || [];
    if (!Array.isArray(incomingSources)) throw new Error("元CSVバックアップが不正です");
    if (!Array.isArray(incomingOandaRows)) throw new Error("OANDA明細バックアップが不正です");
    if (backup.candidates.length + backup.trades.length > 10000 || backup.images.length + incomingReceived.length + incomingOandaRows.length > 10000) throw new Error("件数が上限を超えています");
    for (const rows of [backup.candidates, backup.trades, backup.images, incomingReceived, incomingOandaRows, incomingSources]) {
      if (rows.some(row => !row || typeof row.id !== "string") || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("バックアップ内に不正または重複したIDがあります");
    }
    const [oldC, oldT, oldI, oldReceived, oldOandaRows, oldSources] = await Promise.all([getAll("candidates"), getAll("trades"), getAll("images"), getAll("shareInbox"), getAll("oandaRows"), getAll("oandaFiles")]);
    const knownC = new Set(oldC.map(row => row.id)), knownT = new Set(oldT.map(row => row.id)), knownI = new Set(oldI.map(row => row.id));
    const conflictingIds = new Set();
    for (const [incoming, existing] of [[backup.candidates, oldC], [backup.trades, oldT]]) {
      const byId = new Map(existing.map(row => [row.id, row]));
      for (const row of incoming) {
        const current = byId.get(row.id);
        if (current && !sameRecord(current, row)) conflictingIds.add(row.id);
      }
    }
    const candidates = backup.candidates.filter(row => typeof row.id === "string" && row.screenerVersion === SCREENER_VERSION && PAIRS.includes(row.pair) && !knownC.has(row.id));
    const trades = backup.trades.filter(row => typeof row.id === "string" && row.screenerVersion === SCREENER_VERSION && PAIRS.includes(row.pair) && !knownT.has(row.id));
    const validParents = new Set([...oldC, ...oldT, ...candidates, ...trades].map(row => row.id).filter(id => !conflictingIds.has(id)));
    const images = backup.images.filter(row => typeof row.id === "string" && validParents.has(row.recordId) && !knownI.has(row.id)).map(row => ({ id: row.id, recordId: row.recordId, kind: row.kind, receiptId: row.receiptId || null, name: row.name, mime: row.mime, addedAt: row.addedAt, receivedAt: row.receivedAt || null, file: dataUrlToBlob(row.dataUrl) }));
    const knownReceived = new Set([...oldReceived.map(row => row.id), ...oldI.map(row => row.receiptId || row.id), ...images.map(row => row.receiptId || row.id)]);
    const unassignedImages = incomingReceived.filter(row => typeof row.id === "string" && !knownReceived.has(row.id)).map(row => ({ id: row.id, name: row.name || "共有画像", mime: row.mime, receivedAt: row.receivedAt, status: "unassigned", file: dataUrlToBlob(row.dataUrl) }));
    const knownOandaRows = new Set(oldOandaRows.map(row => row.id));
    const oandaRows = incomingOandaRows.filter(row => typeof row.id === "string" && !knownOandaRows.has(row.id));
    const knownSources = new Set(oldSources.map(row => row.id));
    const sourceFiles = incomingSources.filter(row => !knownSources.has(row.id)).map(row => {
      const match = /^data:[^,]*;base64,([A-Za-z0-9+/=]+)$/.exec(row.dataUrl || "");
      if (!match) throw new Error("元CSVの保存形式が不正です");
      const binary = atob(match[1]);
      if (binary.length > 20 * 1024 * 1024) throw new Error("元CSVが20MBを超えています");
      const { dataUrl, ...metadata } = row;
      return { ...metadata, file: new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))], { type: "text/csv" }) };
    });
    const db = await dbReady;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["candidates", "trades", "images", "shareInbox", "oandaRows", "oandaFiles"], "readwrite");
      for (const row of candidates) tx.objectStore("candidates").add(row);
      for (const row of trades) tx.objectStore("trades").add(row);
      for (const row of images) { tx.objectStore("images").add(row); tx.objectStore("shareInbox").delete(row.receiptId || row.id); }
      for (const row of unassignedImages) tx.objectStore("shareInbox").add(row);
      for (const row of oandaRows) tx.objectStore("oandaRows").add(row);
      for (const row of sourceFiles) tx.objectStore("oandaFiles").add(row);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error("復元が中断されました"));
    });
    await refresh();
    setStatus("#backupStatus", `追加しました: 候補${candidates.length}件・トレード${trades.length}件・添付画像${images.length}枚・未割当画像${unassignedImages.length}枚・OANDA明細${oandaRows.length}行。${conflictingIds.size ? `同じIDで内容が異なる${conflictingIds.size}件は上書きせず、添付画像も取り込んでいません。元端末の記録を確認してください。` : "同じIDは上書きしていません。"}`, !!conflictingIds.size);
  } catch (error) { setStatus("#backupStatus", `取り込み失敗: ${error.message}`, true); }
}

async function exportCsv(type) {
  const [rows, images] = await Promise.all([getAll(type), getAll("images")]);
  const counts = new Map(); for (const image of images) counts.set(image.recordId, (counts.get(image.recordId) || 0) + 1);
  const augmented = rows.map(row => ({ ...row, imageCount: counts.get(row.id) || 0 }));
  const columns = type === "candidates" ? candidateColumns : tradeColumns;
  download(`MK裁量V02_${type === "candidates" ? "候補" : "トレード"}_${jstNow().slice(0, 10)}.csv`, new Blob([toCsv(augmented, columns)], { type: "text/csv;charset=utf-8" }));
  setStatus("#backupStatus", `${type === "candidates" ? "候補" : "トレード"}CSVを書き出しました。画像はJSONバックアップで保存してください。`);
}

function wireEvents() {
  $$(".tab").forEach(button => button.addEventListener("click", () => { showView(button.dataset.view); if (["records", "holdings", "inbox", "oanda", "review"].includes(button.dataset.view)) refresh(); }));
  $("#candidateForm").addEventListener("submit", saveCandidate);
  $("#tradeForm").addEventListener("submit", saveTrade);
  $("#newCandidate").addEventListener("click", () => resetForm("candidate"));
  $("#newTrade").addEventListener("click", () => resetForm("trade"));
  $("#recordTradeWithCandidate").addEventListener("change", syncCandidateTradeFields);
  $("#candidateForm").elements.namedItem("candidateNoStop").addEventListener("change", event => {
    const sl = $("#candidateForm").elements.namedItem("candidateSl");
    if (event.target.checked) sl.value = "";
    sl.disabled = event.target.checked;
  });
  $("#candidateForm").elements.namedItem("candidateSl").addEventListener("input", event => {
    if (event.target.value !== "") $("#candidateForm").elements.namedItem("candidateNoStop").checked = false;
  });
  $$(".image-input").forEach(input => input.addEventListener("change", async () => {
    const kind = input.dataset.kind;
    let rejected = 0;
    for (const file of input.files) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > MAX_IMAGE_BYTES) { rejected++; continue; }
      state.pending[kind].push(file);
    }
    input.value = "";
    try {
      await renderImages(kind, kind === "candidate" ? $("#candidateForm").elements.namedItem("id").value : kind === "candidateTrade" ? "" : $("#tradeForm").elements.namedItem("id").value);
      const label = kind === "exit" ? "決済画像" : kind === "trade" || kind === "candidateTrade" ? "エントリー画像" : "画像";
      const saveLabel = kind === "candidateTrade" ? "候補とトレード" : kind === "candidate" ? "候補" : "トレード";
      const message = `${label}${state.pending[kind].length}枚選択済み。下の「${saveLabel}を保存」で画像も保存します。${rejected ? `対応外または25MB超の画像${rejected}枚は除外しました。` : ""}`;
      setStatus(kind === "candidate" || kind === "candidateTrade" ? "#candidateStatus" : "#tradeStatus", message, !!rejected);
    } catch (error) { setStatus(kind === "candidate" || kind === "candidateTrade" ? "#candidateStatus" : "#tradeStatus", `画像を表示できません: ${error.message}`, true); }
  }));
  $("#candidateSelect").addEventListener("change", async event => {
    const candidate = event.target.value ? await getOne("candidates", event.target.value) : null;
    await renderLinkedCandidateImages(candidate?.id);
    if (candidate && !formValue($("#tradeForm"), "id")) {
      $("#tradeForm").elements.namedItem("pair").value = candidate.pair;
      $("#tradeForm").elements.namedItem("direction").value = candidate.direction;
      if (!formValue($("#tradeForm"), "entryComment")) $("#tradeForm").elements.namedItem("entryComment").value = candidate.decisionComment || "";
    }
  });
  $("#tradeForm").elements.namedItem("noStop").addEventListener("change", event => {
    const sl = $("#tradeForm").elements.namedItem("sl");
    if (event.target.checked) sl.value = "";
    sl.disabled = event.target.checked;
  });
  $("#tradeForm").elements.namedItem("sl").addEventListener("input", event => {
    if (event.target.value !== "") $("#tradeForm").elements.namedItem("noStop").checked = false;
  });
  $("#recordList").addEventListener("click", async event => {
    const start = event.target.closest("[data-start-entry]");
    if (start) {
      await editRecord("candidates", start.dataset.startEntry);
      $("#recordTradeWithCandidate").checked = true;
      syncCandidateTradeFields();
      $("#candidateTradeFields").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const linked = event.target.closest("[data-open-trade]");
    if (linked) { await editRecord("trades", linked.dataset.openTrade); return; }
    const button = event.target.closest("[data-edit]");
    if (button) await editRecord(button.dataset.type, button.dataset.edit);
  });
  $("#holdingList").addEventListener("click", event => { const button = event.target.closest("[data-edit]"); if (button) editRecord(button.dataset.type, button.dataset.edit); });
  $("#reviewList").addEventListener("click", event => { const button = event.target.closest("[data-edit]"); if (button) editRecord(button.dataset.type, button.dataset.edit); });
  $$('input[type="datetime-local"]').forEach(field => field.addEventListener("input", () => { field.dataset.edited = "true"; }));
  $$(".segmented button[data-list]").forEach(button => button.addEventListener("click", async () => { state.listType = button.dataset.list; $$(".segmented button[data-list]").forEach(item => item.classList.toggle("selected", item === button)); const [c, t, i] = await Promise.all([getAll("candidates"), getAll("trades"), getAll("images")]); renderList(c, t, i); }));
  $("#exportBackup").addEventListener("click", exportBackup);
  $("#importBackup").addEventListener("change", event => { importBackup(event.target.files[0]); event.target.value = ""; });
  $("#exportCandidatesCsv").addEventListener("click", () => exportCsv("candidates"));
  $("#exportTradesCsv").addEventListener("click", () => exportCsv("trades"));
  $("#oandaCsvInput").addEventListener("change", event => { previewOandaFile(event.target.files[0]); event.target.value = ""; });
  $("#oandaAccountType").addEventListener("change", clearOandaPreview);
  $("#oandaAccountId").addEventListener("input", clearOandaPreview);
  $("#applyOandaCsv").addEventListener("click", applyOandaImport);
  $$("[data-review]").forEach(button => button.addEventListener("click", () => {
    state.reviewFilter = button.dataset.review;
    try { localStorage.setItem("mk-forward-review-filter", state.reviewFilter); } catch {}
    refresh();
  }));
  $("#closePhoto").addEventListener("click", () => $("#photoDialog").close());
  $("#photoDialog").addEventListener("click", event => { if (event.target === $("#photoDialog")) $("#photoDialog").close(); });
  window.addEventListener("beforeunload", () => { for (const img of $$('img[src^="blob:"]')) URL.revokeObjectURL(img.src); });
}

function setupInstallHelp() {
  const onAndroid = /Android/i.test(navigator.userAgent);
  const installed = window.matchMedia("(display-mode: standalone)").matches;
  if (!onAndroid || installed || !window.isSecureContext) return;
  const panel = $("#installPanel");
  const button = $("#installButton");
  panel.hidden = false;
  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
    button.hidden = false;
  });
  button.addEventListener("click", async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    button.hidden = true;
    await prompt.prompt();
  });
  window.addEventListener("appinstalled", () => { panel.hidden = true; });
}

async function init() {
  wireEvents(); resetForm("candidate"); resetForm("trade");
  setupInstallHelp();
  try {
    await dbReady; await refresh();
    const params = new URLSearchParams(location.search);
    if (params.has("shared")) {
      showView("inbox"); await refresh();
      const received = (await getAll("shareInbox")).filter(row => row.batchId === params.get("shared"));
      setStatus("#receiveStatus", received.length ? `共有画像${received.length}枚を端末内に保存しました。取引と画像区分はここから選べます。` : "今回の受信画像は見つかりません。割当済みの記録または共有元を確認してください。", !received.length);
      history.replaceState(null, "", location.pathname);
    }
    if (params.get("shareError") === "no-image") { showView("inbox"); await refresh(); setStatus("#receiveStatus", "対応する画像ファイルを受信できませんでした。PNG/JPEG/WebP/GIFを共有してください。", true); }
    if (params.get("shareError") === "too-large") { showView("inbox"); await refresh(); setStatus("#receiveStatus", "今回は保存していません。1枚25MB以下・1回20枚以下・合計100MB以下で共有してください。", true); }
    if (params.get("shareError") === "storage") { showView("inbox"); await refresh(); setStatus("#receiveStatus", "画像を端末内に保存できませんでした。共有元に画像が残っていることを確認し、もう一度共有してください。", true); }
  }
  catch (error) { $(".hero>p:not(.eyebrow)").textContent = `このブラウザでは端末内保存を開始できません: ${error.message}`; $$("form button[type=submit]").forEach(button => button.disabled = true); }
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("./sw.js").catch(() => {});
}
init();
