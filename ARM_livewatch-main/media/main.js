// @ts-check
/// <reference lib="dom" />

/**
 * Live Watch WebView frontend.
 * ViewRow fields from backend: id, depth, name, value, address (string),
 * typeName, hasChildren, expanded, changed, isInput, displayFormat, error
 */
(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();

    const tbody = document.getElementById('watch-tbody');
    const btnConnect = document.getElementById('btn-connect');
    const btnPause = document.getElementById('btn-pause');
    const btnPauseLabel = document.getElementById('btn-pause-label');
    const btnRefresh = document.getElementById('btn-refresh');
    const btnClear = document.getElementById('btn-clear');
    const btnSettings = document.getElementById('btn-settings');
    const statusText = document.getElementById('status-text');
    const contextMenu = document.getElementById('context-menu');
    const watchTable = document.querySelector('.watch-table');
    const colEls = {
        name: document.getElementById('col-name'),
        value: document.getElementById('col-value'),
        address: document.getElementById('col-address'),
        type: document.getElementById('col-type'),
    };
    const headerEls = {
        name: document.querySelector('th[data-col="name"]'),
        value: document.querySelector('th[data-col="value"]'),
        address: document.querySelector('th[data-col="address"]'),
        type: document.querySelector('th[data-col="type"]'),
    };

    const defaultColWidths = {
        name: 150,
        value: 230,
        address: 220,
        type: 180,
    };
    const minColWidths = {
        name: 50,
        value: 120,
        address: 150,
        type: 120,
    };
    const colWidths = { ...defaultColWidths };

    let rows = [];
    let connectionState = 'disconnected';
    let paused = false;
    let selectedId = null;
    let contextId = null;
    let previousValues = {};
    let addInputEl = null;
    let addInputDraft = '';
    let addInputError = '';
    let nextAddReqId = 1;
    let activeAddReqId = null;
    let pendingRows = null;
    let isValueEditing = false;
    let editingRowId = null;
    let isResizingColumn = false;

    // ── Toolbar ────────────────────────────────────────────────
    btnConnect.addEventListener('click', () => vscode.postMessage({ type: 'connect' }));
    btnPause.addEventListener('click', () => vscode.postMessage({ type: 'togglePause' }));
    btnRefresh.addEventListener('click', () => vscode.postMessage({ type: 'refreshSymbols' }));
    btnClear.addEventListener('click', () => vscode.postMessage({ type: 'clearAll' }));
    btnSettings.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    setupColumnResize();

    // ── Messages from extension host ───────────────────────────
    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'fullState':
                queueIncomingRows(msg.rows || []);
                connectionState = msg.connectionState || 'disconnected';
                paused = msg.paused || false;
                renderToolbar();
                break;
            case 'updateTree':
                queueIncomingRows(msg.rows || []);
                break;
            case 'connectionState':
                connectionState = msg.state;
                renderToolbar();
                break;
            case 'pauseState':
                paused = msg.paused;
                renderToolbar();
                break;
            case 'addWatchResult':
                handleAddWatchResult(msg);
                break;
        }
    });

    // Delete key removes selected watch (Keil-like behavior)
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Delete' || !selectedId) { return; }
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) { return; }
        e.preventDefault();
        vscode.postMessage({ type: 'removeWatch', nodeId: selectedId });
        selectedId = null;
    });

    vscode.postMessage({ type: 'ready' });

    function isAddInputFocused() {
        const active = document.activeElement;
        return active instanceof HTMLElement && active.classList.contains('add-input');
    }

    function isValueInputFocused() {
        const active = document.activeElement;
        return active instanceof HTMLElement && active.classList.contains('value-input');
    }

    function applyColumnWidths() {
        const keys = Object.keys(colWidths);
        for (const key of keys) {
            const colEl = colEls[key];
            if (!colEl) { continue; }
            colEl.style.width = `${colWidths[key]}px`;
        }
    }

    function setupColumnResize() {
        if (!watchTable) { return; }
        applyColumnWidths();

        const keys = Object.keys(headerEls);
        for (const key of keys) {
            const th = headerEls[key];
            if (!th) { continue; }
            const handle = document.createElement('span');
            handle.className = 'col-resizer';
            handle.dataset.col = key;
            handle.addEventListener('mousedown', (e) => startColumnResize(e, key));
            th.appendChild(handle);
        }
    }

    function startColumnResize(e, key) {
        if (!(e instanceof MouseEvent)) { return; }
        e.preventDefault();
        e.stopPropagation();

        isResizingColumn = true;
        document.body.classList.add('resizing-columns');

        const startX = e.clientX;
        const startWidth = colWidths[key];

        const onMove = (evt) => {
            if (!(evt instanceof MouseEvent)) { return; }
            const delta = evt.clientX - startX;
            const minWidth = minColWidths[key] || 120;
            const next = Math.max(minWidth, startWidth + delta);
            colWidths[key] = next;
            applyColumnWidths();
        };

        const stop = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', stop);
            isResizingColumn = false;
            document.body.classList.remove('resizing-columns');
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', stop);
    }

    function queueIncomingRows(nextRows) {
        // While typing in add-watch input, allow value-only patch updates so
        // other rows keep refreshing without destroying caret/input state.
        if (isAddInputFocused()) {
            if (canPatchRows(rows, nextRows) && patchTableValues(rows, nextRows)) {
                rows = nextRows;
                return;
            }
            pendingRows = nextRows;
            return;
        }

        // While editing one value cell, keep refreshing other cells and skip only
        // the actively edited row to preserve caret/input content.
        if (isValueEditing || isValueInputFocused()) {
            if (canPatchRows(rows, nextRows) && patchTableValues(rows, nextRows, editingRowId)) {
                rows = nextRows;
                return;
            }
            pendingRows = nextRows;
            return;
        }

        applyIncomingRows(nextRows);
    }

    function flushPendingRows() {
        if (!pendingRows) { return; }
        if (isValueEditing || isValueInputFocused()) { return; }
        applyIncomingRows(pendingRows);
        pendingRows = null;
    }

    function applyIncomingRows(nextRows) {
        if (canPatchRows(rows, nextRows) && patchTableValues(rows, nextRows)) {
            rows = nextRows;
            return;
        }
        rows = nextRows;
        renderTable();
    }

    function canPatchRows(prevRows, nextRows) {
        if (!Array.isArray(prevRows) || !Array.isArray(nextRows)) { return false; }
        if (prevRows.length === 0 || nextRows.length === 0) { return false; }
        if (prevRows.length !== nextRows.length) { return false; }

        for (let i = 0; i < prevRows.length; i++) {
            const a = prevRows[i];
            const b = nextRows[i];
            if (a.id !== b.id) { return false; }
            if (a.depth !== b.depth) { return false; }
            if (a.name !== b.name) { return false; }
            if (a.typeName !== b.typeName) { return false; }
            if (a.address !== b.address) { return false; }
            if (a.hasChildren !== b.hasChildren) { return false; }
            if (a.expanded !== b.expanded) { return false; }
        }

        return true;
    }

    function patchTableValues(prevRows, nextRows, skipRowId = null) {
        if (!tbody) { return false; }

        const watchTrs = tbody.querySelectorAll('tr.watch-row');
        if (watchTrs.length !== nextRows.length) { return false; }

        const rowElById = new Map();
        watchTrs.forEach((tr) => {
            if (tr.dataset.id) {
                rowElById.set(tr.dataset.id, tr);
            }
        });

        for (let i = 0; i < nextRows.length; i++) {
            const row = nextRows[i];
            const prev = prevRows[i];
            const tr = rowElById.get(row.id);
            if (!tr) { return false; }
            const valTd = tr.children[1];
            if (!(valTd instanceof HTMLElement)) { return false; }
            if (skipRowId && row.id === skipRowId) {
                continue;
            }

            const isLeaf = !row.hasChildren;
            if (row.error) {
                valTd.innerHTML = '<span class="error-value">' + escapeHtml(row.error) + '</span>';
                valTd.classList.remove('editable', 'value-changed');
            } else {
                valTd.textContent = row.value || '';
                if (isLeaf) {
                    valTd.classList.add('editable');
                } else {
                    valTd.classList.remove('editable');
                }
                if (row.changed) {
                    valTd.classList.add('value-changed');
                } else {
                    valTd.classList.remove('value-changed');
                }
            }

            if (prev.value !== row.value && row.value !== '') {
                tr.classList.add('just-changed');
                setTimeout(() => tr.classList.remove('just-changed'), 800);
            }
        }

        return true;
    }

    function getRowById(rowId) {
        if (!rowId) { return null; }
        for (const r of rows) {
            if (r.id === rowId) {
                return r;
            }
        }
        return null;
    }

    function handleAddWatchResult(msg) {
        const reqId = typeof msg.reqId === 'number' ? msg.reqId : null;
        if (reqId !== null && activeAddReqId !== reqId) {
            return;
        }

        activeAddReqId = null;
        if (msg.success) {
            addInputError = '';
            addInputDraft = '';
            if (addInputEl) {
                addInputEl.value = '';
                addInputEl.classList.remove('invalid', 'pending');
                addInputEl.removeAttribute('title');
                addInputEl.focus();
            }
            if (pendingRows) {
                applyIncomingRows(pendingRows);
                pendingRows = null;
            }
            return;
        }

        addInputError = msg.message || 'Failed to add watch';
        if (addInputEl) {
            addInputEl.classList.remove('pending');
            addInputEl.classList.add('invalid');
            addInputEl.title = addInputError;
            addInputEl.focus();
            addInputEl.select();
        }
    }

    // ── Render ─────────────────────────────────────────────────

    function renderAll() {
        renderToolbar();
        renderTable();
    }

    function renderToolbar() {
        const dot = btnConnect.querySelector('.status-dot');
        dot.className = 'status-dot ' + connectionState;

        const label = btnConnect.querySelector('span:last-child');
        if (connectionState === 'connected') {
            label.textContent = 'Connected';
            statusText.textContent = 'Connected';
        } else if (connectionState === 'connecting') {
            label.textContent = 'Connecting...';
            statusText.textContent = 'Connecting...';
        } else {
            label.textContent = 'Connect';
            statusText.textContent = 'Disconnected';
        }

        btnPauseLabel.textContent = paused ? 'Resume' : 'Pause';
    }

    function renderTable() {
        if (!tbody) { return; }
        const shouldRefocusAddInput = document.activeElement instanceof HTMLElement &&
            document.activeElement.classList.contains('add-input');

        // Track changed values for flash animation
        const newValues = {};
        const changedIds = new Set();
        for (const row of rows) {
            newValues[row.id] = row.value;
            if (previousValues[row.id] !== undefined &&
                previousValues[row.id] !== row.value &&
                row.value !== '') {
                changedIds.add(row.id);
            }
        }
        previousValues = newValues;

        const fragment = document.createDocumentFragment();

        if (rows.length === 0) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 4;
            td.className = 'empty-hint';
            td.textContent = 'No variables watched. Type a name below to add one.';
            tr.appendChild(td);
            fragment.appendChild(tr);
        } else {
            for (const row of rows) {
                fragment.appendChild(createRow(row, changedIds.has(row.id)));
            }
        }

        fragment.appendChild(createInputRow());

        tbody.innerHTML = '';
        tbody.appendChild(fragment);

        if (shouldRefocusAddInput && addInputEl) {
            addInputEl.focus();
            const endPos = addInputEl.value.length;
            addInputEl.setSelectionRange(endPos, endPos);
        }
    }

    /**
     * Create a table row.
     * Row fields: id, depth, name, value, address (string "0x..."),
     * typeName, hasChildren, expanded, changed, displayFormat, error
     */
    function createRow(row, justChanged) {
        const tr = document.createElement('tr');
        tr.className = 'watch-row';
        tr.dataset.id = row.id;
        if (row.id === selectedId) { tr.classList.add('selected'); }
        if (justChanged) { tr.classList.add('just-changed'); }

        // ── Name cell ──
        const nameTd = document.createElement('td');
        const nameDiv = document.createElement('div');
        nameDiv.className = 'name-cell';

        // indent
        const indent = document.createElement('span');
        indent.className = 'indent';
        indent.style.width = (row.depth * 16) + 'px';
        indent.innerHTML = '&nbsp;';
        nameDiv.appendChild(indent);

        // toggle arrow
        const toggle = document.createElement('span');
        const isLeaf = !row.hasChildren;
        toggle.className = 'toggle' + (isLeaf ? ' leaf' : '');
        if (!isLeaf) {
            toggle.textContent = row.expanded ? '\u25BE' : '\u25B8';
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ type: 'toggleExpand', nodeId: row.id });
            });
        }
        nameDiv.appendChild(toggle);

        // name text
        const nameSpan = document.createElement('span');
        nameSpan.className = 'name-text';
        nameSpan.textContent = row.name;
        nameDiv.appendChild(nameSpan);

        nameTd.appendChild(nameDiv);
        tr.appendChild(nameTd);

        // ── Value cell ──
        const valTd = document.createElement('td');
        valTd.className = 'value-cell';
        if (row.error) {
            valTd.innerHTML = '<span class="error-value">' + escapeHtml(row.error) + '</span>';
        } else {
            valTd.textContent = row.value || '';
            if (isLeaf) {
                valTd.classList.add('editable');
                valTd.addEventListener('dblclick', () => {
                    const current = getRowById(row.id) || row;
                    startEdit(valTd, current);
                });
            }
            if (row.changed) {
                valTd.classList.add('value-changed');
            }
        }
        tr.appendChild(valTd);

        // ── Address cell ──
        const addrTd = document.createElement('td');
        addrTd.innerHTML = '<span class="address-text">' + escapeHtml(row.address || '') + '</span>';
        tr.appendChild(addrTd);

        // ── Type cell ──
        const typeTd = document.createElement('td');
        typeTd.innerHTML = '<span class="type-text">' + escapeHtml(row.typeName || '') + '</span>';
        tr.appendChild(typeTd);

        // click to select (no full re-render, otherwise dblclick edit is interrupted)
        tr.addEventListener('click', () => {
            selectedId = row.id;
            const prev = tbody.querySelector('.watch-row.selected');
            if (prev && prev !== tr) {
                prev.classList.remove('selected');
            }
            tr.classList.add('selected');
        });
        // right-click context
        tr.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const current = getRowById(row.id) || row;
            showCtx(e, current);
        });

        return tr;
    }

    function createInputRow() {
        const tr = document.createElement('tr');
        tr.className = 'input-row';
        const td = document.createElement('td');
        td.colSpan = 4;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'add-input';
        if (activeAddReqId !== null) {
            input.classList.add('pending');
        }
        if (addInputError) {
            input.classList.add('invalid');
            input.title = addInputError;
        }
        input.placeholder = '<Enter variable name>';
        input.value = addInputDraft;
        addInputEl = input;
        input.addEventListener('input', () => {
            addInputDraft = input.value;
            addInputError = '';
            input.classList.remove('invalid');
            input.removeAttribute('title');
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const val = input.value.trim();
                if (val) {
                    if (activeAddReqId !== null) { return; }
                    addInputDraft = input.value;
                    addInputError = '';
                    input.classList.remove('invalid');
                    input.classList.add('pending');
                    input.removeAttribute('title');
                    const reqId = nextAddReqId++;
                    activeAddReqId = reqId;
                    vscode.postMessage({ type: 'addWatch', name: val, reqId });
                }
            }
        });
        input.addEventListener('blur', () => {
            setTimeout(() => flushPendingRows(), 0);
        });

        tr.addEventListener('click', () => {
            addInputEl?.focus();
        });

        td.appendChild(input);
        tr.appendChild(td);
        return tr;
    }

    // ── Value editing ──────────────────────────────────────────

    function startEdit(cell, row) {
        if (isValueEditing) { return; }
        isValueEditing = true;
        editingRowId = row.id;

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'value-input';
        input.value = row.value || '';
        cell.textContent = '';
        cell.appendChild(input);
        input.focus();
        input.select();

        let done = false;
        const finish = (commitWrite) => {
            if (done) { return; }
            done = true;
            const v = input.value.trim();
            if (commitWrite && v && v !== row.value) {
                vscode.postMessage({ type: 'writeValue', nodeId: row.id, value: v });
            }
            isValueEditing = false;
            editingRowId = null;
            renderTable();
            flushPendingRows();
        };

        input.addEventListener('blur', () => finish(true));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { finish(true); }
            if (e.key === 'Escape') { finish(false); }
        });
    }

    // ── Context menu ───────────────────────────────────────────

    function showCtx(e, row) {
        contextId = row.id;
        contextMenu.classList.remove('hidden');
        contextMenu.style.left = e.clientX + 'px';
        contextMenu.style.top = e.clientY + 'px';
        contextMenu.querySelectorAll('[data-format]').forEach(item => {
            item.classList.toggle('active', item.dataset.format === (row.displayFormat || 'auto'));
        });
    }

    document.addEventListener('click', () => { contextMenu.classList.add('hidden'); });

    contextMenu.addEventListener('click', (e) => {
        const item = e.target.closest('.context-menu-item');
        if (!item || !contextId) { return; }
        if (item.dataset.format) {
            vscode.postMessage({ type: 'setFormat', nodeId: contextId, format: item.dataset.format });
        }
        if (item.dataset.action === 'remove') {
            vscode.postMessage({ type: 'removeWatch', nodeId: contextId });
        }
        contextMenu.classList.add('hidden');
    });

    // ── Util ───────────────────────────────────────────────────

    function escapeHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }
})();
