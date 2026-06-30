# Changelog

Alle noemenswaardige wijzigingen aan deze extensie staan in dit
bestand. Het format volgt [Keep a Changelog](https://keepachangelog.com/nl/1.1.0/)
en deze extensie volgt [Semantic Versioning](https://semver.org/lang/nl/).

## [1.7.1] — 2026-06-30

### Toegevoegd
- Versienummer in de footer van de popup (uitgelezen uit het manifest,
  één bron van waarheid).
- "Over deze extensie"-blok in Instellingen → Algemeen met links naar de
  broncode op GitHub en de Chrome Web Store.

### Opgelost
- Te grote bijlagen veroorzaakten een onleesbare
  `Resource::kQuotaBytes quota exceeded`-fout. Er is nu een cumulatieve
  opslagcontrole vóór het scrapen die met een duidelijke melding blokkeert
  zolang de popup nog openstaat, met een terugval naar alleen de
  tickettekst als vangnet.

## [1.7] — 2026-06-09

### Toegevoegd
- Eerste publieke release in de Chrome Web Store (unlisted).
- Automatische verzending van de prompt nadat tekst en bijlagen in
  Copilot klaarstaan (uit te schakelen via Instellingen → Algemeen).

### Functionaliteit van deze release
- Scrape van TOPdesk-tickets (nummer, classificatie, planning,
  acties, communicatie) vanuit Mango UI iframes.
- Bijlagen-selectie per ticket: REST API-uploads, e-mailbijlagen
  via de dispatcher-servlet, en inline-afbeeldingen uit het
  actieveld.
- Plak-flow naar Microsoft 365 Copilot met file-upload en
  Lexical-editor-injectie (two-world content script pattern).
- Configureerbare promptbibliotheek met categorieën, import en
  export.
- Optionele anonimisatie van persoonsgegevens (e-mail, telefoon,
  BSN, namen) in de verstuurde tekst.
- Sneltoets `Ctrl+Shift+X` voor directe scrape zonder popup
  (zonder bijlagen).
