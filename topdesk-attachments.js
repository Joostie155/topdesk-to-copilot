// topdesk-attachments.js
// On-demand content script for TOPdesk tabs.
// Reads window.__topdeskAttachmentsRequest, calls the TOPdesk REST API with
// session cookies, returns a result object via window.__topdeskAttachmentsResult
// AND as the implicit return value of the IIFE (picked up by executeScript().result).

(() => {
  const THUMB_MAX_SIZE = 500 * 1024;
  const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

  // TOPdesk modules that expose an identical /id/{uuid}/attachments sub-resource.
  // Order matters: we probe in this order until one 200s.
  const MODULES = [
    "incidents",
    "operatorChanges",
    "changes",
    "problems",
    "serviceRequests",
  ];

  /**
   * Mango UI keeps inactive ticket tabs mounted in hidden containers so their
   * iframes stay loaded but `offsetWidth`/`offsetHeight` are 0. We only want
   * to scan the iframe tree belonging to the currently visible ticket.
   */
  function isVisible(el) {
    if (!el) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    const rect = el.getBoundingClientRect?.();
    if (rect && rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  /**
   * Collect UUID candidates from the DOM with priority tiers:
   *   tier 0 — explicit /incidents/id/{uuid} in iframe URL or anchor
   *   tier 1 — ?unid={uuid} on an iframe whose src looks incident-related
   *   tier 2 — ?unid={uuid} elsewhere
   *   tier 3 — any UUID in a ticket-looking attribute (data-unid, data-id)
   *
   * Returns an array of UUIDs, highest priority first, de-duplicated.
   */
  function findTicketUuidCandidates() {
    const tiers = [new Set(), new Set(), new Set(), new Set()];
    const addTier = (n, id) => { if (id) tiers[n].add(id); };

    const extractPath = (str) =>
      (str && str.match(/\/incidents\/id\/([0-9a-f-]{36})/i) || [])[1] || null;
    const extractUnid = (str) =>
      (str && str.match(/[?&]unid=([0-9a-f-]{36})/i) || [])[1] || null;
    const extractAny = (str) =>
      (str && str.match(UUID_RE) || [])[1] || null;

    const iframes = Array.from(document.querySelectorAll("iframe")).filter(isVisible);

    const walk = (frame) => {
      // iframe src attribute itself
      const srcAttr = frame.getAttribute("src") || frame.src || "";
      addTier(0, extractPath(srcAttr));
      const unidFromSrc = extractUnid(srcAttr);
      if (unidFromSrc) {
        const looksIncident =
          /incident|melding|ticket|detail|request/i.test(srcAttr);
        addTier(looksIncident ? 1 : 2, unidFromSrc);
      }

      try {
        const d = frame.contentDocument;
        if (!d) return;

        // iframe's own current location (may differ from initial src)
        try {
          const loc = frame.contentWindow?.location?.href || "";
          addTier(0, extractPath(loc));
          const unidLoc = extractUnid(loc);
          if (unidLoc) {
            const looksIncident = /incident|melding|ticket|detail|request/i.test(loc);
            addTier(looksIncident ? 1 : 2, unidLoc);
          }
        } catch (_) { /* cross-origin */ }

        // Anchors / images pointing at incidents/id/{uuid}
        for (const el of d.querySelectorAll('a[href*="/incidents/id/"], img[src*="/incidents/id/"]')) {
          if (!isVisible(el)) continue;
          addTier(0, extractPath(el.getAttribute("href")) || extractPath(el.getAttribute("src")));
        }

        // ?unid=... on any href/src (visible only)
        for (const el of d.querySelectorAll("[href],[src]")) {
          if (!isVisible(el)) continue;
          const hu = extractUnid(el.getAttribute("href"));
          const su = extractUnid(el.getAttribute("src"));
          if (hu) addTier(2, hu);
          if (su) addTier(2, su);
        }

        // Data attributes (used by newer Mango builds)
        for (const el of d.querySelectorAll("[data-unid],[data-id]")) {
          if (!isVisible(el)) continue;
          addTier(3, extractAny(el.getAttribute("data-unid")));
          addTier(3, extractAny(el.getAttribute("data-id")));
        }

        // Recurse nested iframes (visible only)
        for (const nested of d.querySelectorAll("iframe")) {
          if (isVisible(nested)) walk(nested);
        }
      } catch (_) { /* cross-origin — skip */ }
    };

    for (const f of iframes) walk(f);

    // Top-level document itself
    for (const el of document.querySelectorAll('a[href*="/incidents/id/"], img[src*="/incidents/id/"]')) {
      addTier(0, extractPath(el.getAttribute("href")) || extractPath(el.getAttribute("src")));
    }
    for (const el of document.querySelectorAll("[href],[src]")) {
      const hu = extractUnid(el.getAttribute("href"));
      const su = extractUnid(el.getAttribute("src"));
      if (hu) addTier(2, hu);
      if (su) addTier(2, su);
    }
    addTier(2, extractUnid(window.location.href));

    const out = [];
    const seen = new Set();
    for (const tier of tiers) {
      for (const id of tier) {
        if (!seen.has(id)) { seen.add(id); out.push(id); }
      }
    }
    return out;
  }

  /**
   * Given an ordered list of UUID candidates, probe each against each module's
   * attachments endpoint. Returns { uuid, module, items } for the first UUID
   * that returns 200 + a JSON array. 404 means wrong module or wrong UUID —
   * we move on. Other errors (401/403/5xx) bubble up as the final error.
   */
  async function resolveAttachments(candidates) {
    const origin = location.origin;
    let lastErr = "Geen UUID-kandidaten gevonden";

    for (const uuid of candidates) {
      for (const module of MODULES) {
        const url = `${origin}/tas/api/${module}/id/${uuid}/attachments`;
        try {
          const resp = await fetch(url, {
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          if (resp.status === 404) {
            lastErr = `HTTP 404 voor ${module}/${uuid}`;
            continue;
          }
          if (!resp.ok) {
            lastErr = `HTTP ${resp.status} voor ${module}/${uuid}`;
            continue;
          }
          const items = await resp.json();
          if (!Array.isArray(items)) {
            lastErr = `Onverwachte response van ${module}/${uuid}`;
            continue;
          }
          console.debug(
            `[TOPdesk-attachments] match: ${module}/${uuid} (${items.length} items)`
          );
          return { uuid, module, items };
        } catch (err) {
          lastErr = (err && err.message) || "Fetch failed";
        }
      }
    }
    const err = new Error(lastErr);
    err.candidates = candidates;
    throw err;
  }

  function guessMime(name) {
    const ext = ((name || "").match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || "";
    const map = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
      heic: "image/heic", heif: "image/heif",
      pdf: "application/pdf",
      eml: "message/rfc822", msg: "application/vnd.ms-outlook",
      txt: "text/plain", csv: "text/csv", md: "text/markdown", json: "application/json",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      doc: "application/msword",
      xls: "application/vnd.ms-excel",
      ppt: "application/vnd.ms-powerpoint",
    };
    return map[ext] || "application/octet-stream";
  }

  function isImageName(name) {
    return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i.test(name || "");
  }

  /**
   * Email attachments (and some other file types) bypass the REST attachments
   * endpoint — they're served via /tas/secure/dispatchersecureservlet/{token}/{file}.
   * Walks ONLY visible iframes (Mango keeps inactive tickets mounted but hidden).
   * De-dupes by URL AND by filename, because dispatcher URLs embed per-render
   * tokens — the same file rendered twice gets two distinct URLs.
   */
  function findDomAttachments() {
    const seenUrl = new Set();
    const seenName = new Set();
    const out = [];

    const scan = (root) => {
      const anchors = root.querySelectorAll?.(
        'a[href*="/dispatchersecureservlet/"]'
      );
      if (!anchors) return;
      for (const a of anchors) {
        if (!isVisible(a)) continue;
        const href = a.getAttribute("href");
        if (!href) continue;
        let absolute;
        try {
          absolute = new URL(href, root.baseURI || location.href).href;
        } catch (_) {
          continue;
        }
        if (seenUrl.has(absolute)) continue;

        let fileName = (a.textContent || "").trim();
        if (!fileName || fileName.length > 200) {
          try {
            const pathname = new URL(absolute).pathname;
            fileName = decodeURIComponent(pathname.split("/").pop() || "") || "bijlage";
          } catch (_) {
            fileName = "bijlage";
          }
        }
        if (seenName.has(fileName)) continue;

        seenUrl.add(absolute);
        seenName.add(fileName);
        out.push({ href: absolute, fileName });
      }
    };

    const walk = (frame) => {
      if (!isVisible(frame)) return;
      try {
        const d = frame.contentDocument;
        if (!d) return;
        scan(d);
        for (const nested of d.querySelectorAll("iframe")) walk(nested);
      } catch (_) { /* cross-origin */ }
    };

    scan(document);
    for (const f of document.querySelectorAll("iframe")) walk(f);

    return out;
  }

  /**
   * Inline images pasted into the action feed use yet another URL shape:
   *   /services/internal-tas-proxy/tas/api/incidents/id/{uuid}/images/image-{img-uuid}.jpg
   * The `<img>` `src` embeds that path. The original filename (e.g. the
   * "WhatsApp Image ... .jpeg" the user remembers) is usually on the
   * element itself as alt/title, or in a parent anchor's text.
   */
  function findInlineImages() {
    const seenUrl = new Set();
    const out = [];

    const pickName = (img) => {
      const candidates = [
        img.getAttribute("alt"),
        img.getAttribute("title"),
        img.getAttribute("aria-label"),
        img.getAttribute("data-filename"),
      ];
      const parentA = img.closest("a[download], a[href]");
      if (parentA) {
        const dl = parentA.getAttribute("download");
        if (dl) candidates.push(dl);
        const txt = (parentA.textContent || "").trim();
        if (txt) candidates.push(txt);
      }
      for (const c of candidates) {
        const s = (c || "").trim();
        if (s && s.length <= 200 && /\.[a-z0-9]{2,6}$/i.test(s)) return s;
      }
      // URL basename fallback — ugly but valid
      try {
        const u = new URL(img.src, img.baseURI || location.href);
        return decodeURIComponent(u.pathname.split("/").pop() || "") || "inline-image.jpg";
      } catch (_) {
        return "inline-image.jpg";
      }
    };

    const scan = (root) => {
      const imgs = root.querySelectorAll?.(
        'img[src*="/internal-tas-proxy/"][src*="/images/"]'
      );
      if (!imgs) return;
      for (const img of imgs) {
        if (!isVisible(img)) continue;
        let absolute;
        try {
          absolute = new URL(img.getAttribute("src") || img.src, root.baseURI || location.href).href;
        } catch (_) {
          continue;
        }
        if (seenUrl.has(absolute)) continue;
        seenUrl.add(absolute);
        out.push({ href: absolute, fileName: pickName(img) });
      }
    };

    const walk = (frame) => {
      if (!isVisible(frame)) return;
      try {
        const d = frame.contentDocument;
        if (!d) return;
        scan(d);
        for (const nested of d.querySelectorAll("iframe")) walk(nested);
      } catch (_) { /* cross-origin */ }
    };

    scan(document);
    for (const f of document.querySelectorAll("iframe")) walk(f);

    return out;
  }

  function parseContentDispositionFilename(cd) {
    if (!cd) return null;
    // RFC 5987 style: filename*=UTF-8''encoded%20name.ext
    const star = cd.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
    if (star) {
      try { return decodeURIComponent(star[1].trim()); } catch (_) { /* fall through */ }
    }
    // Classic: filename="foo.ext" or filename=foo.ext
    const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (plain) return plain[1].trim();
    return null;
  }

  async function buildDomAttachmentList(items, startIndex) {
    const out = [];
    let idx = startIndex || 0;
    for (const it of items) {
      const id = `dom:${idx++}`;
      let fileName = it.fileName;
      let size = 0;

      try {
        const head = await fetch(it.href, { method: "HEAD", credentials: "include" });
        if (head.ok) {
          const cl = head.headers.get("Content-Length");
          if (cl) size = parseInt(cl, 10) || 0;
          const cdName = parseContentDispositionFilename(head.headers.get("Content-Disposition"));
          if (cdName && /\.[a-z0-9]{2,6}$/i.test(cdName)) fileName = cdName;
        }
      } catch (_) { /* size/name unknown is OK */ }

      const isImage = isImageName(fileName);
      const mimeType = guessMime(fileName);

      let thumbnail = null;
      if (isImage && size > 0 && size <= THUMB_MAX_SIZE) {
        try {
          const r = await fetch(it.href, { credentials: "include" });
          if (r.ok) {
            const blob = await r.blob();
            thumbnail = await blobToDataUrl(blob);
          }
        } catch (_) { /* non-fatal */ }
      }

      out.push({
        id,
        fileName,
        downloadUrl: it.href,
        size,
        invisibleForCaller: false,
        entryDate: null,
        uploader: null,
        isImage,
        mimeType,
        thumbnail,
      });
    }
    return out;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  async function buildAttachmentList(items) {
    const origin = location.origin;
    const out = [];
    for (const it of items) {
      const id = it.id;
      const fileName = it.fileName || "bijlage";
      const size = typeof it.size === "number" ? it.size : 0;
      const downloadUrl = it.downloadUrl || "";
      const uploader = it.person?.name || it.operator?.name || null;
      const isImage = isImageName(fileName);
      let mimeType = guessMime(fileName);
      let thumbnail = null;

      if (isImage && size > 0 && size <= THUMB_MAX_SIZE && downloadUrl) {
        try {
          const r = await fetch(origin + downloadUrl, { credentials: "include" });
          if (r.ok) {
            const blob = await r.blob();
            if (blob.type) mimeType = blob.type;
            thumbnail = await blobToDataUrl(blob);
          }
        } catch (_) { /* thumb failure is non-fatal */ }
      }

      out.push({
        id, fileName, downloadUrl, size,
        invisibleForCaller: !!it.invisibleForCaller,
        entryDate: it.entryDate || null,
        uploader, isImage, mimeType, thumbnail,
      });
    }
    return out;
  }

  async function downloadAttachments(ids, meta) {
    const origin = location.origin;
    const byId = new Map((meta || []).map((m) => [m.id, m]));
    const out = [];
    for (const id of ids) {
      const m = byId.get(id);
      if (!m) { out.push({ id, name: "?", error: "Geen metadata" }); continue; }
      try {
        const url = m.downloadUrl.startsWith("http")
          ? m.downloadUrl
          : origin + m.downloadUrl;
        const r = await fetch(url, { credentials: "include" });
        if (!r.ok) {
          out.push({ id, name: m.fileName, error: `HTTP ${r.status}` });
          continue;
        }
        const blob = await r.blob();
        const mime = blob.type || m.mimeType || "application/octet-stream";
        const dataUrl = await blobToDataUrl(blob);
        out.push({ id, name: m.fileName, mimeType: mime, size: blob.size, dataUrl });
      } catch (err) {
        out.push({ id, name: m.fileName, error: (err && err.message) || "Fetch failed" });
      }
    }
    return out;
  }

  async function listAll() {
    const candidates = findTicketUuidCandidates();
    console.debug("[TOPdesk-attachments] UUID-kandidaten:", candidates);

    // REST API probe — may return 0 attachments or throw when no UUID works.
    let apiAttachments = [];
    let apiUuid = null;
    let apiModule = null;
    let apiError = null;
    if (candidates.length) {
      try {
        const { uuid, module, items } = await resolveAttachments(candidates);
        apiUuid = uuid;
        apiModule = module;
        apiAttachments = await buildAttachmentList(items);
      } catch (err) {
        apiError = (err && err.message) || "REST-probe mislukt";
        console.debug("[TOPdesk-attachments] REST-probe:", apiError);
      }
    }

    // DOM scan for email/dispatcher attachments (always runs).
    // Mango renders uploaded attachments in the action feed as dispatcher
    // links too, so the same file ends up in both sources — skip DOM entries
    // whose filename already appears in the REST result (API wins: it has
    // size, mime, and thumbnail metadata).
    const apiNames = new Set(apiAttachments.map((a) => a.fileName));
    const domItems = findDomAttachments().filter((it) => !apiNames.has(it.fileName));
    console.debug(
      "[TOPdesk-attachments] DOM-links uniek t.o.v. API:",
      domItems.length
    );
    const domAttachments = domItems.length
      ? await buildDomAttachmentList(domItems, apiAttachments.length)
      : [];

    // Inline images from action feed (internal-tas-proxy URLs). Dedup by URL
    // against what we already have; they won't overlap with the REST API
    // endpoint (the API doesn't list inline images), but a paranoid check
    // on filename guards against Mango occasionally exposing them both ways.
    const takenUrls = new Set([
      ...apiAttachments.map((a) => a.downloadUrl),
      ...domAttachments.map((a) => a.downloadUrl),
    ]);
    const takenNames = new Set([
      ...apiAttachments.map((a) => a.fileName),
      ...domAttachments.map((a) => a.fileName),
    ]);
    const inlineItems = findInlineImages().filter(
      (it) => !takenUrls.has(it.href) && !takenNames.has(it.fileName)
    );
    console.debug(
      "[TOPdesk-attachments] inline images uniek:",
      inlineItems.length
    );
    const inlineAttachments = inlineItems.length
      ? await buildDomAttachmentList(
          inlineItems,
          apiAttachments.length + domAttachments.length
        )
      : [];

    const attachments = [...apiAttachments, ...domAttachments, ...inlineAttachments];
    return { uuid: apiUuid, module: apiModule, attachments, apiError };
  }

  async function run() {
    const req = window.__topdeskAttachmentsRequest || {};
    const action = req.action;

    try {
      if (action === "list") {
        const { uuid, module, attachments, apiError } = await listAll();
        // Synthesise a pseudo-uuid for cache-key purposes when only DOM
        // attachments are found, so popup.js's lastLoadedUuid caching still
        // works (and re-renders when the URL changes).
        const cacheUuid = uuid || `dom:${location.pathname + location.search}`;
        const result = {
          ok: true,
          uuid: cacheUuid,
          module,
          attachments,
          apiError: apiError && !attachments.length ? apiError : undefined,
        };
        window.__topdeskAttachmentsResult = result;
        return result;
      }
      if (action === "download") {
        // meta.downloadUrl already embeds the right module or absolute URL.
        const downloads = await downloadAttachments(req.ids || [], req.meta || []);
        const result = { ok: true, downloads };
        window.__topdeskAttachmentsResult = result;
        return result;
      }
      const result = { ok: false, error: `Onbekende action: ${action}` };
      window.__topdeskAttachmentsResult = result;
      return result;
    } catch (err) {
      const result = { ok: false, error: (err && err.message) || String(err) };
      window.__topdeskAttachmentsResult = result;
      return result;
    }
  }

  return run();
})();
