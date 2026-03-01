'use strict';

// ===== CONFIG =====
const DEEPSEEK_API_KEY = 'sk-9bd0908d76194c21bb304fe259a4e7fc';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const IAP_PRODUCT_ID   = 'phrases_pack_10';
const FIRST_IAP_AT  = 15; // free phrases before first purchase offer
const IAP_PACK_SIZE = 10; // phrases unlocked per purchase

// ===== GAME CLASS =====
class PromtiGame {
  constructor() {
    // Yandex SDK objects
    this.ysdk     = null;
    this.player   = null;
    this.payments = null;

    // Game state
    this.currentLevelIndex   = 0; // 0-based position in sorted GAME_DATA.phrases
    this.currentPhrase       = null;
    this.activeForbidden     = [];   // forbidden words active this level
    this.removedForbidden    = {};   // { phraseId: Set<forbiddenWordId> }
    this.promptSentThisLevel = false;
    this.purchasedPacks      = 0;
    this.totalCompleted      = 0;

    // UI selection state
    this.selectionMode       = false;
    this.selectedForbiddenId = null;

    // DOM element cache
    this.el = {};
  }

  // ------------------------------------------------------------------ INIT
  async init() {
    this._cacheElements();
    this._bindEvents();

    await this._initYandex();
    this._loadProgress();
    this._loadLevel(this.currentLevelIndex);

    // Notify Yandex that loading is complete
    this.ysdk?.features?.LoadingAPI?.ready();

    // Start tracking gameplay
    this._gameplayStart();

    // Log interface language (for future localisation)
    if (this.ysdk) {
      const lang = this.ysdk.environment.i18n.lang; // e.g. 'ru'
      console.info('[promti] i18n.lang:', lang);
    }

    // Reveal the game — fade out loading overlay
    this.el.loadingOverlay.classList.add('hidden');
  }

  _cacheElements() {
    const $ = id => document.getElementById(id);
    this.el = {
      loadingOverlay:       $('loading-overlay'),
      levelIndicator:       $('level-indicator'),
      targetPhrase:         $('target-phrase'),
      forbiddenContainer:   $('forbidden-container'),
      btnRemove:            $('btn-remove-restriction'),
      btnCancelSel:         $('btn-cancel-selection'),
      promptTextarea:       $('prompt-textarea'),
      validationMsg:        $('validation-msg'),
      btnSend:              $('btn-send-prompt'),
      responseBox:          $('response-box'),
      resultBtns:           $('result-btns'),
      btnRetry:             $('btn-retry'),
      btnNext:              $('btn-next-word'),
      iapOverlay:           $('iap-overlay'),
      btnBuy:               $('btn-buy'),
    };
  }

  _bindEvents() {
    const { el } = this;

    el.btnRemove.addEventListener('click', () => this._enterSelectionMode());
    el.btnCancelSel.addEventListener('click', () => this._exitSelectionMode());
    el.promptTextarea.addEventListener('input', () => this._updateSendBtn());
    el.btnSend.addEventListener('click', () => this._sendPrompt());
    el.btnRetry.addEventListener('click', () => this._retryLevel());
    el.btnNext.addEventListener('click', () => this._nextWord());
    el.btnBuy.addEventListener('click', () => this._handlePurchase());
  }

  // ------------------------------------------------------------------ YANDEX
  async _initYandex() {
    if (typeof YaGames === 'undefined') {
      console.info('[promti] YaGames SDK not found — running in dev mode.');
      return;
    }
    try {
      this.ysdk   = await YaGames.init();
      this.player = await this.ysdk.getPlayer({ scopes: false });

      // Load cloud save
      try {
        const cloudData = await this.player.getData(['progress']);
        if (cloudData && cloudData.progress) {
          this._applyProgressData(cloudData.progress);
        }
      } catch (e) { /* cloud data might be empty on first run */ }

      // Init payments
      try {
        this.payments = await this.ysdk.getPayments({ signed: true });
      } catch (e) {
        console.warn('[promti] Payments unavailable:', e.message);
      }
    } catch (e) {
      console.warn('[promti] Yandex SDK init failed:', e.message);
    }
  }

  // ------------------------------------------------------------------ PROGRESS
  _loadProgress() {
    try {
      const raw = localStorage.getItem('promti_progress');
      if (raw) this._applyProgressData(JSON.parse(raw));
    } catch (e) { /* corrupt storage — ignore */ }
  }

  _applyProgressData(data) {
    if (!data) return;
    this.currentLevelIndex = data.currentLevelIndex ?? 0;
    this.totalCompleted    = data.totalCompleted    || 0;
    this.purchasedPacks    = data.purchasedPacks    || 0;

    // Restore removed forbidden words
    const saved = data.removedForbidden || {};
    Object.entries(saved).forEach(([k, arr]) => {
      this.removedForbidden[k] = new Set(arr);
    });
  }

  _saveProgress() {
    const data = {
      currentLevelIndex: this.currentLevelIndex,
      totalCompleted:   this.totalCompleted,
      purchasedPacks:   this.purchasedPacks,
      removedForbidden: Object.fromEntries(
        Object.entries(this.removedForbidden).map(([k, s]) => [k, [...s]])
      )
    };

    // Local storage
    localStorage.setItem('promti_progress', JSON.stringify(data));

    // Yandex cloud
    if (this.player) {
      this.player.setData({ progress: data })
        .catch(e => console.warn('[promti] Cloud save failed:', e.message));
    }
  }

  // ------------------------------------------------------------------ LEVEL LOAD
  _loadLevel(levelIndex) {
    this.currentPhrase = GAME_DATA.phrases[levelIndex];

    if (!this.currentPhrase) {
      this._showGameComplete();
      return;
    }

    // Check if IAP is required before showing this level
    this.currentLevelIndex = levelIndex;
    if (this._isIAPRequired()) {
      this.el.iapOverlay.classList.remove('hidden');
      return;
    }

    this.promptSentThisLevel = false;
    this.selectionMode       = false;
    this.selectedForbiddenId = null;

    // Build active forbidden list keyed by the phrase's DB id
    const dbId   = this.currentPhrase.id;
    const removed = this.removedForbidden[dbId] || new Set();
    this.activeForbidden = GAME_DATA.forbidden_words
      .filter(fw => fw.phrase_id === dbId && !removed.has(fw.id));

    // Update level indicator (1-based display)
    this.el.levelIndicator.textContent =
      `Уровень ${levelIndex + 1} из ${GAME_DATA.phrases.length}`;

    // Render phrase
    this.el.targetPhrase.textContent = this.currentPhrase.phrase;

    // Render forbidden words
    this._renderForbiddenWords();

    // Reset input area
    this.el.promptTextarea.value    = '';
    this.el.promptTextarea.disabled = false;
    this.el.validationMsg.textContent = '';

    // Reset response area
    this.el.responseBox.innerHTML =
      '<span class="placeholder-text">Ответ нейросети появится здесь</span>';

    // Reset action buttons
    this.el.resultBtns.classList.add('hidden');
    this.el.btnRetry.classList.add('hidden');
    this.el.btnNext.classList.add('hidden');

    // Reset selection buttons
    this.el.btnRemove.classList.remove('hidden');
    this.el.btnCancelSel.classList.add('hidden');

    this._updateSendBtn();
  }

  // ------------------------------------------------------------------ FORBIDDEN WORDS
  _renderForbiddenWords() {
    const container = this.el.forbiddenContainer;
    container.innerHTML = '';

    if (this.activeForbidden.length === 0) {
      container.innerHTML = '<span style="color:#9ab8e0;font-style:italic;font-size:0.9rem;">Нет запрещённых комбинаций</span>';
      return;
    }

    this.activeForbidden.forEach(fw => {
      const item = document.createElement('div');
      item.className = 'forbidden-word-item';
      item.dataset.fwid = fw.id;

      // Checkbox (hidden until selection mode)
      const cb = document.createElement('input');
      cb.type      = 'checkbox';
      cb.className = 'word-checkbox';

      // Red paper sprite
      const paper = document.createElement('div');
      paper.className = 'red-paper';
      const label = document.createElement('span');
      label.textContent = fw.root;
      paper.appendChild(label);

      item.appendChild(cb);
      item.appendChild(paper);
      container.appendChild(item);

      // Click handler (only active in selection mode)
      paper.addEventListener('click', () => {
        if (this.selectionMode) this._selectForbiddenItem(fw.id, item, cb);
      });
      cb.addEventListener('change', () => {
        if (cb.checked) this._selectForbiddenItem(fw.id, item, cb);
      });
    });
  }

  _enterSelectionMode() {
    if (this.activeForbidden.length === 0) return;
    this.selectionMode = true;
    document.querySelectorAll('.forbidden-word-item').forEach(el =>
      el.classList.add('selecting')
    );
    this.el.btnRemove.classList.add('hidden');
    this.el.btnCancelSel.classList.remove('hidden');
  }

  _exitSelectionMode() {
    this.selectionMode       = false;
    this.selectedForbiddenId = null;
    document.querySelectorAll('.forbidden-word-item').forEach(el => {
      el.classList.remove('selecting', 'selected');
    });
    document.querySelectorAll('.word-checkbox').forEach(cb => {
      cb.checked = false;
    });
    this.el.btnRemove.classList.remove('hidden');
    this.el.btnCancelSel.classList.add('hidden');
  }

  _selectForbiddenItem(fwId, selectedItem, selectedCb) {
    // Enforce radio-button behaviour
    document.querySelectorAll('.forbidden-word-item').forEach(el => {
      el.classList.remove('selected');
    });
    document.querySelectorAll('.word-checkbox').forEach(cb => {
      cb.checked = false;
    });
    selectedItem.classList.add('selected');
    selectedCb.checked         = true;
    this.selectedForbiddenId   = fwId;

    // Show rewarded video → remove restriction
    this._showRewardedVideo(
      () => {
        this._removeForbiddenWord(fwId);
        this._exitSelectionMode();
      },
      () => {
        // Not rewarded — just exit selection
        this._exitSelectionMode();
      }
    );
  }

  _removeForbiddenWord(fwId) {
    const pid = this.currentPhrase.id; // DB id, not level index
    if (!this.removedForbidden[pid]) this.removedForbidden[pid] = new Set();
    this.removedForbidden[pid].add(fwId);

    this.activeForbidden = this.activeForbidden.filter(fw => fw.id !== fwId);
    this._renderForbiddenWords();
    this._saveProgress();
    this._updateSendBtn();
  }

  // ------------------------------------------------------------------ VALIDATION
  _normalize(text) {
    // Treat е and ё as the same letter, ignore whitespace, lowercase
    return text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, '');
  }

  _validatePrompt(text) {
    if (text.trim().length <= 3) {
      return { valid: false, msg: 'Промт должен содержать более 3 символов' };
    }
    if (/[^\P{L}\p{Script=Cyrillic}]/u.test(text)) {
      return { valid: false, msg: 'Через перевод объяснять нельзя' };
    }
    if (this.promptSentThisLevel) {
      return { valid: false, msg: 'Промт уже был отправлен на этом уровне' };
    }
    const normText = this._normalize(text);
    for (const fw of this.activeForbidden) {
      if (normText.includes(this._normalize(fw.root))) {
        return { valid: false, msg: `Запрещена комбинация: «${fw.root}»` };
      }
    }
    return { valid: true, msg: '' };
  }

  _updateSendBtn() {
    const text = this.el.promptTextarea.value;
    const { valid, msg } = this._validatePrompt(text);
    this.el.btnSend.disabled = !valid;
    this.el.validationMsg.textContent = text.length > 0 ? msg : '';
  }

  // ------------------------------------------------------------------ DEEPSEEK
  async _sendPrompt() {
    const promptText = this.el.promptTextarea.value;
    const { valid } = this._validatePrompt(promptText);
    if (!valid) return;

    this.promptSentThisLevel        = true;
    this.el.btnSend.disabled        = true;
    this.el.promptTextarea.disabled = true;
    this.el.resultBtns.classList.add('hidden');

    // Show spinner
    this.el.responseBox.innerHTML = `
      <div class="spinner">
        <span>Нейросеть думает…</span>
        <div class="spinner-dots">
          <div class="spinner-dot"></div>
          <div class="spinner-dot"></div>
          <div class="spinner-dot"></div>
        </div>
      </div>`;

    try {
      const res = await fetch(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model:       'deepseek-chat',
          temperature: 0.5,
          messages: [
            {
              role: 'system',
              content:
                'Ты участвуешь в игре «Объясни фразу». ' +
                'Пользователь описывает загаданное словосочетание, не используя слова с теми же корнями, что и в этой фразе. ' +
                'Твоя задача — угадать фразу и обязательно написать её дословно и точно в своём ответе. ' +
                'Угаданная фраза должна прозвучать в ответе явно, в той же форме, как она обычно используется. ' +
                'Ответ должен быть кратким. ' +
                'Важно: в своём ответе также не используй однокоренные слова к словам, которые пользователь употребил в своём запросе. ' +
                'Отвечай на русском языке.'
            },
            { role: 'user', content: promptText.trim() }
          ]
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `HTTP ${res.status}`);
      }

      const data         = await res.json();
      const aiResponse   = data.choices[0].message.content;
      const phraseFound  = this._checkPhraseInResponse(aiResponse);

      this._showResponse(aiResponse, phraseFound);
      this._showResultButtons(phraseFound);

    } catch (err) {
      // Allow retry on network error
      this.promptSentThisLevel        = false;
      this.el.promptTextarea.disabled = false;
      this._updateSendBtn();
      this.el.responseBox.textContent =
        `Ошибка запроса: ${err.message}.\nПроверьте соединение и попробуйте снова.`;
    }
  }

  // Normalize a single word: lowercase + ё→е (spaces not stripped — used for word-level checks)
  _normalizeWord(word) {
    return word.toLowerCase().replace(/ё/g, 'е');
  }

  // Split phrase into words and check each one is present anywhere in the response (order-agnostic).
  // Uses stem-based matching to handle Russian declensions (e.g. "торта" matches "торт").
  _checkPhraseInResponse(response) {
    const normResponse = this._normalizeWord(response);
    return this._phraseWords().every(w => {
      // For short words (≤4 chars) require exact match; for longer words use a stem (first 75%)
      const stemLen = w.length <= 4 ? w.length : Math.floor(w.length * 0.75);
      const stem = w.slice(0, stemLen);
      return normResponse.includes(stem);
    });
  }

  // Returns normalized individual words of the current phrase
  _phraseWords() {
    return this.currentPhrase.phrase
      .split(/\s+/)
      .filter(w => w.length > 0)
      .map(w => this._normalizeWord(w));
  }

  // Build a regex for one word with е/ё interchangeable (case-insensitive)
  _buildWordRegex(word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = escaped.replace(/[её]/gi, '[еёЕЁ]');
    return new RegExp(pattern, 'gi');
  }

  _showResponse(text, phraseFound) {
    // Configure marked: GFM, line breaks, no raw HTML injection
    marked.use({ gfm: true, breaks: true });
    const html = marked.parse(text);
    this.el.responseBox.innerHTML = html;

    if (phraseFound) {
      this._highlightPhraseInDOM(this.el.responseBox);
    }
  }

  // Highlight each word of the target phrase independently in the DOM (order-agnostic)
  _highlightPhraseInDOM(container) {
    const words = this.currentPhrase.phrase.split(/\s+/).filter(w => w.length > 0);

    words.forEach(word => {
      const regex    = this._buildWordRegex(word);
      const walker   = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
      const nodes    = [];
      let node;
      while ((node = walker.nextNode())) nodes.push(node);

      nodes.forEach(textNode => {
        regex.lastIndex = 0;
        if (!regex.test(textNode.textContent)) return;
        regex.lastIndex = 0;

        const wrapper = document.createElement('span');
        wrapper.innerHTML = textNode.textContent.replace(
          regex,
          m => `<mark class="phrase-highlight">${m}</mark>`
        );
        textNode.parentNode.replaceChild(wrapper, textNode);
      });
    });
  }

  _showResultButtons(phraseFound) {
    this.el.resultBtns.classList.remove('hidden');
    if (phraseFound) {
      this.el.btnRetry.classList.add('hidden');
      this.el.btnNext.classList.remove('hidden');
    } else {
      this.el.btnRetry.classList.remove('hidden');
      this.el.btnNext.classList.add('hidden');
    }
  }

  // ------------------------------------------------------------------ RETRY / NEXT
  _retryLevel() {
    this._showRewardedVideo(() => {
      this.promptSentThisLevel        = false;
      this.el.promptTextarea.disabled = false;
      this.el.responseBox.innerHTML   =
        '<span class="placeholder-text">Ответ нейросети появится здесь</span>';
      this.el.resultBtns.classList.add('hidden');
      this._updateSendBtn();
    });
  }

  _nextWord() {
    this._showFullscreenAd(() => {
      this.totalCompleted++;
      this._loadLevel(this.currentLevelIndex + 1);
      this._saveProgress();
    });
  }

  // ------------------------------------------------------------------ IAP
  _isIAPRequired() {
    // First offer after level 15, then every IAP_PACK_SIZE levels
    const limit = FIRST_IAP_AT + this.purchasedPacks * IAP_PACK_SIZE;
    return this.currentLevelIndex >= limit; // 0-based index, so index 15 = level 16
  }

  async _handlePurchase() {
    if (!this.payments) {
      alert('Покупки доступны только в среде Яндекс Игр.\nВ режиме разработки покупка засчитывается автоматически.');
      this.purchasedPacks++;
      this._saveProgress();
      this.el.iapOverlay.classList.add('hidden');
      this._loadLevel(this.currentLevelIndex);
      return;
    }

    try {
      await this.payments.purchase({ id: IAP_PRODUCT_ID });
      this.purchasedPacks++;
      this._saveProgress();
      this.el.iapOverlay.classList.add('hidden');
      this._loadLevel(this.currentLevelIndex);
    } catch (e) {
      if (e.code !== 'UserCanceled') {
        console.error('[promti] Purchase error:', e);
        alert('Ошибка покупки. Попробуйте позже.');
      }
    }
  }

  // ------------------------------------------------------------------ GAMEPLAY API
  _gameplayStart() {
    this.ysdk?.features?.GameplayAPI?.start?.();
  }

  _gameplayStop() {
    this.ysdk?.features?.GameplayAPI?.stop?.();
  }

  // ------------------------------------------------------------------ ADS
  _showRewardedVideo(onReward, onNoReward) {
    if (!this.ysdk) {
      // Dev mode: always reward
      if (onReward) onReward();
      return;
    }

    this._gameplayStop();
    let rewarded = false;
    this.ysdk.adv.showRewardedVideo({
      callbacks: {
        onRewarded: () => { rewarded = true; },
        onClose: () => {
          this._gameplayStart();
          (rewarded ? onReward : onNoReward)?.();
        },
        onError: (e) => {
          console.warn('[promti] Rewarded ad error:', e);
          this._gameplayStart();
          if (onReward) onReward(); // graceful fallback
        }
      }
    });
  }

  _showFullscreenAd(callback) {
    if (!this.ysdk) {
      if (callback) callback();
      return;
    }

    this._gameplayStop();
    let called = false;
    this.ysdk.adv.showFullscreenAdv({
      callbacks: {
        onClose: (_wasShown) => {
          this._gameplayStart();
          if (!called) { called = true; callback?.(); }
        },
        onError: (e) => {
          console.warn('[promti] Fullscreen ad error:', e);
          this._gameplayStart();
          if (!called) { called = true; callback?.(); }
        }
      }
    });
  }

  // ------------------------------------------------------------------ GAME COMPLETE
  _showGameComplete() {
    this.el.responseBox.innerHTML = `
      <div class="game-complete">
        <h2>Поздравляем!</h2>
        <p>Вы прошли все доступные фразы!<br>Следите за обновлениями — новые слова скоро появятся.</p>
      </div>`;
    this.el.resultBtns.classList.add('hidden');
    this.el.btnSend.disabled = true;
    this.el.promptTextarea.disabled = true;
  }
}

// ------------------------------------------------------------------ BOOT
document.addEventListener('DOMContentLoaded', () => {
  const game = new PromtiGame();
  game.init();
});
