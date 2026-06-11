/**
 * Execution Monitor Panel — Real-time node execution timing for ComfyUI.
 *
 * Works in two modes:
 *   1. Enhanced mode (with ComfyUI-Enhancement-Utils installed):
 *      Uses precise profiler events for accurate per-node timing.
 *   2. Standalone mode (no dependencies):
 *      Uses built-in ComfyUI "executing" events to measure wall-clock time
 *      between node transitions. Slightly less accurate but fully functional.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const SIDEBAR_ID = "exec-monitor";
const EXTENSION_NAME = "ExecutionMonitorPanel";

const state = {
    nodeData: new Map(),
    totalTimeMs: 0,
    executionStartTime: 0,
    isRunning: false,
    liveTimerId: null,
    currentNodeId: null,
    containerEl: null,
    sortMode: "time",
    execCounter: 0,
    hasEnhancedProfiler: false,
};

function fmt(ms) {
    if (ms < 1000) return Math.round(ms) + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
    const m = Math.floor(ms / 60000);
    const s = ((ms % 60000) / 1000).toFixed(1);
    return m + "m" + s + "s";
}

function getHeatColor(ratio) {
    if (ratio > 0.7) return "#ff4444";
    if (ratio > 0.4) return "#ff8c00";
    if (ratio > 0.15) return "#ffd700";
    return "#4CAF50";
}

function getNodeTitle(nodeId) {
    try {
        const node = app.graph?.getNodeById(parseInt(nodeId));
        if (node) return node.title || node.type || node.comfyClass || "?";
    } catch {}
    return "?";
}

function buildPanelHTML() {
    return `
        <div class="exec-monitor-root">
            <div class="exec-monitor-status">
                <span id="exec-monitor-state">Ready</span>
                <span id="exec-monitor-elapsed">--</span>
            </div>
            <div class="exec-monitor-toolbar">
                <button id="exec-sort-time" class="exec-btn active">By Duration</button>
                <button id="exec-sort-order" class="exec-btn">By Order</button>
            </div>
            <div id="exec-monitor-body" class="exec-monitor-body">
                <div class="exec-placeholder">Waiting for execution...</div>
            </div>
            <div class="exec-monitor-footer">
                <span id="exec-monitor-count">Nodes: 0</span>
                <span id="exec-monitor-total">Total: --</span>
            </div>
        </div>
        <style>
            .exec-monitor-root {
                display: flex;
                flex-direction: column;
                height: 100%;
                font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
                font-size: 12px;
                color: #eee;
                background: #1a1a2e;
            }
            .exec-monitor-status {
                padding: 8px 12px;
                background: #0f3460;
                font-size: 13px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-bottom: 1px solid #333;
            }
            #exec-monitor-state { font-weight: bold; color: #aaa; }
            #exec-monitor-elapsed { font-size: 14px; font-weight: bold; }
            .exec-monitor-toolbar {
                padding: 4px 8px;
                background: #16213e;
                display: flex;
                gap: 4px;
                border-bottom: 1px solid #333;
            }
            .exec-btn {
                flex: 1;
                padding: 4px 8px;
                border: 1px solid #555;
                border-radius: 4px;
                background: #333;
                color: #aaa;
                cursor: pointer;
                font-size: 11px;
                font-family: inherit;
                transition: background 0.15s, color 0.15s;
            }
            .exec-btn.active {
                background: #e94560;
                color: #fff;
                border-color: #e94560;
            }
            .exec-btn:hover:not(.active) {
                background: #444;
                color: #ccc;
            }
            .exec-monitor-body {
                overflow-y: auto;
                flex: 1;
                padding: 4px 0;
            }
            .exec-placeholder {
                padding: 12px;
                color: #666;
                text-align: center;
            }
            .exec-monitor-footer {
                padding: 6px 12px;
                background: #16213e;
                border-top: 1px solid #333;
                font-size: 11px;
                color: #888;
                display: flex;
                justify-content: space-between;
            }
            .exec-row {
                padding: 6px 8px;
                border-bottom: 1px solid #2a2a3a;
                transition: background 0.15s;
            }
            .exec-row:hover { background: #2a2a4a !important; }
            .exec-row-title {
                color: #ddd;
                font-size: 12px;
                font-weight: 500;
                word-break: break-all;
                line-height: 1.3;
                margin-bottom: 4px;
            }
            .exec-row-id { color: #888; font-size: 10px; }
            .exec-row-active-indicator { color: #4CAF50; }
            .exec-row-bar-container {
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .exec-row-bar-track {
                flex: 1;
                height: 8px;
                background: #333;
                border-radius: 4px;
                overflow: hidden;
            }
            .exec-row-bar-fill {
                height: 100%;
                border-radius: 4px;
                transition: width 0.3s ease;
            }
            .exec-row-time {
                font-weight: bold;
                font-size: 12px;
                min-width: 50px;
                text-align: right;
            }
            .exec-row-pct {
                color: #888;
                font-size: 10px;
                min-width: 32px;
                text-align: right;
            }
        </style>
    `;
}

function setupSortButtons() {
    const { containerEl } = state;
    if (!containerEl) return;

    const btnTime = containerEl.querySelector("#exec-sort-time");
    const btnOrder = containerEl.querySelector("#exec-sort-order");
    if (!btnTime || !btnOrder) return;

    function updateButtons() {
        btnTime.classList.toggle("active", state.sortMode === "time");
        btnOrder.classList.toggle("active", state.sortMode === "order");
    }

    btnTime.onclick = () => { state.sortMode = "time"; updateButtons(); renderRows(); };
    btnOrder.onclick = () => { state.sortMode = "order"; updateButtons(); renderRows(); };
    updateButtons();
}

function renderRows() {
    const body = state.containerEl?.querySelector("#exec-monitor-body");
    if (!body) return;

    const { nodeData, currentNodeId, isRunning, sortMode } = state;

    if (nodeData.size === 0) {
        body.innerHTML = '<div class="exec-placeholder">Waiting for execution...</div>';
        return;
    }

    let entries = [...nodeData.entries()];
    if (sortMode === "time") {
        entries.sort((a, b) => b[1].time - a[1].time);
    } else {
        entries.sort((a, b) => (a[1].execOrder || 0) - (b[1].execOrder || 0));
    }

    const maxTime = Math.max(...entries.map(e => e[1].time), 1);
    const totalTime = entries.reduce((a, e) => a + e[1].time, 0) || 1;

    let html = "";
    for (let i = 0; i < entries.length; i++) {
        const [execId, info] = entries[i];
        const barPct = (info.time / maxTime * 100).toFixed(1);
        const sharePct = (info.time / totalTime * 100).toFixed(1);
        const isActive = execId === currentNodeId && isRunning;
        const ratio = info.time / maxTime;

        const bgColor = isActive ? "#1a3a1a" : (i % 2 === 0 ? "#1e1e2e" : "#222236");
        const barColor = isActive ? "#4CAF50" : getHeatColor(ratio);
        const timeColor = isActive ? "#4CAF50" : getHeatColor(ratio);
        const indicator = isActive ? '<span class="exec-row-active-indicator">▶ </span>' : "";

        html += `<div class="exec-row" style="background:${bgColor};">
            <div class="exec-row-title">
                ${indicator}<span class="exec-row-id">#${execId}</span>
                ${info.title || info.className || "?"}
            </div>
            <div class="exec-row-bar-container">
                <div class="exec-row-bar-track">
                    <div class="exec-row-bar-fill" style="width:${barPct}%;background:${barColor};"></div>
                </div>
                <span class="exec-row-time" style="color:${timeColor};">${fmt(info.time)}</span>
                <span class="exec-row-pct">${sharePct}%</span>
            </div>
        </div>`;
    }

    body.innerHTML = html;
}

function updateStatus() {
    const { containerEl, isRunning, executionStartTime, totalTimeMs, nodeData } = state;
    if (!containerEl) return;

    const stateEl = containerEl.querySelector("#exec-monitor-state");
    const elapsedEl = containerEl.querySelector("#exec-monitor-elapsed");
    const countEl = containerEl.querySelector("#exec-monitor-count");
    const totalEl = containerEl.querySelector("#exec-monitor-total");
    if (!stateEl) return;

    if (isRunning) {
        const elapsed = performance.now() - executionStartTime;
        stateEl.textContent = "Running...";
        stateEl.style.color = "#4CAF50";
        elapsedEl.textContent = fmt(elapsed);
    } else if (totalTimeMs > 0) {
        stateEl.textContent = "Completed";
        stateEl.style.color = "#e94560";
        elapsedEl.textContent = fmt(totalTimeMs);
    } else {
        stateEl.textContent = "Ready";
        stateEl.style.color = "#aaa";
        elapsedEl.textContent = "--";
    }

    countEl.textContent = `Nodes: ${nodeData.size}`;
    const sum = [...nodeData.values()].reduce((a, b) => a + b.time, 0);
    totalEl.textContent = `Total: ${sum > 0 ? fmt(sum) : "--"}`;
}

function startLiveTimer() {
    if (state.liveTimerId) return;
    state.liveTimerId = setInterval(() => {
        updateStatus();
        const { currentNodeId, nodeData } = state;
        if (currentNodeId && nodeData.has(currentNodeId)) {
            const info = nodeData.get(currentNodeId);
            info.time = performance.now() - info.startTime;
            renderRows();
        }
    }, 200);
}

function stopLiveTimer() {
    if (state.liveTimerId) {
        clearInterval(state.liveTimerId);
        state.liveTimerId = null;
    }
}

function finalizeCurrentNode() {
    const { currentNodeId, nodeData } = state;
    if (currentNodeId && nodeData.has(currentNodeId)) {
        const info = nodeData.get(currentNodeId);
        if (info.startTime > 0 && !state.hasEnhancedProfiler) {
            info.time = performance.now() - info.startTime;
        }
    }
}

function setupEventListeners() {
    api.addEventListener("execution_start", () => {
        state.nodeData.clear();
        state.execCounter = 0;
        state.totalTimeMs = 0;
        state.executionStartTime = performance.now();
        state.isRunning = true;
        state.currentNodeId = null;
        state.hasEnhancedProfiler = false;
        renderRows();
        updateStatus();
        startLiveTimer();
    });

    api.addEventListener("executing", ({ detail }) => {
        if (!state.isRunning) return;
        const nodeId = detail;

        if (nodeId) {
            finalizeCurrentNode();
            state.currentNodeId = String(nodeId);

            if (!state.nodeData.has(state.currentNodeId)) {
                state.execCounter++;
                const title = getNodeTitle(state.currentNodeId);
                state.nodeData.set(state.currentNodeId, {
                    title,
                    className: title,
                    time: 0,
                    startTime: performance.now(),
                    execOrder: state.execCounter,
                });
            } else {
                state.nodeData.get(state.currentNodeId).startTime = performance.now();
            }
        } else {
            finalizeCurrentNode();
            state.currentNodeId = null;
            state.isRunning = false;
            if (!state.hasEnhancedProfiler) {
                state.totalTimeMs = performance.now() - state.executionStartTime;
            }
            stopLiveTimer();
            renderRows();
            updateStatus();
        }
    });

    // Enhanced mode: precise timing from Enhancement-Utils profiler
    api.addEventListener("enhutils.profiler.executed", ({ detail }) => {
        state.hasEnhancedProfiler = true;
        const execId = String(detail.node);
        const timeMs = detail.execution_time;

        if (state.nodeData.has(execId)) {
            state.nodeData.get(execId).time = timeMs;
        } else {
            const title = getNodeTitle(execId);
            state.nodeData.set(execId, {
                title,
                className: title,
                time: timeMs,
                startTime: 0,
                execOrder: ++state.execCounter,
            });
        }

        if (state.currentNodeId === execId) {
            state.currentNodeId = null;
        }

        renderRows();
        updateStatus();
    });

    api.addEventListener("enhutils.profiler.execution_end", ({ detail }) => {
        state.isRunning = false;
        state.currentNodeId = null;
        state.totalTimeMs = detail?.total_time || 0;
        stopLiveTimer();
        renderRows();
        updateStatus();
    });
}

function loadPreviousResults() {
    fetch("/enhutils/profiler/results")
        .then(res => {
            if (!res.ok) throw new Error("Not available");
            return res.json();
        })
        .then(data => {
            if (!data || !data.node_times) return;
            state.hasEnhancedProfiler = true;
            for (const [execId, seconds] of Object.entries(data.node_times)) {
                const title = getNodeTitle(execId) || data.node_classes?.[execId] || "?";
                state.nodeData.set(execId, {
                    title,
                    className: title,
                    time: seconds * 1000,
                    startTime: 0,
                    execOrder: 0,
                });
            }
            if (state.nodeData.size > 0) {
                renderRows();
                updateStatus();
            }
        })
        .catch(() => {});
}

app.registerExtension({
    name: EXTENSION_NAME,

    setup() {
        setupEventListeners();
        loadPreviousResults();

        if (app.extensionManager?.registerSidebarTab) {
            app.extensionManager.registerSidebarTab({
                id: SIDEBAR_ID,
                icon: "pi pi-chart-bar",
                title: "Execution Monitor",
                tooltip: "Real-time node execution timing",
                type: "custom",
                render: (container) => {
                    state.containerEl = container;
                    container.innerHTML = buildPanelHTML();
                    setupSortButtons();
                    renderRows();
                    updateStatus();
                },
                destroy: () => {
                    state.containerEl = null;
                },
            });
        }
    },
});
