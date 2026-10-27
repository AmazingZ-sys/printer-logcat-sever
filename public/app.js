(() => {
  'use strict';

  const PAGE_SIZE = 100;
  const MAX_LOGS = 1000;
  const $ = (id) => document.getElementById(id);
  const ui = {
    connectionForm: $('connection-form'), token: $('view-token'), connect: $('connect-button'),
    filterForm: $('filter-form'), filterError: $('filter-error'), reset: $('reset-filters'),
    status: $('connection-status'), statusText: $('status-text'), retry: $('retry-button'),
    pause: $('pause-button'), export: $('export-button'), list: $('log-list'),
    empty: $('empty-state'), emptyTitle: $('empty-title'), emptyDescription: $('empty-description'),
    count: $('loaded-count'), history: $('history-button'), historyNote: $('history-note'),
    dialog: $('detail-dialog'), detailTitle: $('detail-title'), detailSummary: $('detail-summary'),
    detailMetadata: $('detail-metadata'), detailMessage: $('detail-message'), detailData: $('detail-data'),
  };
  const state = {
    token: '', filters: {}, logs: [], ids: new Set(), liveCursor: 0, beforeId: null, hasMore: false,
    active: false, paused: false, initialized: false, initialBusy: false, historyBusy: false,
    generation: 0, streamVersion: 0, queryController: null, historyController: null,
    streamController: null, retryTimer: null, retryAttempt: 0, retryAction: null,
    status: 'idle', historyError: '', retryWhilePaused: false,
  };
  const levelNames = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR' };
  const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });

  $('service-origin').textContent = window.location.host;

  function textNode(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null ? '—' : String(value);
    return node;
  }

  function isCurrent(generation) {
    return generation === state.generation && state.active;
  }

  function setStatus(type, message) {
    state.status = type;
    ui.status.dataset.state = type;
    ui.statusText.textContent = message;
    ui.retry.hidden = type !== 'retrying';
    renderControls();
    renderEmpty();
  }

  function renderControls() {
    ui.connect.textContent = state.active ? '断开连接 ×' : '连接服务 ↗';
    ui.token.readOnly = state.active;
    ui.pause.disabled = !state.active || !state.initialized;
    ui.pause.textContent = state.paused ? '恢复实时' : '暂停实时';
    ui.export.disabled = state.logs.length === 0;
    ui.count.textContent = state.logs.length.toLocaleString('en-US');
    ui.history.disabled = !state.active || !state.initialized || state.historyBusy || !state.hasMore || state.logs.length >= MAX_LOGS;
    ui.history.textContent = state.historyBusy ? '正在读取…' : '加载更早日志 ↓';
    if (state.historyError) ui.historyNote.textContent = state.historyError;
    else if (state.logs.length >= MAX_LOGS) ui.historyNote.textContent = '已达到 1,000 条显示上限，请缩小筛选范围';
    else if (state.initialized && !state.hasMore) ui.historyNote.textContent = '已载入此筛选范围内的全部历史日志';
    else ui.historyNote.textContent = '每次读取 100 条，最多显示 1,000 条';
  }

  function renderEmpty() {
    ui.empty.hidden = state.logs.length > 0;
    if (state.logs.length > 0) return;
    let title = '等待建立连接';
    let description = '填入查看凭据，开始查看设备的真实日志。';
    if (state.initialBusy) {
      title = '正在读取日志';
      description = '获取最近 100 条记录，随后接入实时日志流。';
    } else if (state.status === 'autherror') {
      title = '查看凭据未通过验证';
      description = '请填写有效的 VIEW_TOKEN，然后重新连接。';
    } else if (state.initialized && !state.active) {
      title = '尚未载入匹配日志';
      description = '连接服务以继续读取当前筛选范围内的日志。';
    } else if (state.initialized) {
      title = '当前没有匹配的日志';
      description = state.paused ? '实时接收已暂停，恢复后将补发暂停期间的日志。' : '可以调整筛选条件；连接期间，新的匹配日志会自动出现在这里。';
    } else if (state.status === 'retrying' || state.status === 'error') {
      title = '暂时无法读取日志';
      description = '请检查服务是否可用；连接状态栏会显示重试进度。';
    }
    ui.emptyTitle.textContent = title;
    ui.emptyDescription.textContent = description;
  }

  function formatTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value ?? '—') : timeFormatter.format(date);
  }

  function renderLogs() {
    const focusedId = document.activeElement?.dataset.logId;
    const fragment = document.createDocumentFragment();
    for (const log of state.logs) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'log-entry';
      row.dataset.logId = String(log.id);
      row.setAttribute('aria-label', `查看日志 ${log.id}，${levelNames[log.level] || log.level || 'INFO'}，设备 ${log.deviceId}`);
      const time = textNode('span', 'log-time', formatTime(log.receivedAt));
      time.append(textNode('small', '', `#${log.id}`));
      const level = textNode('span', 'log-level', levelNames[log.level] || 'INFO');
      level.dataset.level = Object.hasOwn(levelNames, log.level) ? log.level : 'info';
      const device = textNode('span', 'log-device', log.deviceId);
      device.title = String(log.deviceId ?? '');
      const message = document.createElement('span');
      message.className = 'log-message';
      message.append(textNode('span', 'log-message-text', log.message));
      const metadata = [log.tag ? `#${log.tag}` : '', log.jobId ? `任务 ${log.jobId}` : ''].filter(Boolean);
      if (metadata.length) message.append(textNode('span', 'log-meta', metadata.join('  /  ')));
      row.append(time, level, device, message, textNode('span', 'log-arrow', '›'));
      row.addEventListener('click', () => showDetails(log));
      fragment.append(row);
    }
    ui.list.replaceChildren(fragment);
    if (focusedId) {
      const focusedRow = Array.from(ui.list.children).find((row) => row.dataset.logId === focusedId);
      if (focusedRow) focusedRow.focus({ preventScroll: true });
    }
    renderControls();
    renderEmpty();
  }

  function addLogs(logs) {
    for (const log of logs) {
      if (!log || !Number.isSafeInteger(log.id) || log.id <= 0 || state.ids.has(log.id)) continue;
      state.logs.push(log);
      state.ids.add(log.id);
    }
    state.logs.sort((a, b) => b.id - a.id);
    if (state.logs.length > MAX_LOGS) state.logs.length = MAX_LOGS;
    state.ids = new Set(state.logs.map((log) => log.id));
    renderLogs();
  }

  function showDetails(log) {
    ui.detailTitle.textContent = `日志 #${log.id}`;
    ui.detailSummary.textContent = `${levelNames[log.level] || log.level || 'INFO'} / ${log.deviceId ?? '—'}`;
    const fields = [
      ['设备 ID', log.deviceId], ['级别', levelNames[log.level] || log.level], ['标签', log.tag],
      ['任务 ID', log.jobId], ['会话 ID', log.sessionId], ['客户端时间', log.timestamp], ['接收时间', log.receivedAt],
    ];
    const fragment = document.createDocumentFragment();
    for (const [name, value] of fields) {
      const item = document.createElement('div');
      item.append(textNode('dt', '', name), textNode('dd', '', value));
      fragment.append(item);
    }
    ui.detailMetadata.replaceChildren(fragment);
    ui.detailMessage.textContent = log.message == null ? '—' : String(log.message);
    ui.detailData.textContent = log.data == null ? '无上下文数据' : JSON.stringify(log.data, null, 2);
    if (!ui.dialog.open) ui.dialog.showModal();
  }

  function readFilters() {
    const values = new FormData(ui.filterForm);
    const filters = {};
    for (const name of ['deviceId', 'level', 'tag', 'jobId', 'q']) {
      const value = String(values.get(name) || '').trim();
      if (value) filters[name] = value;
    }
    for (const name of ['from', 'to']) {
      const value = String(values.get(name) || '');
      if (!value) continue;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new Error('请输入有效的接收时间。');
      filters[name] = date.toISOString();
    }
    if (filters.from && filters.to && filters.from > filters.to) throw new Error('起始时间不能晚于结束时间。');
    return filters;
  }

  function getFilters() {
    try {
      const filters = readFilters();
      ui.filterError.hidden = true;
      ui.filterError.textContent = '';
      return filters;
    } catch (error) {
      ui.filterError.textContent = error.message;
      ui.filterError.hidden = false;
      return null;
    }
  }

  function makeUrl(path, extra) {
    const url = new URL(path, window.location.origin);
    for (const [name, value] of Object.entries({ ...state.filters, ...extra })) {
      if (value != null) url.searchParams.set(name, String(value));
    }
    return url;
  }

  function clearRetry() {
    if (state.retryTimer !== null) window.clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.retryAction = null;
    state.retryWhilePaused = false;
  }

  function stopStream() {
    state.streamVersion += 1;
    if (state.streamController) state.streamController.abort();
    state.streamController = null;
    clearRetry();
  }

  function cancelSession() {
    state.generation += 1;
    stopStream();
    if (state.queryController) state.queryController.abort();
    if (state.historyController) state.historyController.abort();
    state.queryController = null;
    state.historyController = null;
    state.initialBusy = false;
    state.historyBusy = false;
  }

  function resetLogs() {
    state.logs = [];
    state.ids.clear();
    state.liveCursor = 0;
    state.beforeId = null;
    state.hasMore = false;
    state.initialized = false;
    state.historyError = '';
    if (ui.dialog.open) ui.dialog.close();
    renderLogs();
  }

  function disconnect() {
    cancelSession();
    state.active = false;
    state.paused = false;
    state.token = '';
    setStatus('idle', '已断开连接 · 已载入的日志仍可查看或导出');
  }

  function startSession(filters, paused = false) {
    const token = ui.token.value.trim();
    if (!token) {
      setStatus('error', '请先输入 VIEW_TOKEN');
      ui.token.focus();
      return;
    }
    cancelSession();
    state.token = token;
    state.filters = filters;
    state.active = true;
    state.paused = paused;
    state.retryAttempt = 0;
    resetLogs();
    fetchInitial(state.generation);
  }

  class RequestError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function checkResponse(response) {
    if (response.ok) return;
    let message = `请求失败（HTTP ${response.status}）`;
    try {
      const body = await response.json();
      if (typeof body.error === 'string') message = body.error;
    } catch (_) { /* Non-JSON proxy errors still retain their HTTP status. */ }
    throw new RequestError(message, response.status);
  }

  function handleUnauthorized(generation) {
    if (!isCurrent(generation)) return;
    cancelSession();
    state.active = false;
    state.paused = false;
    state.token = '';
    setStatus('autherror', '鉴权失败（401）· 请检查 VIEW_TOKEN 后重新连接');
  }

  function scheduleRetry(generation, error, action, allowWhilePaused = false) {
    if (!isCurrent(generation) || (state.paused && !allowWhilePaused)) return;
    clearRetry();
    const seconds = Math.min(30, 2 ** Math.min(state.retryAttempt++, 5));
    const message = error instanceof Error ? error.message : '连接中断';
    state.retryAction = action;
    state.retryWhilePaused = allowWhilePaused;
    setStatus('retrying', `${message} · ${seconds} 秒后重连`);
    state.retryTimer = window.setTimeout(() => {
      if (!isCurrent(generation) || (state.paused && !allowWhilePaused)) return;
      state.retryTimer = null;
      state.retryAction = null;
      action();
    }, seconds * 1000);
  }

  async function fetchInitial(generation) {
    if (!isCurrent(generation)) return;
    clearRetry();
    const controller = new AbortController();
    state.queryController = controller;
    state.initialBusy = true;
    setStatus('connecting', '正在读取最近日志…');
    try {
      const response = await fetch(makeUrl('/api/logs', { limit: PAGE_SIZE }), {
        headers: { Authorization: `Bearer ${state.token}` }, signal: controller.signal, cache: 'no-store',
      });
      await checkResponse(response);
      const body = await response.json();
      if (!isCurrent(generation) || controller.signal.aborted) return;
      if (!Array.isArray(body.logs) || !Number.isSafeInteger(body.latestId) || body.latestId < 0) throw new Error('服务返回的日志格式无效');
      state.liveCursor = body.latestId;
      state.beforeId = body.nextBeforeId;
      state.hasMore = Boolean(body.hasMore);
      state.initialized = true;
      state.initialBusy = false;
      state.queryController = null;
      addLogs(body.logs);
      if (state.paused) setStatus('paused', '实时已暂停 · 恢复后自动补发');
      else openStream(generation);
    } catch (error) {
      if (!isCurrent(generation) || controller.signal.aborted) return;
      state.initialBusy = false;
      state.queryController = null;
      if (error.status === 401) handleUnauthorized(generation);
      else if (error.status >= 400 && error.status < 500) {
        state.active = false;
        state.token = '';
        setStatus('error', error.message);
      } else scheduleRetry(generation, error, () => fetchInitial(generation), true);
    }
  }

  // SSE lines may cross any chunk boundary, including the middle of a CRLF pair.
  function createEventParser(onEvent) {
    let buffer = '';
    let eventType = '';
    let eventId = null;
    let data = [];
    function line(value) {
      if (value === '') {
        if (data.length) onEvent({ type: eventType || 'message', id: eventId, data: data.join('\n') });
        eventType = '';
        eventId = null;
        data = [];
        return;
      }
      if (value.startsWith(':')) return;
      const colon = value.indexOf(':');
      const name = colon < 0 ? value : value.slice(0, colon);
      let content = colon < 0 ? '' : value.slice(colon + 1);
      if (content.startsWith(' ')) content = content.slice(1);
      if (name === 'data') data.push(content);
      else if (name === 'event') eventType = content;
      else if (name === 'id' && !content.includes('\0')) eventId = content;
    }
    return (chunk, final = false) => {
      buffer += chunk;
      let start = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const character = buffer[index];
        if (character !== '\r' && character !== '\n') continue;
        if (character === '\r' && index === buffer.length - 1 && !final) break;
        line(buffer.slice(start, index));
        if (character === '\r' && buffer[index + 1] === '\n') index += 1;
        start = index + 1;
      }
      buffer = buffer.slice(start);
      // SSE dispatch requires a blank line; an incomplete final event is replayed on reconnect.
    };
  }

  async function openStream(generation) {
    if (!isCurrent(generation) || state.paused || !state.initialized) return;
    stopStream();
    const version = state.streamVersion;
    const controller = new AbortController();
    state.streamController = controller;
    const current = () => isCurrent(generation) && version === state.streamVersion && !controller.signal.aborted && !state.paused;
    let reader;
    const openedAt = Date.now();
    setStatus('connecting', `正在接入实时日志 · 游标 #${state.liveCursor}`);
    try {
      const response = await fetch(makeUrl('/api/logs/stream', { afterId: state.liveCursor }), {
        headers: { Authorization: `Bearer ${state.token}`, Accept: 'text/event-stream' },
        signal: controller.signal, cache: 'no-store',
      });
      await checkResponse(response);
      if (!current()) return;
      if (!response.body) throw new Error('当前浏览器无法读取实时日志流');
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) throw new Error('服务未返回有效的实时日志流');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parse = createEventParser((event) => {
        if (!current() || event.type !== 'log') return;
        const eventId = event.id !== null && /^\d+$/.test(event.id) ? Number(event.id) : NaN;
        const log = JSON.parse(event.data);
        if (!Number.isSafeInteger(eventId) || eventId <= 0 || !log || log.id !== eventId) throw new Error('实时日志事件格式无效');
        // Only log event IDs advance this cursor. History, ready and heartbeats never do.
        state.liveCursor = Math.max(state.liveCursor, eventId);
        state.retryAttempt = 0;
        addLogs([log]);
      });
      setStatus('live', '实时连接已建立 · 自动接收新日志');
      while (current()) {
        const { value, done } = await reader.read();
        if (!current()) return;
        if (done) {
          parse(decoder.decode(), true);
          throw new Error('实时连接已关闭');
        }
        parse(decoder.decode(value, { stream: true }));
      }
    } catch (error) {
      if (!current()) return;
      if (error.status === 401) handleUnauthorized(generation);
      else if (error.status >= 400 && error.status < 500) {
        cancelSession();
        state.active = false;
        state.token = '';
        setStatus('error', error.message);
      } else {
        if (Date.now() - openedAt > 10000) state.retryAttempt = 0;
        scheduleRetry(generation, error, () => openStream(generation));
      }
    } finally {
      if (reader) {
        try { await reader.cancel(); } catch (_) { /* The aborted connection is already closed. */ }
        reader.releaseLock();
      }
      if (state.streamController === controller) state.streamController = null;
    }
  }

  async function loadHistory() {
    if (!state.active || !state.initialized || state.historyBusy || !state.hasMore || state.logs.length >= MAX_LOGS) return;
    const generation = state.generation;
    const controller = new AbortController();
    state.historyController = controller;
    state.historyBusy = true;
    state.historyError = '';
    renderControls();
    try {
      const response = await fetch(makeUrl('/api/logs', { limit: PAGE_SIZE, beforeId: state.beforeId }), {
        headers: { Authorization: `Bearer ${state.token}` }, signal: controller.signal, cache: 'no-store',
      });
      await checkResponse(response);
      const body = await response.json();
      if (!isCurrent(generation) || controller.signal.aborted) return;
      if (!Array.isArray(body.logs)) throw new Error('服务返回的历史日志格式无效');
      // Historical pagination must never update the live stream cursor.
      state.beforeId = body.nextBeforeId;
      state.hasMore = Boolean(body.hasMore);
      addLogs(body.logs);
    } catch (error) {
      if (!isCurrent(generation) || controller.signal.aborted) return;
      if (error.status === 401) handleUnauthorized(generation);
      else state.historyError = `历史读取失败：${error.message}，可点击重试`;
    } finally {
      if (generation === state.generation) {
        state.historyBusy = false;
        state.historyController = null;
        renderControls();
      }
    }
  }

  ui.connectionForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.active) disconnect();
    else {
      const filters = getFilters();
      if (filters) startSession(filters);
    }
  });
  ui.filterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const filters = getFilters();
    if (!filters) return;
    if (state.active) startSession(filters, state.paused);
    else {
      state.filters = filters;
      resetLogs();
      setStatus('idle', '筛选已更新 · 连接服务后读取日志');
    }
  });
  ui.reset.addEventListener('click', () => {
    ui.filterForm.reset();
    ui.filterError.hidden = true;
    if (state.active) startSession({}, state.paused);
    else {
      state.filters = {};
      resetLogs();
      setStatus('idle', '筛选已重置 · 尚未连接');
    }
  });
  ui.pause.addEventListener('click', () => {
    if (!state.active || !state.initialized) return;
    state.paused = !state.paused;
    if (state.paused) {
      stopStream();
      setStatus('paused', '实时已暂停 · 恢复后自动补发');
    } else openStream(state.generation);
  });
  ui.retry.addEventListener('click', () => {
    const action = state.retryAction;
    const allowWhilePaused = state.retryWhilePaused;
    clearRetry();
    if (action && state.active && (!state.paused || allowWhilePaused)) action();
  });
  ui.history.addEventListener('click', loadHistory);
  ui.export.addEventListener('click', () => {
    if (!state.logs.length) return;
    const blob = new Blob([JSON.stringify(state.logs, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `printer-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('close-detail').addEventListener('click', () => ui.dialog.close());
  ui.dialog.addEventListener('click', (event) => {
    if (event.target !== ui.dialog) return;
    const bounds = ui.dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) ui.dialog.close();
  });
  window.addEventListener('pagehide', disconnect);
  renderControls();
})();
