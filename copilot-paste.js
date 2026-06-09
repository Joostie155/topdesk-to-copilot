// copilot-paste.js
// Content script (isolated world) for M365 Work Copilot.
// Reads pending ticket from chrome.storage, uploads any selected TOPdesk
// attachments via the hidden #upload-file-button, then injects copilot-main.js
// into the page's main world to paste the text via the Lexical API.

(function () {
  const MAX_ATTEMPTS = 60;
  const POLL_INTERVAL = 500;
  const PENDING_TIMEOUT_MS = 120000;
  let attempts = 0;

  function checkForPendingTicket() {
    chrome.storage.local.get(["copilot_pendingTicket", "copilot_autoSubmit"], (result) => {
      if (result.copilot_pendingTicket) {
        const { text, timestamp, attachments } = result.copilot_pendingTicket;

        if (Date.now() - timestamp > PENDING_TIMEOUT_MS) {
          chrome.storage.local.remove("copilot_pendingTicket");
          return;
        }

        // Auto-submit is opt-out: on unless the user explicitly turned it off.
        const autoSubmit = result.copilot_autoSubmit !== false;
        tryPaste(text, Array.isArray(attachments) ? attachments : [], autoSubmit);
      }
    });
  }

  function findInputElement() {
    const selectors = [
      '#m365-chat-editor-target-element',
      'span[contenteditable="true"][role="textbox"]',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea',
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
        return el;
      }
    }

    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.shadowRoot) {
        for (const sel of selectors) {
          const found = el.shadowRoot.querySelector(sel);
          if (found && found.offsetWidth > 0) return found;
        }
      }
    }

    return null;
  }

  function findFileInput() {
    return (
      document.getElementById("upload-file-button") ||
      document.querySelector('input[type="file"][multiple]') ||
      document.querySelector('input[type="file"]')
    );
  }

  function dataUrlToFile(dataUrl, fileName, mimeType) {
    try {
      const comma = dataUrl.indexOf(",");
      if (comma === -1) return null;
      const header = dataUrl.substring(0, comma);
      const data = dataUrl.substring(comma + 1);
      const mime = mimeType || (header.match(/:([^;]+)/)?.[1] || "application/octet-stream");
      const bstr = atob(data);
      const u8 = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
      return new File([u8], fileName, { type: mime });
    } catch (err) {
      console.warn("[TOPdesk→Copilot] dataUrlToFile faalde voor", fileName, err);
      return null;
    }
  }

  function uploadFiles(fileInput, attachments) {
    const dt = new DataTransfer();
    let count = 0;
    for (const att of attachments) {
      if (!att?.dataUrl || !att?.name) continue;
      const file = dataUrlToFile(att.dataUrl, att.name, att.mimeType);
      if (file) { dt.items.add(file); count++; }
    }
    if (!count) return 0;
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    return count;
  }

  /**
   * Store text in a hidden DOM element, then inject copilot-main.js
   * into the page's main world where it can access __lexicalEditor.
   */
  function injectAndPaste(text, onDone) {
    let dataEl = document.getElementById('__topdesk_copilot_data');
    if (dataEl) dataEl.remove();

    dataEl = document.createElement('div');
    dataEl.id = '__topdesk_copilot_data';
    dataEl.style.display = 'none';
    dataEl.textContent = text;
    document.documentElement.appendChild(dataEl);

    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('copilot-main.js');
    script.onload = function () {
      script.remove();
      if (onDone) onDone();
    };
    script.onerror = function () {
      script.remove();
      dataEl.remove();
      console.warn('[TOPdesk→Copilot] Main script laden mislukt, fallback naar insertText.');
      const input = findInputElement();
      if (input) {
        input.focus();
        document.execCommand('insertText', false, text);
      }
      if (onDone) onDone();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  /**
   * Auto-submit: once the prompt (and any attachments) are in the composer,
   * send it without the user pressing Enter. Polls for an *enabled* send
   * button — which also waits out attachment uploads, since the button stays
   * disabled while files are still uploading. Falls back to an Enter keypress
   * when no recognizable send button can be found.
   */
  function submitPrompt(editorEl, hasAttachments) {
    const MAX_TICKS = 60;
    const TICK_INTERVAL = 500;
    const initialDelay = hasAttachments ? 1500 : 250;
    const enterFallbackTick = hasAttachments ? 30 : 4;
    let tick = 0;
    let sawButton = false;

    // M365 Copilot's send button is `button.fai-SendButton` (a Fluent UI v9
    // `fui-Button` with aria-label/title "Send"). The class is the most precise
    // and language-independent match; aria-label/title cover other UI languages
    // and survive a class rename.
    const SEND_SELECTORS = [
      'button.fai-SendButton',
      'button.fai-ChatInput__send',
      'button[aria-label*="send" i]',
      'button[aria-label*="verzend" i]',
      'button[aria-label*="verstuur" i]',
      'button[title*="send" i]',
      'button[title*="verzend" i]',
    ];

    function isVisible(el) {
      return !!el && el.offsetWidth > 0 && el.offsetHeight > 0;
    }

    function isDisabled(btn) {
      return btn.disabled ||
        btn.getAttribute('aria-disabled') === 'true' ||
        btn.dataset.isFocusable === 'false';
    }

    function findSendButton() {
      // Walk up from the editor so the closest composer button wins over any
      // unrelated "send" button elsewhere on the page.
      let scope = editorEl;
      for (let i = 0; i < 12 && scope; i++) {
        for (const sel of SEND_SELECTORS) {
          const btn = scope.querySelector(sel);
          if (isVisible(btn)) return btn;
        }
        scope = scope.parentElement;
      }
      for (const sel of SEND_SELECTORS) {
        const btn = document.querySelector(sel);
        if (isVisible(btn)) return btn;
      }
      return null;
    }

    function enterEvent(type) {
      const ev = new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
      });
      // keyCode/which are ignored by the constructor — define them so handlers
      // that still read the legacy properties also see Enter.
      try {
        Object.defineProperty(ev, 'keyCode', { get: () => 13 });
        Object.defineProperty(ev, 'which', { get: () => 13 });
      } catch (e) {}
      return ev;
    }

    function pressEnter() {
      const el = findInputElement() || editorEl;
      if (!el) return;
      el.focus();
      el.dispatchEvent(enterEvent('keydown'));
      el.dispatchEvent(enterEvent('keypress'));
      el.dispatchEvent(enterEvent('keyup'));
    }

    function attempt() {
      tick++;
      const btn = findSendButton();
      if (btn) {
        sawButton = true;
        if (!isDisabled(btn)) {
          btn.click();
          console.log('[TOPdesk→Copilot] Prompt automatisch verstuurd (verzendknop).');
          return;
        }
      } else if (!sawButton && tick >= enterFallbackTick) {
        pressEnter();
        console.log('[TOPdesk→Copilot] Prompt automatisch verstuurd (Enter).');
        return;
      }
      if (tick < MAX_TICKS) {
        setTimeout(attempt, TICK_INTERVAL);
      } else {
        pressEnter();
        console.warn('[TOPdesk→Copilot] Verzendknop bleef inactief — Enter als laatste poging.');
      }
    }

    setTimeout(attempt, initialDelay);
  }

  function tryPaste(text, attachments, autoSubmit) {
    const input = findInputElement();

    if (input) {
      let uploadedCount = 0;
      if (attachments.length) {
        const fileInput = findFileInput();
        if (fileInput) {
          uploadedCount = uploadFiles(fileInput, attachments);
          if (uploadedCount) {
            console.log(`[TOPdesk→Copilot] ${uploadedCount} bijlage${uploadedCount === 1 ? "" : "n"} geüpload.`);
          }
        } else {
          console.warn("[TOPdesk→Copilot] #upload-file-button niet gevonden — ga door zonder bijlagen.");
        }
      }

      const hasAttachments = uploadedCount > 0;

      const pasteText = () => {
        if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          )?.set;

          if (nativeSetter) {
            nativeSetter.call(input, text);
          } else {
            input.value = text;
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          if (autoSubmit) submitPrompt(input, hasAttachments);
        } else {
          injectAndPaste(text, () => {
            if (autoSubmit) submitPrompt(input, hasAttachments);
          });
        }
      };

      if (hasAttachments) {
        setTimeout(pasteText, 400);
      } else {
        pasteText();
      }

      chrome.storage.local.remove("copilot_pendingTicket");
      return;
    }

    attempts++;
    if (attempts < MAX_ATTEMPTS) {
      setTimeout(() => tryPaste(text, attachments, autoSubmit), POLL_INTERVAL);
    } else {
      console.warn("[TOPdesk→Copilot] Input niet gevonden na max pogingen. Gebruik Ctrl+V / ⌘V.");
      chrome.storage.local.remove("copilot_pendingTicket");
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "PASTE_TICKET") {
      tryPaste(
        message.text,
        Array.isArray(message.attachments) ? message.attachments : [],
        message.autoSubmit !== false
      );
      sendResponse({ success: true });
    }
    return true;
  });

  setTimeout(checkForPendingTicket, 1500);
})();
