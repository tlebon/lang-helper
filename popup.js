// Popup script: Handles settings UI

const languageSelect = document.getElementById('language');
const apiKeyInput = document.getElementById('apiKey');
const enabledToggle = document.getElementById('enabled');
const saveBtn = document.getElementById('saveBtn');
const statusMessage = document.getElementById('statusMessage');

// Load current settings
chrome.storage.sync.get(['targetLanguage', 'apiKey', 'enabled'], (result) => {
  if (result.targetLanguage) {
    languageSelect.value = result.targetLanguage;
  }
  if (result.apiKey) {
    apiKeyInput.value = result.apiKey;
  }
  if (result.enabled !== undefined) {
    enabledToggle.checked = result.enabled;
  }
});

// Save settings
saveBtn.addEventListener('click', () => {
  const settings = {
    targetLanguage: languageSelect.value,
    apiKey: apiKeyInput.value,
    enabled: enabledToggle.checked
  };

  if (!settings.apiKey) {
    showStatus('Please enter an API key', 'error');
    return;
  }

  chrome.storage.sync.set(settings, () => {
    showStatus('Settings saved successfully!', 'success');
    setTimeout(() => {
      hideStatus();
    }, 2000);
  });
});

function showStatus(message, type) {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${type}`;
}

function hideStatus() {
  statusMessage.className = 'status-message';
}

// Enable save on input change
[languageSelect, apiKeyInput, enabledToggle].forEach(element => {
  element.addEventListener('change', () => {
    saveBtn.disabled = false;
  });
});
