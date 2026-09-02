// topdesk-tickets.js
// On-demand content script for multi-ticket support. Reads the Mango window
// tab strip to find ALL open tickets (also background tabs, which are NOT
// mounted in the DOM in current TOPdesk versions) and fetches full ticket
// data via the same-origin REST API:
//   GET /tas/api/incidents/number/{number}        → ticket JSON (incl. id)
//   GET /tas/api/incidents/id/{id}/progresstrail  → actions/communications
//
// Injected via the two-step executeScript pattern (see callTicketsScript in
// popup.js): step 1 sets window.__topdeskTicketsRequest, step 2 injects this
// file. Request: { action: "list" } or { action: "fetch", numbers: [...] }.

(async function () {
  const request = window.__topdeskTicketsRequest || { action: "list" };
  delete window.__topdeskTicketsRequest;

  const origin = window.location.origin;
  // Tab labels look like "M2608 1432 map op teams is verdwenen"
  const TICKET_RE = /^([A-Z]\d{4}\s*\d{4})\s*(.*)$/;

  function log(...args) { console.debug("[TOPdesk-tickets]", ...args); }

  /**
   * Scan the Mango window tab strip. `guielement="window_tab"` is a stable,
   * semantic attribute (unlike the per-session generated element ids); the
   * active tab carries `active="true"`.
   */
  function listOpenTickets() {
    const tickets = [];
    const seen = new Set();
    for (const tab of document.querySelectorAll('[guielement="window_tab"]')) {
      const text = (tab.textContent || "").trim().replace(/\s+/g, " ");
      const m = text.match(TICKET_RE);
      if (!m) continue;
      const number = m[1].replace(/\s+/g, " ").trim();
      if (seen.has(number)) continue;
      seen.add(number);
      tickets.push({
        number,
        title: m[2].trim(),
        active: tab.getAttribute("active") === "true",
      });
    }
    return tickets;
  }

  async function apiGet(path) {
    const res = await fetch(`${origin}${path}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    return res;
  }

  function fmtDate(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString("nl-NL", {
        day: "numeric", month: "long", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch { return iso; }
  }

  function stripHtml(s) {
    return String(s || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }

  /** Build the same structured text the DOM scraper produces, but from JSON. */
  function formatTicket(j, trail) {
    let out = "";
    out += `Ticketnummer: ${j.number}\n`;
    if (j.briefDescription) out += `Omschrijving: ${j.briefDescription}\n`;

    const c = j.caller || {};
    const callerLines = [];
    if (c.dynamicName) callerLines.push(`Naam: ${c.dynamicName}`);
    if (c.email) callerLines.push(`E-mail: ${c.email}`);
    if (c.phoneNumber || c.mobileNumber) callerLines.push(`Telefoon: ${c.phoneNumber || c.mobileNumber}`);
    if (c.department?.name) callerLines.push(`Afdeling: ${c.department.name}`);
    if (c.branch?.name) callerLines.push(`Vestiging: ${c.branch.name}`);
    if (callerLines.length) out += `\n--- Aanmelder ---\n${callerLines.join("\n")}\n`;

    const classLines = [];
    if (j.callType?.name) classLines.push(`Soort melding: ${j.callType.name}`);
    if (j.entryType?.name) classLines.push(`Binnengekomen via: ${j.entryType.name}`);
    if (j.category?.name) classLines.push(`Categorie: ${j.category.name}`);
    if (j.subcategory?.name) classLines.push(`Subcategorie: ${j.subcategory.name}`);
    if (classLines.length) out += `\n--- Classificatie ---\n${classLines.join("\n")}\n`;

    const planLines = [];
    if (j.impact?.name) planLines.push(`Impact: ${j.impact.name}`);
    if (j.urgency?.name) planLines.push(`Urgentie: ${j.urgency.name}`);
    if (j.priority?.name) planLines.push(`Prioriteit: ${j.priority.name}`);
    if (j.duration?.name) planLines.push(`Doorlooptijd: ${j.duration.name}`);
    if (j.targetDate) planLines.push(`Streefdatum: ${fmtDate(j.targetDate)}`);
    if (planLines.length) out += `\n--- Planning ---\n${planLines.join("\n")}\n`;

    const handleLines = [];
    if (j.operatorGroup?.name) handleLines.push(`Behandelaarsgroep: ${j.operatorGroup.name}`);
    if (j.operator?.name) handleLines.push(`Behandelaar: ${j.operator.name}`);
    if (j.processingStatus?.name) handleLines.push(`Status: ${j.processingStatus.name}`);
    if (handleLines.length) out += `\n--- Afhandeling ---\n${handleLines.join("\n")}\n`;

    if (j.request) out += `\n--- Verzoek ---\n${stripHtml(j.request)}\n`;

    if (Array.isArray(trail) && trail.length) {
      out += "\n--- Acties & Communicatie ---\n";
      for (const e of trail) {
        const who = e.person?.name || e.operator?.name || "Onbekend";
        const txt = (e.plainText || stripHtml(e.memoText) || "").trim();
        if (!txt) continue;
        const invisible = e.invisibleForCaller ? " (onzichtbaar voor aanmelder)" : "";
        out += `\n${who} — ${fmtDate(e.entryDate)}${invisible}\n${txt}\n`;
      }
    }
    return out;
  }

  async function fetchTicket(number) {
    const res = await apiGet(`/tas/api/incidents/number/${encodeURIComponent(number)}`);
    if (res.status !== 200) {
      return { number, ok: false, error: `HTTP ${res.status} bij ophalen van ${number}` };
    }
    const j = await res.json();
    let trail = [];
    try {
      const rt = await apiGet(`/tas/api/incidents/id/${j.id}/progresstrail?inlineimages=false&page_size=100`);
      if (rt.ok) {
        const parsed = await rt.json();
        trail = Array.isArray(parsed) ? parsed : (parsed.results || []);
      } else {
        log("progresstrail faalde:", number, rt.status);
      }
    } catch (err) {
      log("progresstrail error:", number, err);
    }
    return {
      number: j.number,
      ok: true,
      title: j.briefDescription || "",
      uuid: j.id,
      text: formatTicket(j, trail),
    };
  }

  let result;
  try {
    if (request.action === "fetch") {
      const numbers = Array.isArray(request.numbers) ? request.numbers : [];
      const tickets = [];
      const errors = [];
      for (const num of numbers) {
        try {
          const t = await fetchTicket(num);
          if (t.ok) tickets.push(t);
          else errors.push(t.error);
        } catch (err) {
          errors.push(`${num}: ${err.message}`);
        }
      }
      result = { ok: tickets.length > 0, tickets, errors };
    } else {
      const tickets = listOpenTickets();
      result = { ok: true, tickets, key: tickets.map((t) => `${t.number}${t.active ? "*" : ""}`).join("|") };
    }
  } catch (err) {
    result = { ok: false, error: err.message || String(err) };
  }

  window.__topdeskTicketsResult = result;
  return result;
})();
