"use strict";

const DB_NAME = "menlog-db";
const DB_VERSION = 1;
const STORE_NAME = "entries";

let db;
let entries = [];
let currentPhoto = "";
let currentDetailId = "";
let calendarCursor = startOfMonth(new Date());
let selectedCalendarDate = formatDateInput(new Date());
let toastTimer;

const $ = (id) => document.getElementById(id);

const el = {
  entryForm: $("entryForm"), entryId: $("entryId"), date: $("date"), time: $("time"),
  shop: $("shop"), ramen: $("ramen"), price: $("price"), rating: $("rating"),
  ratingPicker: $("ratingPicker"), photoInput: $("photoInput"), photoPreview: $("photoPreview"),
  photoEmpty: $("photoEmpty"), removePhoto: $("removePhoto"), memo: $("memo"), favorite: $("favorite"),
  saveEntry: $("saveEntry"), resetForm: $("resetForm"), historyList: $("historyList"),
  historyEmpty: $("historyEmpty"), historyCount: $("historyCount"), historySearch: $("historySearch"),
  calendarGrid: $("calendarGrid"), calendarMonthLabel: $("calendarMonthLabel"),
  selectedDayTitle: $("selectedDayTitle"), selectedDayCount: $("selectedDayCount"), selectedDayList: $("selectedDayList"),
  settingsDialog: $("settingsDialog"), detailDialog: $("detailDialog"), toast: $("toast"),
  detailDate: $("detailDate"), detailRamen: $("detailRamen"), detailShop: $("detailShop"),
  detailPhoto: $("detailPhoto"), detailMeta: $("detailMeta"), detailMemo: $("detailMemo"),
  installHint: $("installHint")
};

window.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    db = await openDatabase();
    bindEvents();
    resetEntryForm();
    await refreshEntries();
    registerServiceWorker();
    maybeShowInstallHint();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  } catch (error) {
    console.error(error);
    showToast("保存領域を開けませんでした");
  }
}

function bindEvents() {
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });

  el.entryForm.addEventListener("submit", handleSave);
  el.resetForm.addEventListener("click", resetEntryForm);
  el.historySearch.addEventListener("input", renderHistory);

  el.ratingPicker.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => setRating(Number(button.dataset.rating)));
  });

  el.photoInput.addEventListener("change", handlePhotoSelection);
  el.removePhoto.addEventListener("click", () => setPhoto(""));

  $("calendarPrev").addEventListener("click", () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1);
    renderCalendar();
  });
  $("calendarNext").addEventListener("click", () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
    renderCalendar();
  });
  el.calendarMonthLabel.addEventListener("click", () => {
    calendarCursor = startOfMonth(new Date());
    selectedCalendarDate = formatDateInput(new Date());
    renderCalendar();
  });

  $("openSettings").addEventListener("click", () => el.settingsDialog.showModal());
  $("exportData").addEventListener("click", exportBackup);
  $("importData").addEventListener("change", importBackup);
  $("deleteAllData").addEventListener("click", deleteAllData);

  $("closeDetail").addEventListener("click", () => el.detailDialog.close());
  $("editEntry").addEventListener("click", editCurrentEntry);
  $("deleteEntry").addEventListener("click", deleteCurrentEntry);

  $("dismissInstallHint").addEventListener("click", () => {
    localStorage.setItem("menlog-install-hint-dismissed", "1");
    el.installHint.hidden = true;
  });
}

function showView(name) {
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  document.querySelectorAll(".nav-button").forEach((button) => button.classList.remove("active"));
  $("view" + name).classList.add("active");
  document.querySelector(`.nav-button[data-view="${name}"]`)?.classList.add("active");
  if (name === "History") renderHistory();
  if (name === "Calendar") renderCalendar();
  if (name === "Stats") renderStats();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("date", "date", { unique: false });
        store.createIndex("shop", "shop", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storeRequest(mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    let result;
    try { result = operation(store); } catch (error) { reject(error); return; }
    transaction.oncomplete = () => resolve(result?.result);
    transaction.onerror = () => reject(transaction.error || result?.error);
    transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted"));
  });
}

async function refreshEntries() {
  entries = await storeRequest("readonly", (store) => store.getAll());
  entries.sort(compareEntriesDesc);
  renderHistory();
  renderCalendar();
  renderStats();
}

function compareEntriesDesc(a, b) {
  const aKey = `${a.date || ""}T${a.time || "00:00"}`;
  const bKey = `${b.date || ""}T${b.time || "00:00"}`;
  return bKey.localeCompare(aKey) || (b.updatedAt || "").localeCompare(a.updatedAt || "");
}

async function handleSave(event) {
  event.preventDefault();
  if (!el.entryForm.reportValidity()) return;

  const id = el.entryId.value || makeId();
  const previous = entries.find((item) => item.id === id);
  const now = new Date().toISOString();
  const record = {
    id,
    date: el.date.value,
    time: el.time.value,
    shop: el.shop.value.trim(),
    ramen: el.ramen.value.trim(),
    price: el.price.value === "" ? null : Math.max(0, Number(el.price.value)),
    rating: Number(el.rating.value || 0),
    photo: currentPhoto,
    memo: el.memo.value.trim(),
    favorite: el.favorite.checked,
    createdAt: previous?.createdAt || now,
    updatedAt: now
  };

  el.saveEntry.disabled = true;
  el.saveEntry.textContent = "保存中…";
  try {
    await storeRequest("readwrite", (store) => store.put(record));
    await refreshEntries();
    showToast(previous ? "記録を更新しました" : "今日の一杯を保存しました");
    resetEntryForm();
    showView("History");
  } catch (error) {
    console.error(error);
    const likelyQuota = error?.name === "QuotaExceededError";
    showToast(likelyQuota ? "保存容量が不足しています。写真を減らしてください" : "保存に失敗しました");
  } finally {
    el.saveEntry.disabled = false;
    el.saveEntry.textContent = "この一杯を保存";
  }
}

function resetEntryForm() {
  el.entryForm.reset();
  el.entryId.value = "";
  el.date.value = formatDateInput(new Date());
  el.time.value = formatTimeInput(new Date());
  setRating(0);
  setPhoto("");
  el.saveEntry.textContent = "この一杯を保存";
}

function setRating(value) {
  el.rating.value = String(value);
  el.ratingPicker.querySelectorAll("button").forEach((button) => {
    const active = Number(button.dataset.rating) <= value;
    button.classList.toggle("on", active);
    button.setAttribute("aria-checked", String(Number(button.dataset.rating) === value));
  });
}

async function handlePhotoSelection(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showToast("画像ファイルを選んでください");
    event.target.value = "";
    return;
  }
  try {
    showToast("写真を調整しています…");
    const dataUrl = await compressImage(file, 1600, 0.82);
    setPhoto(dataUrl);
  } catch (error) {
    console.error(error);
    showToast("写真を読み込めませんでした");
  } finally {
    event.target.value = "";
  }
}

function compressImage(file, maxDimension, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("Image load failed"));
      image.onload = () => {
        let { width, height } = image;
        const scale = Math.min(1, maxDimension / Math.max(width, height));
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { alpha: false });
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function setPhoto(dataUrl) {
  currentPhoto = dataUrl || "";
  if (currentPhoto) {
    el.photoPreview.src = currentPhoto;
    el.photoPreview.hidden = false;
    el.photoEmpty.hidden = true;
    el.removePhoto.hidden = false;
  } else {
    el.photoPreview.removeAttribute("src");
    el.photoPreview.hidden = true;
    el.photoEmpty.hidden = false;
    el.removePhoto.hidden = true;
  }
}

function renderHistory() {
  const term = normalizeText(el.historySearch?.value || "");
  const filtered = entries.filter((item) => {
    if (!term) return true;
    return normalizeText(`${item.shop} ${item.ramen} ${item.memo || ""}`).includes(term);
  });

  el.historyCount.textContent = `${filtered.length}杯`;
  el.historyList.replaceChildren(...filtered.map(createEntryCard));
  el.historyEmpty.hidden = filtered.length !== 0;
  if (entries.length > 0 && filtered.length === 0) {
    el.historyEmpty.querySelector("h3").textContent = "一致する記録がありません";
    el.historyEmpty.querySelector("p").textContent = "検索語を変えてみてください。";
  } else {
    el.historyEmpty.querySelector("h3").textContent = "まだ記録がありません";
    el.historyEmpty.querySelector("p").textContent = "下の「記録」から最初の一杯を保存しましょう。";
  }
}

function createEntryCard(item) {
  const article = document.createElement("article");
  article.className = `entry-card${item.photo ? "" : " no-photo"}`;
  article.tabIndex = 0;
  article.setAttribute("role", "button");
  article.setAttribute("aria-label", `${item.date} ${item.shop} ${item.ramen} の詳細`);
  article.addEventListener("click", () => openDetail(item.id));
  article.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetail(item.id); }
  });

  if (item.photo) {
    const image = document.createElement("img");
    image.className = "entry-thumb";
    image.src = item.photo;
    image.alt = "";
    image.loading = "lazy";
    article.appendChild(image);
  }

  const body = document.createElement("div");
  body.className = "entry-card-body";

  const top = document.createElement("div");
  top.className = "entry-card-top";
  const titleWrap = document.createElement("div");
  titleWrap.style.minWidth = "0";
  const title = document.createElement("h3");
  title.textContent = item.ramen;
  const shop = document.createElement("p");
  shop.className = "entry-shop";
  shop.textContent = `${item.favorite ? "♥ " : ""}${item.shop}`;
  if (item.favorite) shop.classList.add("favorite-mark");
  titleWrap.append(title, shop);
  const date = document.createElement("span");
  date.className = "entry-date";
  date.textContent = shortDate(item.date);
  top.append(titleWrap, date);

  const meta = document.createElement("div");
  meta.className = "entry-meta";
  if (item.price !== null && Number.isFinite(Number(item.price))) meta.append(createTag(`${formatMoney(item.price)}円`));
  if (item.rating > 0) {
    const stars = createTag("★".repeat(item.rating));
    stars.classList.add("stars");
    meta.append(stars);
  }
  if (item.time) meta.append(createTag(item.time));

  body.append(top, meta);
  article.appendChild(body);
  return article;
}

function createTag(text) {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

function renderCalendar() {
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  el.calendarMonthLabel.textContent = `${year}年 ${month + 1}月`;

  const first = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - first.getDay());
  const countByDate = entries.reduce((map, item) => {
    map[item.date] = (map[item.date] || 0) + 1;
    return map;
  }, {});

  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 42; i++) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + i);
    const dateKey = formatDateInput(date);
    const count = countByDate[dateKey] || 0;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "calendar-day";
    button.textContent = String(date.getDate());
    button.setAttribute("aria-label", `${date.getFullYear()}年${date.getMonth()+1}月${date.getDate()}日 ${count}杯`);
    if (date.getMonth() !== month) button.classList.add("outside");
    if (dateKey === formatDateInput(new Date())) button.classList.add("today");
    if (dateKey === selectedCalendarDate) button.classList.add("selected");
    if (count > 0) {
      button.classList.add("has-entry");
      if (count > 1) {
        const badge = document.createElement("span");
        badge.className = "day-count";
        badge.textContent = String(count);
        button.appendChild(badge);
      }
    }
    button.addEventListener("click", () => {
      selectedCalendarDate = dateKey;
      if (date.getMonth() !== month) calendarCursor = new Date(date.getFullYear(), date.getMonth(), 1);
      renderCalendar();
    });
    fragment.appendChild(button);
  }
  el.calendarGrid.replaceChildren(fragment);
  renderSelectedDay();
}

function renderSelectedDay() {
  const selected = entries.filter((item) => item.date === selectedCalendarDate);
  el.selectedDayTitle.textContent = longDate(selectedCalendarDate);
  el.selectedDayCount.textContent = `${selected.length}杯`;
  el.selectedDayList.replaceChildren(...selected.map(createEntryCard));
  if (!selected.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "この日の記録はありません。";
    el.selectedDayList.appendChild(p);
  }
}

function renderStats() {
  const today = new Date();
  const monthPrefix = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const prices = entries.map((item) => Number(item.price)).filter((value) => Number.isFinite(value) && value >= 0);
  const ratings = entries.map((item) => Number(item.rating)).filter((value) => value > 0);

  $("statTotal").textContent = formatMoney(entries.length);
  $("statMonth").textContent = formatMoney(entries.filter((item) => item.date?.startsWith(monthPrefix)).length);
  $("statSpent").textContent = formatMoney(prices.reduce((sum, value) => sum + value, 0));
  $("statRating").textContent = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : "–";

  const shops = new Map();
  entries.forEach((item) => shops.set(item.shop, (shops.get(item.shop) || 0) + 1));
  const ranking = [...shops.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja")).slice(0, 5);
  const list = $("shopRanking");
  list.replaceChildren(...ranking.map(([name, count]) => {
    const li = document.createElement("li");
    const shopName = document.createElement("span");
    shopName.className = "rank-name";
    shopName.textContent = name;
    const shopCount = document.createElement("span");
    shopCount.className = "rank-count";
    shopCount.textContent = `${count}杯`;
    li.append(shopName, shopCount);
    return li;
  }));
  $("shopRankingEmpty").hidden = ranking.length > 0;

  renderMonthlyBars();
}

function renderMonthlyBars() {
  const rows = [];
  const base = startOfMonth(new Date());
  for (let offset = 5; offset >= 0; offset--) {
    const date = new Date(base.getFullYear(), base.getMonth() - offset, 1);
    const prefix = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    rows.push({ label: `${date.getFullYear()}/${date.getMonth() + 1}`, count: entries.filter((item) => item.date?.startsWith(prefix)).length });
  }
  const max = Math.max(1, ...rows.map((row) => row.count));
  const container = $("monthlyBars");
  container.replaceChildren(...rows.map((row) => {
    const line = document.createElement("div");
    line.className = "month-row";
    const label = document.createElement("span");
    label.textContent = row.label;
    const track = document.createElement("div");
    track.className = "month-track";
    const fill = document.createElement("div");
    fill.className = "month-fill";
    fill.style.width = `${(row.count / max) * 100}%`;
    track.appendChild(fill);
    const value = document.createElement("span");
    value.className = "month-value";
    value.textContent = `${row.count}杯`;
    line.append(label, track, value);
    return line;
  }));
}

function openDetail(id) {
  const item = entries.find((record) => record.id === id);
  if (!item) return;
  currentDetailId = id;
  el.detailDate.textContent = `${longDate(item.date)}${item.time ? ` ${item.time}` : ""}`;
  el.detailRamen.textContent = item.ramen;
  el.detailShop.textContent = `${item.favorite ? "♥ " : ""}${item.shop}`;
  el.detailShop.classList.toggle("favorite-mark", Boolean(item.favorite));
  if (item.photo) {
    el.detailPhoto.src = item.photo;
    el.detailPhoto.hidden = false;
  } else {
    el.detailPhoto.hidden = true;
    el.detailPhoto.removeAttribute("src");
  }
  const tags = [];
  if (item.price !== null && Number.isFinite(Number(item.price))) tags.push(`${formatMoney(item.price)}円`);
  if (item.rating > 0) tags.push(`評価 ${"★".repeat(item.rating)}`);
  el.detailMeta.replaceChildren(...tags.map(createTag));
  el.detailMemo.textContent = item.memo || "メモはありません。";
  el.detailMemo.classList.toggle("muted", !item.memo);
  el.detailDialog.showModal();
}

function editCurrentEntry() {
  const item = entries.find((record) => record.id === currentDetailId);
  if (!item) return;
  el.detailDialog.close();
  el.entryId.value = item.id;
  el.date.value = item.date || formatDateInput(new Date());
  el.time.value = item.time || "";
  el.shop.value = item.shop || "";
  el.ramen.value = item.ramen || "";
  el.price.value = item.price ?? "";
  el.memo.value = item.memo || "";
  el.favorite.checked = Boolean(item.favorite);
  setRating(Number(item.rating) || 0);
  setPhoto(item.photo || "");
  el.saveEntry.textContent = "変更を保存";
  showView("Add");
  el.shop.focus();
}

async function deleteCurrentEntry() {
  const item = entries.find((record) => record.id === currentDetailId);
  if (!item) return;
  if (!confirm(`「${item.ramen}」の記録を削除しますか？`)) return;
  await storeRequest("readwrite", (store) => store.delete(item.id));
  el.detailDialog.close();
  currentDetailId = "";
  await refreshEntries();
  showToast("記録を削除しました");
}

function exportBackup() {
  const payload = {
    app: "麺ログ",
    version: 1,
    exportedAt: new Date().toISOString(),
    entries
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `menlog-backup-${formatDateInput(new Date()).replaceAll("-", "")}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("バックアップを書き出しました");
}

async function importBackup(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const imported = Array.isArray(parsed) ? parsed : parsed.entries;
    if (!Array.isArray(imported)) throw new Error("Invalid backup");
    const valid = imported.filter(isValidImportedEntry).map(sanitizeImportedEntry);
    if (!valid.length) throw new Error("No valid entries");
    if (!confirm(`${valid.length}件の記録を読み込みます。同じIDの記録は上書きされます。`)) return;
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      valid.forEach((item) => store.put(item));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    await refreshEntries();
    el.settingsDialog.close();
    showToast(`${valid.length}件を読み込みました`);
  } catch (error) {
    console.error(error);
    showToast("このファイルは読み込めません");
  }
}

function isValidImportedEntry(item) {
  return item && typeof item === "object" && typeof item.shop === "string" && typeof item.ramen === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date || "");
}

function sanitizeImportedEntry(item) {
  const now = new Date().toISOString();
  return {
    id: typeof item.id === "string" && item.id ? item.id : makeId(),
    date: String(item.date).slice(0, 10),
    time: /^\d{2}:\d{2}$/.test(item.time || "") ? item.time : "",
    shop: String(item.shop).slice(0, 80),
    ramen: String(item.ramen).slice(0, 100),
    price: item.price === null || item.price === "" ? null : Math.max(0, Number(item.price) || 0),
    rating: Math.min(5, Math.max(0, Number(item.rating) || 0)),
    photo: typeof item.photo === "string" && item.photo.startsWith("data:image/") ? item.photo : "",
    memo: typeof item.memo === "string" ? item.memo.slice(0, 1000) : "",
    favorite: Boolean(item.favorite),
    createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now
  };
}

async function deleteAllData() {
  if (!confirm("すべてのラーメン記録と写真を削除します。本当に削除しますか？")) return;
  if (!confirm("最終確認です。削除後はバックアップがない限り元に戻せません。")) return;
  await storeRequest("readwrite", (store) => store.clear());
  await refreshEntries();
  el.settingsDialog.close();
  showToast("すべての記録を削除しました");
}

function maybeShowInstallHint() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const dismissed = localStorage.getItem("menlog-install-hint-dismissed") === "1";
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  el.installHint.hidden = standalone || dismissed || !isIOS;
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => console.warn("Service worker registration failed", error));
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.hidden = false;
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeText(value) {
  return String(value).normalize("NFKC").toLocaleLowerCase("ja").replace(/\s+/g, " ").trim();
}

function formatDateInput(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function formatTimeInput(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function startOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }

function shortDate(dateString) {
  if (!dateString) return "";
  const [year, month, day] = dateString.split("-").map(Number);
  return `${year}/${month}/${day}`;
}

function longDate(dateString) {
  if (!dateString) return "";
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][date.getDay()];
  return `${year}年${month}月${day}日（${weekday}）`;
}

function formatMoney(value) {
  return new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 }).format(Number(value) || 0);
}
