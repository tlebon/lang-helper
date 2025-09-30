// Background service worker: Handles LLM API calls

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-3-5-sonnet-20241022';

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'analyzeText') {
    console.log('[Lang Helper BG] Received analysis request for', request.text.length, 'characters');
    analyzeTextWithLLM(request.text, request.language)
      .then(suggestions => {
        console.log('[Lang Helper BG] Returning', suggestions.length, 'suggestions');
        sendResponse({ suggestions });
      })
      .catch(error => {
        console.error('[Lang Helper BG] Error:', error.message);
        sendResponse({ error: error.message });
      });
    return true; // Keep channel open for async response
  }
});

async function analyzeTextWithLLM(text, language) {
  // Get API key from storage
  const storage = await chrome.storage.sync.get(['apiKey']);
  const apiKey = storage.apiKey;

  if (!apiKey) {
    throw new Error('API key not configured');
  }

  const prompt = `You are a language learning assistant. Analyze the following text written in ${language} and identify any grammar mistakes, spelling errors, awkward phrasing, or style issues.

Text to analyze (character positions are zero-indexed):
"""
${text}
"""

CRITICAL INSTRUCTIONS FOR CHARACTER POSITIONS:
1. Count ALL characters including spaces and newlines from position 0
2. Newline characters count as 1 character each
3. "start" = the first character of the problematic word/phrase
4. "end" = the position AFTER the last character (so text.substring(start, end) gives the exact text)
5. Include the exact problematic text so I can verify

Example with newlines:
Text: "Hello\nworld" (Hello, newline, world)
- Position 0-4: "Hello"
- Position 5: newline character (\n)
- Position 6-10: "world"
- If "world" is wrong: {"start": 6, "end": 11, "problematicText": "world"}

Respond ONLY with a JSON array in this EXACT format:
[
  {
    "start": <number>,
    "end": <number>,
    "problematicText": "<extract text.substring(start, end) HERE>",
    "severity": "error|warning|info|style",
    "message": "<brief description>",
    "correction": "<suggested correction>",
    "explanation": "<detailed explanation>"
  }
]

VERIFICATION STEP: For each issue, verify that text.substring(start, end) matches your problematicText field exactly.

Return ONLY the JSON array. If no issues: []`;

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`API error: ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const content = data.content[0].text;

    // Parse JSON response
    const suggestions = parseJSONResponse(content);

    // Verify and auto-correct positions
    console.log('[Lang Helper BG] Verifying positions for', suggestions.length, 'suggestions');
    console.log('[Lang Helper BG] Text preview:', text.substring(0, 100) + '...');

    const correctedSuggestions = suggestions.map((suggestion, index) => {
      const actualText = text.substring(suggestion.start, suggestion.end);

      console.log(`[Lang Helper BG] Checking suggestion ${index}: "${suggestion.problematicText}" at ${suggestion.start}-${suggestion.end}`);
      console.log(`[Lang Helper BG]   Text at that position: "${actualText}"`);
      console.log(`[Lang Helper BG]   Context: "...${text.substring(Math.max(0, suggestion.start - 10), suggestion.start)}[${actualText}]${text.substring(suggestion.end, Math.min(text.length, suggestion.end + 10))}..."`);

      if (actualText === suggestion.problematicText) {
        console.log(`[Lang Helper BG] ✓ Suggestion ${index} positions correct: "${actualText}"`);
        return suggestion;
      }

      // Position is wrong, try to find the correct position
      console.warn(`[Lang Helper BG] Position mismatch for suggestion ${index}:`);
      console.warn(`  Expected: "${suggestion.problematicText}"`);
      console.warn(`  Got: "${actualText}"`);

      // Search for the problematic text in the original text
      const searchText = suggestion.problematicText;
      let foundIndex = text.indexOf(searchText);

      // If found, update positions
      if (foundIndex !== -1) {
        const corrected = {
          ...suggestion,
          start: foundIndex,
          end: foundIndex + searchText.length
        };
        console.log(`[Lang Helper BG] ✓ Auto-corrected to positions ${foundIndex}-${foundIndex + searchText.length}`);
        return corrected;
      }

      // Try case-insensitive search
      const lowerText = text.toLowerCase();
      const lowerSearch = searchText.toLowerCase();
      foundIndex = lowerText.indexOf(lowerSearch);

      if (foundIndex !== -1) {
        const corrected = {
          ...suggestion,
          start: foundIndex,
          end: foundIndex + searchText.length
        };
        console.log(`[Lang Helper BG] ✓ Auto-corrected (case-insensitive) to positions ${foundIndex}-${foundIndex + searchText.length}`);
        return corrected;
      }

      console.error(`[Lang Helper BG] ✗ Could not find "${searchText}" in text, skipping this suggestion`);
      return null;
    }).filter(s => s !== null);

    console.log(`[Lang Helper BG] Returning ${correctedSuggestions.length} suggestions (${suggestions.length - correctedSuggestions.length} filtered)`);
    return correctedSuggestions;
  } catch (error) {
    console.error('LLM Analysis failed:', error);
    throw error;
  }
}

function parseJSONResponse(text) {
  try {
    // Try to extract JSON from markdown code blocks if present
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const jsonText = jsonMatch ? jsonMatch[1] : text;

    const parsed = JSON.parse(jsonText.trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Failed to parse LLM response:', error);
    console.error('Response text:', text);
    return [];
  }
}

// Handle extension installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('Language Learning Assistant installed');

  // Set default settings
  chrome.storage.sync.get(['targetLanguage', 'enabled'], (result) => {
    if (!result.targetLanguage) {
      chrome.storage.sync.set({ targetLanguage: 'Spanish', enabled: true });
    }
  });
});
