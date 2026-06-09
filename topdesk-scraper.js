// topdesk-scraper.js
// Extracts ticket data from TOPdesk's iframe-based Mango UI.
// Produces clean, structured output without UI noise.

(function () {
  // ---- Step 1: Find the active ticket iframe ----

  function findTicketDocument() {
    const iframes = document.querySelectorAll("iframe");
    let best = null;
    let bestArea = 0;

    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument;
        if (!doc || !doc.body) continue;
        if (iframe.offsetWidth === 0 || iframe.offsetHeight === 0) continue;

        const area = iframe.offsetWidth * iframe.offsetHeight;
        const h1 = doc.querySelector("h1");
        const text = h1?.textContent || "";

        if (/[A-Z]\d{4}\s*\d{4}/.test(text) && area > bestArea) {
          bestArea = area;
          best = doc;
        }
      } catch (e) {
        continue;
      }
    }

    return best;
  }

  const doc = findTicketDocument();

  if (!doc) {
    return "FOUT: Geen ticket gevonden. Zorg dat je een ticket-detailpagina open hebt in TOPdesk.";
  }

  // ---- Step 2: Extract ticket number and title from H1 ----

  const h1 = doc.querySelector("h1");
  let ticketNumber = "";
  let shortDescription = "";

  if (h1) {
    const divs = h1.querySelectorAll("div");
    if (divs.length >= 2) {
      ticketNumber = divs[0].textContent.trim();
      shortDescription = divs[1].textContent.trim();
    } else {
      const match = h1.textContent.match(/([A-Z]\d{4}\s*\d{4})\s*(.*)/s);
      if (match) {
        ticketNumber = match[1].trim();
        shortDescription = match[2].trim();
      }
    }
  }

  // ---- Step 3: Extract all form field values via label[for] → input/select ----

  const labels = doc.querySelectorAll("label");
  const fieldValues = {};

  labels.forEach((label) => {
    const labelText = label.textContent.trim();
    const forId = label.getAttribute("for");

    if (!forId || !labelText || labelText.length > 50) return;

    const target = doc.getElementById(forId);
    if (!target) return;

    let value = null;
    if (target.tagName === "SELECT") {
      value = target.options?.[target.selectedIndex]?.text;
    } else if (target.tagName === "INPUT") {
      value = target.value;
    } else if (target.tagName === "TEXTAREA") {
      value = target.value;
    }

    if (value && value.trim()) {
      fieldValues[labelText] = value.trim();
    }
  });

  // ---- Step 4: Extract caller/aanmelder info ----

  let callerName = "";
  let callerEmail = "";
  let callerDepartment = "";
  let callerOrg = "";

  const fullText = doc.body.innerText;

  // Try to extract caller info from the top section
  const callerBlock = fullText.match(/^[\s\S]*?(?=Planning|Object\/ruimte|Afhandeling)/);
  if (callerBlock) {
    const block = callerBlock[0];
    const emailMatch = block.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    if (emailMatch) callerEmail = emailMatch[1];

    // Try to find organization (usually "Stichting ..." or similar)
    const orgMatch = block.match(/(Stichting\s+[\w\s]+(?:van\s+\w+)?)/);
    if (orgMatch) callerOrg = orgMatch[1].trim();
  }

  // ---- Step 5: Extract actions/communications ----
  // Actions are the core content — messages between behandelaar and aanmelder.
  // They follow the pattern: "Name\ndate time\nContent"
  // We extract them from innerText and filter out noise.

  const actionPattern = /^([\w\s,\-\.]+)\n(?:onzichtbaar voor aanmelder\n)?(\d{1,2}\s\w+\s\d{4}\s\d{1,2}:\d{2})\n([\s\S]*?)(?=(?:^[\w\s,\-\.]+\n(?:onzichtbaar voor aanmelder\n)?\d{1,2}\s\w+\s\d{4}\s\d{1,2}:\d{2}\n)|$)/gm;

  // Simpler approach: split the text to find the actions section
  // Actions typically start after "Verzoek" or after the field labels section

  let actionsText = "";
  const verzoekIndex = fullText.indexOf("Verzoek\n");
  if (verzoekIndex !== -1) {
    actionsText = fullText.substring(verzoekIndex + "Verzoek\n".length);
  } else {
    // Fallback: find first action by date pattern
    const firstActionMatch = fullText.match(/([\w\s,]+\n\d{1,2}\s\w+\s\d{4}\s\d{1,2}:\d{2})/);
    if (firstActionMatch) {
      actionsText = fullText.substring(fullText.indexOf(firstActionMatch[0]));
    }
  }

  // Clean the actions text
  if (actionsText) {
    // Remove trailing metadata
    const cutoffPatterns = [
      /Aangemaakt op \d.*/s,
      /Informatie\nAanmelddatum.*/s,
      /Geregistreerde tijd.*/s,
    ];
    for (const p of cutoffPatterns) {
      actionsText = actionsText.replace(p, "");
    }
  }

  // ---- Step 6: Clean noise from actions ----

  const noiseLines = new Set([
    "Opslaan", "Escaleren", "Aanmaken", "Meer", "Verzoek",
    "ALGEMEEN", "INFORMATIE", "KOPPELINGEN", "SSP",
    "ASSET INFORMATIE", "BIJLAGEN", "TIJDREGISTRATIE",
    "Suggesties kennissysteem", "Delen met anderen", "Paragraaf",
    "Maak onzichtbaar voor aanmelder", "DEELMELDINGEN",
    "Inklappen", "Uitklappen",
    // Standalone field labels that appear in the body
    "Soort", "Planning", "Impact", "Urgentie", "Prioriteit",
    "Doorlooptijd", "Streefdatum", "On hold", "Bewaakt",
    "Afhandeling", "Behandelaarsgroep", "Behandelaar", "Leverancier",
    "Status", "Gereageerd", "Gereed", "Afgemeld", "Bestede tijd",
    "Object/ruimte", "Extern nummer", "Dienst",
    "Storing", "Telefonisch", "E-mail", "Zelfservice Portal",
    "Applicaties", "Teams", "Categorie", "Subcategorie",
    "Korte omschrijving",
  ]);

  // Patterns that match noise lines
  const noisePatterns = [
    /^GESCHIEDENIS\s*\(\d+\)$/,
    /^Acties,\s*E-mailberichten.*$/,
    /^S\d+\..*->\s*.*$/,  // Status changes like "S2.Aanmelden -> Servicedesk"
    /^Aangemaakt op \d.*$/,
    /^Gewijzigd op \d.*$/,
  ];

  function isNoiseLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (noiseLines.has(trimmed)) return true;
    for (const p of noisePatterns) {
      if (p.test(trimmed)) return true;
    }
    return false;
  }

  let cleanedActions = "";
  if (actionsText) {
    const lines = actionsText.split("\n");
    const cleanLines = [];
    let prevWasEmpty = false;

    for (const line of lines) {
      if (isNoiseLine(line)) continue;

      const trimmed = line.trim();

      // Skip duplicate ticket number/description at start
      if (trimmed === ticketNumber || trimmed === shortDescription) continue;

      // Collapse multiple empty lines
      if (!trimmed) {
        if (!prevWasEmpty) cleanLines.push("");
        prevWasEmpty = true;
        continue;
      }

      prevWasEmpty = false;
      cleanLines.push(trimmed);
    }

    cleanedActions = cleanLines.join("\n").trim();
  }

  // ---- Step 7: Build structured output ----

  let output = "=== TOPDESK TICKET ===\n\n";

  // Header
  if (ticketNumber) output += `Ticketnummer: ${ticketNumber}\n`;
  if (shortDescription) output += `Omschrijving: ${shortDescription}\n`;

  // Caller info
  if (callerEmail || callerOrg) {
    output += "\n--- Aanmelder ---\n";
    if (callerEmail) output += `E-mail: ${callerEmail}\n`;
    if (callerOrg) output += `Organisatie: ${callerOrg}\n`;
  }

  // Ticket classification fields
  const classificationFields = ["Soort melding", "Categorie", "Subcategorie"];
  const hasClassification = classificationFields.some((f) => fieldValues[f]);
  if (hasClassification) {
    output += "\n--- Classificatie ---\n";
    for (const field of classificationFields) {
      if (fieldValues[field]) output += `${field}: ${fieldValues[field]}\n`;
    }
  }

  // Planning & priority fields
  const planningFields = [
    "Impact", "Urgentie", "Prioriteit",
    "Doorlooptijd", "Streefdatum", "On hold",
  ];
  const hasPlanningFields = planningFields.some((f) => fieldValues[f]);
  if (hasPlanningFields) {
    output += "\n--- Planning ---\n";
    for (const field of planningFields) {
      if (fieldValues[field]) output += `${field}: ${fieldValues[field]}\n`;
    }
  }

  // Assignment fields
  const assignmentFields = [
    "Behandelaarsgroep", "Behandelaar", "Leverancier", "Status",
  ];
  const hasAssignment = assignmentFields.some((f) => fieldValues[f]);
  if (hasAssignment) {
    output += "\n--- Afhandeling ---\n";
    for (const field of assignmentFields) {
      if (fieldValues[field]) output += `${field}: ${fieldValues[field]}\n`;
    }
  }

  // Any remaining fields not yet covered
  const coveredFields = new Set([
    ...classificationFields, ...planningFields, ...assignmentFields,
    "Bestede tijd", "Bewaakt",
  ]);
  const extraFields = Object.keys(fieldValues).filter(
    (k) => !coveredFields.has(k)
  );
  if (extraFields.length > 0) {
    output += "\n--- Overige velden ---\n";
    for (const field of extraFields) {
      output += `${field}: ${fieldValues[field]}\n`;
    }
  }

  // Actions — the core content
  if (cleanedActions) {
    output += "\n--- Acties & Communicatie ---\n";
    output += cleanedActions;
    output += "\n";
  }

  // Cap at reasonable length
  if (output.length > 50000) {
    output = output.substring(0, 50000) + "\n\n[... afgekapt op 50.000 tekens]";
  }

  return output;
})();
