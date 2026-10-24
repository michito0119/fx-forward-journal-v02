const REQUIRED = ["チケット番号", "種別", "日時 (JST)", "銘柄", "売買", "数量", "約定価格"];
const NON_TRADE_KINDS = new Set(["スワップ", "入金", "出金"]);

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false, closedQuote = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else field += char;
    } else if (char === '"') { if (field || closedQuote) throw new Error("CSVの引用符の位置が不正です"); quoted = true; }
    else if (char === ",") { row.push(field); field = ""; closedQuote = false; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); if (row.some(value => value !== "")) rows.push(row); row = []; field = ""; closedQuote = false; }
    else if (closedQuote && char !== "\r") throw new Error("CSVの引用符の後ろに不正な文字があります");
    else field += char;
  }
  row.push(field.replace(/\r$/, ""));
  if (row.some(value => value !== "")) rows.push(row);
  if (quoted) throw new Error("CSVの引用符が閉じていない行があります");
  if (!rows.length) throw new Error("CSVに行がありません");
  const headers = rows[0].map(value => value.trim());
  if (new Set(headers).size !== headers.length || headers.some(value => !value)) throw new Error("CSVの列名に重複または空欄があります");
  const missing = REQUIRED.filter(name => !headers.includes(name));
  if (missing.length) throw new Error(`OANDA取引履歴CSVに必要な列がありません: ${missing.join("、")}`);
  const occurrences = new Map();
  return rows.slice(1).map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSVの${index + 2}行目の列数が一致しません`);
    const raw = Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ""]));
    const fingerprint = JSON.stringify(raw);
    const occurrence = occurrences.get(fingerprint) || 0;
    occurrences.set(fingerprint, occurrence + 1);
    return { raw, occurrence };
  });
}

function direction(value) {
  const text = String(value || "").trim();
  if (["買", "買い"].includes(text)) return "買い";
  if (["売", "売り"].includes(text)) return "売り";
  return "";
}

function number(value) {
  const normalized = String(value ?? "").replaceAll(",", "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeOandaCsv(text) {
  const rows = parseCsv(text);
  return rows.map(({ raw, occurrence }, index) => {
    const at = String(raw["日時 (JST)"] || "").trim();
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(at);
    const kind = String(raw["種別"] || "").trim();
    const nonTrade = NON_TRADE_KINDS.has(kind);
    const pair = String(raw["銘柄"] || "").trim().toUpperCase();
    const side = direction(raw["売買"]);
    const quantity = number(raw["数量"]);
    const price = number(raw["約定価格"]);
    const parsedTime = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]) - 9, Number(match[5]), Number(match[6])) : NaN;
    const localCheck = Number.isFinite(parsedTime) ? new Date(parsedTime + 9 * 60 * 60 * 1000) : null;
    const validDate = !!localCheck && localCheck.getUTCFullYear() === Number(match[1]) && localCheck.getUTCMonth() + 1 === Number(match[2]) && localCheck.getUTCDate() === Number(match[3]) && localCheck.getUTCHours() === Number(match[4]) && localCheck.getUTCMinutes() === Number(match[5]) && localCheck.getUTCSeconds() === Number(match[6]);
    const errors = [];
    if (!validDate) errors.push("日時を読めません");
    if (!nonTrade && !["新規取引", "決済取引"].includes(kind)) errors.push(`未対応の明細種別: ${kind || "空欄"}`);
    if (!nonTrade && (!pair || !side || quantity == null || quantity <= 0 || price == null || price <= 0)) errors.push("ペア・売買・数量・価格のいずれかが不正です");
    const entryTime = validDate ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}` : "";
    const ticketId = String(raw["チケット番号"] || "").trim();
    const fingerprint = JSON.stringify([raw, occurrence]);
    const duplicateKey = JSON.stringify(raw);
    return {
      id: `O-${encodeURIComponent(fingerprint)}`,
      duplicateKey,
      rowNumber: index + 2,
      raw,
      ticketId,
      kind,
      pair,
      direction: side,
      quantity,
      price,
      datetimeJst: at,
      datetimeIso: validDate ? new Date(parsedTime).toISOString() : "",
      entryTime,
      spotPnlYen: number(raw["スポット損益(円)"]),
      swapYen: number(raw["スワップ損益(円)"]),
      feeYen: number(raw["手数料(円)"]),
      errors,
    };
  });
}

export function bundleOandaRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = NON_TRADE_KINDS.has(row.kind) ? `nontrade:${row.id}` : `trade:${row.ticketId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(items => {
    const ticketId = items[0].ticketId;
    const entries = items.filter(row => row.kind === "新規取引");
    const exits = items.filter(row => row.kind === "決済取引");
    const invalid = items.some(row => row.errors.length);
    const duplicateEvents = items.length !== new Set(items.map(row => row.duplicateKey || row.id)).size;
    let status = "対応保留";
    if (items.every(row => NON_TRADE_KINDS.has(row.kind))) status = "取引対象外（スワップ・入出金）";
    else if (!ticketId || invalid) status = "入力不正";
    else if (duplicateEvents) status = "同一明細の重複候補";
    else if (entries.length === 1 && exits.length === 0) status = "新規のみ";
    else if (entries.length === 1 && exits.length === 1 && (entries[0].pair !== exits[0].pair || entries[0].direction !== exits[0].direction)) status = "新規決済のペア・方向不一致";
    else if (entries.length === 1 && exits.length === 1 && exits[0].datetimeIso < entries[0].datetimeIso) status = "決済日時が新規日時より前";
    else if (entries.length === 1 && exits.length === 1 && entries[0].quantity === exits[0].quantity) status = "新規＋全決済";
    else if (entries.length === 1 && exits.length === 1) status = "数量不一致";
    else if (entries.length > 1 || exits.length > 1) status = "複数約定・部分決済候補";
    return { ticketId, items, entry: entries.length === 1 ? entries[0] : null, exit: exits.length === 1 ? exits[0] : null, status };
  });
}

// A match must be unique in both directions, within one explicitly named account.
export function planOandaImport(bundles, trades, accountType, accountId, pairs, options = {}) {
  const sameAccount = trade => trade.accountType === accountType && trade.accountId === accountId;
  const proposals = bundles.map(bundle => {
    const hold = note => ({ ...bundle, action: "保留", note });
    if (bundle.status === "取引対象外（スワップ・入出金）") return { ...bundle, action: "対象外", note: "原明細を保存します。取引の照合・勝敗判定には使用しません" };
    if (!["新規のみ", "新規＋全決済"].includes(bundle.status)) return hold(bundle.status);
    const entry = bundle.entry;
    if (!entry || !pairs.includes(entry.pair)) return hold("アプリ対象外のペアまたは新規明細なし");
    const linked = trades.filter(trade => sameAccount(trade) && trade.oandaTicketId === bundle.ticketId);
    if (linked.length > 1) return hold("同一チケットが複数記録に紐づいています");
    if (linked.length === 1) {
      const trade = linked[0];
      if (trade.pair !== entry.pair || trade.direction !== entry.direction ||
          (trade.entryTimeOanda && trade.entryTimeOanda !== entry.datetimeIso) ||
          (trade.entryPrice != null && trade.entryPrice !== entry.price) ||
          (trade.quantity != null && trade.quantity !== entry.quantity)) return hold("照合済み記録と新規約定が矛盾しています");
      return { ...bundle, action: "更新", tradeId: trade.id, note: "口座・チケットと新規約定が一致" };
    }
    const compatible = trade => !trade.oandaTicketId &&
      (!trade.accountType || trade.accountType === accountType) &&
      (!trade.accountId || trade.accountId === accountId) &&
      (!trade.pair || trade.pair === entry.pair) && trade.direction === entry.direction;
    const timeDistance = (trade, execution = entry) => {
      const value = trade.entryTimeHint || trade.entryTimeUser || trade.entryTime;
      const time = Date.parse(value ? `${value}${value.length === 16 ? ":00" : ""}+09:00` : "");
      return Number.isFinite(time) ? Math.abs(time - Date.parse(execution.datetimeIso)) : Infinity;
    };
    const allCandidates = trades.filter(compatible).sort((a,b) => timeDistance(a)-timeDistance(b) || a.id.localeCompare(b.id));
    const choice = Object.hasOwn(options.choices || {}, bundle.ticketId) ? options.choices[bundle.ticketId] : "";
    if (choice === "__new__") return { ...bundle, action: "新規追加", matchMethod: "user-new", note: "本人確認：対応する既存記録なし。CSV由来として追加" };
    if (choice) {
      const selected = allCandidates.find(trade => trade.id === choice);
      if (!selected) return hold("選んだ記録は照合できません。候補を確認し直してください");
      return { ...bundle, action: "照合", tradeId: selected.id, candidateTradeIds: allCandidates.map(t=>t.id), matchMethod: "user", note: `本人が画像・日時差を確認: ${selected.id}` };
    }
    // Hints are not execution evidence. Search pair/side/account broadly without
    // a time cutoff: late registration must not create a second CSV-only trade.
    const memoCandidates = allCandidates.filter(trade => trade.recordMode === "journal" || trade.entryTimeSource === "hint" || trade.entryTimeSource === "registration" || !trade.entryTimeSource || !trade.accountId || !trade.accountType || !trade.pair);
    if (memoCandidates.length) {
      const nearby = allCandidates.filter(trade => timeDistance(trade) <= 2 * 60 * 60 * 1000);
      const best = memoCandidates[0];
      // Search every entry, including unsafe/partial bundles. They still compete
      // for the memo even though they cannot be imported automatically.
      const rivals = (options.competitionBundles || bundles).filter(other =>
        other.items.some(event => event.kind === "新規取引" &&
          (!event.direction || event.direction === best.direction) && (!best.pair || !event.pair || event.pair === best.pair) &&
          (!event.datetimeIso || timeDistance(best, event) <= 2 * 60 * 60 * 1000)));
      const rivalIds = new Set(rivals.map(other=>other.ticketId));
      for (const linkedTrade of trades) if (sameAccount(linkedTrade) && linkedTrade.oandaTicketId && linkedTrade.entryTimeOanda &&
        linkedTrade.direction === best.direction && (!best.pair || linkedTrade.pair === best.pair) &&
        timeDistance(best, { datetimeIso: linkedTrade.entryTimeOanda }) <= 2 * 60 * 60 * 1000) rivalIds.add(linkedTrade.oandaTicketId);
      const accountConfirmed = (best.accountId === accountId && best.accountType === accountType) || options.allowUnassignedAccount === true;
      if (accountConfirmed && timeDistance(best) <= 30 * 60 * 1000 && nearby.length === 1 && rivalIds.size === 1)
        return { ...bundle, action: "照合", tradeId: best.id, candidateTradeIds: allCandidates.map(t=>t.id), matchMethod: "auto-near", accountConfirmedBy: best.accountId === accountId && best.accountType === accountType ? "record" : "import-consent", note: "自動候補：30分以内・方向一致・口座確認済み・前後2時間の対応が双方で一意" };
      const reason = !accountConfirmed ? "口座確認が必要です。同じ口座の記録なら確認チェックを入れ、CSVを選び直してください" :
        !Number.isFinite(timeDistance(best)) ? "目安日時が未記録または不正です。日時を補完するか候補を確認してください" :
        timeDistance(best) > 30 * 60 * 1000 ? `目安と約定が${Math.round(timeDistance(best)/60000)}分離れています（自動候補は30分以内）。画像を見て候補を確認してください` :
        `近い日時に複数の対応があります（記録${nearby.length}件・約定${rivalIds.size}件）。画像を見て候補を確認してください`;
      return { ...hold(reason), candidateTradeIds: allCandidates.map(t=>t.id) };
    }
    // Unknown account and provisional dates cannot prove absence of a journal record.
    const possible = trades.filter(trade => trade.accountType === accountType &&
      (!trade.accountId || trade.accountId === accountId) &&
      trade.pair === entry.pair && trade.direction === entry.direction &&
      (!trade.oandaTicketId || !trade.accountId));
    if (possible.some(trade => !trade.accountId || trade.entryTimeSource !== "manual"))
      return { ...hold("口座未設定または仮日時の記録があります。候補を選んで確認してください"), candidateTradeIds: allCandidates.map(t=>t.id) };
    const candidates = possible.filter(trade => Math.abs(Date.parse(`${trade.entryTime}:00+09:00`) - Date.parse(entry.datetimeIso)) <= 30 * 60 * 1000);
    if (candidates.length > 1) return { ...hold(`照合候補が${candidates.length}件あります`), candidateTradeIds: allCandidates.map(t=>t.id) };
    if (candidates.length === 1) return { ...bundle, action: "照合", tradeId: candidates[0].id, note: `日時・口座・ペア・方向が一意一致: ${candidates[0].id}` };
    return { ...bundle, action: "新規追加", note: "CSV由来の記録として追加（フォワード検証の対象外）" };
  });
  const claims = new Map();
  for (const proposal of proposals) if (proposal.tradeId) claims.set(proposal.tradeId, (claims.get(proposal.tradeId) || 0) + 1);
  return proposals.map(proposal => claims.get(proposal.tradeId) > 1
    ? { ...proposal, action: "保留", note: "複数のチケットが同じ記録を照合候補にしています" } : proposal);
}

export function isConfirmedClosed(row) {
  return !!row.oandaTicketId && row.reconciliationStatus === "closed" && row.exitTimeSource === "oanda" &&
    !!row.exitTimeOanda && row.pnlYen != null && row.pnlYen !== "" && Number.isFinite(Number(row.pnlYen));
}

export function isTradeOpen(row) {
  if (row.reconciliationStatus === "closed") return false;
  if (row.exitTimeSource === "registration") return true;
  return !row.exitTime && row.exitPrice == null && row.pnlYen == null;
}
