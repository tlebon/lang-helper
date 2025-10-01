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
let activeOverlays = new Map(); // Track element -> overlay mapping for cleanup

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

  // Analyze existing text after a delay to ensure settings are loaded
  setTimeout(() => {
    const text = getTextWithLineBreaks(element);
    if (text && text.trim().length >= 10 && currentSettings.enabled && currentSettings.apiKey) {
      analyzeText(text, element);
    }
  }, 1000); // Delay to ensure settings are loaded
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
      // Store suggestions for this element
      elementSuggestions.set(element, {
        text: text,
        suggestions: response.suggestions,
        timestamp: Date.now()
      });

      displaySuggestions(response.suggestions, element);
    }
  } catch (error) {
    // Silently fail - analysis errors are not critical
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
      ${suggestion.correction ? `
        <div class="lang-helper-tooltip-suggestion">
          <strong>Suggestion:</strong> <span style="color: #2e7d32; font-weight: 600;">${escapeHtml(suggestion.correction)}</span>
        </div>
        <button class="lang-helper-replace-btn" data-suggestion='${JSON.stringify(suggestion).replace(/'/g, "&apos;")}' style="
          margin-top: 8px;
          padding: 6px 12px;
          background: #2e7d32;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
        ">Replace</button>
      ` : ''}
      ${suggestion.explanation ? `<div class="lang-helper-tooltip-explanation">${escapeHtml(suggestion.explanation)}</div>` : ''}
    </div>
  `;

  suggestionOverlay.style.display = 'block';

  // Position below the underlined text
  const left = Math.min(rect.left, window.innerWidth - 340); // Keep within viewport
  const top = rect.bottom + window.scrollY + 5;

  suggestionOverlay.style.left = left + 'px';
  suggestionOverlay.style.top = top + 'px';

  // Add click handler for replace button
  const replaceBtn = suggestionOverlay.querySelector('.lang-helper-replace-btn');
  if (replaceBtn) {
    replaceBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const suggestionData = JSON.parse(replaceBtn.getAttribute('data-suggestion'));
      applySuggestion(suggestionData, targetElement);
      hideTooltip();
    });
  }
}

function hideTooltip() {
  if (suggestionOverlay) {
    suggestionOverlay.style.display = 'none';
  }
}

function applySuggestion(suggestion, markElement) {
  // Find the element being monitored (traverse up from the mark to find the overlay, then get the original element)
  const overlay = markElement.closest('#lang-helper-content-overlay');
  if (!overlay) return;

  // Find the original element from our activeOverlays map
  let targetElement = null;
  activeOverlays.forEach((data, element) => {
    if (data.overlay === overlay) {
      targetElement = element;
    }
  });

  if (!targetElement) return;

  // Get current text
  const currentText = getTextWithLineBreaks(targetElement);

  // Replace the text at the specified position
  const newText = currentText.substring(0, suggestion.start) +
                  suggestion.correction +
                  currentText.substring(suggestion.end);

  // Apply the new text
  if (targetElement.value !== undefined) {
    // For textarea/input
    targetElement.value = newText;
  } else if (targetElement.isContentEditable) {
    // For contenteditable, we need to preserve the cursor position and update carefully
    targetElement.innerText = newText;
  }

  // Update stored suggestions - remove the fixed one and adjust positions of others
  const storedData = elementSuggestions.get(targetElement);
  if (storedData) {
    const lengthDiff = suggestion.correction.length - (suggestion.end - suggestion.start);

    // Filter out the fixed suggestion and adjust positions of suggestions that come after it
    const updatedSuggestions = storedData.suggestions
      .filter(s => s.start !== suggestion.start || s.end !== suggestion.end)
      .map(s => {
        if (s.start >= suggestion.end) {
          // Adjust positions for suggestions after the fixed one
          return {
            ...s,
            start: s.start + lengthDiff,
            end: s.end + lengthDiff
          };
        }
        return s;
      });

    // Update stored suggestions
    elementSuggestions.set(targetElement, {
      text: newText,
      suggestions: updatedSuggestions,
      timestamp: Date.now()
    });

    // Re-display suggestions without triggering new analysis
    displaySuggestions(updatedSuggestions, targetElement);
  }
}


function createPositionedOverlay(suggestions, element, text) {

  // Remove existing overlay
  const existingOverlay = document.getElementById('lang-helper-content-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }

  // We'll filter suggestions after rendering by checking actual mark positions

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
  overlay.style.zIndex = '1000'; // High enough to be clickable, we'll handle toolbar with clipping
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
  const marks = overlay.querySelectorAll('.lang-helper-mark');
  let hideTooltipTimeout = null;

  marks.forEach((mark) => {
    mark.addEventListener('mouseenter', (e) => {
      // Clear any pending hide timeout
      if (hideTooltipTimeout) {
        clearTimeout(hideTooltipTimeout);
        hideTooltipTimeout = null;
      }

      const suggestionData = e.target.getAttribute('data-suggestion');
      const suggestion = JSON.parse(suggestionData);
      if (suggestion) {
        showTooltip(suggestion, e.target);
      }
    });

    mark.addEventListener('mouseleave', () => {
      // Delay hiding to allow moving to the tooltip
      hideTooltipTimeout = setTimeout(() => {
        hideTooltip();
      }, 200);
    });
  });

  // Also add hover listeners to the tooltip itself
  if (suggestionOverlay) {
    suggestionOverlay.addEventListener('mouseenter', () => {
      // Cancel hide when hovering over tooltip
      if (hideTooltipTimeout) {
        clearTimeout(hideTooltipTimeout);
        hideTooltipTimeout = null;
      }
    });

    suggestionOverlay.addEventListener('mouseleave', () => {
      hideTooltip();
    });
  }

  // Function to hide marks that overlap with toolbars
  const hideOverlappingMarks = () => {
    const allToolbars = document.querySelectorAll('[role="toolbar"]');
    const elementRect = element.getBoundingClientRect();

    // Filter to only toolbars that overlap with the element area
    const relevantToolbars = Array.from(allToolbars).filter(toolbar => {
      const toolbarRect = toolbar.getBoundingClientRect();
      const overlapsH = toolbarRect.left < elementRect.right && toolbarRect.right > elementRect.left;
      const overlapsV = toolbarRect.top < elementRect.bottom && toolbarRect.bottom > elementRect.top;
      return overlapsH && overlapsV && toolbarRect.height > 0;
    });

    marks.forEach((mark) => {
      const markRect = mark.getBoundingClientRect();
      let shouldHide = false;

      relevantToolbars.forEach(toolbar => {
        const toolbarRect = toolbar.getBoundingClientRect();

        // Check for overlap
        const overlapsHorizontally = markRect.left < toolbarRect.right && markRect.right > toolbarRect.left;
        const overlapsVertically = markRect.top < toolbarRect.bottom && markRect.bottom > toolbarRect.top;

        if (overlapsHorizontally && overlapsVertically) {
          shouldHide = true;
        }
      });

      if (shouldHide) {
        mark.style.visibility = 'hidden';
      } else {
        mark.style.visibility = 'visible';
      }
    });
  };

  // Check immediately
  hideOverlappingMarks();

  // Define cleanup function first so it can be used in updatePosition
  const cleanup = () => {
    if (overlay && overlay.parentNode) {
      overlay.remove();
    }
    if (scrollListener) {
      window.removeEventListener('scroll', scrollListener, true);
    }
    if (resizeListener) {
      window.removeEventListener('resize', resizeListener);
    }
  };

  // Update overlay position when scrolling or resizing
  const updatePosition = () => {
    // Check if element is still in the document
    if (!document.body.contains(element)) {
      cleanup();
      return;
    }

    const newRect = element.getBoundingClientRect();

    // Find all potential clipping containers
    let clippingContainers = [];
    let current = element.parentElement;

    while (current && current !== document.documentElement) {
      const style = window.getComputedStyle(current);
      const hasOverflow = style.overflow !== 'visible' || style.overflowY !== 'visible' || style.overflowX !== 'visible';

      if (hasOverflow) {
        clippingContainers.push(current);
      }

      current = current.parentElement;
    }

    // Calculate clipping based on all containers
    let clipTop = 0;
    let clipBottom = 0;
    let clipLeft = 0;
    let clipRight = 0;

    // Find the most restrictive bounds from all containers
    let minTop = -Infinity;
    let maxBottom = Infinity;
    let minLeft = -Infinity;
    let maxRight = Infinity;

    clippingContainers.forEach(container => {
      const containerRect = container.getBoundingClientRect();

      // Track the most restrictive boundaries
      if (containerRect.top > minTop) minTop = containerRect.top;
      if (containerRect.bottom < maxBottom) maxBottom = containerRect.bottom;
      if (containerRect.left > minLeft) minLeft = containerRect.left;
      if (containerRect.right < maxRight) maxRight = containerRect.right;
    });

    // Calculate clipping based on the most restrictive bounds
    if (minTop > newRect.top) clipTop = minTop - newRect.top;
    if (maxBottom < newRect.bottom) clipBottom = newRect.bottom - maxBottom;
    if (minLeft > newRect.left) clipLeft = minLeft - newRect.left;
    if (maxRight < newRect.right) clipRight = newRect.right - maxRight;

    // Also clip to viewport
    const viewportTop = -newRect.top;
    const viewportBottom = newRect.bottom - window.innerHeight;
    const viewportLeft = -newRect.left;
    const viewportRight = newRect.right - window.innerWidth;

    if (viewportTop > clipTop) clipTop = viewportTop;
    if (viewportBottom > clipBottom) clipBottom = viewportBottom;
    if (viewportLeft > clipLeft) clipLeft = viewportLeft;
    if (viewportRight > clipRight) clipRight = viewportRight;

    // Ensure clipping values are non-negative
    clipTop = Math.max(0, clipTop);
    clipBottom = Math.max(0, clipBottom);
    clipLeft = Math.max(0, clipLeft);
    clipRight = Math.max(0, clipRight);

    // Hide if completely out of view
    const isOutOfView = clipTop >= newRect.height ||
                        clipBottom >= newRect.height ||
                        clipLeft >= newRect.width ||
                        clipRight >= newRect.width;

    if (isOutOfView) {
      overlay.style.display = 'none';
    } else {
      overlay.style.display = 'block';
      overlay.style.left = newRect.left + window.scrollX + 'px';
      overlay.style.top = newRect.top + window.scrollY + 'px';
      overlay.style.width = newRect.width + 'px';
      overlay.style.height = newRect.height + 'px';

      // Use clip-path to hide content outside visible bounds
      if (clipTop > 0 || clipBottom > 0 || clipLeft > 0 || clipRight > 0) {
        overlay.style.clipPath = `inset(${clipTop}px ${clipRight}px ${clipBottom}px ${clipLeft}px)`;
        overlay.style.overflow = 'hidden';
      } else {
        overlay.style.clipPath = 'none';
        overlay.style.overflow = 'hidden';
      }

      // Recheck which marks should be hidden due to toolbar overlap
      hideOverlappingMarks();
    }
  };

  const scrollListener = () => updatePosition();
  const resizeListener = () => updatePosition();

  window.addEventListener('scroll', scrollListener, true);
  window.addEventListener('resize', resizeListener);

  // Trigger initial position update
  updatePosition();

  // Also clean up when user starts typing again
  element.addEventListener('input', cleanup, { once: true });

  // Store cleanup function and overlay reference
  element.setAttribute('data-overlay-id', 'lang-helper-content-overlay');
  element._overlayCleanup = cleanup;
  element._overlayElement = overlay;

  // Also store in global map for cleanup detection
  activeOverlays.set(element, { overlay, cleanup });
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
  textElements.forEach(setupTextMonitoring);
}

// Initial setup
monitorPage();

// Function to check for stale overlays
const cleanupStaleOverlays = () => {
  if (activeOverlays.size > 0) {
    activeOverlays.forEach((data, element) => {
      // Check if element is actually visible (has dimensions and is in a visible container)
      const rect = element.getBoundingClientRect();
      const isVisible = rect.width > 0 && rect.height > 0;
      const inDOM = document.body.contains(element);
      const isConnected = element.isConnected;

      // If element has no size or is not visible, it's probably hidden/removed
      if (!inDOM || !isConnected || !isVisible) {
        data.cleanup();
        activeOverlays.delete(element);
      }
    });
  }
};

// Watch for dynamically added and removed elements
const observer = new MutationObserver((mutations) => {
  // Check for new elements
  monitorPage();

  // Check for stale overlays
  cleanupStaleOverlays();
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});

// Also check periodically in case MutationObserver misses something
setInterval(cleanupStaleOverlays, 2000);
