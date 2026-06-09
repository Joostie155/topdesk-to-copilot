// background.js — TOPdesk → Copilot
const PROMPTS = {
  analyze: "Analyseer dit TOPdesk ticket. Geef een samenvatting, beoordeel de prioriteit, en stel een actieplan voor:",
  reply: "Stel een professioneel en vriendelijk antwoord op voor dit TOPdesk ticket. Houd het bondig en duidelijk:",
  summarize: "Geef een korte samenvatting van dit TOPdesk ticket in 5-10 zinnen:",
  troubleshoot_internet: "Analyseer dit TOPdesk ticket. Het betreft een internet/netwerk probleem. Zoek naar mogelijke oorzaken zoals bekende storingen, Microsoft 365 service health issues, of relevante foutmeldingen. Geef een diagnose en stappen om het probleem op te lossen:",
  troubleshoot_general: "Analyseer dit TOPdesk ticket. Onderzoek het technische probleem en zoek naar mogelijke oorzaken en oplossingen. Geef concrete troubleshooting-stappen die ik als servicedesk medewerker kan uitvoeren:",
  close_reply: "Stel een kort en vriendelijk afsluitbericht op voor dit TOPdesk ticket. De melding is opgelost. Vat samen wat er gedaan is op basis van de acties in het ticket:",
  knowledge: "Maak op basis van dit TOPdesk ticket een kennisartikel. Beschrijf het probleem, de oorzaak, en de oplossing in duidelijke stappen zodat een collega dit zelfstandig kan oplossen:",
  handover: "Schrijf een overdracht-notitie voor dit ticket. Vat het probleem samen, wat er al geprobeerd is, en wat de volgende stappen zijn. Dit is bedoeld voor een collega die het ticket overneemt:",
};

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

const COPILOT_URLS = {
  work: "https://m365.cloud.microsoft/chat/",
  personal: "https://copilot.microsoft.com/",
};

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "scrape-ticket") return;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const url = tab.url || "";
    if (!url.includes("topdesk") && !url.includes("tod.") && !url.includes("localhost")) return;

    const stored = await chrome.storage.local.get(["copilot_selectedPrompt", "copilot_customPromptText", "copilot_extraInputText", "copilot_mode", "copilot_userName", "copilot_promptConfig", "copilot_anonimiseer"]);
    const selectedKey = stored.copilot_selectedPrompt || "analyze";
    let promptText;
    if (selectedKey === "custom") {
      promptText = stored.copilot_customPromptText || "";
    } else {
      // Prefer the user's edited prompt from promptConfig; fall back to hardcoded
      promptText = stored.copilot_promptConfig?.prompts?.[selectedKey]?.text
        || PROMPTS[selectedKey]
        || PROMPTS.analyze;
    }

    if (REPLY_PROMPT_KEYS.has(selectedKey)) {
      promptText = appendSignoff(promptText, stored.copilot_userName);
    }

    const extra = (stored.copilot_extraInputText || "").trim();
    if (extra) {
      promptText = promptText ? `${promptText}\n\nExtra context: ${extra}` : extra;
    }

    const [scrapeResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["topdesk-scraper.js"],
    });

    let ticketText = scrapeResult?.result;
    if (!ticketText || ticketText.startsWith("FOUT:") || ticketText.length < 20) return;

    if (stored.copilot_anonimiseer) ticketText = anonimiseer(ticketText);

    const fullText = promptText ? `${promptText}\n\n${ticketText}` : ticketText;

    await chrome.storage.local.set({
      copilot_pendingTicket: {
        text: fullText,
        timestamp: Date.now(),
        attachments: [],
      },
    });

    // Clipboard fallback
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (text) => navigator.clipboard.writeText(text),
      args: [fullText],
    });

    const mode = stored.copilot_mode || "work";
    const newTab = await chrome.tabs.create({ url: COPILOT_URLS[mode], active: false });
    if (tab.groupId && tab.groupId !== -1) {
      try { await chrome.tabs.group({ tabIds: [newTab.id], groupId: tab.groupId }); } catch {}
    }
    await chrome.tabs.update(newTab.id, { active: true });
  } catch (err) {
    console.error("[TOPdesk→Copilot] Shortcut error:", err);
  }
});
