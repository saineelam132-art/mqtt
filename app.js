(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------

  const SETTINGS_KEY = "mqttDashboard.settings";
  const SUBS_KEY = "mqttDashboard.subscriptions";

  const STATUS_TOPIC = "mahesh01/transmission/status";
  const FAULT_CURRENT_TOPIC = "mahesh01/transmission/fault_current";
  const FAULT_DISTANCE_TOPIC = "mahesh01/transmission/fault_distance";
  const RELAY_TOPIC = "mahesh01/transmission/relay";
  const AUTH_TOPIC = "mahesh01/auth";
  const SECURITY_TOPICS = [STATUS_TOPIC, FAULT_CURRENT_TOPIC, FAULT_DISTANCE_TOPIC];
  const UNLOCKED_STATUS_VALUES = new Set([
    "NORMAL",
    "VERIFYING",
    "SHORT_CIRCUIT_FAULT",
    "OPEN_CIRCUIT_FAULT",
  ]);

  const KNOWN_TOPICS = [
    "mahesh01/auth",
    "mahesh01/transmission/input_voltage",
    "mahesh01/transmission/load_voltage",
    "mahesh01/transmission/fault_current",
    "mahesh01/transmission/load_current",
    "mahesh01/transmission/power",
    "mahesh01/transmission/energy",
    "mahesh01/transmission/cost",
    "mahesh01/transmission/status",
    "mahesh01/transmission/fault_distance",
    "mahesh01/transmission/relay",
  ];

  const UNIT_MAP = {
    "mahesh01/transmission/input_voltage": "V",
    "mahesh01/transmission/load_voltage": "V",
    "mahesh01/transmission/fault_current": "A",
    "mahesh01/transmission/load_current": "A",
    "mahesh01/transmission/power": "W",
    "mahesh01/transmission/energy": "kWh",
    "mahesh01/transmission/cost": "₹",
    "mahesh01/transmission/fault_distance": "cm",
  };

  const MAX_LOG_MESSAGES = 20;

  // Topics whose data must be fully hidden/discarded while the system is
  // locked (Security Mode) — gauges, history table, stat cards and the
  // debug panel all treat these specially.
  const PROTECTED_TOPICS = new Set([
    "mahesh01/transmission/input_voltage",
    "mahesh01/transmission/load_voltage",
    "mahesh01/transmission/fault_current",
    "mahesh01/transmission/load_current",
    "mahesh01/transmission/power",
    "mahesh01/transmission/energy",
    "mahesh01/transmission/cost",
    "mahesh01/transmission/status",
    "mahesh01/transmission/fault_distance",
    "mahesh01/transmission/relay",
  ]);

  const DEFAULT_ZONES = [
    { from: 0, to: 0.7, color: "#34d399" },
    { from: 0.7, to: 0.9, color: "#fbbf24" },
    { from: 0.9, to: 1, color: "#f87171" },
  ];
  const FAULT_CURRENT_ZONES = [
    { from: 0, to: 0.5 / 3, color: "#34d399" },
    { from: 0.5 / 3, to: 1, color: "#f87171" },
  ];
  // No fault threshold for these — a gentle informational gradient, not a risk band.
  const INFO_ZONES = [
    { from: 0, to: 0.8, color: "#34d399" },
    { from: 0.8, to: 1, color: "#22d3ee" },
  ];

  // Order here also drives the gauge selector tab order.
  const GAUGE_CONFIGS = [
    { topic: "mahesh01/transmission/input_voltage", label: "Input Voltage", min: 0, max: 15, unit: "V", zones: DEFAULT_ZONES },
    { topic: "mahesh01/transmission/load_voltage", label: "Load Voltage", min: 0, max: 15, unit: "V", zones: DEFAULT_ZONES },
    { topic: "mahesh01/transmission/fault_current", label: "Fault Current", min: 0, max: 3, unit: "A", zones: FAULT_CURRENT_ZONES },
    { topic: "mahesh01/transmission/load_current", label: "Load Current", min: 0, max: 3, unit: "A", zones: DEFAULT_ZONES },
    { topic: "mahesh01/transmission/power", label: "Power", min: 0, max: 50, unit: "W", zones: DEFAULT_ZONES },
    { topic: "mahesh01/transmission/energy", label: "Energy", min: 0, max: 5, unit: "kWh", zones: INFO_ZONES },
    { topic: "mahesh01/transmission/cost", label: "Cost", min: 0, max: 50, unit: "₹", zones: INFO_ZONES },
  ];

  // ---------------------------------------------------------------------
  // IndexedDB message history store
  // ---------------------------------------------------------------------

  const DB_NAME = "mqtt-dashboard";
  const DB_STORE = "messages";
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          const store = db.createObjectStore(DB_STORE, { keyPath: "id", autoIncrement: true });
          store.createIndex("topic", "topic", { unique: false });
          store.createIndex("timestamp", "timestamp", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function storeMessage(topic, payload, timestamp) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).add({ topic, payload, timestamp });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getMessagesForTopic(topic) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const idx = tx.objectStore(DB_STORE).index("topic");
      const results = [];
      const req = idx.openCursor(IDBKeyRange.only(topic));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllStoredTopics() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const idx = tx.objectStore(DB_STORE).index("topic");
      const topics = new Set();
      const req = idx.openKeyCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          topics.add(cursor.key);
          cursor.continue();
        } else {
          resolve(topics);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ---------------------------------------------------------------------
  // Settings persistence (localStorage)
  // ---------------------------------------------------------------------

  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function loadSubscriptions() {
    try {
      return JSON.parse(localStorage.getItem(SUBS_KEY)) || [];
    } catch {
      return [];
    }
  }

  function saveSubscriptions(list) {
    localStorage.setItem(SUBS_KEY, JSON.stringify(list));
  }

  // ---------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------

  const el = (id) => document.getElementById(id);

  const hostInput = el("hostInput");
  const portInput = el("portInput");
  const pathInput = el("pathInput");
  const userInput = el("userInput");
  const passInput = el("passInput");
  const clientIdInput = el("clientIdInput");
  const tlsCheckbox = el("tlsCheckbox");
  const connectBtn = el("connectBtn");
  const brokerUrlPreview = el("brokerUrlPreview");
  const connDot = el("connDot");
  const connLabel = el("connLabel");
  const toggleSettingsBtn = el("toggleSettingsBtn");
  const settingsForm = el("settingsForm");

  const securityBanner = el("securityBanner");
  const gaugeTabs = el("gaugeTabs");
  const gaugeSingle = el("gaugeSingle");

  const statusBadge = el("statusBadge");
  const faultDistanceValue = el("faultDistanceValue");
  const relayDot = el("relayDot");
  const relayText = el("relayText");

  const topicInput = el("topicInput");
  const addTopicBtn = el("addTopicBtn");
  const subsEmptyState = el("subsEmptyState");
  const subsList = el("subsList");
  const subsHint = el("subsHint");

  const lockStatus = el("lockStatus");
  const lockIcon = el("lockIcon");
  const lockText = el("lockText");
  const pubTopicInput = el("pubTopicInput");
  const pubMessageInput = el("pubMessageInput");
  const pubSendBtn = el("pubSendBtn");
  const secretBtn = el("secretBtn");
  const msgLog = el("msgLog");
  const msgLogEmpty = el("msgLogEmpty");

  const historyTopicSelect = el("historyTopicSelect");
  const fromDateInput = el("fromDateInput");
  const toDateInput = el("toDateInput");
  const refreshHistoryBtn = el("refreshHistoryBtn");
  const downloadPdfBtn = el("downloadPdfBtn");
  const statTotalRecords = el("statTotalRecords");
  const statFirstRecorded = el("statFirstRecorded");
  const statLastRecorded = el("statLastRecorded");
  const statCurrentValue = el("statCurrentValue");
  const historyTableBody = el("historyTableBody");
  const historyEmptyState = el("historyEmptyState");
  const historyTable = el("historyTable");

  const debugToggle = el("debugToggle");
  const debugBody = el("debugBody");
  const debugChevron = el("debugChevron");
  const debugConnStatus = el("debugConnStatus");
  const debugBrokerUrl = el("debugBrokerUrl");
  const debugSubCount = el("debugSubCount");
  const debugLastTopic = el("debugLastTopic");
  const debugLastValue = el("debugLastValue");
  const debugLastTime = el("debugLastTime");

  const secretModalOverlay = el("secretModalOverlay");
  const secretCodeInput = el("secretCodeInput");
  const secretCancelBtn = el("secretCancelBtn");
  const secretSendBtn = el("secretSendBtn");
  const toast = el("toast");

  // ---------------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------------

  const state = {
    client: null,
    connected: false,
    subscriptions: loadSubscriptions(),
    latestByTopic: new Map(), // topic -> { value, time }
    logMessages: [], // { dir: 'out'|'in', topic, payload, time }
    // Never assume unlocked: locked by default until a real status message
    // says otherwise, on page load and again on every fresh connect.
    isLocked: true,
    unlockedAt: null, // ms timestamp of the most recent unlock, for history filtering
    lastReceived: null, // { topic, value, time }
    selectedGaugeTopic: GAUGE_CONFIGS[0].topic, // default: Input Voltage
  };

  let activeGauge = null; // the single mounted gauge instance
  const HISTORY_EMPTY_DEFAULT_TEXT = "No records for this topic yet.";

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function formatTime(date) {
    return date.toLocaleTimeString([], { hour12: false });
  }

  function formatDate(date) {
    const dd = String(date.getDate()).padStart(2, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const yyyy = date.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  function formatDateTime(date) {
    return `${formatDate(date)} ${formatTime(date)}`;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.add("hidden"), 3000);
  }

  function computeBrokerUrl() {
    const scheme = tlsCheckbox.checked ? "wss" : "ws";
    const host = hostInput.value.trim() || "test.mosquitto.org";
    const port = portInput.value.trim() || (tlsCheckbox.checked ? "8081" : "8080");
    let path = pathInput.value.trim() || "/mqtt";
    if (!path.startsWith("/")) path = "/" + path;
    return `${scheme}://${host}:${port}${path}`;
  }

  function refreshBrokerUrlPreview() {
    const url = computeBrokerUrl();
    brokerUrlPreview.textContent = url;
    debugBrokerUrl.textContent = url;
  }

  function persistCurrentSettings() {
    saveSettings({
      host: hostInput.value.trim(),
      port: portInput.value.trim(),
      path: pathInput.value.trim(),
      username: userInput.value.trim(),
      clientId: clientIdInput.value.trim(),
      tls: tlsCheckbox.checked,
    });
  }

  // ---------------------------------------------------------------------
  // Connection UI state
  // ---------------------------------------------------------------------

  function setConnectionUiState(mode) {
    connDot.classList.remove("connecting", "connected");
    if (mode === "connecting") {
      connDot.classList.add("connecting");
      connLabel.textContent = "Connecting";
      debugConnStatus.textContent = "connecting";
    } else if (mode === "connected") {
      connDot.classList.add("connected");
      connLabel.textContent = "Connected";
      debugConnStatus.textContent = "connected";
    } else {
      connLabel.textContent = "Disconnected";
      debugConnStatus.textContent = "disconnected";
    }
    connectBtn.textContent = mode === "connected" ? "Disconnect" : "Connect";
    connectBtn.classList.toggle("danger", mode === "connected");
    connectBtn.disabled = mode === "connecting";
    pubSendBtn.disabled = mode !== "connected";
    secretBtn.disabled = mode !== "connected";
    addTopicBtn.disabled = mode !== "connected";
    subsHint.classList.toggle("hidden", mode === "connected");
  }

  // ---------------------------------------------------------------------
  // MQTT connection
  // ---------------------------------------------------------------------

  function connect() {
    const url = computeBrokerUrl();
    persistCurrentSettings();
    setConnectionUiState("connecting");

    const options = {
      clientId: clientIdInput.value.trim() || undefined,
      username: userInput.value.trim() || undefined,
      password: passInput.value || undefined,
      clean: true,
      reconnectPeriod: 0,
    };

    let client;
    try {
      client = mqtt.connect(url, options);
    } catch (err) {
      setConnectionUiState("disconnected");
      showToast("Failed to connect: " + err.message);
      return;
    }

    state.client = client;

    client.on("connect", () => {
      state.connected = true;
      setConnectionUiState("connected");
      settingsForm.classList.add("hidden");
      toggleSettingsBtn.textContent = "Show settings";

      // Never assume unlocked on a fresh connection: reset to locked and
      // wipe any protected data until a real status message arrives.
      resetSecurityState();

      // Re-subscribe to persisted user subscriptions.
      state.subscriptions.forEach((topic) => client.subscribe(topic));
      // Auto-subscribe to the security/status topics so the Security panel
      // and message log work without requiring a manual subscription.
      SECURITY_TOPICS.forEach((topic) => client.subscribe(topic));

      renderSubscriptions();
      updateDebugSubCount();
    });

    client.on("message", (topic, payloadBuf) => {
      const payload = payloadBuf.toString();
      const now = new Date();
      handleIncomingMessage(topic, payload, now);
    });

    client.on("error", (err) => {
      showToast("MQTT error: " + err.message);
    });

    client.on("close", () => {
      state.connected = false;
      setConnectionUiState("disconnected");
      resetSecurityState();
    });
  }

  function disconnect() {
    if (state.client) {
      state.client.end(true);
      state.client = null;
    }
    state.connected = false;
    setConnectionUiState("disconnected");
    resetSecurityState();
  }

  function handleIncomingMessage(topic, payload, time) {
    // The lock state is derived from this topic first, so the discard
    // check below (state.isLocked) always reflects the latest status.
    if (topic === STATUS_TOPIC) {
      const normalized = (payload || "").trim().toUpperCase();
      setLocked(!UNLOCKED_STATUS_VALUES.has(normalized), time);
    }

    // The Security/Command Panel's own log is never hidden, even while
    // locked — it's the mechanism for observing/recovering from lockdown.
    if (SECURITY_TOPICS.includes(topic)) {
      pushLogMessage({ dir: "in", topic, payload, time });
    }

    if (PROTECTED_TOPICS.has(topic) && state.isLocked) {
      return; // discard: never store or display protected data while locked
    }

    state.latestByTopic.set(topic, { value: payload, time });
    state.lastReceived = { topic, value: payload, time };

    updateDebugLastReceived(topic, payload, time);
    renderSubscriptions();

    // Only the currently-selected gauge is mounted; the other six topics
    // keep updating state.latestByTopic silently in the background so
    // switching back to them shows the current value, not a stale one.
    if (activeGauge && topic === state.selectedGaugeTopic) {
      const num = parseFloat(payload);
      if (!Number.isNaN(num)) activeGauge.setValue(num);
    }

    if (topic === STATUS_TOPIC || topic === FAULT_DISTANCE_TOPIC || topic === RELAY_TOPIC) {
      renderSystemStatus();
    }

    // Persist every incoming message for Data History & Reports.
    storeMessage(topic, payload, time.getTime()).then(() => {
      if (historyTopicSelect.value === topic) {
        refreshHistoryTable();
      }
      ensureTopicInHistorySelect(topic);
    });
  }

  // ---------------------------------------------------------------------
  // Subscriptions panel
  // ---------------------------------------------------------------------

  function renderSubscriptions() {
    subsList.innerHTML = "";
    if (state.subscriptions.length === 0) {
      subsEmptyState.classList.remove("hidden");
      subsList.classList.add("hidden");
      return;
    }
    subsEmptyState.classList.add("hidden");
    subsList.classList.remove("hidden");

    state.subscriptions.forEach((topic) => {
      const li = document.createElement("li");

      const topicSpan = document.createElement("span");
      topicSpan.className = "sub-topic";
      topicSpan.textContent = topic;

      const metaSpan = document.createElement("span");
      metaSpan.className = "sub-meta";

      const latest = state.latestByTopic.get(topic);
      const valueSpan = document.createElement("span");
      valueSpan.className = "sub-value";
      valueSpan.textContent = latest ? latest.value : "—";

      const unsubBtn = document.createElement("button");
      unsubBtn.className = "unsub-btn";
      unsubBtn.textContent = "✕";
      unsubBtn.title = "Unsubscribe";
      unsubBtn.addEventListener("click", () => unsubscribeTopic(topic));

      metaSpan.appendChild(valueSpan);
      metaSpan.appendChild(unsubBtn);
      li.appendChild(topicSpan);
      li.appendChild(metaSpan);
      subsList.appendChild(li);
    });
  }

  function subscribeTopic(topic) {
    if (!topic || state.subscriptions.includes(topic)) return;
    state.subscriptions.push(topic);
    saveSubscriptions(state.subscriptions);
    if (state.client && state.connected) {
      state.client.subscribe(topic);
    }
    ensureTopicInHistorySelect(topic);
    renderSubscriptions();
    updateDebugSubCount();
  }

  function unsubscribeTopic(topic) {
    state.subscriptions = state.subscriptions.filter((t) => t !== topic);
    saveSubscriptions(state.subscriptions);
    if (state.client && state.connected) {
      state.client.unsubscribe(topic);
    }
    renderSubscriptions();
    updateDebugSubCount();
  }

  function updateDebugSubCount() {
    const total = new Set([...state.subscriptions, ...SECURITY_TOPICS]);
    debugSubCount.textContent = state.connected ? String(total.size) : "0";
  }

  // ---------------------------------------------------------------------
  // Security / Command panel
  // ---------------------------------------------------------------------

  function setLocked(newLocked, time) {
    const wasLocked = state.isLocked;
    state.isLocked = newLocked;

    if (!wasLocked && newLocked) {
      // Mode flipped back to security mode mid-session: wipe everything
      // protected immediately, don't wait for a refresh.
      clearProtectedState();
    }
    state.unlockedAt = newLocked ? null : (time || new Date()).getTime();

    if (wasLocked && !newLocked) {
      // Just authorized: gauge/table/status should show "no data yet"
      // rather than a stale locked placeholder, until fresh values arrive.
      if (activeGauge) activeGauge.showWaiting();
      renderSystemStatus();
      if (PROTECTED_TOPICS.has(historyTopicSelect.value)) {
        refreshHistoryTable();
      }
    }

    renderLockUi();
  }

  function renderLockUi() {
    const unlocked = !state.isLocked;
    lockStatus.classList.toggle("locked", !unlocked);
    lockStatus.classList.toggle("unlocked", unlocked);
    lockIcon.textContent = unlocked ? "🔓" : "🔒";
    lockText.textContent = unlocked ? "UNLOCKED" : "LOCKED";
    securityBanner.classList.toggle("hidden", unlocked);
  }

  function clearProtectedState() {
    PROTECTED_TOPICS.forEach((topic) => state.latestByTopic.delete(topic));
    renderSubscriptions();

    if (activeGauge) activeGauge.showLocked();
    renderSystemStatus();

    if (state.lastReceived && PROTECTED_TOPICS.has(state.lastReceived.topic)) {
      state.lastReceived = null;
      debugLastTopic.textContent = "🔒 Locked";
      debugLastValue.textContent = "🔒 Locked";
      debugLastTime.textContent = "—";
    }

    if (PROTECTED_TOPICS.has(historyTopicSelect.value)) {
      refreshHistoryTable();
    }
  }

  function resetSecurityState() {
    state.isLocked = true;
    state.unlockedAt = null;
    clearProtectedState();
    renderLockUi();
  }

  function pushLogMessage(entry) {
    state.logMessages.unshift(entry);
    if (state.logMessages.length > MAX_LOG_MESSAGES) {
      state.logMessages.length = MAX_LOG_MESSAGES;
    }
    renderMsgLog();
  }

  function renderMsgLog() {
    msgLog.innerHTML = "";
    if (state.logMessages.length === 0) {
      msgLogEmpty.classList.remove("hidden");
      msgLog.classList.add("hidden");
      return;
    }
    msgLogEmpty.classList.add("hidden");
    msgLog.classList.remove("hidden");

    state.logMessages.forEach((entry) => {
      const li = document.createElement("li");
      const dirLabel = entry.dir === "out" ? "You → ESP8266" : "ESP8266 → You";
      const dirClass = entry.dir === "out" ? "out" : "in";
      li.innerHTML = `
        <span class="msg-time">${formatTime(entry.time)}</span>
        <span class="msg-dir ${dirClass}">${dirLabel}</span>
        <span class="msg-topic">${escapeHtml(entry.topic)}</span>
        — <span class="msg-payload">${escapeHtml(entry.payload)}</span>
      `;
      msgLog.appendChild(li);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function publishMessage(topic, payload) {
    if (!state.client || !state.connected) {
      showToast("Not connected to broker.");
      return false;
    }
    if (!topic) {
      showToast("Topic is required.");
      return false;
    }
    state.client.publish(topic, payload);
    pushLogMessage({ dir: "out", topic, payload, time: new Date() });
    return true;
  }

  // ---------------------------------------------------------------------
  // Data History & Reports panel
  // ---------------------------------------------------------------------

  function populateHistoryTopicSelect() {
    historyTopicSelect.innerHTML = "";
    KNOWN_TOPICS.forEach((topic) => addHistorySelectOption(topic));
    getAllStoredTopics().then((stored) => {
      stored.forEach((topic) => ensureTopicInHistorySelect(topic));
    });
  }

  function addHistorySelectOption(topic) {
    if ([...historyTopicSelect.options].some((o) => o.value === topic)) return;
    const opt = document.createElement("option");
    opt.value = topic;
    opt.textContent = topic;
    historyTopicSelect.appendChild(opt);
  }

  function ensureTopicInHistorySelect(topic) {
    addHistorySelectOption(topic);
  }

  function renderHistoryLockedPlaceholder() {
    historyTableBody.innerHTML = "";
    historyTable.classList.add("hidden");
    historyEmptyState.textContent = "🔒 Locked — authorize with the secret code to view history for this topic.";
    historyEmptyState.classList.remove("hidden");
    statTotalRecords.textContent = "🔒";
    statFirstRecorded.textContent = "🔒 Locked";
    statLastRecorded.textContent = "🔒 Locked";
    statCurrentValue.textContent = "🔒 Locked";
  }

  async function refreshHistoryTable() {
    const topic = historyTopicSelect.value;
    if (!topic) return;

    const isProtected = PROTECTED_TOPICS.has(topic);
    if (isProtected && state.isLocked) {
      renderHistoryLockedPlaceholder();
      return { topic, unit: UNIT_MAP[topic] || "", records: [], locked: true };
    }

    let records = await getMessagesForTopic(topic);

    // Never retroactively reveal data that arrived before this unlock.
    if (isProtected && state.unlockedAt) {
      records = records.filter((r) => r.timestamp >= state.unlockedAt);
    }

    const fromVal = fromDateInput.value ? new Date(fromDateInput.value + "T00:00:00") : null;
    const toVal = toDateInput.value ? new Date(toDateInput.value + "T23:59:59.999") : null;
    if (fromVal) records = records.filter((r) => r.timestamp >= fromVal.getTime());
    if (toVal) records = records.filter((r) => r.timestamp <= toVal.getTime());

    records.sort((a, b) => b.timestamp - a.timestamp);

    const unit = UNIT_MAP[topic] || "";

    historyTableBody.innerHTML = "";
    if (records.length === 0) {
      historyEmptyState.textContent = HISTORY_EMPTY_DEFAULT_TEXT;
      historyEmptyState.classList.remove("hidden");
      historyTable.classList.add("hidden");
    } else {
      historyEmptyState.classList.add("hidden");
      historyTable.classList.remove("hidden");
      records.forEach((r) => {
        const d = new Date(r.timestamp);
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${formatDate(d)}</td>
          <td>${formatTime(d)}</td>
          <td>${escapeHtml(r.payload)}</td>
          <td>${escapeHtml(unit)}</td>
        `;
        historyTableBody.appendChild(tr);
      });
    }

    statTotalRecords.textContent = String(records.length);
    if (records.length > 0) {
      const sortedAsc = [...records].sort((a, b) => a.timestamp - b.timestamp);
      statFirstRecorded.textContent = formatDateTime(new Date(sortedAsc[0].timestamp));
      statLastRecorded.textContent = formatDateTime(new Date(sortedAsc[sortedAsc.length - 1].timestamp));
      statCurrentValue.textContent = sortedAsc[sortedAsc.length - 1].payload;
    } else {
      statFirstRecorded.textContent = "—";
      statLastRecorded.textContent = "—";
      statCurrentValue.textContent = "—";
    }

    return { topic, unit, records };
  }

  async function downloadHistoryPdf() {
    const data = await refreshHistoryTable();
    if (data && data.locked) {
      showToast("System is locked — cannot export protected data.");
      return;
    }
    if (!data || data.records.length === 0) {
      showToast("No records to export for this topic.");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    doc.setFontSize(14);
    doc.text("MQTT Data History Report", 14, 16);
    doc.setFontSize(10);
    doc.text(`Topic: ${data.topic}`, 14, 24);
    const rangeText = `Range: ${fromDateInput.value || "all"} to ${toDateInput.value || "all"}`;
    doc.text(rangeText, 14, 30);

    const rows = data.records.map((r) => {
      const d = new Date(r.timestamp);
      return [formatDate(d), formatTime(d), r.payload, data.unit];
    });

    doc.autoTable({
      startY: 36,
      head: [["Date", "Time", "Value", "Unit"]],
      body: rows,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [45, 212, 191] },
    });

    const safeTopic = data.topic.replace(/[^a-z0-9]+/gi, "_");
    doc.save(`mqtt-history-${safeTopic}.pdf`);
  }

  // ---------------------------------------------------------------------
  // Live Meters: single-gauge selector
  // ---------------------------------------------------------------------

  function buildGaugeTabs() {
    gaugeTabs.innerHTML = "";
    GAUGE_CONFIGS.forEach((cfg) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gauge-tab";
      btn.textContent = cfg.label;
      btn.dataset.topic = cfg.topic;
      btn.addEventListener("click", () => selectGaugeTopic(cfg.topic));
      gaugeTabs.appendChild(btn);
    });
    updateGaugeTabActiveState();
  }

  function updateGaugeTabActiveState() {
    [...gaugeTabs.children].forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.topic === state.selectedGaugeTopic);
    });
  }

  function mountGauge(topic) {
    const cfg = GAUGE_CONFIGS.find((c) => c.topic === topic);
    if (!cfg) return;

    gaugeSingle.innerHTML = "";
    activeGauge = createGauge(gaugeSingle, cfg);

    if (state.isLocked) {
      activeGauge.showLocked();
      return;
    }
    const latest = state.latestByTopic.get(topic);
    const num = latest ? parseFloat(latest.value) : NaN;
    if (!Number.isNaN(num)) {
      activeGauge.setValue(num);
    } else {
      activeGauge.showWaiting();
    }
  }

  function selectGaugeTopic(topic) {
    if (topic === state.selectedGaugeTopic) return;
    state.selectedGaugeTopic = topic;
    updateGaugeTabActiveState();
    mountGauge(topic);
  }

  // ---------------------------------------------------------------------
  // System Status panel (message-type topics: status/fault_distance/relay)
  // ---------------------------------------------------------------------

  function renderSystemStatus() {
    if (state.isLocked) {
      statusBadge.textContent = "🔒 Locked";
      statusBadge.className = "status-badge locked";
      faultDistanceValue.textContent = "🔒 Locked";
      relayText.textContent = "🔒 Locked";
      relayDot.classList.remove("on");
      return;
    }

    const status = state.latestByTopic.get(STATUS_TOPIC);
    const distance = state.latestByTopic.get(FAULT_DISTANCE_TOPIC);
    const relay = state.latestByTopic.get(RELAY_TOPIC);

    if (status) {
      const val = status.value.trim().toUpperCase();
      statusBadge.textContent = val;
      let cls = "status-badge";
      if (val === "NORMAL") cls += " badge-green";
      else if (val === "VERIFYING") cls += " badge-yellow";
      else cls += " badge-red"; // fault states, e.g. SHORT_CIRCUIT_FAULT / OPEN_CIRCUIT_FAULT
      statusBadge.className = cls;
    } else {
      statusBadge.textContent = "—";
      statusBadge.className = "status-badge";
    }

    faultDistanceValue.textContent = distance ? `${distance.value} ${UNIT_MAP[FAULT_DISTANCE_TOPIC]}` : "—";

    if (relay) {
      const on = relay.value.trim().toUpperCase() === "ON";
      relayText.textContent = on ? "ON" : "OFF";
      relayDot.classList.toggle("on", on);
    } else {
      relayText.textContent = "—";
      relayDot.classList.remove("on");
    }
  }

  // ---------------------------------------------------------------------
  // Debug panel
  // ---------------------------------------------------------------------

  function updateDebugLastReceived(topic, value, time) {
    debugLastTopic.textContent = topic;
    debugLastValue.textContent = value;
    debugLastTime.textContent = formatDateTime(time);
  }

  // ---------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------

  [hostInput, portInput, pathInput, tlsCheckbox].forEach((input) => {
    input.addEventListener("input", refreshBrokerUrlPreview);
    input.addEventListener("change", refreshBrokerUrlPreview);
  });

  connectBtn.addEventListener("click", () => {
    if (state.connected) {
      disconnect();
    } else {
      connect();
    }
  });

  toggleSettingsBtn.addEventListener("click", () => {
    const hidden = settingsForm.classList.toggle("hidden");
    toggleSettingsBtn.textContent = hidden ? "Show settings" : "Hide settings";
  });

  addTopicBtn.addEventListener("click", () => {
    const topic = topicInput.value.trim();
    if (!topic) return;
    subscribeTopic(topic);
    topicInput.value = "";
  });
  topicInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addTopicBtn.click();
  });

  pubSendBtn.addEventListener("click", () => {
    const topic = pubTopicInput.value.trim();
    const payload = pubMessageInput.value;
    if (publishMessage(topic, payload)) {
      pubMessageInput.value = "";
    }
  });

  secretBtn.addEventListener("click", () => {
    secretCodeInput.value = "";
    secretModalOverlay.classList.remove("hidden");
    secretCodeInput.focus();
  });

  secretCancelBtn.addEventListener("click", () => {
    secretModalOverlay.classList.add("hidden");
  });

  secretSendBtn.addEventListener("click", () => {
    const code = secretCodeInput.value;
    if (!code) {
      showToast("Enter a secret code first.");
      return;
    }
    if (publishMessage(AUTH_TOPIC, code)) {
      secretModalOverlay.classList.add("hidden");
      showToast(`Secret sent to ${AUTH_TOPIC}`);
    }
  });
  secretCodeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") secretSendBtn.click();
  });

  refreshHistoryBtn.addEventListener("click", refreshHistoryTable);
  historyTopicSelect.addEventListener("change", refreshHistoryTable);
  downloadPdfBtn.addEventListener("click", downloadHistoryPdf);

  debugToggle.addEventListener("click", () => {
    const collapsed = debugBody.classList.toggle("hidden");
    debugChevron.classList.toggle("collapsed", collapsed);
  });

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  function init() {
    const settings = loadSettings();
    if (settings.host) hostInput.value = settings.host;
    if (settings.port) portInput.value = settings.port;
    if (settings.path) pathInput.value = settings.path;
    if (settings.username) userInput.value = settings.username;
    if (settings.clientId) clientIdInput.value = settings.clientId;
    if (typeof settings.tls === "boolean") tlsCheckbox.checked = settings.tls;

    refreshBrokerUrlPreview();
    setConnectionUiState("disconnected");
    renderSubscriptions();
    renderMsgLog();
    buildGaugeTabs();
    mountGauge(state.selectedGaugeTopic);
    renderSystemStatus();
    renderLockUi();
    updateDebugSubCount();
    populateHistoryTopicSelect();

    historyTopicSelect.value = "mahesh01/auth";
    refreshHistoryTable();
  }

  init();
})();
