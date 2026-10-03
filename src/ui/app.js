// Bohemarr WebUI Client Application
(function () {
  'use strict';

  // State
  let apiKey = localStorage.getItem('bohemarr_api_key') || '';
  let activeTab = 'search-tab';
  let queuePollInterval = null;
  let activeQueueJobsCount = 0;
  let serverConfig = { categories: ['tv', 'movies'], downloadsDir: '' };
  let previousJobsMap = new Map();

  // DOM Elements
  const authModal = document.getElementById('auth-modal');
  const authInput = document.getElementById('modal-api-key-input');
  const authError = document.getElementById('auth-error-msg');
  const btnSaveApiKey = document.getElementById('btn-save-api-key');
  const btnOpenSettings = document.getElementById('btn-open-settings');

  const tabButtons = document.querySelectorAll('.nav-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const queueCountBadge = document.getElementById('queue-count-badge');
  const navSpeed = document.getElementById('nav-speed');
  const navSpeedText = document.getElementById('nav-speed-text');

  // URL Resolver DOM
  const urlForm = document.getElementById('url-resolver-form');
  const urlInput = document.getElementById('direct-url-input');
  const btnResolveUrl = document.getElementById('btn-resolve-url');
  const urlResolvedResult = document.getElementById('url-resolved-result');

  // Search DOM
  const searchForm = document.getElementById('search-form');
  const searchInput = document.getElementById('search-query-input');
  const searchCategorySelect = document.getElementById('search-category-select');
  const searchProviderSelect = document.getElementById('search-provider-select');
  const btnSearch = document.getElementById('btn-search');
  const searchResultsContainer = document.getElementById('search-results-container');

  // Queue DOM
  const queueListContainer = document.getElementById('queue-list-container');
  const btnPauseAll = document.getElementById('btn-pause-all-queue');
  const btnResumeAll = document.getElementById('btn-resume-all-queue');
  const btnRefreshQueue = document.getElementById('btn-refresh-queue');

  // Downloads DOM
  const downloadsListContainer = document.getElementById('downloads-list-container');
  const btnRefreshDownloads = document.getElementById('btn-refresh-downloads');

  const toastContainer = document.getElementById('toast-container');

  // --- Helpers ---
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 2 : 0) + ' ' + units[i];
  }

  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return '0 KB/s';
    return formatBytes(bytesPerSec) + '/s';
  }

  async function apiRequest(url, options = {}) {
    const headers = options.headers || {};
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }
    options.headers = headers;

    try {
      const response = await fetch(url, options);
      if (response.status === 401) {
        openAuthModal('Platnost API klíče vypršela nebo je neplatný.');
        throw new Error('Neplatný API klíč');
      }
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Chyba serveru (${response.status})`);
      }
      return data;
    } catch (err) {
      throw err;
    }
  }

  // --- Auth Modal ---
  function openAuthModal(errorMsg = '') {
    authModal.style.display = 'flex';
    authInput.value = apiKey;
    if (errorMsg) {
      authError.textContent = errorMsg;
      authError.style.display = 'block';
    } else {
      authError.style.display = 'none';
    }
    authInput.focus();
  }

  function closeAuthModal() {
    authModal.style.display = 'none';
    authError.style.display = 'none';
  }

  async function checkAuthAndInit() {
    if (!apiKey) {
      openAuthModal();
      return;
    }
    try {
      await apiRequest('/api/ui/auth');
      closeAuthModal();
      await loadConfigAndProviders();
      loadQueue();
      startPolling();
    } catch (err) {
      openAuthModal('Nepodařilo se ověřit API klíč.');
    }
  }

  btnSaveApiKey.addEventListener('click', async () => {
    const val = authInput.value.trim();
    if (!val) {
      authError.textContent = 'Zadejte prosím API klíč.';
      authError.style.display = 'block';
      return;
    }
    apiKey = val;
    localStorage.setItem('bohemarr_api_key', apiKey);
    try {
      await apiRequest('/api/ui/auth');
      closeAuthModal();
      showToast('Úspěšně přihlášeno', 'success');
      await loadConfigAndProviders();
      loadQueue();
      startPolling();
    } catch (err) {
      authError.textContent = 'Zadaný API klíč je neplatný.';
      authError.style.display = 'block';
    }
  });

  btnOpenSettings.addEventListener('click', () => openAuthModal());

  // --- Navigation Tabs ---
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      switchTab(targetTab);
    });
  });

  function switchTab(tabId) {
    activeTab = tabId;
    tabButtons.forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === tabId));
    tabPanes.forEach(p => p.classList.toggle('active', p.id === tabId));

    if (tabId === 'queue-tab') {
      loadQueue();
    } else if (tabId === 'downloads-tab') {
      loadDownloads();
    }
  }

  // --- Initial Config & Providers ---
  async function loadConfigAndProviders() {
    try {
      const [conf, provs] = await Promise.all([
        apiRequest('/api/ui/config'),
        apiRequest('/api/ui/providers'),
      ]);
      serverConfig = conf;

      if (conf.version) {
        const badge = document.getElementById('app-version-badge');
        if (badge) {
          badge.textContent = `v${conf.version}`;
          badge.title = `Bohemarr WebUI v${conf.version} (Build ${conf.build || ''})`;
        }
        const modalText = document.getElementById('modal-version-text');
        if (modalText) {
          modalText.textContent = `Bohemarr WebUI v${conf.version} (Build ${conf.build || ''})`;
        }
      }

      // Populate provider select
      searchProviderSelect.innerHTML = '<option value="">Všichni provideři</option>';
      provs.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        searchProviderSelect.appendChild(opt);
      });
    } catch (err) {
      console.error('Failed to load initial config/providers', err);
    }
  }

  // --- URL Resolver ---
  urlForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;

    btnResolveUrl.disabled = true;
    btnResolveUrl.querySelector('.btn-text').textContent = 'Načítám...';
    btnResolveUrl.querySelector('.spinner').style.display = 'inline-block';
    urlResolvedResult.style.display = 'none';

    try {
      const res = await apiRequest('/api/ui/resolve-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      renderResolvedShow(res);
      showToast(`Pořad "${res.title}" byl úspěšně načten`, 'success');
    } catch (err) {
      showToast(err.message || 'Chyba při načítání URL', 'error');
    } finally {
      btnResolveUrl.disabled = false;
      btnResolveUrl.querySelector('.btn-text').textContent = 'Načíst pořad';
      btnResolveUrl.querySelector('.spinner').style.display = 'none';
    }
  });

  function renderResolvedShow(data) {
    urlResolvedResult.style.display = 'block';
    const isTv = data.kind === 'tv';
    const releases = data.releases || [];
    const count = releases.length;

    if (!isTv && count > 0) {
      const rel = releases[0];
      let html = `
        <div class="show-detail-card">
          <div class="show-header">
            <div class="show-title-group">
              <h3>${escapeHtml(data.title)}</h3>
              <div class="show-meta-badges">
                <span class="badge badge-primary">${escapeHtml(data.providerName || data.provider)}</span>
                <span class="badge badge-secondary">Film</span>
              </div>
            </div>
            <div class="show-actions">
              ${rel.isCompleted ? `
                <button class="btn btn-outline btn-sm" disabled>✅ Již staženo</button>
              ` : rel.inQueue ? `
                <button class="btn btn-outline btn-sm" disabled>Ve frontě</button>
              ` : `
                <button class="btn btn-primary btn-sm btn-download-release" data-id="${escapeHtml(rel.id)}">
                  ⬇️ Stáhnout film
                </button>
              `}
            </div>
          </div>
        </div>
      `;
      urlResolvedResult.innerHTML = html;
      urlResolvedResult.querySelectorAll('.btn-download-release').forEach(btn => {
        btn.addEventListener('click', async () => {
          await enqueueRelease(btn.getAttribute('data-id'), btn);
        });
      });
      return;
    }

    // Group releases by season
    const seasonsMap = new Map();
    releases.forEach(rel => {
      let sNum = rel.season;
      if (sNum === undefined || sNum === null || sNum < 0) {
        const match = (rel.title || '').match(/(?:s|série|serie|rada|řada|season)\s*(\d+)/i) || (rel.title || '').match(/s(\d+)e\d+/i);
        sNum = match && match[1] ? parseInt(match[1], 10) : 1;
      }
      if (!seasonsMap.has(sNum)) {
        seasonsMap.set(sNum, []);
      }
      seasonsMap.get(sNum).push(rel);
    });

    const seasonKeys = [...seasonsMap.keys()].sort((a, b) => a - b);
    const hasMultipleSeasons = seasonKeys.length > 1;

    let html = `
      <div class="show-detail-card">
        <div class="show-header">
          <div class="show-title-group">
            <h3>${escapeHtml(data.title)}</h3>
            <div class="show-meta-badges">
              <span class="badge badge-primary">${escapeHtml(data.providerName || data.provider)}</span>
              <span class="badge badge-secondary">Seriál / Pořad</span>
              <span class="badge badge-secondary">${seasonKeys.length} ${seasonKeys.length === 1 ? 'série' : seasonKeys.length < 5 ? 'série' : 'sérií'}</span>
              <span class="badge badge-secondary">${count} ${count === 1 ? 'epizoda' : count < 5 ? 'epizody' : 'epizod'}</span>
            </div>
          </div>
          <div class="show-actions">
            ${count > 1 ? `
              <button class="btn btn-outline btn-sm" id="btn-download-all-episodes" title="Stáhnout všech ${count} epizod ze všech sérií">
                ⬇️ Stáhnout celý seriál (${count})
              </button>
            ` : ''}
          </div>
        </div>
    `;

    // Season quick filter tabs if more than 1 season
    if (hasMultipleSeasons) {
      html += `
        <div class="season-nav-tabs">
          <button class="btn-season-tab active" data-filter="all">Všechny série (${count})</button>
      `;
      seasonKeys.forEach(sNum => {
        const sName = sNum === 0 ? 'Speciály' : `Série ${sNum}`;
        const sCount = seasonsMap.get(sNum).length;
        html += `<button class="btn-season-tab" data-filter="${sNum}">${sName} (${sCount})</button>`;
      });
      html += `</div>`;
    }

    // Render each season
    seasonKeys.forEach(sNum => {
      const sName = sNum === 0 ? 'Speciály (0. série)' : `Série ${sNum}`;
      const seasonReleases = seasonsMap.get(sNum);
      seasonReleases.sort((a, b) => (a.episode || 0) - (b.episode || 0));

      const availableCount = seasonReleases.filter(r => !r.inQueue && !r.isCompleted).length;
      const completedCount = seasonReleases.filter(r => r.isCompleted).length;
      const queueCount = seasonReleases.filter(r => r.inQueue).length;

      html += `
        <div class="season-section" data-season-num="${sNum}">
          <div class="season-section-header">
            <div class="season-title-box">
              <h4 class="season-title">📁 ${sName}</h4>
              <div class="show-meta-badges">
                <span class="badge badge-secondary">${seasonReleases.length} ${seasonReleases.length === 1 ? 'epizoda' : seasonReleases.length < 5 ? 'epizody' : 'epizod'}</span>
                ${availableCount > 0 ? `<span class="badge badge-primary">${availableCount} ke stažení</span>` : ''}
                ${queueCount > 0 ? `<span class="badge badge-warning">${queueCount} ve frontě</span>` : ''}
                ${completedCount > 0 ? `<span class="badge badge-success">${completedCount} hotovo</span>` : ''}
              </div>
            </div>
            <div class="season-actions">
              ${availableCount > 1 ? `
                <label class="season-select-all-label">
                  <input type="checkbox" class="cb-select-season-all" data-season="${sNum}"> Vybrat
                </label>
                <button class="btn btn-outline btn-sm btn-download-selected-season" data-season="${sNum}" style="display: none;">
                  ⬇️ Stáhnout vybrané (<span class="selected-count">0</span>)
                </button>
              ` : ''}
              ${availableCount > 0 ? `
                <button class="btn btn-primary btn-sm btn-download-season" data-season="${sNum}">
                  ⬇️ Stáhnout ${sName} (${availableCount})
                </button>
              ` : `
                <button class="btn btn-outline btn-sm" disabled>
                  ✅ ${completedCount === seasonReleases.length ? 'Série stažena' : 'Vše ve frontě'}
                </button>
              `}
            </div>
          </div>

          <div class="episodes-table-container">
            <table class="table">
              <thead>
                <tr>
                  <th style="width: 40px; text-align: center;"></th>
                  <th style="width: 90px;">Epizoda</th>
                  <th>Název epizody</th>
                  <th style="width: 120px;">Stav</th>
                  <th style="width: 130px; text-align: right;">Akce</th>
                </tr>
              </thead>
              <tbody>
      `;

      seasonReleases.forEach(rel => {
        const epLabel = rel.season && rel.episode ? `S${String(rel.season).padStart(2, '0')}E${String(rel.episode).padStart(2, '0')}` : (rel.episode ? `E${rel.episode}` : '—');
        const statusBadge = rel.isCompleted ? '<span class="badge badge-success">Dokončeno</span>'
          : rel.inQueue ? `<span class="badge badge-warning">${rel.status === 'Downloading' ? 'Stahuje se' : 'Ve frontě'}</span>`
          : '<span class="badge badge-secondary">K dispozici</span>';

        const canSelect = !rel.inQueue && !rel.isCompleted;

        html += `
          <tr data-release-id="${escapeHtml(rel.id)}">
            <td style="text-align: center;">
              <input type="checkbox" class="ep-checkbox" data-season="${sNum}" data-id="${escapeHtml(rel.id)}" ${!canSelect ? 'disabled' : ''}>
            </td>
            <td><strong>${escapeHtml(epLabel)}</strong></td>
            <td>${escapeHtml(rel.title)}</td>
            <td class="status-cell">${statusBadge}</td>
            <td style="text-align: right;">
              ${rel.isCompleted ? `
                <button class="btn btn-outline btn-sm" disabled>Hotovo</button>
              ` : rel.inQueue ? `
                <button class="btn btn-outline btn-sm" disabled>Ve frontě</button>
              ` : `
                <button class="btn btn-primary btn-sm btn-download-release" data-id="${escapeHtml(rel.id)}">
                  ⬇️ Stáhnout
                </button>
              `}
            </td>
          </tr>
        `;
      });

      html += `
              </tbody>
            </table>
          </div>
        </div>
      `;
    });

    html += `</div>`;
    urlResolvedResult.innerHTML = html;

    // Attach Event Listeners
    // 1. Single episode download
    urlResolvedResult.querySelectorAll('.btn-download-release').forEach(btn => {
      btn.addEventListener('click', async () => {
        const relId = btn.getAttribute('data-id');
        await enqueueRelease(relId, btn);
      });
    });

    // 2. Season Tab Filter
    urlResolvedResult.querySelectorAll('.btn-season-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        urlResolvedResult.querySelectorAll('.btn-season-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const filter = tab.getAttribute('data-filter');
        urlResolvedResult.querySelectorAll('.season-section').forEach(sec => {
          if (filter === 'all' || sec.getAttribute('data-season-num') === filter) {
            sec.style.display = 'block';
          } else {
            sec.style.display = 'none';
          }
        });
      });
    });

    // 3. Download entire season
    urlResolvedResult.querySelectorAll('.btn-download-season').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sNum = parseInt(btn.getAttribute('data-season'), 10);
        const sReleases = seasonsMap.get(sNum) || [];
        btn.disabled = true;
        btn.textContent = 'Přidávám do fronty...';

        let addedCount = 0;
        for (const rel of sReleases) {
          if (!rel.inQueue && !rel.isCompleted) {
            try {
              await apiRequest('/api/ui/queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ releaseId: rel.id, category: 'tv' }),
              });
              rel.inQueue = true;
              addedCount++;

              // Update row in UI
              const row = urlResolvedResult.querySelector(`tr[data-release-id="${rel.id}"]`);
              if (row) {
                const statusCell = row.querySelector('.status-cell');
                if (statusCell) statusCell.innerHTML = '<span class="badge badge-warning">Ve frontě</span>';
                const rowBtn = row.querySelector('.btn-download-release');
                if (rowBtn) {
                  rowBtn.disabled = true;
                  rowBtn.textContent = 'Ve frontě';
                  rowBtn.classList.remove('btn-primary');
                  rowBtn.classList.add('btn-outline');
                }
                const cb = row.querySelector('.ep-checkbox');
                if (cb) {
                  cb.disabled = true;
                  cb.checked = false;
                }
              }
            } catch (err) {
              console.error('Failed to enqueue release', rel.id, err);
            }
          }
        }

        const sTitle = sNum === 0 ? 'Speciály' : `Série ${sNum}`;
        showToast(`Přidáno ${addedCount} epizod ze ${sTitle} do fronty`, 'success');
        btn.textContent = '✅ Série přidána';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-outline');
        loadQueue();
      });
    });

    // 4. Checkbox Multi-selection within seasons
    urlResolvedResult.querySelectorAll('.season-section').forEach(sec => {
      const sNum = sec.getAttribute('data-season-num');
      const selectAllCb = sec.querySelector('.cb-select-season-all');
      const btnDownloadSelected = sec.querySelector('.btn-download-selected-season');
      const epCheckboxes = sec.querySelectorAll('.ep-checkbox:not(:disabled)');

      function updateSelectedState() {
        if (!btnDownloadSelected) return;
        const checked = sec.querySelectorAll('.ep-checkbox:checked');
        const count = checked.length;
        if (count > 0) {
          btnDownloadSelected.style.display = 'inline-flex';
          const cntSpan = btnDownloadSelected.querySelector('.selected-count');
          if (cntSpan) cntSpan.textContent = count;
        } else {
          btnDownloadSelected.style.display = 'none';
        }
        if (selectAllCb) {
          selectAllCb.checked = count > 0 && count === epCheckboxes.length;
        }
      }

      if (selectAllCb) {
        selectAllCb.addEventListener('change', () => {
          epCheckboxes.forEach(cb => { cb.checked = selectAllCb.checked; });
          updateSelectedState();
        });
      }

      epCheckboxes.forEach(cb => {
        cb.addEventListener('change', updateSelectedState);
      });

      if (btnDownloadSelected) {
        btnDownloadSelected.addEventListener('click', async () => {
          btnDownloadSelected.disabled = true;
          btnDownloadSelected.textContent = 'Přidávám...';
          const checked = sec.querySelectorAll('.ep-checkbox:checked');
          let addedCount = 0;
          for (const cb of checked) {
            const relId = cb.getAttribute('data-id');
            try {
              await apiRequest('/api/ui/queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ releaseId: relId, category: 'tv' }),
              });
              addedCount++;
              const row = sec.querySelector(`tr[data-release-id="${relId}"]`);
              if (row) {
                const statusCell = row.querySelector('.status-cell');
                if (statusCell) statusCell.innerHTML = '<span class="badge badge-warning">Ve frontě</span>';
                const rowBtn = row.querySelector('.btn-download-release');
                if (rowBtn) {
                  rowBtn.disabled = true;
                  rowBtn.textContent = 'Ve frontě';
                  rowBtn.classList.remove('btn-primary');
                  rowBtn.classList.add('btn-outline');
                }
                cb.disabled = true;
                cb.checked = false;
              }
            } catch (err) {
              console.error('Failed to enqueue release', relId, err);
            }
          }
          showToast(`Přidáno ${addedCount} vybraných epizod do fronty`, 'success');
          btnDownloadSelected.style.display = 'none';
          btnDownloadSelected.disabled = false;
          if (selectAllCb) selectAllCb.checked = false;
          loadQueue();
        });
      }
    });

    // 5. Download all episodes (global)
    const btnDownloadAll = document.getElementById('btn-download-all-episodes');
    if (btnDownloadAll) {
      btnDownloadAll.addEventListener('click', async () => {
        btnDownloadAll.disabled = true;
        btnDownloadAll.textContent = 'Přidávám celý seriál...';
        let addedCount = 0;
        for (const rel of releases) {
          if (!rel.inQueue && !rel.isCompleted) {
            try {
              await apiRequest('/api/ui/queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ releaseId: rel.id, category: 'tv' }),
              });
              rel.inQueue = true;
              addedCount++;
            } catch (err) {
              console.error('Failed to enqueue', rel.id, err);
            }
          }
        }
        showToast(`Přidáno ${addedCount} epizod do fronty`, 'success');
        btnDownloadAll.textContent = '✅ Vše přidáno';
        btnDownloadAll.disabled = true;
        loadQueue();
      });
    }
  }

  async function enqueueRelease(releaseId, btnElement = null) {
    if (btnElement) {
      btnElement.disabled = true;
      btnElement.textContent = 'Přidávám...';
    }
    try {
      await apiRequest('/api/ui/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ releaseId }),
      });
      showToast('Položka přidána do fronty stahování', 'success');
      if (btnElement) {
        btnElement.className = 'btn btn-outline btn-sm';
        btnElement.textContent = 'Ve frontě';
      }
      loadQueue();
    } catch (err) {
      showToast(err.message || 'Nepodařilo se přidat do fronty', 'error');
      if (btnElement) {
        btnElement.disabled = false;
        btnElement.textContent = '⬇️ Stáhnout';
      }
    }
  }

  // --- Search in Archives ---
  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (!q) return;

    btnSearch.disabled = true;
    btnSearch.querySelector('.btn-text').textContent = 'Hledám...';
    btnSearch.querySelector('.spinner').style.display = 'inline-block';
    searchResultsContainer.innerHTML = '<div class="empty-state"><span class="spinner"></span><p class="mt-2">Prohledávám archivy...</p></div>';

    const category = searchCategorySelect.value;
    const provider = searchProviderSelect.value;

    const params = new URLSearchParams({ q });
    if (category) params.set('category', category);
    if (provider) params.set('provider', provider);

    try {
      const res = await apiRequest(`/api/ui/search?${params.toString()}`);
      renderSearchResults(res.results || []);
    } catch (err) {
      searchResultsContainer.innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message || 'Chyba při vyhledávání')}</div>`;
    } finally {
      btnSearch.disabled = false;
      btnSearch.querySelector('.btn-text').textContent = 'Vyhledat';
      btnSearch.querySelector('.spinner').style.display = 'none';
    }
  });

  function renderSearchResults(results) {
    if (!results.length) {
      searchResultsContainer.innerHTML = '<div class="empty-state">Nebyly nalezeny žádné výsledky odpovídající dotazu.</div>';
      return;
    }

    let html = `<div class="results-grid">`;
    results.forEach(rel => {
      const epLabel = rel.season && rel.episode ? `S${String(rel.season).padStart(2, '0')}E${String(rel.episode).padStart(2, '0')}` : '';
      const quality = rel.height ? `${rel.height}p` : '';
      const sizeStr = rel.size ? formatBytes(rel.size) : '';

      html += `
        <div class="result-card">
          <div>
            <div class="result-title">${escapeHtml(rel.title)}</div>
            <div class="result-meta mt-2">
              <span class="badge badge-primary">${escapeHtml(rel.provider)}</span>
              ${rel.kind === 'tv' ? '<span class="badge badge-secondary">Seriál</span>' : '<span class="badge badge-secondary">Film</span>'}
              ${epLabel ? `<span class="badge badge-secondary">${escapeHtml(epLabel)}</span>` : ''}
              ${quality ? `<span class="badge badge-secondary">${quality}</span>` : ''}
              ${sizeStr ? `<span class="text-muted">${sizeStr}</span>` : ''}
            </div>
          </div>
          <div class="result-footer">
            <span class="text-muted" style="font-size: 0.75rem;">${rel.year || ''}</span>
            ${rel.inQueue ? `
              <button class="btn btn-outline btn-sm" disabled>Ve frontě</button>
            ` : `
              <button class="btn btn-primary btn-sm btn-search-download" data-id="${escapeHtml(rel.id)}">
                ⬇️ Stáhnout
              </button>
            `}
          </div>
        </div>
      `;
    });
    html += `</div>`;
    searchResultsContainer.innerHTML = html;

    searchResultsContainer.querySelectorAll('.btn-search-download').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        await enqueueRelease(id, btn);
      });
    });
  }

  // --- Queue Management ---
  async function loadQueue() {
    try {
      const res = await apiRequest('/api/ui/queue');
      const jobs = res.jobs || [];
      activeQueueJobsCount = jobs.filter(j => j.status === 'Downloading' || j.status === 'Queued').length;

      // Detect completed jobs
      const currentJobIds = new Set(jobs.map(j => j.id));
      for (const [prevId, prevJob] of previousJobsMap.entries()) {
        if (!currentJobIds.has(prevId) && (prevJob.status === 'Downloading' || prevJob.status === 'Queued')) {
          apiRequest('/api/ui/downloads').then(dlRes => {
            const completed = (dlRes.downloads || []).find(d => d.id === prevId && d.status === 'Completed');
            if (completed) {
              showToast(`🎉 Stahování "${prevJob.title}" bylo dokončeno! Soubor najdete v záložce "Stažené soubory".`, 'success');
              if (activeTab === 'downloads-tab') {
                loadDownloads();
              }
            }
          }).catch(() => {});
        }
      }
      previousJobsMap = new Map(jobs.map(j => [j.id, { title: j.title, status: j.status }]));

      // Update badge
      if (activeQueueJobsCount > 0) {
        queueCountBadge.textContent = activeQueueJobsCount;
        queueCountBadge.style.display = 'inline-flex';
      } else {
        queueCountBadge.style.display = 'none';
      }

      // Update navbar total speed
      const totalSpeed = jobs.reduce((sum, j) => sum + (j.speed || 0), 0);
      if (totalSpeed > 0) {
        navSpeedText.textContent = formatSpeed(totalSpeed);
        navSpeed.style.display = 'flex';
      } else {
        navSpeed.style.display = 'none';
      }

      if (activeTab === 'queue-tab') {
        renderQueue(jobs, res.paused);
      }
    } catch (err) {
      console.error('Queue load error', err);
    }
  }

  function renderQueue(jobs, isPaused) {
    if (!jobs.length) {
      queueListContainer.innerHTML = `
        <div class="empty-state">
          <p>Fronta stahování je prázdná.</p>
          <p class="text-muted mt-2">Všechna stahování byla dokončena nebo můžete přidat nové pořady přes záložku <a href="#" id="link-go-search" style="color: #38bdf8; text-decoration: underline;">Hledat & URL</a>.</p>
          <p class="text-muted mt-1">Dokončené soubory najdete v záložce <a href="#" id="link-go-downloads" style="color: #38bdf8; text-decoration: underline;">Stažené soubory</a>.</p>
        </div>
      `;
      const linkSearch = document.getElementById('link-go-search');
      if (linkSearch) linkSearch.addEventListener('click', (e) => { e.preventDefault(); switchTab('search-tab'); });
      const linkDl = document.getElementById('link-go-downloads');
      if (linkDl) linkDl.addEventListener('click', (e) => { e.preventDefault(); switchTab('downloads-tab'); });
      return;
    }

    let html = '';
    jobs.forEach(job => {
      const isDownloading = job.status === 'Downloading';
      const isJobPaused = job.status === 'Paused';
      const statusBadge = isDownloading ? '<span class="badge badge-primary">Stahuje se</span>'
        : isJobPaused ? '<span class="badge badge-warning">Pozastaveno</span>'
        : job.status === 'Failed' ? '<span class="badge badge-danger">Chyba</span>'
        : '<span class="badge badge-secondary">Čeká</span>';

      const downloadedStr = formatBytes(job.bytes);
      const totalStr = job.totalBytes > 0 ? formatBytes(job.totalBytes) : '';
      const sizeDisplay = totalStr ? `${downloadedStr} / ${totalStr}` : downloadedStr;
      const speedStr = isDownloading && job.speed > 0 ? formatSpeed(job.speed) : '';

      html += `
        <div class="queue-row" data-job-id="${escapeHtml(job.id)}">
          <div class="queue-info">
            <div class="queue-title" title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</div>
            <div class="queue-details">
              <span class="badge badge-secondary">${escapeHtml(job.provider)}</span>
              <span class="badge badge-secondary">${escapeHtml(job.category)}</span>
              ${statusBadge}
              ${speedStr ? `<strong style="color: #38bdf8;">${speedStr}</strong>` : ''}
              ${job.error ? `<span class="text-muted" style="color: #ef4444;" title="${escapeHtml(job.error)}">${escapeHtml(job.error)}</span>` : ''}
            </div>
          </div>

          <div class="queue-progress-bar-container">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${job.progress}%;"></div>
            </div>
            <div class="progress-text">
              <span>${sizeDisplay}</span>
              <span><strong>${job.progress}%</strong></span>
            </div>
          </div>

          <div class="queue-actions">
            ${isDownloading ? `
              <button class="btn btn-outline btn-sm btn-pause-job" data-id="${escapeHtml(job.id)}" title="Pozastavit">⏸️</button>
            ` : isJobPaused ? `
              <button class="btn btn-outline btn-sm btn-resume-job" data-id="${escapeHtml(job.id)}" title="Spustit">▶️</button>
            ` : ''}
            <button class="btn btn-danger btn-sm btn-delete-job" data-id="${escapeHtml(job.id)}" title="Zrušit stahování">🗑️</button>
          </div>
        </div>
      `;
    });

    queueListContainer.innerHTML = html;

    // Attach actions
    queueListContainer.querySelectorAll('.btn-pause-job').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        await apiRequest('/api/ui/queue/pause', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        loadQueue();
      });
    });

    queueListContainer.querySelectorAll('.btn-resume-job').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        await apiRequest('/api/ui/queue/resume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        loadQueue();
      });
    });

    queueListContainer.querySelectorAll('.btn-delete-job').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (confirm('Opravdu chcete zrušit toto stahování?')) {
          await apiRequest(`/api/ui/queue/${id}`, { method: 'DELETE' });
          showToast('Úloha byla zrušena', 'info');
          loadQueue();
        }
      });
    });
  }

  btnPauseAll.addEventListener('click', async () => {
    await apiRequest('/api/ui/queue/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    showToast('Fronta pozastavena', 'info');
    loadQueue();
  });

  btnResumeAll.addEventListener('click', async () => {
    await apiRequest('/api/ui/queue/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    showToast('Fronta spuštěna', 'info');
    loadQueue();
  });

  btnRefreshQueue.addEventListener('click', () => loadQueue());

  // --- Completed Downloads / History ---
  async function loadDownloads() {
    downloadsListContainer.innerHTML = '<div class="empty-state"><span class="spinner"></span><p class="mt-2">Načítám dokončené soubory...</p></div>';
    try {
      const res = await apiRequest('/api/ui/downloads');
      renderDownloads(res.downloads || []);
    } catch (err) {
      downloadsListContainer.innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message || 'Chyba při načítání souborů')}</div>`;
    }
  }

  function renderDownloads(downloads) {
    if (!downloads.length) {
      downloadsListContainer.innerHTML = '<div class="empty-state">Zatím nebyly dokončeny žádné soubory ke stažení.</div>';
      return;
    }

    let html = '';
    downloads.forEach(item => {
      const isFailed = item.status === 'Failed';
      const statusBadge = isFailed ? '<span class="badge badge-danger">Selhalo</span>' : '<span class="badge badge-success">Dokončeno</span>';
      const dateStr = item.finishedAt ? new Date(item.finishedAt).toLocaleString('cs-CZ') : '';
      const sizeStr = item.bytes ? formatBytes(item.bytes) : '0 B';
      const displayPath = item.filePath || item.storage;

      html += `
        <div class="download-row">
          <div class="download-row-header">
            <div>
              <div class="download-title">${escapeHtml(item.title)}</div>
              <div class="result-meta mt-1">
                <span class="badge badge-primary">${escapeHtml(item.provider)}</span>
                <span class="badge badge-secondary">${escapeHtml(item.category)}</span>
                ${statusBadge}
                <span class="text-muted">${sizeStr}</span>
                <span class="text-muted">${dateStr}</span>
              </div>
            </div>
            <div class="d-flex items-center gap-2">
              ${!isFailed && item.hasFile ? `
                <a href="${item.downloadUrl}?apikey=${encodeURIComponent(apiKey)}" class="btn btn-primary btn-sm" download>
                  📥 Stáhnout do PC
                </a>
              ` : ''}
              ${isFailed ? `
                <button class="btn btn-outline btn-sm btn-retry-download" data-id="${escapeHtml(item.id)}">
                  🔄 Opakovat
                </button>
              ` : ''}
              <button class="btn btn-danger btn-sm btn-delete-history" data-id="${escapeHtml(item.id)}">
                🗑️ Smazat
              </button>
            </div>
          </div>

          <div class="download-row-body">
            <div class="file-path-box" title="Absolutní cesta pro transkódování">
              <span>📁 ${escapeHtml(displayPath)}</span>
              <button class="btn-copy-path" data-path="${escapeHtml(displayPath)}" title="Kopírovat cestu do schránky">
                📋 Kopírovat
              </button>
            </div>
            ${item.error ? `<div class="text-muted" style="color: #ef4444; font-size: 0.8rem;">Chyba: ${escapeHtml(item.error)}</div>` : ''}
          </div>
        </div>
      `;
    });

    downloadsListContainer.innerHTML = html;

    // Attach copy path events
    downloadsListContainer.querySelectorAll('.btn-copy-path').forEach(btn => {
      btn.addEventListener('click', () => {
        const path = btn.getAttribute('data-path');
        navigator.clipboard.writeText(path).then(() => {
          showToast('Cesta zkopírována do schránky', 'success');
        }).catch(() => {
          showToast('Cestu se nepodařilo zkopírovat', 'error');
        });
      });
    });

    downloadsListContainer.querySelectorAll('.btn-retry-download').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        try {
          await apiRequest(`/api/ui/queue/${id}/retry`, { method: 'POST' });
          showToast('Úloha byla zařazena k novému stažení', 'success');
          loadDownloads();
        } catch (err) {
          showToast(err.message || 'Chyba při opakování', 'error');
        }
      });
    });

    downloadsListContainer.querySelectorAll('.btn-delete-history').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const deleteDisk = confirm('Chcete smazat záznam z historie včetně souborů na disku? (Stiskněte Storno pro ponechání souborů na disku a smazání pouze záznamu)');
        try {
          await apiRequest(`/api/ui/downloads/${id}?deleteFiles=${deleteDisk ? '1' : '0'}`, { method: 'DELETE' });
          showToast('Záznam smazán', 'info');
          loadDownloads();
        } catch (err) {
          showToast(err.message || 'Chyba při mazání', 'error');
        }
      });
    });
  }

  btnRefreshDownloads.addEventListener('click', () => loadDownloads());

  // --- Real-time Polling ---
  function startPolling() {
    if (queuePollInterval) clearInterval(queuePollInterval);
    queuePollInterval = setInterval(() => {
      if (apiKey) {
        loadQueue();
      }
    }, 1500);
  }

  function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Initial Run
  checkAuthAndInit();
})();
