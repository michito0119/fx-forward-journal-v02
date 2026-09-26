import { PAIRS, RULE_VERSION, SCREENER_VERSION, jstNow, newId, toCsv, escapeHtml, candidateColumns, tradeColumns, initialStopStatus, sameRecord } from "./utils.mjs";

const DB_NAME = "mk-forward-journal-v02";
const DB_VERSION = 1;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const state = { listType: "candidates", pending: { candidate: [], trade: [] }, previewUrls: [], listUrls: [] };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ["candidates", "trades", "images"]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
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

async function saveRecord(storeName, record, files, kind) {
  const db = await dbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName, "images"], "readwrite");
    tx.objectStore(storeName).put(record);
    for (const file of files) tx.objectStore("images").add({ id: newId("I"), recordId: record.id, kind, file, name: file.name, mime: file.type, addedAt: new Date().toISOString() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("保存が中断されました"));
  });
}

function formValue(form, name) { return form.elements.namedItem(name)?.value?.trim() || ""; }
function formChecked(form, name) { return !!form.elements.namedItem(name)?.checked; }
function numericOrNull(value) { return value === "" ? null : Number(value); }
function setStatus(id, message, error = false) { const el = $(id); el.textContent = message; el.style.color = error ? "#ffad9e" : "#6fe3bc"; }
function showView(name) {
  $$(".tab").forEach(button => { const active = button.dataset.view === name; button.classList.toggle("active", active); if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
  $$(".view").forEach(view => view.classList.toggle("active", view.id === `view-${name}`));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function revokePreviews() { for (const url of state.previewUrls) URL.revokeObjectURL(url); state.previewUrls = []; }
function revokeListImages() { for (const url of state.listUrls) URL.revokeObjectURL(url); state.listUrls = []; }
function previewButton(file, pending) {
  const url = URL.createObjectURL(file);
  state.previewUrls.push(url);
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
  holder.replaceChildren();
  const saved = recordId ? (await getAll("images")).filter(item => item.recordId === recordId) : [];
  for (const image of saved) holder.append(previewButton(image.file, false));
  for (const file of state.pending[kind]) holder.append(previewButton(file, true));
  if (!saved.length && !state.pending[kind].length) { const note = document.createElement("span"); note.className = "micro"; note.textContent = "画像はまだありません"; holder.append(note); }
}

function resetForm(kind) {
  const form = $(`#${kind}Form`);
  form.reset(); form.elements.namedItem("id").value = "";
  form.elements.namedItem(kind === "candidate" ? "candidateTime" : "entryTime").value = jstNow();
  if (kind === "trade") form.elements.namedItem("sl").disabled = false;
  state.pending[kind] = [];
  renderImages(kind);
  setStatus(kind === "candidate" ? "#candidateStatus" : "#tradeStatus", "");
}

async function refresh() {
  const [candidates, trades, images] = await Promise.all([getAll("candidates"), getAll("trades"), getAll("images")]);
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
}

function renderList(candidates, trades, images) {
  const rows = state.listType === "candidates" ? candidates : trades;
  renderListRows(rows, images, $("#recordList"), state.listType);
}

function isOpenTrade(row) { return !row.exitTime && row.exitPrice == null && row.pnlYen == null; }

function renderHoldings(trades, images) {
  const rows = trades.filter(isOpenTrade);
  $("#holdingsCount").textContent = `未決済のトレード ${rows.length}件`;
  renderListRows(rows, images, $("#holdingList"), "trades");
}

function renderListRows(rows, images, holder, type) {
  revokeListImages();
  holder.replaceChildren();
  if (!rows.length) { holder.innerHTML = `<div class="empty">${type === "trades" && holder.id === "holdingList" ? "保有中のトレードはありません" : "まだ記録がありません"}</div>`; return; }
  const counts = new Map(); for (const image of images) counts.set(image.recordId, (counts.get(image.recordId) || 0) + 1);
  rows.sort((a, b) => (type === "candidates" ? b.candidateTime.localeCompare(a.candidateTime) : b.entryTime.localeCompare(a.entryTime)));
  for (const row of rows) {
    const card = document.createElement("article"); card.className = "record-card";
    const when = type === "candidates" ? row.candidateTime : row.entryTime;
    const detail = type === "candidates" ? `${row.origin} · ${row.judgment}` : `${row.accountType} · ${row.compliance || "遵守保留"}`;
    const firstImage = images.find(image => image.recordId === row.id);
    if (firstImage) {
      const thumbnail = document.createElement("img");
      thumbnail.className = "record-thumb";
      const url = URL.createObjectURL(firstImage.file); state.listUrls.push(url);
      thumbnail.src = url; thumbnail.alt = `${row.pair}の添付画像`;
      card.append(thumbnail);
    } else {
      const thumbnail = document.createElement("div"); thumbnail.className = "record-thumb no-img"; thumbnail.textContent = "📊"; card.append(thumbnail);
    }
    card.insertAdjacentHTML("beforeend", `<div class="record-info"><h3>${escapeHtml(row.pair)} <span class="${row.direction === "買い" ? "buy" : "sell"}">${escapeHtml(row.direction)}</span></h3><p>${escapeHtml(when?.replace("T", " "))} JST · ${escapeHtml(detail)}</p><small>画像 ${counts.get(row.id) || 0}枚 · ${escapeHtml(row.id)}</small></div><button type="button" class="quiet" data-edit="${escapeHtml(row.id)}" data-type="${type}">開く</button>`);
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
  state.pending[kind] = [];
  fillForm($(`#${kind}Form`), record);
  await renderImages(kind, id);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function saveCandidate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) { setStatus("#candidateStatus", "必須項目を入力してください。", true); return; }
  setStatus("#candidateStatus", "保存中…");
  try {
    const id = formValue(form, "id") || newId("C");
    const previous = await getOne("candidates", id);
    const now = new Date().toISOString();
    const candidate = { id, ruleVersion: previous?.ruleVersion || RULE_VERSION, screenerVersion: previous?.screenerVersion || SCREENER_VERSION, candidateTime: formValue(form, "candidateTime"), pair: formValue(form, "pair"), direction: formValue(form, "direction"), origin: formValue(form, "origin"), reasons: [...form.querySelectorAll('input[name="reasons"]:checked')].map(el => el.value), d1View: formValue(form, "d1View"), h4View: formValue(form, "h4View"), h1View: formValue(form, "h1View"), h4Role: formValue(form, "h4Role"), setup: formValue(form, "setup"), decisionTf: formValue(form, "decisionTf"), trigger: formValue(form, "trigger"), judgment: formValue(form, "judgment"), decisionComment: formValue(form, "decisionComment"), createdAt: previous?.createdAt || now, updatedAt: now };
    const imageCount = state.pending.candidate.length;
    await saveRecord("candidates", candidate, state.pending.candidate, "candidate"); resetForm("candidate"); await refresh(); setStatus("#candidateStatus", `保存しました: ${id}（画像${imageCount}枚）`);
  }
  catch (error) { setStatus("#candidateStatus", `保存できませんでした: ${error.message}`, true); }
}

async function saveTrade(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) { setStatus("#tradeStatus", "必須項目を入力してください。", true); return; }
  setStatus("#tradeStatus", "保存中…");
  try {
    const id = formValue(form, "id") || newId("T");
    const previous = await getOne("trades", id);
    const now = new Date().toISOString();
    const noStop = formChecked(form, "noStop");
    const sl = noStop ? null : numericOrNull(formValue(form, "sl"));
    const stopStatus = initialStopStatus(sl, noStop);
    const keepRisk = previous?.sl === sl && stopStatus === "設定あり";
    const trade = { ...previous, id, candidateId: formValue(form, "candidateId"), ruleVersion: previous?.ruleVersion || RULE_VERSION, accountType: formValue(form, "accountType"), pair: formValue(form, "pair"), direction: formValue(form, "direction"), entryTime: formValue(form, "entryTime"), entryPrice: previous?.entryPrice ?? null, sl, stopStatus, tp: numericOrNull(formValue(form, "tp")), trailingPlanned: formChecked(form, "trailingPlanned"), riskYen: keepRisk ? previous.riskYen ?? null : null, compliance: formValue(form, "compliance"), entryComment: formValue(form, "entryComment"), exitTime: formValue(form, "exitTime"), exitPrice: previous?.exitPrice ?? null, pnlYen: previous?.pnlYen ?? null, pnlR: keepRisk ? previous.pnlR ?? null : null, exitReason: formValue(form, "exitReason"), postReview: formValue(form, "postReview"), createdAt: previous?.createdAt || now, updatedAt: now };
    trade.screenerVersion = previous?.screenerVersion || SCREENER_VERSION;
    const imageCount = state.pending.trade.length;
    await saveRecord("trades", trade, state.pending.trade, "trade"); resetForm("trade"); await refresh(); setStatus("#tradeStatus", `保存しました: ${id}（画像${imageCount}枚）`);
  }
  catch (error) { setStatus("#tradeStatus", `保存できませんでした: ${error.message}`, true); }
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
    const [candidates, trades, images] = await Promise.all([getAll("candidates"), getAll("trades"), getAll("images")]);
    const encoded = [];
    for (const image of images) encoded.push({ id: image.id, recordId: image.recordId, kind: image.kind, name: image.name, mime: image.mime, addedAt: image.addedAt, dataUrl: await imageToDataUrl(image.file) });
    const backup = { schema: "mk-forward-v02", ruleVersion: RULE_VERSION, screenerVersion: SCREENER_VERSION, exportedAt: new Date().toISOString(), candidates, trades, images: encoded };
    download(`MK裁量V02_完全バックアップ_${jstNow().slice(0, 10)}.json`, new Blob([JSON.stringify(backup)], { type: "application/json" }));
    setStatus("#backupStatus", `書き出しました: 候補${candidates.length}件・トレード${trades.length}件・画像${images.length}枚`);
  } catch (error) { setStatus("#backupStatus", `バックアップ失敗: ${error.message}`, true); }
}

async function importBackup(file) {
  if (!file) return;
  if (file.size > 250 * 1024 * 1024) { setStatus("#backupStatus", "250MBを超えるバックアップは取り込めません", true); return; }
  setStatus("#backupStatus", "バックアップを検査中…");
  try {
    const backup = JSON.parse(await file.text());
    if (backup.schema !== "mk-forward-v02" || backup.screenerVersion !== SCREENER_VERSION || !Array.isArray(backup.candidates) || !Array.isArray(backup.trades) || !Array.isArray(backup.images)) throw new Error("V0.2記録アプリのバックアップではありません");
    if (backup.candidates.length + backup.trades.length > 10000 || backup.images.length > 10000) throw new Error("件数が上限を超えています");
    const [oldC, oldT, oldI] = await Promise.all([getAll("candidates"), getAll("trades"), getAll("images")]);
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
    const images = backup.images.filter(row => typeof row.id === "string" && validParents.has(row.recordId) && !knownI.has(row.id)).map(row => ({ id: row.id, recordId: row.recordId, kind: row.kind, name: row.name, mime: row.mime, addedAt: row.addedAt, file: dataUrlToBlob(row.dataUrl) }));
    const db = await dbReady;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["candidates", "trades", "images"], "readwrite");
      for (const row of candidates) tx.objectStore("candidates").add(row);
      for (const row of trades) tx.objectStore("trades").add(row);
      for (const row of images) tx.objectStore("images").add(row);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error("復元が中断されました"));
    });
    await refresh();
    setStatus("#backupStatus", `追加しました: 候補${candidates.length}件・トレード${trades.length}件・画像${images.length}枚。${conflictingIds.size ? `同じIDで内容が異なる${conflictingIds.size}件は上書きせず、添付画像も取り込んでいません。元端末の記録を確認してください。` : "同じIDは上書きしていません。"}`, !!conflictingIds.size);
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
  $$(".tab").forEach(button => button.addEventListener("click", () => { showView(button.dataset.view); if (["records", "holdings"].includes(button.dataset.view)) refresh(); }));
  $("#candidateForm").addEventListener("submit", saveCandidate);
  $("#tradeForm").addEventListener("submit", saveTrade);
  $("#newCandidate").addEventListener("click", () => resetForm("candidate"));
  $("#newTrade").addEventListener("click", () => resetForm("trade"));
  $$(".image-input").forEach(input => input.addEventListener("change", async () => {
    const kind = input.dataset.kind;
    let rejected = 0;
    for (const file of input.files) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > MAX_IMAGE_BYTES) { rejected++; continue; }
      state.pending[kind].push(file);
    }
    input.value = "";
    try {
      await renderImages(kind, $(`#${kind}Form`).elements.namedItem("id").value);
      const message = `${state.pending[kind].length}枚選択済み。下の「${kind === "candidate" ? "候補" : "トレード"}を保存」で画像も保存します。${rejected ? `対応外または25MB超の画像${rejected}枚は除外しました。` : ""}`;
      setStatus(kind === "candidate" ? "#candidateStatus" : "#tradeStatus", message, !!rejected);
    } catch (error) { setStatus(kind === "candidate" ? "#candidateStatus" : "#tradeStatus", `画像を表示できません: ${error.message}`, true); }
  }));
  $("#candidateSelect").addEventListener("change", async event => {
    const candidate = event.target.value ? await getOne("candidates", event.target.value) : null;
    if (candidate && !formValue($("#tradeForm"), "id")) { $("#tradeForm").elements.namedItem("pair").value = candidate.pair; $("#tradeForm").elements.namedItem("direction").value = candidate.direction; }
  });
  $("#tradeForm").elements.namedItem("noStop").addEventListener("change", event => {
    const sl = $("#tradeForm").elements.namedItem("sl");
    if (event.target.checked) sl.value = "";
    sl.disabled = event.target.checked;
  });
  $("#tradeForm").elements.namedItem("sl").addEventListener("input", event => {
    if (event.target.value !== "") $("#tradeForm").elements.namedItem("noStop").checked = false;
  });
  $("#recordList").addEventListener("click", event => { const button = event.target.closest("[data-edit]"); if (button) editRecord(button.dataset.type, button.dataset.edit); });
  $("#holdingList").addEventListener("click", event => { const button = event.target.closest("[data-edit]"); if (button) editRecord(button.dataset.type, button.dataset.edit); });
  $$(".segmented button").forEach(button => button.addEventListener("click", async () => { state.listType = button.dataset.list; $$(".segmented button").forEach(item => item.classList.toggle("selected", item === button)); const [c, t, i] = await Promise.all([getAll("candidates"), getAll("trades"), getAll("images")]); renderList(c, t, i); }));
  $("#exportBackup").addEventListener("click", exportBackup);
  $("#importBackup").addEventListener("change", event => { importBackup(event.target.files[0]); event.target.value = ""; });
  $("#exportCandidatesCsv").addEventListener("click", () => exportCsv("candidates"));
  $("#exportTradesCsv").addEventListener("click", () => exportCsv("trades"));
  $("#closePhoto").addEventListener("click", () => $("#photoDialog").close());
  $("#photoDialog").addEventListener("click", event => { if (event.target === $("#photoDialog")) $("#photoDialog").close(); });
  window.addEventListener("beforeunload", () => { revokePreviews(); revokeListImages(); });
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
  try { await dbReady; await refresh(); }
  catch (error) { $(".hero>p:not(.eyebrow)").textContent = `このブラウザでは端末内保存を開始できません: ${error.message}`; $$("form button[type=submit]").forEach(button => button.disabled = true); }
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("./sw.js").catch(() => {});
}
init();

