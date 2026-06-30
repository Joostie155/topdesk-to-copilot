// popup.js — TOPdesk → Copilot v2 with Config Management
document.addEventListener("DOMContentLoaded", async () => {
  const scrapeBtn         = document.getElementById("scrapeBtn");
  const statusEl          = document.getElementById("status");
  const previewEl         = document.getElementById("preview");
  const previewText       = document.getElementById("previewText");
  const promptSelect      = document.getElementById("promptSelect");
  const customPromptGroup = document.getElementById("customPromptGroup");
  const customPrompt      = document.getElementById("customPrompt");
  const extraInput        = document.getElementById("extraInput");
  const nameInput         = document.getElementById("nameInput");
  const charCount         = document.getElementById("charCount");
  const anonToggle        = document.getElementById("anonToggle");

  const attachmentsGroup = document.getElementById("attachmentsGroup");
  const attachmentsList  = document.getElementById("attachmentsList");
  const attachmentsHint  = document.getElementById("attachmentsHint");
  const attachCountEl    = document.getElementById("attachCount");
  const attachSelectAll  = document.getElementById("attachSelectAll");
  const attachSelectNone = document.getElementById("attachSelectNone");

  const ATTACH_SIZE_WARN  = 10 * 1024 * 1024;
  const ATTACH_SIZE_BLOCK = 30 * 1024 * 1024;
  // chrome.storage.local heeft een quotum van ~10 MB voor de hele extensie.
  // Bijlagen worden als base64 data-URL opgeslagen (~1.37× de bytegrootte),
  // dus we rekenen de geschatte opslag uit en houden marge voor config/tekst.
  const BASE64_OVERHEAD     = 1.37;
  const STORAGE_QUOTA_SAFE  = 9 * 1024 * 1024;
  const NO_ATTACH_DEFAULT_KEYS = new Set([
    "reply", "close_reply", "close_no_response", "reminder_no_response", "request_info",
  ]);

  let currentAttachments = [];
  let selectedAttachmentIds = new Set();
  let lastLoadedUuid = null;
  let attachmentsLoading = false;

  // ─── Anonymization ────────────────────────────────────────────────────────────

  function anonimiseer(text) {
    const melderNames = [];
    const melderMatch = text.match(/^Melder:\s*(.+)$/m);
    if (melderMatch) {
      const fullName = melderMatch[1].trim();
      melderNames.push(fullName);
      const parts = fullName.split(/\s+/);
      if (parts.length >= 2) {
        melderNames.push(parts[0]);
        melderNames.push(parts.slice(1).join(" "));
      }
    }

    let result = text;

    const uniqueNames = [...new Set(melderNames)].sort((a, b) => b.length - a.length);
    for (const name of uniqueNames) {
      if (name.length < 3) continue;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(escaped, "gi"), "[MELDER]");
    }

    result = result.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, "[EMAIL]");
    result = result.replace(/\b\d{9}\b/g, "[BSN]");
    result = result.replace(/(?:\+31[\s\-]?|0)(?:\d[\s\-]?){8,9}\d/g, "[TELEFOON]");
    result = result.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "[IP-ADRES]");
    result = result.replace(/\b\d{4}\s?[A-Z]{2}\b/g, "[POSTCODE]");
    result = result.replace(/\b[A-Z]{2}\d{2}[A-Z]{4}\d{10}\b/g, "[IBAN]");

    return result;
  }

  // Prompt keys that need an opening greeting and signoff appended
  const REPLY_PROMPT_KEYS = new Set(["reply", "close_reply"]);
  function appendSignoff(promptText, userName) {
    const name = (userName || "").trim();
    const opening = `Begin het bericht altijd met "Beste [voornaam van de melder],". Haal de voornaam uit de ticketinformatie (veld "Melder" of de aanhef in eerdere communicatie). Als er geen duidelijke voornaam te vinden is, gebruik dan "Beste collega,".`;
    const closing = name
      ? `Sluit het bericht altijd af met exact deze ondertekening, op een nieuwe regel:\n\nMet vriendelijke groet,\n${name}`
      : "";
    const instructions = [opening, closing].filter(Boolean).join("\n\n");
    return `${promptText}\n\n${instructions}`;
  }

  // Settings page elements
  const settingsBtn     = document.getElementById("settingsBtn");
  const mainPage        = document.getElementById("mainPage");
  const settingsPage    = document.getElementById("settingsPage");
  const backBtn         = document.getElementById("backBtn");
  const promptList      = document.getElementById("promptList");
  const categoryList    = document.getElementById("categoryList");
  const addPromptBtn    = document.getElementById("addPromptBtn");
  const addCategoryBtn  = document.getElementById("addCategoryBtn");
  const exportBtn       = document.getElementById("exportBtn");
  const importBtn       = document.getElementById("importBtn");
  const importInput     = document.getElementById("importInput");
  const resetAllBtn     = document.getElementById("resetAllBtn");
  const savedIndicator  = document.getElementById("savedIndicator");
  const autoSubmitToggle = document.getElementById("autoSubmitToggle");

  // Versie uit het manifest (één bron van waarheid) tonen in footer + settings.
  const extVersion = chrome.runtime.getManifest().version;
  const versionLabel = document.getElementById("versionLabel");
  if (versionLabel) versionLabel.textContent = `v${extVersion}`;
  const aboutVersion = document.getElementById("aboutVersion");
  if (aboutVersion) aboutVersion.textContent = `TOPdesk → Copilot · v${extVersion}`;

  const COPILOT_URL = "https://m365.cloud.microsoft/chat/";

  let defaultConfig = null;
  let currentConfig = null;

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function showSavedIndicator() {
    savedIndicator.classList.add("show");
    setTimeout(() => savedIndicator.classList.remove("show"), 2000);
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return "onbekende grootte";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function thumbIconFor(att) {
    const name = (att.fileName || "").toLowerCase();
    if (att.isImage) return "🖼️";
    if (name.endsWith(".pdf")) return "📄";
    if (name.endsWith(".eml") || name.endsWith(".msg")) return "✉️";
    if (/\.(docx?|rtf|odt)$/.test(name)) return "📝";
    if (/\.(xlsx?|csv|ods)$/.test(name)) return "📊";
    if (/\.(pptx?|odp)$/.test(name)) return "📽️";
    if (/\.(zip|rar|7z|tar|gz)$/.test(name)) return "🗜️";
    return "📎";
  }

  /**
   * Two-step executeScript: first set window.__topdeskAttachmentsRequest via an
   * inline func, then inject topdesk-attachments.js which reads it. Both steps
   * share the same isolated world, so the window global survives between them.
   */
  async function callAttachmentsScript(tabId, request) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (r) => { window.__topdeskAttachmentsRequest = r; },
        args: [request],
      });
      const [out] = await chrome.scripting.executeScript({
        target: { tabId },
        files: ["topdesk-attachments.js"],
      });
      return out?.result || null;
    } catch (err) {
      console.warn("[TOPdesk→Copilot] callAttachmentsScript error:", err);
      return null;
    }
  }

  // ─── Config load / save ──────────────────────────────────────────────────────

  async function loadDefaultConfig() {
    try {
      const r = await fetch(chrome.runtime.getURL("default-config.json"));
      defaultConfig = await r.json();
    } catch (err) {
      console.error("Failed to load default config:", err);
    }
  }

  async function loadConfig() {
    if (!defaultConfig) await loadDefaultConfig();
    return new Promise((resolve) => {
      chrome.storage.local.get(["copilot_promptConfig"], (result) => {
        if (result.copilot_promptConfig) {
          currentConfig = result.copilot_promptConfig;
          if (!currentConfig.groups)      currentConfig.groups = defaultConfig?.groups ?? [];
          if (!currentConfig.promptOrder) currentConfig.promptOrder = defaultConfig?.promptOrder ?? [];
          if (!currentConfig.prompts)     currentConfig.prompts = {};
        } else {
          currentConfig = JSON.parse(JSON.stringify(defaultConfig));
        }
        resolve(currentConfig);
      });
    });
  }

  async function saveConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ copilot_promptConfig: currentConfig }, resolve);
    });
  }

  // ─── Main dropdown ───────────────────────────────────────────────────────────

  function buildPromptSelect() {
    promptSelect.innerHTML = "";
    const groups = {};
    for (const key of currentConfig.promptOrder) {
      const p = currentConfig.prompts[key];
      if (!p) continue;
      (groups[p.group] ??= []).push({ key, ...p });
    }
    for (const groupName of currentConfig.groups) {
      if (!groups[groupName]?.length) continue;
      const optgroup = document.createElement("optgroup");
      optgroup.label = groupName;
      for (const p of groups[groupName]) {
        const opt = document.createElement("option");
        opt.value = p.key;
        opt.textContent = p.label;
        optgroup.appendChild(opt);
      }
      promptSelect.appendChild(optgroup);
    }
    const custom = document.createElement("option");
    custom.value = "custom";
    custom.textContent = "✏️ Eigen prompt...";
    promptSelect.appendChild(custom);
  }

  // ─── Prompt list (settings) ──────────────────────────────────────────────────

  function buildPromptList() {
    const openKeys = new Set(
      [...document.querySelectorAll(".prompt-item-body.open")]
        .map(el => el.id.replace("body-", ""))
    );

    promptList.innerHTML = "";

    if (!currentConfig.promptOrder.length) {
      promptList.innerHTML = `<p class="empty-hint">Geen prompts. Klik "+ Nieuwe prompt" om er een toe te voegen.</p>`;
      return;
    }

    for (const key of currentConfig.promptOrder) {
      const prompt = currentConfig.prompts[key];
      if (!prompt) continue;

      const isDefault = !!defaultConfig?.prompts[key];
      const groupOptions = currentConfig.groups.length
        ? currentConfig.groups.map(g =>
            `<option value="${escapeHtml(g)}"${g === prompt.group ? " selected" : ""}>${escapeHtml(g)}</option>`
          ).join("")
        : `<option value="">— Voeg eerst een categorie toe —</option>`;

      const item = document.createElement("div");
      item.className = "prompt-item";
      item.innerHTML = `
        <div class="prompt-item-header" data-key="${key}">
          <span class="prompt-name">${escapeHtml(prompt.label || "Naamloos")}</span>
          <div class="prompt-header-right">
            <span class="group-tag">${escapeHtml(prompt.group)}</span>
            <button class="prompt-delete-btn" data-key="${key}" title="Verwijderen">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
                <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="prompt-item-body" id="body-${key}">
          <div class="form-row">
            <label class="form-label">Naam</label>
            <input type="text" id="label-${key}" class="form-input" value="${escapeHtml(prompt.label)}" placeholder="Bijv. Analyseer ticket">
          </div>
          <div class="form-row">
            <label class="form-label">Categorie</label>
            <select id="group-${key}" class="form-select">${groupOptions}</select>
          </div>
          <div class="form-row">
            <label class="form-label">Prompt tekst</label>
            <textarea id="edit-${key}" placeholder="Typ de prompt tekst...">${escapeHtml(prompt.text)}</textarea>
          </div>
          <div class="btn-row">
            ${isDefault ? `<button class="reset-prompt-btn" data-key="${key}">Reset</button>` : ""}
            <button class="save-prompt-btn" data-key="${key}">Opslaan</button>
          </div>
        </div>`;
      promptList.appendChild(item);
    }

    for (const key of openKeys) {
      document.getElementById(`body-${key}`)?.classList.add("open");
    }

    promptList.querySelectorAll(".prompt-item-header").forEach(header => {
      header.addEventListener("click", (e) => {
        if (e.target.closest(".prompt-delete-btn")) return;
        document.getElementById(`body-${header.dataset.key}`)?.classList.toggle("open");
      });
    });

    promptList.querySelectorAll(".prompt-delete-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const key = btn.dataset.key;
        const label = currentConfig.prompts[key]?.label || "deze prompt";
        if (!confirm(`"${label}" verwijderen?`)) return;
        delete currentConfig.prompts[key];
        currentConfig.promptOrder = currentConfig.promptOrder.filter(k => k !== key);
        await saveConfig();
        buildPromptList();
        buildPromptSelect();
        showSavedIndicator();
      });
    });

    promptList.querySelectorAll(".save-prompt-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.key;
        const labelInput  = document.getElementById(`label-${key}`);
        const groupSelect = document.getElementById(`group-${key}`);
        const textarea    = document.getElementById(`edit-${key}`);
        const newLabel = labelInput?.value.trim();
        if (!newLabel) {
          labelInput?.classList.add("input-error");
          labelInput?.focus();
          return;
        }
        labelInput?.classList.remove("input-error");
        currentConfig.prompts[key].label = newLabel;
        currentConfig.prompts[key].group = groupSelect?.value || currentConfig.prompts[key].group;
        currentConfig.prompts[key].text  = textarea?.value ?? "";
        await saveConfig();
        showSavedIndicator();
        buildPromptList();
        buildPromptSelect();
      });
    });

    promptList.querySelectorAll(".reset-prompt-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        const key = btn.dataset.key;
        if (defaultConfig?.prompts[key]) {
          currentConfig.prompts[key] = { ...defaultConfig.prompts[key] };
          await saveConfig();
          showSavedIndicator();
          buildPromptList();
          buildPromptSelect();
        }
      });
    });
  }

  // ─── Category list (settings) ────────────────────────────────────────────────

  function buildCategoryList() {
    categoryList.innerHTML = "";

    if (!currentConfig.groups.length) {
      categoryList.innerHTML = `<p class="empty-hint">Geen categorieën. Klik "+ Nieuwe categorie" om er een toe te voegen.</p>`;
      return;
    }

    for (const group of currentConfig.groups) {
      const count = currentConfig.promptOrder.filter(k => currentConfig.prompts[k]?.group === group).length;
      const item = document.createElement("div");
      item.className = "category-item";
      item.dataset.group = group;
      item.innerHTML = `
        <span class="category-name">${escapeHtml(group)}</span>
        <span class="category-count">${count} prompt${count !== 1 ? "s" : ""}</span>
        <div class="category-btns">
          <button class="icon-btn rename-cat-btn" title="Hernoemen">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="icon-btn danger delete-cat-btn" title="Verwijderen">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
          </button>
        </div>`;
      categoryList.appendChild(item);
    }

    categoryList.querySelectorAll(".rename-cat-btn").forEach((btn, i) => {
      btn.addEventListener("click", () => startRenameCategory(currentConfig.groups[i]));
    });
    categoryList.querySelectorAll(".delete-cat-btn").forEach((btn, i) => {
      btn.addEventListener("click", () => deleteCategoryHandler(currentConfig.groups[i]));
    });
  }

  function startAddCategory() {
    if (categoryList.querySelector(".new-item")) return;

    const item = document.createElement("div");
    item.className = "category-item new-item";
    item.innerHTML = `
      <input type="text" class="category-name-input" placeholder="Naam nieuwe categorie...">
      <div class="category-btns">
        <button class="icon-btn confirm confirm-add-cat" title="Toevoegen">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </button>
        <button class="icon-btn cancel-add-cat" title="Annuleren">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>`;
    categoryList.insertBefore(item, categoryList.firstChild);

    const input = item.querySelector(".category-name-input");
    input.focus();

    async function doAdd() {
      const name = input.value.trim();
      if (!name) { item.remove(); return; }
      if (currentConfig.groups.includes(name)) {
        input.classList.add("input-error"); input.focus(); return;
      }
      currentConfig.groups.push(name);
      await saveConfig();
      buildCategoryList();
      buildPromptList();
      showSavedIndicator();
    }

    item.querySelector(".confirm-add-cat").addEventListener("click", doAdd);
    item.querySelector(".cancel-add-cat").addEventListener("click", () => item.remove());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doAdd();
      if (e.key === "Escape") item.remove();
    });
  }

  function startRenameCategory(groupName) {
    let item = null;
    for (const el of categoryList.querySelectorAll(".category-item:not(.new-item)")) {
      if (el.dataset.group === groupName) { item = el; break; }
    }
    if (!item) return;

    item.innerHTML = `
      <input type="text" class="category-name-input" value="${escapeHtml(groupName)}">
      <div class="category-btns">
        <button class="icon-btn confirm confirm-rename-cat" title="Bevestigen">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </button>
        <button class="icon-btn cancel-rename-cat" title="Annuleren">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>`;

    const input = item.querySelector(".category-name-input");
    input.focus(); input.select();

    async function doRename() {
      const newName = input.value.trim();
      if (!newName || newName === groupName) { buildCategoryList(); return; }
      if (currentConfig.groups.includes(newName)) {
        input.classList.add("input-error"); input.focus(); return;
      }
      const idx = currentConfig.groups.indexOf(groupName);
      if (idx !== -1) currentConfig.groups[idx] = newName;
      for (const key of Object.keys(currentConfig.prompts)) {
        if (currentConfig.prompts[key].group === groupName) {
          currentConfig.prompts[key].group = newName;
        }
      }
      await saveConfig();
      buildCategoryList();
      buildPromptList();
      buildPromptSelect();
      showSavedIndicator();
    }

    item.querySelector(".confirm-rename-cat").addEventListener("click", doRename);
    item.querySelector(".cancel-rename-cat").addEventListener("click", () => buildCategoryList());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doRename();
      if (e.key === "Escape") buildCategoryList();
    });
  }

  async function deleteCategoryHandler(groupName) {
    const count = currentConfig.promptOrder.filter(k => currentConfig.prompts[k]?.group === groupName).length;
    let msg = `Categorie "${groupName}" verwijderen?`;
    if (count > 0) msg += `\n\n${count} prompt${count !== 1 ? "s" : ""} in deze categorie worden ook verwijderd.`;
    if (!confirm(msg)) return;

    const toDelete = currentConfig.promptOrder.filter(k => currentConfig.prompts[k]?.group === groupName);
    for (const key of toDelete) delete currentConfig.prompts[key];
    currentConfig.promptOrder = currentConfig.promptOrder.filter(k => !toDelete.includes(k));
    currentConfig.groups = currentConfig.groups.filter(g => g !== groupName);

    await saveConfig();
    buildCategoryList();
    buildPromptList();
    buildPromptSelect();
    showSavedIndicator();
  }

  // ─── Export / Import / Reset ─────────────────────────────────────────────────

  function exportConfig() {
    const blob = new Blob([JSON.stringify(currentConfig, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "topdesk-copilot-config.json"; a.click();
    URL.revokeObjectURL(url);
  }

  function importConfig(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        if (imported.prompts && imported.version) {
          currentConfig = imported;
          if (!currentConfig.groups)      currentConfig.groups = [];
          if (!currentConfig.promptOrder) currentConfig.promptOrder = [];
          await saveConfig();
          buildPromptSelect();
          buildPromptList();
          buildCategoryList();
          showSavedIndicator();
        } else {
          showFooterError("Ongeldig config bestand");
        }
      } catch (err) {
        showFooterError("Fout bij importeren: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  function showFooterError(msg) {
    const el = document.createElement("span");
    el.style.cssText = "font-size:11px;color:#991b1b;";
    el.textContent = msg;
    document.querySelector(".settings-footer .left-btns").appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  async function resetAll() {
    if (!confirm("Weet je zeker dat je alle prompts en categorieën wilt resetten naar de standaardwaarden?")) return;
    currentConfig = JSON.parse(JSON.stringify(defaultConfig));
    await saveConfig();
    buildPromptSelect();
    buildPromptList();
    buildCategoryList();
    showSavedIndicator();
  }

  // ─── Initialize ──────────────────────────────────────────────────────────────

  await loadConfig();
  buildPromptSelect();

  // Tab switching
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });

  // Add new prompt
  addPromptBtn.addEventListener("click", () => {
    const key = `custom_${Date.now()}`;
    const firstGroup = currentConfig.groups[0] ?? "";
    currentConfig.prompts[key] = { label: "", group: firstGroup, text: "" };
    currentConfig.promptOrder.push(key);
    buildPromptList();
    const newBody = document.getElementById(`body-${key}`);
    if (newBody) {
      newBody.classList.add("open");
      newBody.scrollIntoView({ behavior: "smooth", block: "nearest" });
      document.getElementById(`label-${key}`)?.focus();
    }
  });

  // Add new category
  addCategoryBtn.addEventListener("click", startAddCategory);

  // Settings page navigation
  function openSettings() {
    buildPromptList();
    buildCategoryList();
    mainPage.classList.add("hidden");
    settingsPage.classList.add("active");
  }

  function closeSettings() {
    mainPage.classList.remove("hidden");
    settingsPage.classList.remove("active");
  }

  settingsBtn.addEventListener("click", openSettings);
  backBtn.addEventListener("click", closeSettings);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settingsPage.classList.contains("active")) closeSettings();
  });

  exportBtn.addEventListener("click", exportConfig);
  importBtn.addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", (e) => {
    if (e.target.files[0]) { importConfig(e.target.files[0]); e.target.value = ""; }
  });
  resetAllBtn.addEventListener("click", resetAll);

  // Show/hide custom prompt & persist preferences
  promptSelect.addEventListener("change", () => {
    customPromptGroup.style.display = promptSelect.value === "custom" ? "block" : "none";
    chrome.storage.local.set({ copilot_selectedPrompt: promptSelect.value });
    if (currentAttachments.length) {
      applySmartDefaults(promptSelect.value);
      renderAttachments();
    }
  });
  customPrompt.addEventListener("input", () => {
    chrome.storage.local.set({ copilot_customPromptText: customPrompt.value });
  });
  extraInput.addEventListener("input", () => {
    chrome.storage.local.set({ copilot_extraInputText: extraInput.value });
  });
  nameInput.addEventListener("input", () => {
    chrome.storage.local.set({ copilot_userName: nameInput.value });
  });
  anonToggle.addEventListener("change", () => {
    chrome.storage.local.set({ copilot_anonimiseer: anonToggle.checked });
  });
  if (autoSubmitToggle) {
    autoSubmitToggle.addEventListener("change", () => {
      chrome.storage.local.set({ copilot_autoSubmit: autoSubmitToggle.checked });
    });
  }

  // Restore saved preferences
  chrome.storage.local.get(["copilot_selectedPrompt", "copilot_customPromptText", "copilot_extraInputText", "copilot_userName", "copilot_anonimiseer", "copilot_autoSubmit"], (result) => {
    if (result.copilot_selectedPrompt) {
      promptSelect.value = result.copilot_selectedPrompt;
      if (result.copilot_selectedPrompt === "custom") customPromptGroup.style.display = "block";
    }
    if (result.copilot_customPromptText) customPrompt.value = result.copilot_customPromptText;
    if (result.copilot_extraInputText)   extraInput.value   = result.copilot_extraInputText;
    if (result.copilot_userName)         nameInput.value    = result.copilot_userName;
    if (result.copilot_anonimiseer)      anonToggle.checked = true;
    // Auto-submit is opt-out: checked unless the user explicitly turned it off.
    if (autoSubmitToggle) autoSubmitToggle.checked = result.copilot_autoSubmit !== false;
  });

  // ─── Attachments ─────────────────────────────────────────────────────────────

  function applySmartDefaults(selectedPromptKey) {
    selectedAttachmentIds.clear();
    if (NO_ATTACH_DEFAULT_KEYS.has(selectedPromptKey)) return;
    for (const att of currentAttachments) {
      if (att.isImage && att.size <= ATTACH_SIZE_BLOCK) {
        selectedAttachmentIds.add(att.id);
      }
    }
  }

  function renderAttachments() {
    if (!attachmentsGroup) return;

    if (!currentAttachments.length) {
      attachmentsGroup.style.display = "none";
      if (attachmentsHint) attachmentsHint.style.display = "none";
      return;
    }

    attachmentsGroup.style.display = "block";
    attachCountEl.textContent = `(${currentAttachments.length})`;

    attachmentsList.innerHTML = "";
    let anyImageSelected = false;

    for (const att of currentAttachments) {
      const oversized = att.size > ATTACH_SIZE_BLOCK;
      const large = !oversized && att.size > ATTACH_SIZE_WARN;
      const selected = selectedAttachmentIds.has(att.id) && !oversized;
      if (selected && att.isImage) anyImageSelected = true;

      const sizeClass = oversized ? "toobig" : large ? "large" : "";
      const sizeLabel = oversized ? `${formatSize(att.size)} — te groot` : formatSize(att.size);

      const thumbInner = att.thumbnail
        ? `<img src="${escapeHtml(att.thumbnail)}" alt="">`
        : `<span>${thumbIconFor(att)}</span>`;

      const badges = [];
      if (att.invisibleForCaller) badges.push(`<span class="attach-badge internal">Intern</span>`);

      const item = document.createElement("label");
      item.className = "attach-item" + (selected ? " selected" : "") + (oversized ? " disabled" : "");
      item.innerHTML = `
        <input type="checkbox" data-id="${escapeHtml(att.id)}" ${selected ? "checked" : ""} ${oversized ? "disabled" : ""}>
        <div class="attach-thumb">${thumbInner}</div>
        <div class="attach-meta">
          <div class="attach-name" title="${escapeHtml(att.fileName)}">${escapeHtml(att.fileName)}</div>
          <div class="attach-sub">
            <span class="attach-size ${sizeClass}">${escapeHtml(sizeLabel)}</span>
            ${badges.join("")}
          </div>
        </div>`;
      attachmentsList.appendChild(item);
    }

    attachmentsList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.dataset.id;
        if (cb.checked) selectedAttachmentIds.add(id); else selectedAttachmentIds.delete(id);
        renderAttachments();
      });
    });

    if (anyImageSelected) {
      attachmentsHint.textContent = "⚠️ Anonimisatie werkt niet op afbeeldingen.";
      attachmentsHint.style.display = "block";
    } else {
      attachmentsHint.style.display = "none";
    }
  }

  function renderAttachmentsLoading() {
    if (!attachmentsGroup) return;
    attachmentsGroup.style.display = "block";
    if (attachCountEl) attachCountEl.textContent = "";
    attachmentsList.innerHTML =
      '<div class="attach-loading"><span class="attach-spinner"></span>Bijlagen ophalen…</div>';
    if (attachmentsHint) attachmentsHint.style.display = "none";
  }

  async function loadAttachmentsForActiveTab() {
    if (attachmentsLoading) return;
    attachmentsLoading = true;

    const showLoaderIfStillWaiting = lastLoadedUuid === null && !currentAttachments.length;
    let loaderTimer = null;
    if (showLoaderIfStillWaiting) {
      loaderTimer = setTimeout(() => {
        if (attachmentsLoading) renderAttachmentsLoading();
      }, 200);
    }
    const clearLoader = () => { if (loaderTimer) { clearTimeout(loaderTimer); loaderTimer = null; } };

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) { clearLoader(); renderAttachments(); return; }
      const url = tab.url || "";
      if (!url.includes("topdesk") && !url.includes("tod.") && !url.includes("localhost")) {
        clearLoader(); renderAttachments(); return;
      }

      const res = await callAttachmentsScript(tab.id, { action: "list" });
      clearLoader();
      if (!res || !res.ok) {
        console.debug("[TOPdesk→Copilot] attachments list faalde:", res);
        if (lastLoadedUuid !== null) {
          currentAttachments = [];
          selectedAttachmentIds.clear();
          lastLoadedUuid = null;
        }
        renderAttachments();
        return;
      }
      console.debug("[TOPdesk→Copilot] attachments:", res.attachments?.length ?? 0, "uuid:", res.uuid);
      if (res.uuid === lastLoadedUuid) return;
      lastLoadedUuid = res.uuid;
      currentAttachments = Array.isArray(res.attachments) ? res.attachments : [];
      applySmartDefaults(promptSelect.value);
      renderAttachments();
    } finally {
      clearLoader();
      attachmentsLoading = false;
    }
  }

  if (attachSelectAll) {
    attachSelectAll.addEventListener("click", () => {
      for (const att of currentAttachments) {
        if (att.size <= ATTACH_SIZE_BLOCK) selectedAttachmentIds.add(att.id);
      }
      renderAttachments();
    });
  }
  if (attachSelectNone) {
    attachSelectNone.addEventListener("click", () => {
      selectedAttachmentIds.clear();
      renderAttachments();
    });
  }

  // ─── Ticket indicator ────────────────────────────────────────────────────────

  const ticketStatusEl   = document.getElementById("ticketStatus");
  const ticketLabelEl    = ticketStatusEl?.querySelector(".ticket-label");
  const ticketInfoEl     = document.getElementById("ticketInfo");
  const ticketInfoNumber = document.getElementById("ticketInfoNumber");
  const ticketInfoTitle  = document.getElementById("ticketInfoTitle");
  const ticketInfoCaller = document.getElementById("ticketInfoCaller");

  function setTicketIndicator(state, label) {
    if (!ticketStatusEl) return;
    ticketStatusEl.className = `ticket-status ticket-status--${state}`;
    if (ticketLabelEl) ticketLabelEl.textContent = label;
  }

  function setTicketInfo(ticketNumber, title, caller) {
    if (!ticketInfoEl) return;
    if (ticketNumber) {
      ticketInfoNumber.textContent = ticketNumber;
      const displayTitle = (title && title.trim()) || "(geen omschrijving)";
      ticketInfoTitle.textContent = displayTitle;
      ticketInfoTitle.title = displayTitle;
      const displayCaller = (caller && caller.trim()) ? `👤 ${caller.trim()}` : "";
      ticketInfoCaller.textContent = displayCaller;
      ticketInfoCaller.title = caller || "";
      ticketInfoEl.style.display = "block";
    } else {
      ticketInfoEl.style.display = "none";
    }
  }

  async function checkTicketStatus() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return { state: "none" };
      const url = tab.url || "";
      if (!url.includes("topdesk") && !url.includes("tod.") && !url.includes("localhost")) {
        return { state: "none" };
      }
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const iframes = document.querySelectorAll("iframe");
          let best = null;
          let bestArea = 0;
          for (const iframe of iframes) {
            try {
              const doc = iframe.contentDocument;
              if (!doc || !doc.body) continue;
              if (iframe.offsetWidth === 0 || iframe.offsetHeight === 0) continue;
              const h1 = doc.querySelector("h1");
              const text = h1?.textContent || "";
              if (!/[A-Z]\d{4}\s*\d{4}/.test(text)) continue;
              const area = iframe.offsetWidth * iframe.offsetHeight;
              if (area <= bestArea) continue;
              let ticketNumber = "", title = "";
              const divs = h1.querySelectorAll("div");
              if (divs.length >= 2) {
                ticketNumber = divs[0].textContent.trim();
                title = divs[1].textContent.trim();
              } else {
                const m = text.match(/([A-Z]\d{4}\s*\d{4})\s*(.*)/s);
                if (m) { ticketNumber = m[1].trim(); title = m[2].trim(); }
              }
              // Caller extraction: try labeled "Aanmelder/Melder" field first, fall back to text scan
              let caller = "";
              for (const lbl of doc.querySelectorAll("label")) {
                const lt = lbl.textContent.trim().toLowerCase();
                if (lt !== "aanmelder" && lt !== "melder") continue;
                const forId = lbl.getAttribute("for");
                if (!forId) continue;
                const target = doc.getElementById(forId);
                const v = target?.value || target?.textContent || "";
                if (v && v.trim()) { caller = v.trim(); break; }
              }
              if (!caller) {
                const NAME_RE = /^[A-ZÀ-ſ][^@,\d]{1,40},\s+[A-ZÀ-ſ][^@\d]{1,60}$/;
                const fullText = doc.body.innerText || "";
                const head = fullText.match(/^[\s\S]*?(?=Planning|Object\/ruimte|Afhandeling|Verzoek)/);
                if (head) {
                  for (const raw of head[0].split("\n")) {
                    const line = raw.trim();
                    if (!line) continue;
                    const stripped = line.replace(/\d{1,2}\s\w+\s\d{4}.*$/, "").trim();
                    if (!stripped || stripped.length > 80) continue;
                    if (/[A-Z]\d{4}\s*\d{4}/.test(stripped)) continue;
                    if (title && stripped === title) continue;
                    if (NAME_RE.test(stripped)) { caller = stripped; break; }
                  }
                }
              }
              bestArea = area;
              best = { ticketNumber, title, caller };
            } catch {}
          }
          return best;
        },
      });
      if (result?.result) {
        return {
          state: "ready",
          ticketNumber: result.result.ticketNumber,
          title: result.result.title,
          caller: result.result.caller,
        };
      }
      return { state: "empty" };
    } catch {
      return { state: "none" };
    }
  }

  async function pollTicketStatus() {
    const { state, ticketNumber, title, caller } = await checkTicketStatus();
    if (state === "ready") {
      setTicketIndicator("green", "Ticket klaar om te scrapen");
      setTicketInfo(ticketNumber, title, caller);
      loadAttachmentsForActiveTab();
    } else if (state === "empty") {
      setTicketIndicator("yellow", "Geen ticket geopend");
      setTicketInfo(null);
      if (lastLoadedUuid !== null) {
        currentAttachments = [];
        selectedAttachmentIds.clear();
        lastLoadedUuid = null;
        renderAttachments();
      }
    } else {
      setTicketIndicator("red", "Geen TOPdesk-tab");
      setTicketInfo(null);
      if (lastLoadedUuid !== null) {
        currentAttachments = [];
        selectedAttachmentIds.clear();
        lastLoadedUuid = null;
        renderAttachments();
      }
    }
  }

  pollTicketStatus();
  const ticketPollHandle = setInterval(pollTicketStatus, 2000);
  window.addEventListener("unload", () => clearInterval(ticketPollHandle));

  // ─── Scrape ──────────────────────────────────────────────────────────────────

  function updateStatus(message, type = "info") {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    statusEl.style.display = "block";
  }

  function resetScrapeBtn() {
    scrapeBtn.disabled = false;
    scrapeBtn.textContent = "📋 Ticket scrapen & naar Copilot";
  }

  scrapeBtn.addEventListener("click", async () => {
    scrapeBtn.disabled = true;
    scrapeBtn.textContent = "⏳ Scraping...";
    updateStatus("Ticket wordt gelezen...", "info");

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) { updateStatus("Geen actief tabblad gevonden.", "error"); resetScrapeBtn(); return; }

      const url = tab.url || "";
      if (!url.includes("topdesk") && !url.includes("tod.") && !url.includes("localhost")) {
        updateStatus("Dit is geen TOPdesk pagina. Open een ticket in TOPdesk.", "error");
        resetScrapeBtn(); return;
      }

      const [scrapeResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["topdesk-scraper.js"],
      });

      let ticketText = scrapeResult?.result;
      if (!ticketText || ticketText.startsWith("FOUT:") || ticketText.length < 20) {
        updateStatus(
          ticketText?.startsWith("FOUT:") ? ticketText : "Geen ticket-data gevonden. Zorg dat je op een ticket-detailpagina zit.",
          "error"
        );
        resetScrapeBtn(); return;
      }

      if (anonToggle.checked) ticketText = anonimiseer(ticketText);

      previewText.textContent = ticketText.substring(0, 500) + (ticketText.length > 500 ? "\n..." : "");
      charCount.textContent = `${ticketText.length} tekens`;
      previewEl.style.display = "block";
      updateStatus("Ticket gelezen! Copilot wordt geopend...", "success");

      const selectedPrompt = promptSelect.value;
      let promptText = selectedPrompt === "custom"
        ? customPrompt.value.trim()
        : (currentConfig.prompts[selectedPrompt]?.text || "");

      if (REPLY_PROMPT_KEYS.has(selectedPrompt)) {
        promptText = appendSignoff(promptText, nameInput.value);
      }

      const extra = extraInput.value.trim();
      if (extra) promptText = promptText ? `${promptText}\n\nExtra context: ${extra}` : extra;

      const ticketIdMatch   = ticketText.match(/Ticketnummer:\s*([A-Z]\d{4}\s*\d{4})/);
      const ticketDescMatch = ticketText.match(/Omschrijving:\s*(.+)/);
      const ticketId = ticketIdMatch
        ? `${ticketIdMatch[1]}${ticketDescMatch ? "_" + ticketDescMatch[1].trim() : ""}`
        : "TOPdesk_ticket";

      const fullText = promptText ? `${promptText}\n\n${ticketText}` : ticketText;

      let attachments = [];
      const selectedIds = [...selectedAttachmentIds].filter((id) => {
        const att = currentAttachments.find((a) => a.id === id);
        return att && att.size <= ATTACH_SIZE_BLOCK;
      });

      // Cumulatieve opslagcheck: voorkom de stille quota-fout (popup sluit zodra
      // de Copilot-tab opent, dus een melding achteraf zie je niet meer).
      const selectedAtts = currentAttachments.filter((a) => selectedIds.includes(a.id));
      const estBytes = selectedAtts.reduce((s, a) => s + (a.size || 0) * BASE64_OVERHEAD, 0) + fullText.length;
      if (selectedIds.length && estBytes > STORAGE_QUOTA_SAFE) {
        const totalMb = (selectedAtts.reduce((s, a) => s + (a.size || 0), 0) / 1024 / 1024).toFixed(1);
        updateStatus(
          `De geselecteerde bijlage${selectedIds.length === 1 ? "" : "n"} (${totalMb} MB) ${selectedIds.length === 1 ? "past" : "passen samen"} niet in de opslag van de extensie (max ~10 MB). Vink minder of kleinere bijlagen aan, of klik "Geen" om alleen de tekst te versturen.`,
          "error"
        );
        resetScrapeBtn();
        return;
      }

      if (selectedIds.length) {
        updateStatus(`Ticket gelezen. ${selectedIds.length} bijlage${selectedIds.length === 1 ? "" : "n"} ophalen...`, "info");
        const meta = currentAttachments
          .filter((a) => selectedIds.includes(a.id))
          .map((a) => ({ id: a.id, fileName: a.fileName, downloadUrl: a.downloadUrl, mimeType: a.mimeType }));
        const dl = await callAttachmentsScript(tab.id, { action: "download", ids: selectedIds, meta });
        if (dl?.ok && Array.isArray(dl.downloads)) {
          attachments = dl.downloads
            .filter((d) => d.dataUrl && d.name)
            .map((d) => ({ name: d.name, mimeType: d.mimeType, dataUrl: d.dataUrl }));
          const failed = dl.downloads.length - attachments.length;
          if (failed > 0) {
            updateStatus(`${failed} bijlage${failed === 1 ? "" : "n"} kon${failed === 1 ? "" : "den"} niet worden opgehaald, ga door...`, "info");
          }
        }
      }

      let attachmentsDropped = false;
      try {
        await storePendingTicket(fullText, ticketId, attachments);
      } catch (storeErr) {
        if (attachments.length && isQuotaError(storeErr)) {
          // Bijlagen passen niet in chrome.storage.local (~10 MB). De tickettekst
          // past altijd wel: sla die zonder bijlagen op zodat de flow doorgaat.
          await storePendingTicket(fullText, ticketId, []);
          attachmentsDropped = true;
        } else {
          throw storeErr;
        }
      }

      await fallbackToClipboard(fullText, true);
      const newTab = await chrome.tabs.create({ url: COPILOT_URL, active: false });
      if (tab.groupId && tab.groupId !== -1) {
        try { await chrome.tabs.group({ tabIds: [newTab.id], groupId: tab.groupId }); } catch {}
      }
      await chrome.tabs.update(newTab.id, { active: true });

      if (attachmentsDropped) {
        updateStatus(
          "⚠️ Bijlage(n) te groot voor opslag (max ~10 MB). De tickettekst is wél verstuurd — voeg de bijlage handmatig toe in Copilot.",
          "info"
        );
      } else {
        updateStatus("✅ Copilot geopend! Tekst wordt automatisch geplakt.", "success");
      }
      resetScrapeBtn();
    } catch (err) {
      console.error("Scrape error:", err);
      updateStatus(`Fout: ${friendlyError(err)}`, "error");
      resetScrapeBtn();
    }
  });

  function storePendingTicket(fullText, ticketId, attachments) {
    return chrome.storage.local.set({
      copilot_pendingTicket: {
        text: fullText,
        ticketId,
        timestamp: Date.now(),
        attachments,
      },
    });
  }

  function isQuotaError(err) {
    const msg = (err && (err.message || err)) + "";
    return /quota/i.test(msg);
  }

  function friendlyError(err) {
    if (isQuotaError(err)) {
      return "De bijlage is te groot voor de opslag van de extensie (max ~10 MB). Kies een kleinere bijlage of voeg deze handmatig toe in Copilot.";
    }
    return err && err.message ? err.message : String(err);
  }

  async function fallbackToClipboard(text, silent = false) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    if (!silent) updateStatus("📋 Gekopieerd naar klembord! Plak (⌘V) in Copilot.", "success");
  }
});
