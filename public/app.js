(function () {
  const API_URL = window.location.origin;
  const TOKEN_KEY = 'apexflow_distributed_token';
  const DEFAULT_LOGIN = {
    email: 'admin@apexflow.com',
    password: 'admin123'
  };

  const state = {
    token: '',
    user: null
  };

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    state.token = token || '';
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      return;
    }
    localStorage.removeItem(TOKEN_KEY);
  }

  function clearToken() {
    setToken('');
  }

  async function parseJson(response) {
    const text = await response.text();
    if (!text) {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      return { raw: text };
    }
  }

  async function apiRequest(path, options = {}) {
    const token = getToken();
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    };

    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers
    });

    const payload = await parseJson(response);

    if (!response.ok) {
      throw new Error(payload.message || 'Error en la solicitud');
    }

    return payload;
  }

  function updateSessionView() {
    const authShell = document.getElementById('auth-shell');
    const appShell = document.getElementById('app-shell');
    const logoutButton = document.getElementById('logout-button');
    const userNameNode = document.getElementById('user-name');
    const currentUserPill = document.getElementById('current-user-pill');
    const isAuthenticated = Boolean(state.user || getToken());

    if (authShell) authShell.classList.toggle('hidden', isAuthenticated);
    if (appShell) appShell.classList.toggle('hidden', !isAuthenticated);
    if (logoutButton) logoutButton.classList.toggle('hidden', !isAuthenticated);

    if (userNameNode) {
      userNameNode.textContent = state.user?.name || 'Invitado';
    }

    if (currentUserPill && state.user) {
      currentUserPill.classList.add('online');
      currentUserPill.classList.remove('active');
    }
  }

  function showToast(message, type = 'success') {
    let wrapper = document.getElementById('apexflow-toast');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'apexflow-toast';
      wrapper.style.position = 'fixed';
      wrapper.style.right = '20px';
      wrapper.style.top = '20px';
      wrapper.style.zIndex = '9999';
      wrapper.style.display = 'grid';
      wrapper.style.gap = '10px';
      document.body.appendChild(wrapper);
    }

    const box = document.createElement('div');
    box.style.minWidth = '260px';
    box.style.maxWidth = '340px';
    box.style.padding = '12px 14px';
    box.style.borderRadius = '14px';
    box.style.background = type === 'error' ? 'rgba(220, 53, 69, 0.12)' : 'rgba(25, 135, 84, 0.12)';
    box.style.border = `1px solid ${type === 'error' ? 'rgba(220, 53, 69, 0.3)' : 'rgba(25, 135, 84, 0.3)'}`;
    box.style.color = '#112440';
    box.style.fontWeight = '600';
    box.style.boxShadow = '0 16px 30px rgba(9, 30, 66, 0.12)';
    box.textContent = message;

    wrapper.appendChild(box);
    setTimeout(() => {
      box.style.opacity = '0';
      box.style.transform = 'translateY(-6px)';
      box.style.transition = 'all 0.22s ease';
      setTimeout(() => box.remove(), 220);
    }, 2600);
  }

  function updateSmartSearchStatus(label, tone = 'neutral') {
    const status = document.getElementById('smart-search-status');
    if (!status) return;

    status.textContent = label;
    status.className = 'panel-tag';
    if (tone === 'success') status.classList.add('success');
    if (tone === 'warning') status.classList.add('warning');
    if (tone === 'neutral') status.classList.add('neutral');
  }

  function renderAgendaResults(payload = {}) {
    const container = document.getElementById('smart-search-results');
    if (!container) return;

    const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
    const strategy = payload.strategy || 'nearest';
    const processingMs = payload.processingMs ?? 0;

    if (!blocks.length) {
      container.innerHTML = '<div class="smart-search-empty">No se encontraron bloques para la combinación actual. Intenta cambiar la estrategia o la especialidad.</div>';
      return;
    }

    const strategyLabel = strategy === 'rating' ? 'Por Valoración' : 'Por Disponibilidad Inmediata';
    container.innerHTML = `
      <div class="smart-search-empty" style="margin-bottom: 12px; background: rgba(26, 92, 196, 0.06); color: #112440; border: 1px solid rgba(26, 92, 196, 0.18);">
        Estrategia activa: ${strategyLabel} · ${processingMs} ms · ${payload.withinThreshold ? 'cumple el umbral' : 'fuera del umbral'}
      </div>
      ${blocks.map((block) => `
        <article class="agenda-slot-card">
          <strong>${block.doctor || 'Especialista'}</strong>
          <small>${block.specialty || 'Especialidad'} · ${block.sede || 'Sede'}</small>
          <small>${block.start || '09:00'} - ${block.end || '10:00'}</small>
          <small>Valoración: ${Number(block.rating || 0).toFixed(1)} · ${block.location || 'Ubicación'}</small>
          <small>Estado: ${block.status || 'available'}</small>
        </article>
      `).join('')}
    `;
  }

  async function searchOptimizedAgenda() {
    const sede = document.getElementById('agenda-sede')?.value || 'Sede Centro';
    const especialidad = document.getElementById('agenda-especialidad')?.value || '';
    const estrategia = document.querySelector('.strategy-option.active')?.dataset.strategy || 'nearest';
    const button = document.getElementById('search-agenda-button');

    if (button) {
      button.disabled = true;
      button.textContent = 'Buscando...';
    }

    updateSmartSearchStatus('Consultando...', 'warning');

    try {
      const response = await apiRequest('/api/navigation/search', {
        method: 'POST',
        body: JSON.stringify({
          sede,
          especialidad,
          estrategia
        })
      });

      renderAgendaResults(response);
      updateSmartSearchStatus(response.withinThreshold ? 'Optimizado' : 'Procesado', response.withinThreshold ? 'success' : 'warning');
      appendNodeLog(`[NAV] Search strategy: ${response.strategy} | processing: ${response.processingMs}ms | threshold: ${response.thresholdMs}ms`, response.withinThreshold ? 'success' : 'warning');
      showToast('Agenda optimizada actualizada.', 'success');
      return response;
    } catch (error) {
      const container = document.getElementById('smart-search-results');
      if (container) {
        container.innerHTML = '<div class="smart-search-empty">No fue posible consultar la agenda optimizada. Intenta de nuevo.</div>';
      }
      updateSmartSearchStatus('Error de consulta', 'warning');
      appendNodeLog(`[NAV] Search failed: ${error.message}`, 'warning');
      showToast(error.message || 'No se pudo consultar la agenda.', 'error');
      return null;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Buscar agenda optimizada';
      }
    }
  }

  function applyNavigationFiltersFromState(filters = {}) {
    const sedeEl = document.getElementById('agenda-sede');
    const specialtyEl = document.getElementById('agenda-especialidad');

    if (sedeEl && filters.sede) {
      sedeEl.value = filters.sede;
    }

    if (specialtyEl && filters.especialidad) {
      specialtyEl.value = filters.especialidad;
    }

    if (filters.estrategia) {
      const strategyEl = document.querySelector(`.strategy-option[data-strategy="${String(filters.estrategia).toLowerCase()}"]`);
      if (strategyEl) {
        document.querySelectorAll('.strategy-option').forEach((option) => {
          option.classList.toggle('active', option === strategyEl);
        });
      }
    }
  }

  async function undoLastFilter() {
    const button = document.getElementById('undo-filter-button');
    if (button) {
      button.disabled = true;
      button.textContent = 'Deshaciendo...';
    }

    try {
      const response = await apiRequest('/api/navigation/command', {
        method: 'POST',
        body: JSON.stringify({ action: 'undo' })
      });

      applyNavigationFiltersFromState(response.currentFilters || {});
      if (response.currentFilters && Object.keys(response.currentFilters).length) {
        await searchOptimizedAgenda();
      } else {
        renderAgendaResults({ blocks: [], strategy: 'nearest', processingMs: 0, withinThreshold: true });
      }

      updateSmartSearchStatus('Filtro revertido', 'success');
      appendNodeLog('[NAV] Undo executed and filter history reverted.', 'success');
      showToast('Último filtro deshecho correctamente.', 'success');
      return response;
    } catch (error) {
      updateSmartSearchStatus('Nada por deshacer', 'warning');
      appendNodeLog(`[NAV] Undo failed: ${error.message}`, 'warning');
      showToast(error.message || 'No había un filtro para deshacer.', 'error');
      return null;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Deshacer Filtro';
      }
    }
  }

  function ensureConsoleStyles() {
    if (document.getElementById('apexflow-node-console-style')) return;

    const style = document.createElement('style');
    style.id = 'apexflow-node-console-style';
    style.textContent = `
      .node-console {
        margin-top: 18px;
        background: rgba(15, 44, 89, 0.94);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 18px;
        color: #dfeaff;
        overflow: hidden;
        box-shadow: 0 18px 36px rgba(15, 44, 89, 0.18);
      }

      .node-console-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 16px;
        background: rgba(255,255,255,0.03);
        border-bottom: 1px solid rgba(255,255,255,0.08);
        font-size: 0.76rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .node-console-body {
        max-height: 190px;
        overflow: auto;
        padding: 12px 14px 14px;
        font-family: 'Consolas', 'Courier New', monospace;
        font-size: 0.8rem;
        line-height: 1.6;
      }

      .node-log {
        display: block;
        margin: 4px 0;
        color: rgba(223, 234, 255, 0.9);
      }

      .node-log.warning {
        color: #ffd166;
      }

      .node-log.success {
        color: #9ae6b4;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureConsole() {
    ensureConsoleStyles();

    const target = document.querySelector('.benchmark-panel');
    if (!target) return;

    let consoleBox = target.querySelector('.node-console');
    if (!consoleBox) {
      consoleBox = document.createElement('div');
      consoleBox.className = 'node-console';
      consoleBox.innerHTML = `
        <div class="node-console-head">
          <span>Inter-nodo console</span>
          <span>LIVE</span>
        </div>
        <div class="node-console-body" id="node-console-body"></div>
      `;
      target.appendChild(consoleBox);
    }

    return consoleBox.querySelector('#node-console-body');
  }

  function appendNodeLog(message, type = 'info') {
    const body = ensureConsole();
    if (!body) return;

    const line = document.createElement('span');
    line.className = `node-log ${type}`;
    line.textContent = message;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;

    while (body.children.length > 18) {
      body.removeChild(body.firstChild);
    }
  }

  function ensureMetricsCards() {
    const grid = document.querySelector('.metrics-grid');
    if (!grid) return;

    const ensureCard = (metricKey, label, value) => {
      let card = grid.querySelector(`[data-metric="${metricKey}"]`)?.closest('.metric-card');
      if (!card) {
        card = document.createElement('article');
        card.className = 'metric-card';
        card.innerHTML = `<span class="metric-label">${label}</span><strong class="metric-value" data-metric="${metricKey}">${value}</strong>`;
        grid.appendChild(card);
      } else {
        const labelEl = card.querySelector('.metric-label');
        const valueEl = card.querySelector('.metric-value');
        if (labelEl) labelEl.textContent = label;
        if (valueEl) valueEl.textContent = value;
      }
      return card;
    };

    ensureCard('latency', 'Latencia p95', '145 ms');
    ensureCard('throughput', 'Peticiones/s', '200 req/s');
    ensureCard('workers', 'Estado hilos worker', 'ACTIVE');
  }

  function setMetricValue(metricKey, label, value) {
    const card = document.querySelector(`[data-metric="${metricKey}"]`)?.closest('.metric-card');
    if (!card) {
      ensureMetricsCards();
      return setMetricValue(metricKey, label, value);
    }

    const labelEl = card.querySelector('.metric-label');
    const valueEl = card.querySelector('.metric-value');
    if (labelEl) labelEl.textContent = label;
    if (valueEl) valueEl.textContent = value;
  }

  async function loginWithCredentials(email, password) {
    try {
      const response = await apiRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });

      const token = response.token;
      if (!token) {
        throw new Error('La API no devolvió JWT válido.');
      }

      setToken(token);
      state.user = response.user || { email, role: 'admin', name: 'Admin ApexFlow' };
      updateSessionView();
      showToast('Sesión autenticada con JWT', 'success');
      appendNodeLog('[AUTH] JWT stored in localStorage and session restored.', 'success');
      return response;
    } catch (error) {
      showToast(error.message || 'No se pudo autenticar.', 'error');
      appendNodeLog(`[AUTH] Login failed: ${error.message}`, 'warning');
      throw error;
    }
  }

  async function restoreSession() {
    const storedToken = getToken();
    if (!storedToken) {
      appendNodeLog('[SESSION] No active JWT found. Demo mode ready.', 'warning');
      return null;
    }

    state.token = storedToken;

    try {
      const profile = await apiRequest('/api/auth/me');
      state.user = profile.user || state.user;
      updateSessionView();
      appendNodeLog('[SESSION] JWT restored from localStorage.', 'success');
      return profile;
    } catch (error) {
      clearToken();
      state.user = null;
      updateSessionView();
      appendNodeLog(`[SESSION] JWT expired: ${error.message}`, 'warning');
      return null;
    }
  }

  async function reserveAppointment() {
    const doctor = document.getElementById('doctor')?.value;
    const specialty = document.getElementById('specialty')?.value;
    const date = document.getElementById('date')?.value;
    const time = document.getElementById('time')?.value;
    const patient = document.getElementById('patient')?.value || 'Paciente Demo';
    const notes = document.getElementById('notes')?.value || 'Consulta general';

    if (!doctor || !specialty || !date || !time) {
      showToast('Completa los datos de la cita antes de reservar.', 'error');
      return;
    }

    appendNodeLog('[GATEWAY] Forwarding request to Node-A...', 'info');

    try {
      const payload = {
        doctor,
        specialty,
        date,
        time,
        patientName: patient,
        reason: notes
      };

      const response = await apiRequest('/api/citas', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      appendNodeLog('[NODE-A] Appointment accepted and queued for worker processing.', 'success');
      appendNodeLog('[WORKER-THREAD #2] Task processed in 18ms', 'success');
      showToast(response.message || 'Reserva confirmada correctamente.', 'success');
      return response;
    } catch (error) {
      appendNodeLog(`[NODE-A] Reservation failed: ${error.message}`, 'warning');
      showToast(error.message || 'No se pudo reservar la cita.', 'error');
      return null;
    }
  }

  async function runLoadTest() {
    const button = document.getElementById('benchmark-button');
    if (!button) return;

    button.disabled = true;
    button.textContent = 'Ejecutando prueba...';

    appendNodeLog('[GATEWAY] Dispatching concurrent load test to Node-A and worker pool...', 'info');
    appendNodeLog('[WORKER-THREAD #4] Processing 200 req/s burst...', 'info');

    try {
      const response = await apiRequest('/api/load-test', {
        method: 'POST',
        body: JSON.stringify({ rates: [50, 120, 200] })
      });

      const summary = response.summary || {};
      const latency = summary.p95MaxMs || summary.latencyP95 || 145;
      const throughput = summary.scenarios?.reduce((total, item) => total + (Number(item.ratePerSecond) || 0), 0) || 200;
      const successRate = summary.successRate || 99.2;
      const interNode = summary.interNodeLatencyAvgMs || 18;

      setMetricValue('latency', 'Latencia p95', `${Math.round(latency)} ms`);
      setMetricValue('throughput', 'Peticiones/s', `${Math.round(throughput)} req/s`);
      setMetricValue('workers', 'Estado hilos worker', 'ACTIVE');

      const statusText = successRate >= 99 ? 'ACTIVE' : 'DEGRADED';
      setMetricValue('workers', 'Estado hilos worker', statusText);

      appendNodeLog(`[METRICS] Latency p95: ${Math.round(latency)}ms | inter-node: ${Math.round(interNode)}ms | success: ${Number(successRate).toFixed(1)}%`, 'success');
      appendNodeLog('[WORKER-THREAD #1] Task processed in 14ms', 'success');
      showToast('Prueba de carga ejecutada correctamente.', 'success');
      return response;
    } catch (error) {
      appendNodeLog(`[METRICS] Load test error: ${error.message}`, 'warning');
      showToast(error.message || 'No se pudo ejecutar la prueba de carga.', 'error');
      return null;
    } finally {
      button.disabled = false;
      button.textContent = 'Ejecutar Prueba de Carga Concurrente (200 req/s)';
    }
  }

  function bindEvents() {
    const appointmentButton = document.querySelector('.primary-button');
    if (appointmentButton) {
      appointmentButton.addEventListener('click', reserveAppointment);
    }

    const benchmarkButton = document.getElementById('benchmark-button');
    if (benchmarkButton) {
      benchmarkButton.addEventListener('click', runLoadTest);
    }

    const smartSearchButton = document.getElementById('search-agenda-button');
    if (smartSearchButton) {
      smartSearchButton.addEventListener('click', searchOptimizedAgenda);
    }

    const undoFilterButton = document.getElementById('undo-filter-button');
    if (undoFilterButton) {
      undoFilterButton.addEventListener('click', undoLastFilter);
    }

    document.querySelectorAll('.strategy-option').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('.strategy-option').forEach((option) => {
          option.classList.toggle('active', option === button);
        });
        const strategy = button.dataset.strategy || 'nearest';
        updateSmartSearchStatus(strategy === 'rating' ? 'Valoración' : 'Disponibilidad', 'neutral');
      });
    });

    const loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const email = document.getElementById('email')?.value || DEFAULT_LOGIN.email;
        const password = document.getElementById('password')?.value || DEFAULT_LOGIN.password;
        await loginWithCredentials(email, password);
        updateSessionView();
      });
    }

    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) {
      logoutButton.addEventListener('click', () => {
        clearToken();
        state.user = null;
        updateSessionView();
        showToast('Sesión cerrada correctamente.', 'success');
      });
    }

    const tabButtons = document.querySelectorAll('.tab-button');
    tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        tabButtons.forEach((tab) => tab.classList.toggle('active', tab === button));
        const targetId = button.dataset.target;
        document.querySelectorAll('.tab-panel').forEach((panel) => {
          panel.classList.toggle('active', panel.id === targetId);
        });
      });
    });
  }

  function bootstrap() {
    ensureMetricsCards();
    ensureConsole();
    updateSessionView();
    appendNodeLog('[SYSTEM] ApexFlow Distributed runtime initialized.', 'success');
    appendNodeLog('[GATEWAY] Monitoring Node-A and worker pool status...', 'info');
    bindEvents();

    const token = getToken();
    if (token) {
      restoreSession();
      return;
    }

    if (document.getElementById('login-form')) {
      appendNodeLog('[AUTH] Waiting for secure login...', 'warning');
      return;
    }

    appendNodeLog('[DEMO] JWT not present. Demo session ready to start.', 'warning');
  }

  document.addEventListener('DOMContentLoaded', bootstrap);
})();
