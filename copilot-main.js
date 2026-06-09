// copilot-main.js
// Runs in the PAGE's main world (injected by copilot-paste.js).
// Reads ticket text from a hidden DOM element, then uses the Lexical editor
// API to paste with proper line breaks and formatting.

(function () {
  var dataEl = document.getElementById('__topdesk_copilot_data');
  if (!dataEl) {
    console.warn('[TOPdesk→Copilot] Data element niet gevonden.');
    return;
  }

  var text = dataEl.textContent;
  dataEl.remove();

  if (!text) return;

  var selectors = [
    '#m365-chat-editor-target-element',
    'span[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
  ];

  var input = null;
  for (var s = 0; s < selectors.length; s++) {
    var el = document.querySelector(selectors[s]);
    if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
      input = el;
      break;
    }
  }

  if (!input) {
    console.warn('[TOPdesk→Copilot] Input element niet gevonden in main world.');
    return;
  }

  var editor = input.__lexicalEditor;
  if (!editor || !editor._nodes) {
    console.warn('[TOPdesk→Copilot] Lexical editor niet gevonden, fallback naar insertText.');
    input.focus();
    document.execCommand('insertText', false, text);
    return;
  }

  var TextNode = editor._nodes.get('text') && editor._nodes.get('text').klass;
  var LineBreakNode = editor._nodes.get('linebreak') && editor._nodes.get('linebreak').klass;
  var ParagraphNode = editor._nodes.get('paragraph') && editor._nodes.get('paragraph').klass;

  if (!TextNode || !LineBreakNode || !ParagraphNode) {
    console.warn('[TOPdesk→Copilot] Lexical node classes niet gevonden, fallback.');
    input.focus();
    document.execCommand('insertText', false, text);
    return;
  }

  try {
    editor.update(function () {
      var root = editor.getEditorState()._nodeMap.get('root');
      root.clear();

      var para = new ParagraphNode();
      var lines = text.split('\n');

      for (var i = 0; i < lines.length; i++) {
        if (i > 0) {
          para.append(new LineBreakNode());
        }
        if (lines[i].length > 0) {
          para.append(new TextNode(lines[i]));
        }
      }

      root.append(para);
    });
    console.log('[TOPdesk→Copilot] Ticket geplakt via Lexical API!');
  } catch (e) {
    console.error('[TOPdesk→Copilot] Lexical update fout:', e);
    input.focus();
    document.execCommand('insertText', false, text);
  }
})();
