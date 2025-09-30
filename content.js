// Content script: Monitors text input and displays suggestions

let currentSettings = {
  targetLanguage: 'Spanish',
  apiKey: '',
  enabled: true
};

let analysisTimeout = null;
let activeElement = null;
let suggestionOverlay = null;
let currentAnalysis = null; // Track ongoing analysis
let elementSuggestions = new WeakMap(); // Store all suggestions per element

// Load settings from storage
chrome.storage.sync.get(['targetLanguage', 'apiKey', 'enabled'], (result) => {
  currentSettings = { ...currentSettings, ...result };
});

// Listen for settings changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.targetLanguage) currentSettings.targetLanguage = changes.targetLanguage.newValue;
  if (changes.apiKey) currentSettings.apiKey = changes.apiKey.newValue;
  if (changes.enabled !== undefined) currentSettings.enabled = changes.enabled.newValue;
});

// Create suggestion overlay element
function createSuggestionOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'lang-helper-overlay';
  overlay.className = 'lang-helper-suggestion-tooltip';
  overlay.style.display = 'none';
  document.body.appendChild(overlay);
  return overlay;
}

// Initialize overlay
if (!suggestionOverlay) {
  suggestionOverlay = createSuggestionOverlay();
}

// Track text input elements
function setupTextMonitoring(element) {
  if (element.hasAttribute('data-lang-helper-monitored')) return;
  element.setAttribute('data-lang-helper-monitored', 'true');

  element.addEventListener('input', handleTextInput);
  element.addEventListener('focus', handleFocus);
  element.addEventListener('blur', handleBlur);

  // Analyze existing text immediately if present
  const text = getTextWithLineBreaks(element);
  if (text && text.trim().length >= 10 && currentSettings.enabled && currentSettings.apiKey) {
    setTimeout(() => {
      analyzeText(text, element);
    }, 500); // Small delay to avoid analyzing too many fields at once
  }
}

function handleFocus(event) {
  activeElement = event.target;

  // Check if there's already text in the field and analyze it immediately
  const element = event.target;
  const text = getTextWithLineBreaks(element);

  if (text && text.trim().length >= 10 && currentSettings.enabled && currentSettings.apiKey) {
    analyzeText(text, element);
  }
}

function handleBlur(event) {
  if (activeElement === event.target) {
    activeElement = null;
  }
}

function handleTextInput(event) {
  if (!currentSettings.enabled || !currentSettings.apiKey) {
    return;
  }

  const element = event.target;
  const text = getTextWithLineBreaks(element);

  // Debounce analysis
  clearTimeout(analysisTimeout);
  analysisTimeout = setTimeout(() => {
    analyzeText(text, element);
  }, 1500); // Wait 1.5s after user stops typing
}

async function analyzeText(text, element) {
  if (!text || text.trim().length < 10) {
    return;
  }

  // Check if already analyzing
  if (currentAnalysis) {
    return;
  }

  try {
    currentAnalysis = { text, element };

    // Send to background script for LLM analysis
    const response = await chrome.runtime.sendMessage({
      action: 'analyzeText',
      text: text,
      language: currentSettings.targetLanguage
    });

    if (response && response.suggestions) {
      console.log('[Lang Helper] Received suggestions:', response.suggestions);

      // Store suggestions for this element
      elementSuggestions.set(element, {
        text: text,
        suggestions: response.suggestions,
        timestamp: Date.now()
      });

      displaySuggestions(response.suggestions, element);
    } else if (response && response.error) {
      console.error('[Lang Helper] Analysis error:', response.error);
    }
  } catch (error) {
    console.error('[Lang Helper] Analysis failed:', error);
  } finally {
    currentAnalysis = null;
  }
}

function displaySuggestions(suggestions, element) {
  // Remove previous highlights
  removeHighlights(element);

  if (!suggestions || suggestions.length === 0) return;

  // For contenteditable or input elements, we'll use a wrapper approach
  if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
    createOverlayHighlights(suggestions, element);
  } else if (element.isContentEditable) {
    createInlineHighlights(suggestions, element);
  }
}

function createOverlayHighlights(suggestions, element) {
  // Create a positioned overlay that shows highlights over the textarea
  const wrapper = getOrCreateWrapper(element);
  const highlightLayer = wrapper.querySelector('.lang-helper-highlights');

  const text = element.value;
  let highlightedHTML = escapeHtml(text);

  // Sort suggestions by position (reverse order to replace from end to start)
  const sortedSuggestions = [...suggestions].sort((a, b) => b.start - a.start);

  sortedSuggestions.forEach((suggestion, index) => {
    const before = highlightedHTML.substring(0, suggestion.start);
    const highlighted = highlightedHTML.substring(suggestion.start, suggestion.end);
    const after = highlightedHTML.substring(suggestion.end);

    highlightedHTML = before +
      `<span class="lang-helper-highlight" data-suggestion-id="${index}" data-severity="${suggestion.severity || 'info'}">${highlighted}</span>` +
      after;
  });

  highlightLayer.innerHTML = highlightedHTML;

  // Store suggestions on the element for later retrieval
  element.setAttribute('data-suggestions', JSON.stringify(suggestions));

  // Add hover listeners
  highlightLayer.querySelectorAll('.lang-helper-highlight').forEach(span => {
    span.addEventListener('mouseenter', handleHighlightHover);
    span.addEventListener('mouseleave', hideTooltip);
  });
}

function createInlineHighlights(suggestions, element) {
  // Store suggestions on the element
  element.setAttribute('data-suggestions', JSON.stringify(suggestions));

  // Get the text content with line breaks preserved
  const text = getTextWithLineBreaks(element);

  // Create positioned overlay with underlines
  createPositionedOverlay(suggestions, element, text);
}

function getTextWithLineBreaks(element) {
  // For textarea/input, use value
  if (element.value !== undefined) {
    return element.value;
  }

  // For contenteditable, innerText handles line breaks correctly
  return element.innerText || element.textContent || '';
}

function handleHighlightHover(event) {
  const span = event.target;
  const suggestionId = parseInt(span.getAttribute('data-suggestion-id'));
  const element = span.closest('[data-suggestions]') || activeElement;

  if (!element) return;

  const suggestions = JSON.parse(element.getAttribute('data-suggestions') || '[]');
  const suggestion = suggestions[suggestionId];

  if (suggestion) {
    showTooltip(suggestion, span);
  }
}

function showTooltip(suggestion, targetElement) {
  if (!suggestionOverlay) return;

  const rect = targetElement.getBoundingClientRect();

  suggestionOverlay.innerHTML = `
    <div class="lang-helper-tooltip-content">
      <div class="lang-helper-tooltip-header">${getSeverityLabel(suggestion.severity)}</div>
      <div class="lang-helper-tooltip-message">${escapeHtml(suggestion.message)}</div>
      ${suggestion.correction ? `<div class="lang-helper-tooltip-suggestion"><strong>Suggestion:</strong> <span style="color: #2e7d32; font-weight: 600;">${escapeHtml(suggestion.correction)}</span></div>` : ''}
      ${suggestion.explanation ? `<div class="lang-helper-tooltip-explanation">${escapeHtml(suggestion.explanation)}</div>` : ''}
    </div>
  `;

  suggestionOverlay.style.display = 'block';

  // Position below the underlined text
  const left = Math.min(rect.left, window.innerWidth - 340); // Keep within viewport
  const top = rect.bottom + window.scrollY + 5;

  suggestionOverlay.style.left = left + 'px';
  suggestionOverlay.style.top = top + 'px';
}

function hideTooltip() {
  if (suggestionOverlay) {
    suggestionOverlay.style.display = 'none';
  }
}

function showSuggestionsPanel(suggestions, element) {
  console.log('[Lang Helper] Showing suggestions panel with', suggestions.length, 'items');

  // Remove any existing panel
  const existingPanel = document.getElementById('lang-helper-suggestions-panel');
  if (existingPanel) {
    existingPanel.remove();
  }

  // Create panel
  const panel = document.createElement('div');
  panel.id = 'lang-helper-suggestions-panel';
  panel.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    max-width: 400px;
    max-height: 500px;
    overflow-y: auto;
    background: white;
    border: 2px solid #4285f4;
    border-radius: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
  `;

  // Header
  const header = document.createElement('div');
  header.style.cssText = `
    background: linear-gradient(135deg, #4285f4, #34a853);
    color: white;
    padding: 12px 16px;
    font-weight: 600;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-radius: 10px 10px 0 0;
  `;
  header.innerHTML = `
    <span>✨ ${suggestions.length} Suggestion${suggestions.length !== 1 ? 's' : ''}</span>
    <button id="lang-helper-close-panel" style="background: none; border: none; color: white; cursor: pointer; font-size: 20px; padding: 0; width: 24px; height: 24px;">×</button>
  `;

  panel.appendChild(header);

  // Content
  const content = document.createElement('div');
  content.style.cssText = `padding: 16px;`;

  suggestions.forEach((suggestion, index) => {
    const item = document.createElement('div');
    item.style.cssText = `
      margin-bottom: 16px;
      padding: 12px;
      background: #f8f9fa;
      border-radius: 8px;
      border-left: 4px solid ${getSeverityColor(suggestion.severity)};
    `;

    const text = element.value || element.textContent || element.innerText || '';
    const problematicText = text.substring(suggestion.start, suggestion.end);

    item.innerHTML = `
      <div style="display: flex; align-items: center; margin-bottom: 8px;">
        <span style="font-size: 12px; font-weight: 600; text-transform: uppercase; color: #666;">${getSeverityLabel(suggestion.severity)}</span>
      </div>
      <div style="margin-bottom: 8px;">
        <span style="background: #ffebee; padding: 2px 6px; border-radius: 4px; text-decoration: line-through; color: #c62828;">${escapeHtml(problematicText)}</span>
        ${suggestion.correction ? `<span style="margin: 0 8px;">→</span><span style="background: #e8f5e9; padding: 2px 6px; border-radius: 4px; color: #2e7d32; font-weight: 500;">${escapeHtml(suggestion.correction)}</span>` : ''}
      </div>
      <div style="color: #555; font-size: 13px; margin-bottom: 4px;">${escapeHtml(suggestion.message)}</div>
      ${suggestion.explanation ? `<div style="color: #777; font-size: 12px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #ddd;">${escapeHtml(suggestion.explanation)}</div>` : ''}
    `;

    content.appendChild(item);
  });

  panel.appendChild(content);
  document.body.appendChild(panel);

  // Close button handler
  document.getElementById('lang-helper-close-panel').addEventListener('click', () => {
    panel.remove();
  });

  // Auto-close after 30 seconds
  setTimeout(() => {
    if (panel.parentNode) {
      panel.remove();
    }
  }, 30000);
}

function getSeverityColor(severity) {
  const colors = {
    error: '#dc3545',
    warning: '#ffc107',
    info: '#17a2b8',
    style: '#6c757d'
  };
  return colors[severity] || '#17a2b8';
}

function createSuggestionsSidebar(suggestions, element, text) {
  console.log('[Lang Helper] Creating suggestions sidebar');

  // Remove existing sidebar
  const existingSidebar = document.getElementById('lang-helper-sidebar');
  if (existingSidebar) {
    existingSidebar.remove();
  }

  // Create compact sidebar
  const sidebar = document.createElement('div');
  sidebar.id = 'lang-helper-sidebar';
  sidebar.style.cssText = `
    position: fixed;
    right: 20px;
    top: 50%;
    transform: translateY(-50%);
    max-width: 350px;
    max-height: 80vh;
    overflow-y: auto;
    background: white;
    border: 2px solid #4285f4;
    border-radius: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    z-index: 999999;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
  `;

  // Header
  const header = document.createElement('div');
  header.style.cssText = `
    background: linear-gradient(135deg, #4285f4, #34a853);
    color: white;
    padding: 10px 12px;
    font-weight: 600;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-radius: 10px 10px 0 0;
    font-size: 14px;
  `;
  header.innerHTML = `
    <span>✨ ${suggestions.length} Issue${suggestions.length !== 1 ? 's' : ''}</span>
    <button id="lang-helper-close-sidebar" style="background: none; border: none; color: white; cursor: pointer; font-size: 18px; padding: 0; width: 20px; height: 20px; line-height: 20px;">×</button>
  `;

  sidebar.appendChild(header);

  // Content
  const content = document.createElement('div');
  content.style.cssText = `padding: 12px;`;

  suggestions.forEach((suggestion, index) => {
    const item = document.createElement('div');
    item.style.cssText = `
      margin-bottom: 12px;
      padding: 10px;
      background: #f8f9fa;
      border-radius: 6px;
      border-left: 3px solid ${getSeverityColor(suggestion.severity)};
      cursor: pointer;
      transition: background 0.2s;
    `;

    item.addEventListener('mouseenter', () => {
      item.style.background = '#e9ecef';
    });

    item.addEventListener('mouseleave', () => {
      item.style.background = '#f8f9fa';
    });

    const problematicText = text.substring(suggestion.start, suggestion.end);

    item.innerHTML = `
      <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: #666; margin-bottom: 6px;">
        ${getSeverityIcon(suggestion.severity)} ${suggestion.severity}
      </div>
      <div style="margin-bottom: 6px;">
        <span style="background: #ffebee; padding: 2px 5px; border-radius: 3px; text-decoration: line-through; color: #c62828; font-size: 12px;">${escapeHtml(problematicText)}</span>
        ${suggestion.correction ? `<span style="margin: 0 6px; color: #666;">→</span><span style="background: #e8f5e9; padding: 2px 5px; border-radius: 3px; color: #2e7d32; font-weight: 600; font-size: 12px;">${escapeHtml(suggestion.correction)}</span>` : ''}
      </div>
      <div style="color: #555; font-size: 12px; line-height: 1.4;">${escapeHtml(suggestion.message)}</div>
      ${suggestion.explanation ? `<div style="color: #777; font-size: 11px; margin-top: 6px; padding-top: 6px; border-top: 1px solid #ddd; line-height: 1.4;">${escapeHtml(suggestion.explanation)}</div>` : ''}
    `;

    content.appendChild(item);
  });

  sidebar.appendChild(content);
  document.body.appendChild(sidebar);

  // Close button handler
  document.getElementById('lang-helper-close-sidebar').addEventListener('click', () => {
    sidebar.remove();
  });

  // Auto-close when clicking outside
  const closeOnClickOutside = (e) => {
    if (!sidebar.contains(e.target)) {
      sidebar.remove();
      document.removeEventListener('click', closeOnClickOutside);
    }
  };
  setTimeout(() => {
    document.addEventListener('click', closeOnClickOutside);
  }, 100);
}

function getSeverityIcon(severity) {
  const icons = {
    error: '❌',
    warning: '⚠️',
    info: 'ℹ️',
    style: '✨'
  };
  return icons[severity] || 'ℹ️';
}

function createPositionedOverlay(suggestions, element, text) {

  // Remove existing overlay
  const existingOverlay = document.getElementById('lang-helper-content-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }

  // Create overlay container that sits on top of the element
  const overlay = document.createElement('div');
  overlay.id = 'lang-helper-content-overlay';

  // Position it over the element
  const rect = element.getBoundingClientRect();
  const computedStyle = window.getComputedStyle(element);

  // Copy ALL relevant styles to match exactly
  overlay.style.position = 'absolute';
  overlay.style.left = rect.left + window.scrollX + 'px';
  overlay.style.top = rect.top + window.scrollY + 'px';
  overlay.style.width = rect.width + 'px';
  overlay.style.height = rect.height + 'px';
  overlay.style.padding = computedStyle.padding;
  overlay.style.margin = computedStyle.margin;
  overlay.style.border = computedStyle.border;
  overlay.style.fontSize = computedStyle.fontSize;
  overlay.style.fontFamily = computedStyle.fontFamily;
  overlay.style.fontWeight = computedStyle.fontWeight;
  overlay.style.lineHeight = computedStyle.lineHeight;
  overlay.style.letterSpacing = computedStyle.letterSpacing;
  overlay.style.wordSpacing = computedStyle.wordSpacing;
  overlay.style.textAlign = computedStyle.textAlign;
  overlay.style.whiteSpace = computedStyle.whiteSpace;
  overlay.style.wordWrap = computedStyle.wordWrap;
  overlay.style.overflowWrap = computedStyle.overflowWrap;
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '9999';
  overlay.style.color = 'transparent'; // Make text invisible
  overlay.style.overflow = 'hidden';
  overlay.style.boxSizing = computedStyle.boxSizing;

  // Build HTML with highlights
  let html = '';
  let lastIndex = 0;

  // Sort suggestions by start position
  const sortedSuggestions = [...suggestions].sort((a, b) => a.start - b.start);

  sortedSuggestions.forEach((suggestion, index) => {
    // Add text before highlight (invisible, with line breaks)
    html += `<span style="color: transparent;">${escapeHtmlWithBreaks(text.substring(lastIndex, suggestion.start))}</span>`;

    // Add highlighted text with visible underline
    const highlightedText = text.substring(suggestion.start, suggestion.end);
    // Store the actual suggestion data as JSON in the element
    const suggestionData = JSON.stringify(suggestion);
    html += `<mark class="lang-helper-mark" data-suggestion='${suggestionData.replace(/'/g, "&apos;")}' data-severity="${suggestion.severity}" style="
      background: transparent;
      color: transparent;
      cursor: pointer;
      pointer-events: auto;
      padding: 0;
      margin: 0;
      text-decoration: none;
    ">${escapeHtmlWithBreaks(highlightedText)}</mark>`;

    lastIndex = suggestion.end;
  });

  // Add remaining text (invisible, with line breaks)
  html += `<span style="color: transparent;">${escapeHtmlWithBreaks(text.substring(lastIndex))}</span>`;

  overlay.innerHTML = html;
  document.body.appendChild(overlay);

  // Add hover listeners to marks
  overlay.querySelectorAll('.lang-helper-mark').forEach(mark => {
    mark.addEventListener('mouseenter', (e) => {
      const suggestionData = e.target.getAttribute('data-suggestion');
      const suggestion = JSON.parse(suggestionData);
      if (suggestion) {
        showTooltip(suggestion, e.target);
      }
    });
    mark.addEventListener('mouseleave', hideTooltip);
  });

  // Update overlay position when scrolling or resizing
  const updatePosition = () => {
    const newRect = element.getBoundingClientRect();

    // Check if element is still visible on screen
    if (newRect.top < -100 || newRect.bottom > window.innerHeight + 100) {
      // Element scrolled off screen, hide overlay
      overlay.style.display = 'none';
    } else {
      overlay.style.display = 'block';
      overlay.style.left = newRect.left + window.scrollX + 'px';
      overlay.style.top = newRect.top + window.scrollY + 'px';
      overlay.style.width = newRect.width + 'px';
      overlay.style.height = newRect.height + 'px';
    }
  };

  const scrollListener = () => updatePosition();
  const resizeListener = () => updatePosition();

  window.addEventListener('scroll', scrollListener, true);
  window.addEventListener('resize', resizeListener);

  // Clean up when typing starts again (not on blur, that's too aggressive)
  const cleanup = () => {
    if (overlay && overlay.parentNode) {
      overlay.remove();
    }
    window.removeEventListener('scroll', scrollListener, true);
    window.removeEventListener('resize', resizeListener);
  };

  // Only clean up when user starts typing again, not on blur
  element.addEventListener('input', cleanup, { once: true });

  // Store cleanup function
  element.setAttribute('data-overlay-id', 'lang-helper-content-overlay');
  element._overlayCleanup = cleanup;
}

function getSeverityLabel(severity) {
  const labels = {
    error: '❌ Error',
    warning: '⚠️ Warning',
    info: 'ℹ️ Suggestion',
    style: '✨ Style'
  };
  return labels[severity] || 'ℹ️ Suggestion';
}

function removeHighlights(element) {
  // Remove wrapper highlights
  const wrapper = element.parentElement?.classList.contains('lang-helper-wrapper')
    ? element.parentElement
    : null;

  if (wrapper) {
    const highlightLayer = wrapper.querySelector('.lang-helper-highlights');
    if (highlightLayer) highlightLayer.innerHTML = '';
  }

  // Remove inline highlights
  element.querySelectorAll('.lang-helper-inline').forEach(span => {
    const parent = span.parentNode;
    while (span.firstChild) {
      parent.insertBefore(span.firstChild, span);
    }
    parent.removeChild(span);
  });

  element.removeAttribute('data-suggestions');
}

function getOrCreateWrapper(element) {
  let wrapper = element.parentElement;

  if (!wrapper || !wrapper.classList.contains('lang-helper-wrapper')) {
    wrapper = document.createElement('div');
    wrapper.className = 'lang-helper-wrapper';

    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'lang-helper-highlights';

    element.parentNode.insertBefore(wrapper, element);
    wrapper.appendChild(highlightLayer);
    wrapper.appendChild(element);

    // Copy styles
    syncWrapperStyles(element, wrapper, highlightLayer);
  }

  return wrapper;
}

function syncWrapperStyles(element, wrapper, highlightLayer) {
  const computed = window.getComputedStyle(element);

  wrapper.style.position = 'relative';
  wrapper.style.display = 'inline-block';
  wrapper.style.width = computed.width;

  highlightLayer.style.position = 'absolute';
  highlightLayer.style.top = '0';
  highlightLayer.style.left = '0';
  highlightLayer.style.width = '100%';
  highlightLayer.style.height = '100%';
  highlightLayer.style.pointerEvents = 'none';
  highlightLayer.style.whiteSpace = 'pre-wrap';
  highlightLayer.style.wordWrap = 'break-word';
  highlightLayer.style.overflow = 'hidden';
  highlightLayer.style.padding = computed.padding;
  highlightLayer.style.border = computed.border;
  highlightLayer.style.font = computed.font;
  highlightLayer.style.lineHeight = computed.lineHeight;
}

function findTextNode(element, start, end) {
  let currentPos = 0;

  function traverse(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent.length;
      if (currentPos + length >= start && currentPos <= end) {
        return {
          node: node,
          startOffset: Math.max(0, start - currentPos),
          endOffset: Math.min(length, end - currentPos)
        };
      }
      currentPos += length;
    } else {
      for (let child of node.childNodes) {
        const result = traverse(child);
        if (result) return result;
      }
    }
    return null;
  }

  return traverse(element);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeHtmlWithBreaks(text) {
  const div = document.createElement('div');
  div.textContent = text;
  // Replace newlines with <br> tags
  return div.innerHTML.replace(/\n/g, '<br>');
}

// Monitor all text inputs on the page
function monitorPage() {
  // Include Gmail compose fields and other contenteditable divs
  const textElements = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [role="textbox"]');
  console.log('[Lang Helper] Found', textElements.length, 'text elements to monitor');
  textElements.forEach(setupTextMonitoring);
}

// Initial setup
monitorPage();

// Watch for dynamically added elements
const observer = new MutationObserver((mutations) => {
  monitorPage();
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});
