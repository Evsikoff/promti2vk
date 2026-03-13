'use strict';

// ===== CONFIG =====
const DEEPSEEK_API_KEY = 'sk-9bd0908d76194c21bb304fe259a4e7fc';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

const ENERGY_IAP_ID          = 'energy_pack_100';
const ENERGY_IAP_PROMO_ID    = 'energy_pack_100_promo';
const ENERGY_IAP_AMOUNT      = 100;
const ENERGY_IAP_PRICE       = 90; // base price in RUB
const ENERGY_VIDEO_AMOUNT    = 5;
const ENERGY_FIRST_GRANT     = 15;
const ENERGY_FREE_AMOUNT     = 10;
const ENERGY_FREE_INTERVAL   = 10 * 60 * 60 * 1000; // 10 hours in ms

// ===== GAME CLASS =====
class PromtiGame {
  constructor() {
    // VK Bridge reference (set in _initVK)
    this._bridge       = null;
    this.vkBridgeReady = false;

    // OK SDK ready flag (set in _initOK)
    this.okReady       = false;

    // Platform: null (web/dev), 'vk', or 'ok'
    this.platform      = null;

    // Data loaded from JSON files
    this.phrases       = [];  // from phrases.json
    this.forbiddenWords = []; // from forbidden_words.json
    this.dictionaries  = [];  // from dictionaries.json

    // Game state
    this.currentDictionaryId = null;
    this.currentPhrase       = null;
    this.activeForbidden     = [];   // forbidden words active this level
    this.removedForbidden    = {};   // { phraseId: Set<forbiddenWordId> }
    this.promptSentThisLevel = false;

    // Progress
    this.completedPhrases    = {};   // { phraseId: true }
    this.skippedPhrases      = {};   // { phraseId: true }
    this.totalCompleted      = 0;
    this.totalAttempts       = 0;

    // Energy state
    this.energy              = 0;
    this.lastFreeEnergyTime  = 0;    // timestamp of last free grant (0 = never)
    this.energyTimerInterval = null;

    // Promotion state
    this.activePromotion     = null;

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

    await Promise.all([
      this._loadData(),
      this._loadPromotion()
    ]);

    // Load from localStorage first (fast path for returning users)
    this._loadProgress();

    // Detect platform via URL params (most reliable signal)
    this._detectPlatform();

    // Attempt to init VK Bridge first (unified launcher on OK often provides it)
    await Promise.race([
      this._initVK(),
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);

    // Also attempt OK SDK if detected or in OK
    if (this.platform === 'ok') {
      await Promise.race([
        this._initOK(),
        new Promise(resolve => setTimeout(resolve, 5000))
      ]);
    }

    this._initEnergy();
    this._updateStatsPanel();
    this._applyPromotionUI();

    // Show start screen
    this._showStartScreen();

    // Reveal the game — fade out loading overlay
    console.info('[promti] Game initialized, hiding overlay');
    this.el.loadingOverlay.classList.add('hidden');
  }

  _cacheElements() {
    const $ = id => document.getElementById(id);
    this.el = {
      appContainer:           $('app-container'),
      loadingOverlay:         $('loading-overlay'),
      startScreen:            $('start-screen'),
      gameContainer:          $('game-container'),
      dictionariesContainer:  $('dictionaries-container'),
      levelIndicator:         $('level-indicator'),
      btnBack:                $('btn-back'),
      targetPhrase:           $('target-phrase'),
      forbiddenContainer:     $('forbidden-container'),
      btnRemove:              $('btn-remove-restriction'),
      btnCancelSel:           $('btn-cancel-selection'),
      promptTextarea:         $('prompt-textarea'),
      validationMsg:          $('validation-msg'),
      btnSend:                $('btn-send-prompt'),
      responseBox:            $('response-box'),
      resultBtns:             $('result-btns'),
      btnRetry:               $('btn-retry'),
      btnSkip:                $('btn-skip'),
      btnNext:                $('btn-next-word'),
      statCompleted:          $('stat-completed'),
      statAttempts:           $('stat-attempts'),
      statEnergy:             $('stat-energy'),
      btnEnergyAdd:           $('btn-energy-add'),
      energyModal:            $('energy-modal'),
      modalEnergyValue:       $('modal-energy-value'),
      energyTimer:            $('energy-timer'),
      btnEnergyClose:         $('btn-energy-close'),
      btnEnergyWatch:         $('btn-energy-watch'),
      btnEnergyBuy:           $('btn-energy-buy'),
      promoBadge:             $('promo-badge'),
      discountBadge:          $('discount-badge'),
    };
  }

  _bindEvents() {
    const { el } = this;

    el.btnBack.addEventListener('click', () => this._goBack());
    el.btnRemove.addEventListener('click', () => this._enterSelectionMode());
    el.btnCancelSel.addEventListener('click', () => this._exitSelectionMode());
    el.promptTextarea.addEventListener('input', () => this._updateSendBtn());
    el.btnSend.addEventListener('click', () => this._sendPrompt());
    el.btnRetry.addEventListener('click', () => this._retryLevel());
    el.btnSkip.addEventListener('click', () => this._skipWord());
    el.btnNext.addEventListener('click', () => this._nextWord());
    el.btnEnergyAdd.addEventListener('click', () => this._openEnergyModal());
    el.btnEnergyClose.addEventListener('click', () => this._closeEnergyModal());
    el.btnEnergyWatch.addEventListener('click', () => this._watchVideoForEnergy());
    el.btnEnergyBuy.addEventListener('click', () => this._handleEnergyPurchase());
  }

  // ------------------------------------------------------------------ DATA LOADING
  async _loadData() {
    try {
      const [phrasesRes, forbiddenRes, dictionariesRes] = await Promise.all([
        fetch('phrases.json'),
        fetch('forbidden_words.json'),
        fetch('dictionaries.json')
      ]);
      const phrasesData      = await phrasesRes.json();
      const forbiddenData    = await forbiddenRes.json();
      const dictionariesData = await dictionariesRes.json();

      this.phrases        = phrasesData.phrases           || [];
      this.forbiddenWords = forbiddenData.forbidden_words  || [];
      this.dictionaries   = dictionariesData.dictionaries  || [];
    } catch (e) {
      console.error('[promti] Failed to load game data:', e);
    }
  }

  // ------------------------------------------------------------------ PLATFORM DETECTION
  _detectPlatform() {
    const params = new URLSearchParams(window.location.search);
    // Odnoklassniki: vk_client=ok OR vk_platform ends with _ok OR vk_ok_app_id present
    const vkClient   = params.get('vk_client')  || '';
    const vkPlatform = params.get('vk_platform') || '';
    const apiServer  = params.get('api_server') || '';

    if (
      vkClient === 'ok' ||
      vkPlatform.endsWith('_ok') ||
      params.has('vk_ok_app_id') ||
      apiServer.includes('ok.ru') ||
      (typeof FAPI !== 'undefined')
    ) {
      this.platform = 'ok';
      console.info('[promti] Odnoklassniki platform detected');
      return;
    }
    // VK: any vk_* param present
    if ([...params.keys()].some(k => k.startsWith('vk_'))) {
      this.platform = 'vk';
      console.info('[promti] VK platform detected');
    }
  }

  // ------------------------------------------------------------------ VK BRIDGE
  async _initVK() {
    // VK Bridge may be exposed under different globals depending on how it was loaded
    const bridge = (typeof vkBridge !== 'undefined' && vkBridge)
                || (typeof VKBridge  !== 'undefined' && VKBridge)
                || null;

    if (!bridge) {
      console.info('[promti] VK Bridge not found — running in dev mode.');
      return;
    }

    // Store reference for later use
    this._bridge = bridge;

    // Subscribe BEFORE sending VKWebAppInit so we never miss VKWebAppUpdateConfig.
    // VK sends that event as a direct response to VKWebAppInit (can arrive before
    // the init promise resolves), so the subscription must be in place first.
    this._bridge.subscribe((e) => {
      if (e.detail.type === 'VKWebAppUpdateConfig') {
        const h = e.detail.data.viewport_height;
        if (h && h > 0) {
          this.el.appContainer.style.height = h + 'px';
        }
      }
    });

    const VK_TIMEOUT = 5000; // ms

    try {
      const initData = await Promise.race([
        this._bridge.send('VKWebAppInit'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('VKWebAppInit timeout')), VK_TIMEOUT)
        )
      ]);
      if (initData.result) {
        this.vkBridgeReady = true;
        if (!this.platform) this.platform = 'vk';
        console.info('[promti] VK Bridge initialized');
      } else {
        console.warn('[promti] VK Bridge init returned false');
        return;
      }
    } catch (e) {
      console.warn('[promti] VK Bridge init failed:', e.message);
      return;
    }

    // Give VK a moment to deliver VKWebAppUpdateConfig (it fires asynchronously
    // right after VKWebAppInit is processed). Without this pause the container
    // height could be set after the loading overlay is already hidden.
    await new Promise(resolve => setTimeout(resolve, 150));

    // Load progress from VK Storage (primary source — overrides localStorage)
    try {
      const vkData = await Promise.race([
        this._loadFromVKStorage('promti'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('VK Storage load timeout')), VK_TIMEOUT)
        )
      ]);
      if (vkData) {
        this._applyProgressData(vkData);
        console.info('[promti] Progress loaded from VK Storage');
      }
    } catch (e) {
      console.warn('[promti] VK Storage load failed:', e.message);
    }
  }

  // ------------------------------------------------------------------ OK SDK
  _initOK() {
    return new Promise((resolve) => {
      // 1. Poll for FAPI — OK injects it asynchronously after iframe load
      const POLL_INTERVAL = 100; // ms
      const POLL_TIMEOUT  = 4000; // ms (leaves ~1 s for OKSDK fallback within the outer 5 s race)
      let elapsed = 0;

      const resolveFAPI = (fapi) => {
        this.okReady = true;
        this._setupOKCallbacks();
        console.info('[promti] FAPI (OK SDK) found and hooked (after %d ms)', elapsed);
        resolve();
      };

      const checkFAPI = () => {
        let fapi = null;
        try {
          fapi = (typeof FAPI !== 'undefined' && FAPI) ||
                 (window.parent && typeof window.parent.FAPI !== 'undefined' && window.parent.FAPI) || null;
        } catch (e) {
          // Cross-origin parent access blocked
        }

        if (fapi) { resolveFAPI(fapi); return; }

        elapsed += POLL_INTERVAL;
        if (elapsed < POLL_TIMEOUT) {
          setTimeout(checkFAPI, POLL_INTERVAL);
        } else {
          console.info('[promti] FAPI not found after %d ms — falling back to OKSDK', POLL_TIMEOUT);
          tryOKSDK();
        }
      };

      // 2. Fallback to OKSDK (external sites or if FAPI never appeared)
      const params = new URLSearchParams(window.location.search);
      const appId     = params.get('application_id') || params.get('api_id') || '';
      const sessKey   = params.get('session_secret_key') || params.get('auth_sig') || params.get('session_key') || '';
      const apiServer = params.get('api_server') || '';

      const tryInit = () => {
        const sdk = (typeof OKSDK !== 'undefined' && OKSDK) || null;
        if (!sdk) {
          console.info('[promti] OKSDK not found — checking FAPI again or dev mode.');
          resolve();
          return;
        }
        sdk.init({
          app_id             : appId,
          session_secret_key : sessKey,
          api_server         : apiServer,
        }, () => {
          this.okReady = true;
          this._setupOKCallbacks();
          console.info('[promti] OKSDK initialized');
          resolve();
        }, (err) => {
          console.warn('[promti] OKSDK init failed:', err);
          resolve();
        });
      };

      const tryOKSDK = () => {
        if (typeof OKSDK !== 'undefined') {
          tryInit();
        } else {
          const script = document.createElement('script');
          script.src = 'https://api.ok.ru/js/sdk.js';
          script.onload = tryInit;
          script.onerror = () => {
            console.warn('[promti] Could not load OKSDK script');
            resolve();
          };
          document.head.appendChild(script);
        }
      };

      checkFAPI();
    });
  }

  // FAPI uses a global API_callback function to return results
  _setupOKCallbacks() {
    const self = this;
    const hook = (originalCallback) => {
      return function(method, result, data) {
        console.info('[promti] OK Callback Hook:', method, result, data);

        // Pass to original if it exists
        if (typeof originalCallback === 'function') {
          try { originalCallback(method, result, data); } catch(e) {}
        }

        // Handle our logic
        self._handleOKCallback(method, result, data);
      };
    };

    // Hook both potential callback names
    window.API_callback  = hook(window.API_callback);
    window.FAPI_callback = hook(window.FAPI_callback);
  }

  _handleOKCallback(method, result, data) {
      if (method === 'showPayment') {
        if (result === 'ok') {
          // Dispatched via custom events or handled directly
          window.dispatchEvent(new CustomEvent('ok-payment-success', { detail: data }));
        } else {
          window.dispatchEvent(new CustomEvent('ok-payment-failed', { detail: data }));
        }
      }

      if (method === 'showRewardedVideo') {
        if (result === 'ok') {
          window.dispatchEvent(new CustomEvent('ok-ads-rewarded', { detail: data }));
        } else {
          window.dispatchEvent(new CustomEvent('ok-ads-failed', { detail: data }));
        }
      }

      if (method === 'showAd') {
        window.dispatchEvent(new CustomEvent('ok-ads-completed', { detail: data }));
      }
  }

  // ------------------------------------------------------------------ VK STORAGE HELPERS
  // Saves arbitrary JSON value to VK Storage under the given key,
  // splitting into 4000-char chunks automatically.
  async _saveToVKStorage(key, value) {
    const str = JSON.stringify(value);
    const chunkSize = 4000;
    const chunks = [];
    for (let i = 0; i < str.length; i += chunkSize) {
      chunks.push(str.slice(i, i + chunkSize));
    }
    // Store chunk count first
    await this._bridge.send('VKWebAppStorageSet', {
      key:   `${key}_cnt`,
      value: String(chunks.length)
    });
    // Store each chunk
    for (let i = 0; i < chunks.length; i++) {
      await this._bridge.send('VKWebAppStorageSet', {
        key:   `${key}_${i}`,
        value: chunks[i]
      });
    }
  }

  // Loads and reassembles chunked JSON value from VK Storage.
  async _loadFromVKStorage(key) {
    const cntRes   = await this._bridge.send('VKWebAppStorageGet', { keys: [`${key}_cnt`] });
    const cntEntry = cntRes.keys.find(k => k.key === `${key}_cnt`);
    if (!cntEntry || !cntEntry.value) return null;

    const n = parseInt(cntEntry.value, 10);
    if (!n || n < 1) return null;

    const chunkKeys  = Array.from({ length: n }, (_, i) => `${key}_${i}`);
    const chunksRes  = await this._bridge.send('VKWebAppStorageGet', { keys: chunkKeys });
    const str = chunkKeys
      .map(k => {
        const entry = chunksRes.keys.find(e => e.key === k);
        return entry ? entry.value : '';
      })
      .join('');
    return JSON.parse(str);
  }

  // ------------------------------------------------------------------ PROMOTIONS
  async _loadPromotion() {
    try {
      const res = await fetch('promotions.json');
      if (!res.ok) return;
      const data = await res.json();
      const now = new Date();
      for (const promo of (data.promotions || [])) {
        const [sd, sm, sy] = promo.start.split('.');
        const [fd, fm, fy] = promo.finish.split('.');
        const start  = new Date(+sy, +sm - 1, +sd, 0, 0, 0, 0);
        const finish = new Date(+fy, +fm - 1, +fd, 23, 59, 59, 999);
        if (now >= start && now <= finish) {
          this.activePromotion = promo;
          break;
        }
      }
    } catch (e) {
      console.warn('[promti] Could not load promotions.json:', e.message);
    }
  }

  _applyPromotionUI() {
    const promo = this.activePromotion;

    // On social platforms show price in platform currency instead of rubles
    if (this.platform === 'vk') {
      const label = promo ? '4 голоса' : '8 голосов';
      if (promo) {
        this.el.promoBadge.classList.remove('hidden');
        this.el.discountBadge.textContent = `-${promo.discount}%`;
        this.el.discountBadge.classList.remove('hidden');
      } else {
        this.el.promoBadge.classList.add('hidden');
        this.el.discountBadge.classList.add('hidden');
      }
      this.el.btnEnergyBuy.textContent = `Купить 100 единиц энергии — ${label}`;
      return;
    }

    if (this.platform === 'ok') {
      const label = promo ? '4 ОКов' : '8 ОКов';
      if (promo) {
        this.el.promoBadge.classList.remove('hidden');
        this.el.discountBadge.textContent = `-${promo.discount}%`;
        this.el.discountBadge.classList.remove('hidden');
      } else {
        this.el.promoBadge.classList.add('hidden');
        this.el.discountBadge.classList.add('hidden');
      }
      this.el.btnEnergyBuy.textContent = `Купить 100 единиц энергии — ${label}`;
      return;
    }

    // Default: show price in rubles
    if (promo) {
      this.el.promoBadge.classList.remove('hidden');
      const discounted = Math.round(ENERGY_IAP_PRICE * (1 - promo.discount / 100));
      this.el.discountBadge.textContent = `-${promo.discount}%`;
      this.el.discountBadge.classList.remove('hidden');
      this.el.btnEnergyBuy.textContent = `Купить 100 единиц энергии — ${discounted} ₽`;
    } else {
      this.el.promoBadge.classList.add('hidden');
      this.el.discountBadge.classList.add('hidden');
      this.el.btnEnergyBuy.textContent = `Купить 100 единиц энергии — ${ENERGY_IAP_PRICE} ₽`;
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
    this.totalCompleted     = data.totalCompleted     || 0;
    this.totalAttempts      = data.totalAttempts      || 0;
    this.energy             = data.energy             || 0;
    this.lastFreeEnergyTime = data.lastFreeEnergyTime || 0;
    this.completedPhrases   = data.completedPhrases   || {};
    this.skippedPhrases     = data.skippedPhrases     || {};

    // Restore removed forbidden words
    const saved = data.removedForbidden || {};
    Object.entries(saved).forEach(([k, arr]) => {
      this.removedForbidden[k] = new Set(arr);
    });
  }

  _saveProgress() {
    const data = {
      totalCompleted:     this.totalCompleted,
      totalAttempts:      this.totalAttempts,
      energy:             this.energy,
      lastFreeEnergyTime: this.lastFreeEnergyTime,
      completedPhrases:   this.completedPhrases,
      skippedPhrases:     this.skippedPhrases,
      removedForbidden: Object.fromEntries(
        Object.entries(this.removedForbidden).map(([k, s]) => [k, [...s]])
      )
    };

    // VK Storage (primary)
    if (this.vkBridgeReady) {
      this._saveToVKStorage('promti', data)
        .catch(e => console.warn('[promti] VK Storage save failed:', e));
    }

    // Local storage (fallback)
    try {
      localStorage.setItem('promti_progress', JSON.stringify(data));
    } catch (e) {
      console.warn('[promti] localStorage save failed:', e);
    }
  }

  // ------------------------------------------------------------------ START SCREEN
  _showStartScreen() {
    this._renderStartScreen();
    this.el.startScreen.classList.remove('hidden');
    this.el.gameContainer.classList.add('hidden');
  }

  _renderStartScreen() {
    const container = this.el.dictionariesContainer;
    container.innerHTML = '';

    this.dictionaries.forEach(dict => {
      const dictPhrases = this.phrases.filter(p => p.dictionary_id === dict.id);
      const total = dictPhrases.length;
      const completed = dictPhrases.filter(p => this.completedPhrases[p.id]).length;
      const allDone = total > 0 && completed === total;

      const badge = document.createElement('div');
      badge.className = 'dict-badge' + (allDone ? ' dict-badge-done' : '');

      if (dict.icon) {
        const iconEl = document.createElement('div');
        iconEl.className = 'dict-badge-icon';
        iconEl.textContent = dict.icon;
        badge.appendChild(iconEl);
      }

      const nameEl = document.createElement('div');
      nameEl.className = 'dict-badge-name';
      nameEl.textContent = dict.name;

      const exampleEl = document.createElement('div');
      exampleEl.className = 'dict-badge-example';
      exampleEl.textContent = dict.example;

      const progressEl = document.createElement('div');
      progressEl.className = 'dict-badge-progress';
      progressEl.textContent = `${completed} / ${total}`;

      badge.appendChild(nameEl);
      badge.appendChild(exampleEl);
      badge.appendChild(progressEl);

      if (allDone) {
        const checkEl = document.createElement('div');
        checkEl.className = 'dict-badge-check';
        checkEl.textContent = '✓';
        badge.appendChild(checkEl);
      } else {
        badge.addEventListener('click', () => this._onDictionaryClick(dict.id));
      }

      container.appendChild(badge);
    });
  }

  _onDictionaryClick(dictionaryId) {
    if (this.energy < 1) {
      this._openEnergyModal();
      return;
    }
    this.currentDictionaryId = dictionaryId;
    const phrase = this._selectRandomPhrase(dictionaryId);
    if (!phrase) return;
    this._showGameScreen(phrase);
  }

  _selectRandomPhrase(dictionaryId) {
    const dictPhrases = this.phrases.filter(p => p.dictionary_id === dictionaryId);
    const available = dictPhrases.filter(
      p => !this.completedPhrases[p.id] && !this.skippedPhrases[p.id]
    );
    if (available.length === 0) return null;
    return available[Math.floor(Math.random() * available.length)];
  }

  _goBack() {
    this._showStartScreen();
  }

  // ------------------------------------------------------------------ GAME SCREEN
  _showGameScreen(phrase) {
    this.el.startScreen.classList.add('hidden');
    this.el.gameContainer.classList.remove('hidden');
    this._loadPhrase(phrase);
  }

  _loadPhrase(phrase) {
    this.currentPhrase       = phrase;
    this.promptSentThisLevel = false;
    this.selectionMode       = false;
    this.selectedForbiddenId = null;

    // Build active forbidden list keyed by the phrase's id
    const removed = this.removedForbidden[phrase.id] || new Set();
    this.activeForbidden = this.forbiddenWords
      .filter(fw => fw.phrase_id === phrase.id && !removed.has(fw.id));

    // Update level indicator: N = explained in this dict, M = total in dict
    const dictPhrases = this.phrases.filter(p => p.dictionary_id === this.currentDictionaryId);
    const completedInDict = dictPhrases.filter(p => this.completedPhrases[p.id]).length;
    const totalInDict = dictPhrases.length;
    this.el.levelIndicator.textContent =
      `Уровень ${completedInDict} из ${totalInDict}`;

    // Render phrase
    this.el.targetPhrase.textContent = phrase.phrase;

    // Render forbidden words
    this._renderForbiddenWords();

    // Reset input area
    this.el.promptTextarea.value      = '';
    this.el.promptTextarea.disabled   = false;
    this.el.validationMsg.textContent = '';

    // Reset response area
    this.el.responseBox.innerHTML =
      '<span class="placeholder-text">Ответ нейросети появится здесь</span>';

    // Reset action buttons
    this.el.resultBtns.classList.add('hidden');
    this.el.btnRetry.classList.add('hidden');
    this.el.btnSkip.classList.add('hidden');
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
    const pid = this.currentPhrase.id;
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
    if (this.energy <= 0) {
      return { valid: false, msg: 'Недостаточно энергии — пополните запас' };
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

    // Deduct 1 energy and count the attempt
    this.totalAttempts++;
    this.energy = Math.max(0, this.energy - 1);
    this._saveProgress();
    this._updateStatsPanel();

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
          model:           'deepseek-chat',
          temperature:     0.5,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Ты участвуешь в игре «Объясни фразу». ' +
                'Пользователь описывает загаданное словосочетание, не используя слова с теми же корнями, что и в этой фразе. ' +
                'Твоя задача — угадать фразу. ' +
                'Отвечай строго в формате JSON с двумя полями: ' +
                '"answer" — угаданная фраза, написанная дословно и точно, в той форме, как она обычно используется; ' +
                '"reasoning" — краткое обоснование, почему ты считаешь, что ответ именно такой. ' +
                'Важно: в поле "reasoning" также не используй однокоренные слова к словам, которые пользователь употребил в своём запросе. ' +
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

      const data       = await res.json();
      const raw        = data.choices[0].message.content;
      let answer = raw, reasoning = null;
      try {
        const parsed = JSON.parse(raw);
        answer    = parsed.answer    || raw;
        reasoning = parsed.reasoning || null;
      } catch (e) { /* fallback: treat whole response as answer */ }

      const phraseFound = this._checkPhraseInResponse(answer);
      this._showResponse(answer, reasoning, phraseFound);
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

  // Normalize a single word: lowercase + ё→е
  _normalizeWord(word) {
    return word.toLowerCase().replace(/ё/g, 'е');
  }

  // Split phrase into words and check each one is present in the response.
  // Uses stem-based matching to handle Russian declensions.
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

  _showResponse(answer, reasoning, phraseFound) {
    marked.use({ gfm: true, breaks: true });

    let html = `<div class="response-answer">${marked.parse(answer)}</div>`;
    if (reasoning) {
      html += `<div class="response-reasoning">${marked.parse(reasoning)}</div>`;
    }
    this.el.responseBox.innerHTML = html;

    if (phraseFound) {
      this._highlightPhraseInDOM(this.el.responseBox.querySelector('.response-answer'));
    }
  }

  // Highlight each word of the target phrase in the DOM
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
      this.el.btnSkip.classList.add('hidden');
      this.el.btnNext.classList.remove('hidden');
    } else {
      this.el.btnRetry.classList.remove('hidden');
      this.el.btnSkip.classList.remove('hidden');
      this.el.btnNext.classList.add('hidden');
    }
  }

  // ------------------------------------------------------------------ RETRY / SKIP / NEXT
  _skipWord() {
    this._showRewardedVideo(
      () => {
        // Mark current phrase as skipped and save
        this.skippedPhrases[this.currentPhrase.id] = true;
        this._saveProgress();

        // Load next available phrase from same dictionary
        const nextPhrase = this._selectRandomPhrase(this.currentDictionaryId);
        if (!nextPhrase) {
          this._showDictionaryComplete();
        } else {
          this._loadPhrase(nextPhrase);
        }
      },
      () => { /* video not watched — do nothing */ }
    );
  }

  _retryLevel() {
    this._showFullscreenAd(() => {
      this.promptSentThisLevel        = false;
      this.el.promptTextarea.disabled = false;
      this.el.responseBox.innerHTML   =
        '<span class="placeholder-text">Ответ нейросети появится здесь</span>';
      this.el.resultBtns.classList.add('hidden');
      this.el.btnSkip.classList.add('hidden');
      this._updateSendBtn();
    });
  }

  _nextWord() {
    this._showFullscreenAd(() => {
      // Mark current phrase as completed
      this.completedPhrases[this.currentPhrase.id] = true;
      this.totalCompleted++;
      this._saveProgress();
      this._updateStatsPanel();

      // Try to get next random phrase from same dictionary
      const nextPhrase = this._selectRandomPhrase(this.currentDictionaryId);
      if (!nextPhrase) {
        this._showDictionaryComplete();
      } else {
        this._loadPhrase(nextPhrase);
      }
    });
  }

  // ------------------------------------------------------------------ ENERGY
  _initEnergy() {
    const now = Date.now();
    if (this.lastFreeEnergyTime === 0) {
      // First ever launch
      this.energy += ENERGY_FIRST_GRANT;
      this.lastFreeEnergyTime = now;
      this._saveProgress();
    } else if (now - this.lastFreeEnergyTime >= ENERGY_FREE_INTERVAL) {
      // 10 hours have passed since last free grant
      this.energy += ENERGY_FREE_AMOUNT;
      this.lastFreeEnergyTime = now;
      this._saveProgress();
    }
  }

  _updateStatsPanel() {
    this.el.statCompleted.textContent = this.totalCompleted;
    this.el.statAttempts.textContent  = this.totalAttempts;
    this.el.statEnergy.textContent    = this.energy;
  }

  _openEnergyModal() {
    this.el.modalEnergyValue.textContent = this.energy;
    this._updateEnergyTimer();
    this.el.energyModal.classList.remove('hidden');
    this.energyTimerInterval = setInterval(() => this._updateEnergyTimer(), 1000);
  }

  _closeEnergyModal() {
    this.el.energyModal.classList.add('hidden');
    clearInterval(this.energyTimerInterval);
    this.energyTimerInterval = null;
  }

  _updateEnergyTimer() {
    const remaining = Math.max(0, ENERGY_FREE_INTERVAL - (Date.now() - this.lastFreeEnergyTime));
    if (remaining === 0) {
      this.el.energyTimer.textContent = 'Бесплатная энергия доступна — зайдите снова!';
    } else {
      const h = Math.floor(remaining / 3_600_000);
      const m = Math.floor((remaining % 3_600_000) / 60_000);
      const s = Math.floor((remaining % 60_000) / 1_000);
      this.el.energyTimer.textContent =
        `До следующего бесплатного начисления: ${h}ч ${String(m).padStart(2,'0')}м ${String(s).padStart(2,'0')}с`;
    }
  }

  _watchVideoForEnergy() {
    this._showRewardedVideo(
      () => {
        this.energy += ENERGY_VIDEO_AMOUNT;
        this._saveProgress();
        this._updateStatsPanel();
        this.el.modalEnergyValue.textContent = this.energy;
      },
      () => { /* no reward — do nothing */ }
    );
  }

  async _handleEnergyPurchase() {
    const iapId = this.activePromotion ? ENERGY_IAP_PROMO_ID : ENERGY_IAP_ID;

    console.info('[promti:buy] === ENERGY PURCHASE STARTED ===');
    console.info('[promti:buy] platform=%s | vkBridgeReady=%s | okReady=%s | activePromotion=%s',
      this.platform, this.vkBridgeReady, this.okReady,
      this.activePromotion ? this.activePromotion.name : 'none');
    console.info('[promti:buy] iapId=%s | energy_before=%d', iapId, this.energy);

    // 1. Try VK Bridge if ready (even on OK platform)
    if (this.vkBridgeReady) {
      console.info('[promti:buy] vkBridgeReady=true → trying VKWebAppShowOrderBox, item=%s', iapId);
      try {
        const data = await this._bridge.send('VKWebAppShowOrderBox', {
          type: 'item',
          item: iapId
        });
        console.info('[promti:buy] VK Bridge result: %o', data);
        if (data.success) {
          this.energy += ENERGY_IAP_AMOUNT;
          console.info('[promti:buy] VK Bridge success → energy +%d, new total=%d', ENERGY_IAP_AMOUNT, this.energy);
          this._saveProgress();
          this._updateStatsPanel();
          this.el.modalEnergyValue.textContent = this.energy;
        } else {
          console.warn('[promti:buy] VK Bridge returned success=false (no charge)');
        }
        return;
      } catch (e) {
        console.warn('[promti] VK Bridge purchase failed, trying fallback...', e);
        // If user didn't just close it, we might want to try FAPI fallback below
        if (e?.error_data?.error_reason === 'User closed payment dialog') {
          console.info('[promti:buy] User closed VK payment dialog → aborting');
          return;
        }
      }
    } else {
      console.info('[promti:buy] vkBridgeReady=false → skipping VK Bridge');
    }

    // 2. Fallback to OK/FAPI if on OK
    if (this.platform === 'ok') {
      console.info('[promti:buy] platform=ok → entering OK payment path');
      const iapName = 'Энергия (100 ед.)';
      const iapPrice = this.activePromotion ? 4 : 8; // OK Internal Currency (OKs)
      console.info('[promti:buy] iapName=%s | iapPrice=%d ОКов', iapName, iapPrice);

      // Use FAPI if available
      let fapi = null;
      let fapiSource = 'none';
      try {
        const windowFapiType = typeof FAPI !== 'undefined' ? typeof FAPI : 'undefined';
        let parentFapiType = 'N/A';
        try { parentFapiType = typeof window.parent.FAPI !== 'undefined' ? typeof window.parent.FAPI : 'undefined'; } catch (_) { parentFapiType = 'cross-origin blocked'; }
        console.info('[promti:buy] FAPI check: window.FAPI=%s | window.parent.FAPI=%s', windowFapiType, parentFapiType);

        if (typeof FAPI !== 'undefined' && FAPI) {
          fapi = FAPI;
          fapiSource = 'window.FAPI';
        } else if (window.parent && typeof window.parent.FAPI !== 'undefined' && window.parent.FAPI) {
          fapi = window.parent.FAPI;
          fapiSource = 'window.parent.FAPI';
        }
      } catch (e) {
        console.warn('[promti:buy] FAPI resolution threw:', e);
      }
      console.info('[promti:buy] fapi resolved from: %s | fapi=%o | has UI.showPayment: %s',
        fapiSource, fapi, !!(fapi && fapi.UI && fapi.UI.showPayment));

      if (fapi && fapi.UI && fapi.UI.showPayment) {
        console.info('[promti:buy] FAPI path selected → registering ok-payment-success / ok-payment-failed listeners');
        return new Promise((resolve) => {
          const handler = (e) => {
            window.removeEventListener('ok-payment-success', handler);
            window.removeEventListener('ok-payment-failed', failHandler);
            console.info('[promti:buy] ok-payment-success received, detail=%o', e.detail);
            this.energy += ENERGY_IAP_AMOUNT;
            console.info('[promti:buy] Energy +%d → new total=%d', ENERGY_IAP_AMOUNT, this.energy);
            this._saveProgress();
            this._updateStatsPanel();
            this.el.modalEnergyValue.textContent = this.energy;
            resolve();
          };
          const failHandler = (e) => {
            window.removeEventListener('ok-payment-success', handler);
            window.removeEventListener('ok-payment-failed', failHandler);
            console.warn('[promti:buy] ok-payment-failed received, detail=%o', e.detail);
            resolve();
          };
          window.addEventListener('ok-payment-success', handler);
          window.addEventListener('ok-payment-failed', failHandler);
          console.info('[promti:buy] Listeners registered, calling fapi.UI.showPayment(%s, ..., %s, %d, null, null, ok, true)',
            iapName, iapId, iapPrice);
          try {
            fapi.UI.showPayment(iapName, '100 единиц энергии для игры', iapId, iapPrice, null, null, 'ok', 'true');
            console.info('[promti:buy] fapi.UI.showPayment() called — waiting for callback');
          } catch (e) {
            console.warn('[promti] FAPI showPayment error:', e);
            resolve();
          }
        });
      }

      // Fallback to OKSDK
      if (typeof OKSDK === 'undefined') {
        console.warn('[promti:buy] OKSDK not available — no payment method found, aborting');
        return;
      }
      console.info('[promti:buy] FAPI unavailable → falling back to OKSDK.Payments.show');
      const oksdkPayload = {
        name        : iapName,
        description : '100 единиц энергии для игры',
        code        : iapId,
        price       : iapPrice,
        uids        : '',
      };
      console.info('[promti:buy] OKSDK.Payments.show args: %o', oksdkPayload);
      return new Promise((resolve) => {
        OKSDK.Payments.show(oksdkPayload, () => {
          this.energy += ENERGY_IAP_AMOUNT;
          console.info('[promti:buy] OKSDK payment success → energy +%d, new total=%d', ENERGY_IAP_AMOUNT, this.energy);
          this._saveProgress();
          this._updateStatsPanel();
          this.el.modalEnergyValue.textContent = this.energy;
          resolve();
        }, (err) => {
          console.warn('[promti] OK payment cancelled or failed:', err);
          resolve();
        });
      });
    } else {
      console.info('[promti:buy] platform=%s → skipping OK payment path', this.platform);
    }

    // Final fallback for dev mode
    if (!this.vkBridgeReady && !this.okReady) {
      this.energy += ENERGY_IAP_AMOUNT;
      console.info('[promti:buy] No platform detected (dev mode) → granting energy directly, new total=%d', this.energy);
      this._saveProgress();
      this._updateStatsPanel();
      this.el.modalEnergyValue.textContent = this.energy;
    }
  }

  // ------------------------------------------------------------------ ADS
  async _showRewardedVideo(onReward, onNoReward) {
    // 1. Try VK Bridge if ready
    if (this.vkBridgeReady) {
      try {
        const checkData = await this._bridge.send('VKWebAppCheckNativeAds', { ad_format: 'reward' });
        if (checkData.result) {
          const showData = await this._bridge.send('VKWebAppShowNativeAds', { ad_format: 'reward' });
          if (showData.result) {
            if (onReward) onReward();
            return;
          }
        }
      } catch (e) {
        console.warn('[promti] VK Bridge rewarded ad failed, trying fallback...', e);
      }
    }

    // 2. Fallback to OK/FAPI if on OK
    if (this.platform === 'ok') {
      // Use FAPI if available (standard for "Games in OK")
      let fapi = null;
      try {
        fapi = (typeof FAPI !== 'undefined' && FAPI) || (window.parent && typeof window.parent.FAPI !== 'undefined' && window.parent.FAPI) || null;
      } catch (e) {}

      if (fapi && fapi.UI && fapi.UI.showRewardedVideo) {
        const handler = (e) => {
          window.removeEventListener('ok-ads-rewarded', handler);
          window.removeEventListener('ok-ads-failed', failHandler);
          if (onReward) onReward();
        };
        const failHandler = (e) => {
          window.removeEventListener('ok-ads-rewarded', handler);
          window.removeEventListener('ok-ads-failed', failHandler);
          if (onNoReward) onNoReward();
        };
        window.addEventListener('ok-ads-rewarded', handler);
        window.addEventListener('ok-ads-failed', failHandler);

        try {
          fapi.UI.showRewardedVideo();
        } catch (e) {
          console.warn('[promti] FAPI showRewardedVideo error:', e);
          if (onNoReward) onNoReward();
        }
        return;
      }

      // Fallback to OKSDK
      try {
        OKSDK.Ads.load({ format: 'reward' }, (adId) => {
          try {
            OKSDK.Ads.show(adId, () => {
              if (onReward) onReward();
            }, () => {
              if (onNoReward) onNoReward();
            });
          } catch (e) {
            console.warn('[promti] OK Ads.show error:', e);
            if (onNoReward) onNoReward();
          }
        }, () => {
          console.warn('[promti] No OK rewarded ad available');
          if (onNoReward) onNoReward();
        });
      } catch (e) {
        console.warn('[promti] OK Ads.load error:', e);
        if (onNoReward) onNoReward();
      }
      return;
    }

    try {
      // Check if rewarded ad is available (triggers preload if not)
      const checkData = await this._bridge.send('VKWebAppCheckNativeAds', {
        ad_format: 'reward'
      });
      if (!checkData.result) {
        console.warn('[promti] No rewarded ad available');
        if (onNoReward) onNoReward();
        return;
      }
      // Show rewarded ad
      const showData = await this._bridge.send('VKWebAppShowNativeAds', {
        ad_format: 'reward'
      });
      if (showData.result) {
        if (onReward) onReward();
      } else {
        if (onNoReward) onNoReward();
      }
    } catch (e) {
      console.warn('[promti] Rewarded ad error:', e);
      // Graceful fallback: grant reward so user is not blocked
      if (onReward) onReward();
    }
  }

  async _showFullscreenAd(callback) {
    // 1. Try VK Bridge if ready
    if (this.vkBridgeReady) {
      try {
        await this._bridge.send('VKWebAppShowNativeAds', { ad_format: 'interstitial' });
        if (callback) callback();
        return;
      } catch (e) {
        console.warn('[promti] VK Bridge interstitial failed, trying fallback...', e);
      }
    }

    // 2. Fallback to OK/FAPI if on OK
    if (this.platform === 'ok') {
      // Use FAPI if available
      let fapi = null;
      try {
        fapi = (typeof FAPI !== 'undefined' && FAPI) || (window.parent && typeof window.parent.FAPI !== 'undefined' && window.parent.FAPI) || null;
      } catch (e) {}

      if (fapi && fapi.UI && fapi.UI.showAd) {
        const handler = (e) => {
          window.removeEventListener('ok-ads-completed', handler);
          if (callback) callback();
        };
        window.addEventListener('ok-ads-completed', handler);

        try {
          fapi.UI.showAd();
        } catch (e) {
          console.warn('[promti] FAPI showAd error:', e);
          if (callback) callback();
        }
        return;
      }

      // Fallback to OKSDK
      try {
        OKSDK.Ads.load({ format: 'interstitial' }, (adId) => {
          try {
            OKSDK.Ads.show(adId, () => {
              if (callback) callback();
            }, () => {
              if (callback) callback();
            });
          } catch (e) {
            console.warn('[promti] OK interstitial show error:', e);
            if (callback) callback();
          }
        }, () => {
          if (callback) callback();
        });
      } catch (e) {
        console.warn('[promti] OK interstitial load error:', e);
        if (callback) callback();
      }
      return;
    }

    // Final fallback for dev mode
    if (!this.vkBridgeReady && !this.okReady) {
      if (callback) callback();
    }
  }

  // ------------------------------------------------------------------ DICTIONARY COMPLETE
  _showDictionaryComplete() {
    // Update level indicator to show full completion
    const dictPhrases = this.phrases.filter(p => p.dictionary_id === this.currentDictionaryId);
    const total = dictPhrases.length;
    this.el.levelIndicator.textContent = `Уровень ${total} из ${total}`;

    this.el.responseBox.innerHTML = `
      <div class="game-complete">
        <h2>Словарь пройден!</h2>
        <p>Вы объяснили все слова в этом словаре!<br>Нажмите «← Назад», чтобы выбрать другой.</p>
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
