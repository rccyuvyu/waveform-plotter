(() => {
  const vscode = acquireVsCodeApi();

  const ui = {
    recordBtn: document.getElementById('recordBtn'),
    stopBtn: document.getElementById('stopBtn'),
    clearBtn: document.getElementById('clearBtn'),
    exportBtn: document.getElementById('exportBtn'),
    timeBtn: document.getElementById('timeBtn'),
    fftBtn: document.getElementById('fftBtn'),
    timeUnitBtn: document.getElementById('timeUnitBtn'),
    xZoomOutBtn: document.getElementById('xZoomOutBtn'),
    timeScaleBadge: document.getElementById('timeScaleBadge'),
    xZoomInBtn: document.getElementById('xZoomInBtn'),
    liveBtn: document.getElementById('liveBtn'),
    sourceSel: document.getElementById('sourceSel'),
    freqInput: document.getElementById('freqInput'),
    freqLabel: document.getElementById('freqLabel'),
    settingsBtn: document.getElementById('settingsBtn'),
    varInput: document.getElementById('varInput'),
    addBtn: document.getElementById('addBtn'),
    channels: document.getElementById('channels'),
    statusLeft: document.getElementById('statusLeft'),
    statusMid: document.getElementById('statusMid'),
    statusRight: document.getElementById('statusRight'),
    settingsDlg: document.getElementById('settingsDlg'),
    telnetPort: document.getElementById('telnetPort'),
    rttPort: document.getElementById('rttPort'),
    ramStart: document.getElementById('ramStart'),
    ramSize: document.getElementById('ramSize'),
    autoInit: document.getElementById('autoInit'),
    fontSize: document.getElementById('fontSize'),
    lineWidth: document.getElementById('lineWidth'),
    refreshFps: document.getElementById('refreshFps'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
    canvas: document.getElementById('plotCanvas')
  };

  const state = {
    bufferCapacity: 10000,
    data: { channels: [], timestampsSec: [], version: 0 },
    variables: [],
    status: '',
    sessionStatus: '',
    liveStatus: '',
    recording: false,
    liveRunning: false,
    dataSource: 'Telnet',
    frequencyHz: 50,
    displayMode: 'TIME',
    timeUnit: 'ms',
    fontSize: 12,
    lineWidth: 2,
    refreshFps: 60,
    settings: {
      telnetPort: 4444,
      rttPort: 9090,
      rttRamStart: '',
      rttRamSize: '',
      rttAutoInit: true
    }
  };

  const view = {
    yScale: 1,
    yOffset: 0,
    yAuto: true,
    timeYBase: { valid: false, min: -1, max: 1 },
    fftYBase: { valid: false, min: -120, max: 0 },
    xOffsetSec: 0,
    xScaleSPP: 0.001,
    autoTrack: true,
    xAuto: true,
    userZoomed: false,
    fftXScale: 1,
    fftXOffset: 0,
    hoverX: -1,
    hoverY: -1,
    dragging: false,
    dragAxisLock: 'none',
    dragStartX: 0,
    dragStartY: 0,
    dragStartXOffsetSec: 0,
    dragStartFftXOffset: 0,
    dragStartYOffset: 0,
    currentYMin: -1,
    currentYMax: 1,
    fftCache: null,
    fftCacheVersion: -1,
    lastRenderMs: 0,
    channelStructSig: '',
    channelDom: new Map()
  };

  const margins = { top: 12, right: 12, bottom: 28, left: 62 };
  const ctx = ui.canvas.getContext('2d');
  let dpr = window.devicePixelRatio || 1;

  setupEvents();
  setupCanvas();
  requestAnimationFrame(renderLoop);

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg?.type === 'append') {
      applyAppend(msg.append);
      return;
    }
    if (msg?.type !== 'state') {
      return;
    }
    Object.assign(state, msg.state);
    if (msg.state.data) {
      state.data = msg.state.data;
    }
    if (msg.state.variables) {
      state.variables = msg.state.variables;
    }
    renderControls();
  });

  vscode.postMessage({ type: 'refresh' });

  function setupEvents() {
    ui.recordBtn.addEventListener('click', () => vscode.postMessage({ type: 'record' }));
    ui.stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stopRecord' }));
    ui.clearBtn.addEventListener('click', () => {
      resetView();
      vscode.postMessage({ type: 'clear' });
    });
    ui.exportBtn.addEventListener('click', () => vscode.postMessage({ type: 'exportCsv' }));
    ui.timeBtn.addEventListener('click', () => {
      resetView();
      vscode.postMessage({ type: 'displayMode', mode: 'TIME' });
    });
    ui.fftBtn.addEventListener('click', () => {
      resetView();
      vscode.postMessage({ type: 'displayMode', mode: 'FFT' });
    });
    ui.timeUnitBtn.addEventListener('click', () => {
      const unit = state.timeUnit === 'ms' ? 'us' : 'ms';
      vscode.postMessage({ type: 'timeUnit', unit });
    });
    ui.xZoomOutBtn.addEventListener('click', () => zoomTimeAxis(1.2));
    ui.xZoomInBtn.addEventListener('click', () => zoomTimeAxis(1 / 1.2));
    ui.liveBtn.addEventListener('click', () => vscode.postMessage({ type: 'toggleLive' }));
    ui.sourceSel.addEventListener('change', () => vscode.postMessage({ type: 'dataSource', source: ui.sourceSel.value }));
    ui.freqInput.addEventListener('change', () => {
      const freq = clampInt(ui.freqInput.value, 1, 10000, 50);
      vscode.postMessage({ type: 'setFrequency', frequencyHz: freq });
    });
    ui.addBtn.addEventListener('click', addVarFromInput);
    ui.varInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        addVarFromInput();
      }
    });

    ui.settingsBtn.addEventListener('click', () => {
      fillSettings();
      ui.settingsDlg.showModal();
    });

    ui.saveSettingsBtn.addEventListener('click', () => {
      const payload = {
        type: 'saveSettings',
        telnetPort: clampInt(ui.telnetPort.value, 1, 65535, 4444),
        rttPort: clampInt(ui.rttPort.value, 1, 65535, 9090),
        rttRamStart: ui.ramStart.value.trim(),
        rttRamSize: ui.ramSize.value.trim(),
        rttAutoInit: ui.autoInit.checked,
        fontSize: clampInt(ui.fontSize.value, 8, 20, 12),
        lineWidth: clampFloat(ui.lineWidth.value, 0.5, 5, 2),
        refreshFps: clampInt(ui.refreshFps.value, 30, 120, 60)
      };
      vscode.postMessage(payload);
    });

    ui.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      resetView();
    });

    ui.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      view.dragging = true;
      view.dragAxisLock = 'none';
      view.dragStartX = e.offsetX;
      view.dragStartY = e.offsetY;
      view.dragStartXOffsetSec = view.xOffsetSec;
      view.dragStartFftXOffset = view.fftXOffset;
      view.dragStartYOffset = view.yOffset;
      ui.canvas.style.cursor = 'move';
    });

    window.addEventListener('mouseup', () => {
      view.dragging = false;
      view.dragAxisLock = 'none';
      ui.canvas.style.cursor = 'default';
    });

    ui.canvas.addEventListener('mousemove', (e) => {
      const rect = ui.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      view.hoverX = x;
      view.hoverY = y;

      if (!view.dragging) return;
      const plotW = width() - margins.left - margins.right;
      const plotH = height() - margins.top - margins.bottom;
      if (plotW <= 0 || plotH <= 0) return;

      const dx = x - view.dragStartX;
      const dy = y - view.dragStartY;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      // 拖拽方向锁定：以上下为主时仅移动 Y，避免 X 轴刻度值被误改
      if (view.dragAxisLock === 'none' && (absDx > 3 || absDy > 3)) {
        if (absDy > absDx * 1.25) {
          view.dragAxisLock = 'y';
        } else if (absDx > absDy * 1.25) {
          view.dragAxisLock = 'x';
        } else {
          view.dragAxisLock = 'xy';
        }
      }

      if (view.dragAxisLock !== 'y') {
        if (state.displayMode === 'TIME') {
          view.xOffsetSec = Math.max(0, view.dragStartXOffsetSec - dx * view.xScaleSPP);
          view.autoTrack = false;
          view.xAuto = false;
        } else {
          const spectra = computeSpectra();
          const maxBins = spectra[0]?.magnitudes.length || 0;
          if (maxBins > 0) {
            const visibleBins = Math.max(2, Math.floor(maxBins / view.fftXScale));
            const pixelsPerBin = plotW / visibleBins;
            view.fftXOffset = clampInt(view.dragStartFftXOffset - dx / pixelsPerBin, 0, Math.max(0, maxBins - visibleBins), 0);
          }
        }
      }

      if (view.dragAxisLock !== 'x') {
        const yRange = view.currentYMax - view.currentYMin;
        view.yOffset = view.dragStartYOffset + (dy / plotH) * yRange;
        view.yAuto = false;
      }
    });

    ui.canvas.addEventListener('mouseleave', () => {
      view.hoverX = -1;
      view.hoverY = -1;
    });

    ui.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (state.displayMode === 'TIME') {
          const px = e.offsetX - margins.left;
          const mouseTime = view.xOffsetSec + px * view.xScaleSPP;
          const zoomFactor = e.deltaY < 0 ? 1 / 1.2 : 1.2;
          view.xScaleSPP = clampFloat(view.xScaleSPP * zoomFactor, 1e-9, 100, 0.001);
          view.xOffsetSec = Math.max(0, mouseTime - px * view.xScaleSPP);
          view.autoTrack = false;
          view.xAuto = false;
          view.userZoomed = true;
        } else {
          view.fftXScale = clampFloat(view.fftXScale * factor, 0.1, 100, 1);
        }
      } else {
        view.yScale = clampFloat(view.yScale * factor, 0.01, 1000, 1);
        view.yAuto = false;
      }
    }, { passive: false });
  }

  function setupCanvas() {
    const ro = new ResizeObserver(() => resizeCanvas());
    ro.observe(ui.canvas.parentElement);
    resizeCanvas();
  }

  function resizeCanvas() {
    dpr = window.devicePixelRatio || 1;
    const rect = ui.canvas.getBoundingClientRect();
    ui.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    ui.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function width() {
    return ui.canvas.width / dpr;
  }

  function height() {
    return ui.canvas.height / dpr;
  }

  function renderLoop(ts) {
    const interval = 1000 / Math.max(1, state.refreshFps || 60);
    if (ts - view.lastRenderMs >= interval) {
      view.lastRenderMs = ts;
      draw();
    }
    requestAnimationFrame(renderLoop);
  }

  function draw() {
    const w = width();
    const h = height();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#171a1f';
    ctx.fillRect(0, 0, w, h);

    const plotW = w - margins.left - margins.right;
    const plotH = h - margins.top - margins.bottom;
    updateTimeScaleBadge(plotW);
    if (plotW <= 0 || plotH <= 0) return;

    const channels = state.data.channels;
    if (!channels.length || channels.every((ch) => ch.data.length === 0)) {
      drawEmptyHint(w, h);
      return;
    }

    if (state.displayMode === 'FFT') {
      paintFFT(plotW, plotH);
    } else {
      paintTime(plotW, plotH);
    }
  }

  function paintTime(plotW, plotH) {
    const timestamps = state.data.timestampsSec;
    if (timestamps.length < 2) {
      drawEmptyHint(width(), height());
      return;
    }

    const totalDuration = timestamps[timestamps.length - 1];
    if (view.xAuto && totalDuration > 0) {
      if (!view.userZoomed) {
        view.xScaleSPP = (totalDuration * 1.05) / plotW;
        view.xOffsetSec = 0;
      } else {
        const visible = view.xScaleSPP * plotW;
        view.xOffsetSec = Math.max(0, totalDuration - visible * 0.95);
      }
    }

    const tStart = view.xOffsetSec;
    const visibleDuration = view.xScaleSPP * plotW;
    const tEnd = tStart + visibleDuration;

    const startIdx = findIndexAtTime(timestamps, tStart);
    const endIdx = Math.min(timestamps.length, findIndexAtTime(timestamps, tEnd) + 1);

    let yMin = Number.POSITIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;
    for (const ch of state.data.channels) {
      for (let i = startIdx; i < Math.min(endIdx, ch.data.length); i++) {
        const v = ch.data[i];
        if (Number.isNaN(v)) continue;
        yMin = Math.min(yMin, v);
        yMax = Math.max(yMax, v);
      }
    }

    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      yMin = -1;
      yMax = 1;
    }
    if (yMin === yMax) {
      yMin -= 1;
      yMax += 1;
    }
    ({ yMin, yMax } = applyViewYRange('TIME', yMin, yMax));
    view.currentYMin = yMin;
    view.currentYMax = yMax;

    drawTimeGrid(plotW, plotH, yMin, yMax, tStart, tEnd);

    ctx.save();
    ctx.beginPath();
    ctx.rect(margins.left, margins.top, plotW, plotH);
    ctx.clip();

    for (const ch of state.data.channels) {
      ctx.strokeStyle = ch.color;
      ctx.lineWidth = state.lineWidth;
      ctx.beginPath();
      let prev = false;
      for (let i = startIdx; i < Math.min(endIdx, ch.data.length); i++) {
        const v = ch.data[i];
        if (Number.isNaN(v)) {
          prev = false;
          continue;
        }
        const x = margins.left + ((timestamps[i] - tStart) / visibleDuration) * plotW;
        const y = margins.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
        if (!prev) {
          ctx.moveTo(x, y);
          prev = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    ctx.restore();

    if (inPlot(view.hoverX, view.hoverY, plotW, plotH)) {
      drawTimeCrosshair(plotW, plotH, tStart, visibleDuration);
    }
  }

  function paintFFT(plotW, plotH) {
    const spectra = computeSpectra();
    if (!spectra.length) {
      drawEmptyHint(width(), height());
      return;
    }

    const halfN = spectra[0].magnitudes.length;
    const fftN = spectra[0].fftN;
    const freqResolution = Math.max(1, state.frequencyHz) / fftN;

    const visibleBins = clampInt(Math.floor(halfN / view.fftXScale), 2, halfN, halfN);
    const startBin = clampInt(view.fftXOffset, 0, Math.max(0, halfN - visibleBins), 0);
    const endBin = Math.min(halfN, startBin + visibleBins);

    let yMin = Number.POSITIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;
    for (const sp of spectra) {
      for (let i = startBin; i < Math.min(endBin, sp.magnitudes.length); i++) {
        const v = sp.magnitudes[i];
        if (v < -200) continue;
        yMin = Math.min(yMin, v);
        yMax = Math.max(yMax, v);
      }
    }

    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      yMin = -120;
      yMax = 0;
    }
    if (yMin === yMax) {
      yMin -= 10;
      yMax += 10;
    }
    ({ yMin, yMax } = applyViewYRange('FFT', yMin, yMax));
    view.currentYMin = yMin;
    view.currentYMax = yMax;

    drawFFTGrid(plotW, plotH, yMin, yMax, startBin, endBin, freqResolution);

    ctx.save();
    ctx.beginPath();
    ctx.rect(margins.left, margins.top, plotW, plotH);
    ctx.clip();

    for (const sp of spectra) {
      ctx.strokeStyle = sp.color;
      ctx.lineWidth = state.lineWidth;
      ctx.beginPath();
      let prev = false;
      for (let i = startBin; i < Math.min(endBin, sp.magnitudes.length); i++) {
        const v = sp.magnitudes[i];
        const x = margins.left + ((i - startBin) / (visibleBins - 1)) * plotW;
        const y = margins.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
        if (!prev) {
          ctx.moveTo(x, y);
          prev = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    ctx.restore();

    if (inPlot(view.hoverX, view.hoverY, plotW, plotH)) {
      drawFFTCrosshair(plotW, plotH, spectra, startBin, visibleBins, freqResolution);
    }
  }

  function drawTimeGrid(plotW, plotH, yMin, yMax, tStart, tEnd) {
    const duration = tEnd - tStart;
    drawYGrid(plotW, plotH, yMin, yMax);

    const step = pickFriendlyTimeStep(duration);
    let t = Math.ceil(tStart / step) * step;
    while (t <= tEnd) {
      const x = margins.left + ((t - tStart) / duration) * plotW;
      drawVGrid(x, margins.top, margins.top + plotH, fmtTime(t));
      t += step;
    }
  }

  function drawFFTGrid(plotW, plotH, yMin, yMax, startBin, endBin, freqResolution) {
    drawYGrid(plotW, plotH, yMin, yMax, 'dB');
    const freqStart = startBin * freqResolution;
    const freqEnd = Math.max(freqStart + freqResolution, (endBin - 1) * freqResolution);
    const freqSpan = freqEnd - freqStart;
    const step = pickFriendlyValueStep(freqSpan);
    const epsilon = step * 1e-6;
    let freq = Math.ceil((freqStart - epsilon) / step) * step;
    let guard = 0;

    while (freq <= freqEnd + epsilon && guard < 256) {
      const snapped = snapTick(freq, step);
      const x = margins.left + ((snapped - freqStart) / freqSpan) * plotW;
      drawVGrid(x, margins.top, margins.top + plotH, fmtFreq(snapped));
      freq += step;
      guard += 1;
    }
  }

  function drawYGrid(plotW, plotH, yMin, yMax, suffix = '') {
    ctx.strokeStyle = 'rgba(160, 170, 190, 0.22)';
    ctx.fillStyle = '#98a3b8';
    ctx.lineWidth = 1;
    ctx.font = `${Math.max(8, state.fontSize)}px "Fira Code", monospace`;

    const visibleRange = yMax - yMin;
    const step = pickFriendlyValueStep(visibleRange);
    const epsilon = step * 1e-6;
    let v = Math.ceil((yMin - epsilon) / step) * step;
    let guard = 0;

    while (v <= yMax + epsilon && guard < 256) {
      const snapped = snapTick(v, step);
      const y = margins.top + plotH - ((snapped - yMin) / visibleRange) * plotH;
      ctx.beginPath();
      ctx.moveTo(margins.left, y);
      ctx.lineTo(margins.left + plotW, y);
      ctx.stroke();
      ctx.fillText(`${fmtValue(snapped)}${suffix}`, 2, y + 4);
      v += step;
      guard += 1;
    }

    ctx.strokeStyle = 'rgba(160, 170, 190, 0.35)';
    ctx.strokeRect(margins.left, margins.top, plotW, plotH);
  }

  function drawVGrid(x, yTop, yBottom, label) {
    ctx.strokeStyle = 'rgba(160, 170, 190, 0.16)';
    ctx.beginPath();
    ctx.moveTo(x, yTop);
    ctx.lineTo(x, yBottom);
    ctx.stroke();
    ctx.fillStyle = '#98a3b8';
    ctx.font = `${Math.max(8, state.fontSize - 1)}px "Fira Code", monospace`;
    ctx.fillText(label, x + 2, yBottom + 14);
  }

  function drawTimeCrosshair(plotW, plotH, tStart, visibleDuration) {
    drawCrosshair(plotW, plotH);
    const relX = (view.hoverX - margins.left) / plotW;
    const hoverTime = tStart + relX * visibleDuration;
    const idx = findIndexAtTime(state.data.timestampsSec, hoverTime);
    const lines = [{ color: '#d2dae8', text: `t = ${fmtTime(hoverTime)}` }];
    for (const ch of state.data.channels) {
      if (idx < 0 || idx >= ch.data.length) continue;
      lines.push({ color: ch.color, text: `${ch.name}: ${fmtValue(ch.data[idx])}` });
    }
    drawTooltip(plotW, plotH, lines);
  }

  function drawFFTCrosshair(plotW, plotH, spectra, startBin, visibleBins, freqResolution) {
    drawCrosshair(plotW, plotH);
    const relX = (view.hoverX - margins.left) / plotW;
    const bin = startBin + Math.floor(relX * (visibleBins - 1));
    const freq = bin * freqResolution;
    const lines = [];
    for (const sp of spectra) {
      if (bin < 0 || bin >= sp.magnitudes.length) continue;
      lines.push({ color: sp.color, text: `${sp.name}: ${fmtFreq(freq)}, ${fmtValue(sp.magnitudes[bin])}dB` });
    }
    drawTooltip(plotW, plotH, lines);
  }

  function drawCrosshair(plotW, plotH) {
    ctx.strokeStyle = 'rgba(230, 235, 245, 0.4)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(view.hoverX, margins.top);
    ctx.lineTo(view.hoverX, margins.top + plotH);
    ctx.moveTo(margins.left, view.hoverY);
    ctx.lineTo(margins.left + plotW, view.hoverY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawTooltip(plotW, plotH, lines) {
    if (!lines.length) return;
    ctx.font = `bold ${Math.max(9, state.fontSize + 1)}px "Fira Code", monospace`;
    const lineH = Math.max(14, state.fontSize + 5);
    let maxW = 0;
    for (const l of lines) {
      maxW = Math.max(maxW, ctx.measureText(l.text).width);
    }
    const tw = maxW + 16;
    const th = lines.length * lineH + 8;
    const tx = view.hoverX + tw + 12 > margins.left + plotW ? view.hoverX - tw - 8 : view.hoverX + 10;
    const ty = clampFloat(view.hoverY - th / 2, margins.top, margins.top + plotH - th, margins.top);

    ctx.fillStyle = 'rgba(22, 25, 32, 0.92)';
    roundRect(ctx, tx, ty, tw, th, 6, true, false);
    ctx.strokeStyle = 'rgba(220, 230, 240, 0.28)';
    roundRect(ctx, tx, ty, tw, th, 6, false, true);

    let y = ty + lineH;
    for (const l of lines) {
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, tx + 8, y);
      y += lineH;
    }
  }

  function drawEmptyHint(w, h) {
    ctx.fillStyle = '#8fa0b8';
    ctx.font = `${Math.max(11, state.fontSize + 2)}px "JetBrains Mono", monospace`;
    const text = 'Select variables and start recording to see waveforms';
    const mw = ctx.measureText(text).width;
    ctx.fillText(text, (w - mw) / 2, h / 2);
  }

  function computeSpectra() {
    if (view.fftCache && view.fftCacheVersion === state.data.version) {
      return view.fftCache;
    }
    const maxPoints = state.data.channels.reduce((m, ch) => Math.max(m, ch.data.length), 0);
    const fftInputSize = Math.min(1024, maxPoints);
    if (fftInputSize < 2) {
      view.fftCache = [];
      view.fftCacheVersion = state.data.version;
      return view.fftCache;
    }

    const fft = new FFT();
    const spectra = [];
    for (const ch of state.data.channels) {
      if (ch.data.length < 2) continue;
      const n = Math.min(fftInputSize, ch.data.length);
      const slice = ch.data.slice(ch.data.length - n).map((v) => (Number.isNaN(v) ? 0 : v));
      spectra.push({
        name: ch.name,
        color: ch.color,
        magnitudes: fft.magnitudeSpectrum(slice),
        fftN: fft.fftSize(slice.length)
      });
    }

    view.fftCache = spectra;
    view.fftCacheVersion = state.data.version;
    return spectra;
  }

  function renderControls() {
    ui.sourceSel.value = state.dataSource;
    if (ui.freqInput.value !== String(state.frequencyHz)) {
      ui.freqInput.value = String(state.frequencyHz);
    }
    ui.freqInput.style.display = state.dataSource === 'RTT' ? 'none' : '';
    ui.freqLabel.style.display = state.dataSource === 'RTT' ? 'none' : '';

    ui.timeUnitBtn.textContent = state.timeUnit;
    ui.recordBtn.disabled = state.recording;
    ui.stopBtn.disabled = !state.recording;
    ui.liveBtn.textContent = state.liveRunning ? (state.dataSource === 'RTT' ? '■ RTT' : '■ Live') : '▶ Live';

    ui.timeBtn.disabled = state.displayMode === 'TIME';
    ui.fftBtn.disabled = state.displayMode === 'FFT';
    ui.timeUnitBtn.style.display = state.displayMode === 'TIME' ? '' : 'none';
    ui.xZoomOutBtn.style.display = state.displayMode === 'TIME' ? '' : 'none';
    ui.xZoomInBtn.style.display = state.displayMode === 'TIME' ? '' : 'none';
    ui.timeScaleBadge.style.display = state.displayMode === 'TIME' ? '' : 'none';
    ui.xZoomOutBtn.disabled = state.displayMode !== 'TIME';
    ui.xZoomInBtn.disabled = state.displayMode !== 'TIME';

    if (ui.statusLeft.textContent !== state.status) ui.statusLeft.textContent = state.status;
    if (ui.statusMid.textContent !== state.sessionStatus) ui.statusMid.textContent = state.sessionStatus;
    if (ui.statusRight.textContent !== state.liveStatus) ui.statusRight.textContent = state.liveStatus;

    renderChannelsSmart();
  }

  function renderChannelsSmart() {
    const signature = state.variables.map((v) => `${v.name}|${v.color}`).join('\u0001');
    const structureChanged = signature !== view.channelStructSig;
    if (structureChanged) {
      view.channelStructSig = signature;
      const el = ui.channels;
      el.innerHTML = '';
      view.channelDom.clear();

      for (const v of state.variables) {
        const item = document.createElement('div');
        item.className = 'chItem';
        item.style.color = v.color;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', () => {
          vscode.postMessage({ type: 'toggleTracked', name: v.name, checked: cb.checked });
        });

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = v.name;

        const value = document.createElement('span');
        value.className = 'value';

        const remove = document.createElement('button');
        remove.className = 'remove';
        remove.textContent = '✕';
        remove.addEventListener('click', () => {
          vscode.postMessage({ type: 'removeVariable', name: v.name });
        });

        item.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          vscode.postMessage({ type: 'removeVariable', name: v.name });
        });

        item.appendChild(cb);
        item.appendChild(name);
        item.appendChild(value);
        item.appendChild(remove);
        el.appendChild(item);

        view.channelDom.set(v.name, { cb, value });
      }
    }

    for (const v of state.variables) {
      const node = view.channelDom.get(v.name);
      if (!node) continue;
      if (node.cb.checked !== !!v.checked) {
        node.cb.checked = !!v.checked;
      }
      const text = v.valueText ? ` ${v.valueText}` : '';
      if (node.value.textContent !== text) {
        node.value.textContent = text;
      }
    }
  }

  function fillSettings() {
    ui.telnetPort.value = String(state.settings.telnetPort);
    ui.rttPort.value = String(state.settings.rttPort);
    ui.ramStart.value = state.settings.rttRamStart || '';
    ui.ramSize.value = state.settings.rttRamSize || '';
    ui.autoInit.checked = !!state.settings.rttAutoInit;
    ui.fontSize.value = String(state.fontSize);
    ui.lineWidth.value = String(state.lineWidth);
    ui.refreshFps.value = String(state.refreshFps >= 120 ? 120 : state.refreshFps >= 60 ? 60 : 30);
  }

  function applyAppend(append) {
    if (!append || !Array.isArray(append.timestampsSec) || !state.data) {
      return;
    }
    if (!Array.isArray(state.data.timestampsSec)) {
      state.data.timestampsSec = [];
    }

    state.data.timestampsSec.push(...append.timestampsSec);
    const appendMap = new Map((append.channels || []).map((ch) => [ch.name, ch.data || []]));
    for (const channel of state.data.channels) {
      const incoming = appendMap.get(channel.name);
      if (incoming && incoming.length) {
        channel.data.push(...incoming);
      }
    }

    trimBufferedData();
    state.data.version = state.data.version + append.timestampsSec.length;
    renderControls();
  }

  function trimBufferedData() {
    const overflow = Math.max(0, state.data.timestampsSec.length - state.bufferCapacity);
    if (overflow <= 0) {
      return;
    }
    state.data.timestampsSec.splice(0, overflow);
    for (const channel of state.data.channels) {
      channel.data.splice(0, overflow);
    }
  }

  function addVarFromInput() {
    const name = ui.varInput.value.trim();
    if (!name) return;
    vscode.postMessage({ type: 'addVariable', name });
    ui.varInput.value = '';
  }

  function findIndexAtTime(ts, t) {
    if (!ts.length) return 0;
    let lo = 0;
    let hi = ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function pickFriendlyTimeStep(visibleDuration) {
    const target = visibleDuration / 6;
    if (target <= 0) return 1;
    const steps = [1, 2, 5];
    const exp = Math.floor(Math.log10(target));
    const base = Math.pow(10, exp);
    for (const s of steps) {
      const step = s * base;
      if (step >= target * 0.7) return step;
    }
    return 10 * base;
  }

  function zoomTimeAxis(zoomFactor) {
    if (state.displayMode !== 'TIME') return;
    const plotW = width() - margins.left - margins.right;
    if (plotW <= 0) return;
    const anchorRatio = 0.5;
    const anchorTime = view.xOffsetSec + anchorRatio * plotW * view.xScaleSPP;
    view.xScaleSPP = clampFloat(view.xScaleSPP * zoomFactor, 1e-9, 100, 0.001);
    view.xOffsetSec = Math.max(0, anchorTime - anchorRatio * plotW * view.xScaleSPP);
    view.autoTrack = false;
    view.xAuto = false;
    view.userZoomed = true;
    updateTimeScaleBadge(plotW);
  }

  function updateTimeScaleBadge(plotW) {
    if (!ui.timeScaleBadge) return;
    if (state.displayMode !== 'TIME') {
      if (ui.timeScaleBadge.textContent !== 'X Tick --') {
        ui.timeScaleBadge.textContent = 'X Tick --';
      }
      return;
    }
    const safePlotW = Math.max(1, plotW || width() - margins.left - margins.right);
    const visibleDuration = Math.max(view.xScaleSPP * safePlotW, 0);
    const tick = pickFriendlyTimeStep(visibleDuration);
    const label = `X Tick ${fmtTime(tick)}`;
    if (ui.timeScaleBadge.textContent !== label) {
      ui.timeScaleBadge.textContent = label;
    }
  }

  function pickFriendlyValueStep(visibleRange) {
    const target = visibleRange / 6;
    if (target <= 0) return 1;
    const steps = [1, 2, 5];
    const exp = Math.floor(Math.log10(target));
    const base = Math.pow(10, exp);
    for (const s of steps) {
      const step = s * base;
      if (step >= target * 0.7) return step;
    }
    return 10 * base;
  }

  function snapTick(value, step) {
    return Math.round(value / step) * step;
  }

  function fmtValue(v) {
    if (!Number.isFinite(v)) return 'NaN';
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 1) return v.toFixed(2);
    if (a >= 0.01) return v.toFixed(4);
    return v.toExponential(2);
  }

  function fmtFreq(hz) {
    if (hz >= 1000) return `${(hz / 1000).toFixed(1)}kHz`;
    if (hz >= 1) return `${hz.toFixed(1)}Hz`;
    return `${hz.toFixed(2)}Hz`;
  }

  function fmtTime(seconds) {
    if (state.timeUnit === 'us') {
      const us = seconds * 1_000_000;
      if (Math.abs(us) >= 100) return `${us.toFixed(0)}μs`;
      if (Math.abs(us) >= 1) return `${us.toFixed(1)}μs`;
      return `${us.toFixed(2)}μs`;
    }
    const ms = seconds * 1000;
    if (Math.abs(ms) >= 100) return `${ms.toFixed(0)}ms`;
    if (Math.abs(ms) >= 1) return `${ms.toFixed(1)}ms`;
    return `${ms.toFixed(2)}ms`;
  }

  function inPlot(x, y, plotW, plotH) {
    return x >= margins.left && x <= margins.left + plotW && y >= margins.top && y <= margins.top + plotH;
  }

  function resetView() {
    view.yScale = 1;
    view.yOffset = 0;
    view.xScaleSPP = 0.001;
    view.xOffsetSec = 0;
    view.autoTrack = true;
    view.xAuto = true;
    view.userZoomed = false;
    view.fftXScale = 1;
    view.fftXOffset = 0;
    view.yAuto = true;
    view.timeYBase.valid = false;
    view.fftYBase.valid = false;
  }

  function applyViewYRange(mode, rawMin, rawMax) {
    const base = mode === 'FFT' ? view.fftYBase : view.timeYBase;
    if (view.yAuto || !base.valid) {
      base.min = rawMin;
      base.max = rawMax;
      base.valid = true;
    }
    let min = base.min;
    let max = base.max;
    const yc = (min + max) / 2;
    const yr = (max - min) / view.yScale;
    min = yc - yr / 2 + view.yOffset;
    max = yc + yr / 2 + view.yOffset;
    return { yMin: min, yMax: max };
  }

  function roundRect(c, x, y, w, h, r, fill, stroke) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
    if (fill) c.fill();
    if (stroke) c.stroke();
  }

  function clampInt(v, min, max, fallback) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function clampFloat(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  class FFT {
    constructor() {
      this.cachedWindowSize = 0;
      this.cachedWindow = [];
      this.workN = 0;
      this.workRe = [];
      this.workIm = [];
    }

    magnitudeSpectrum(input) {
      const n = this.nextPowerOf2(input.length);
      const half = n / 2;
      if (this.workN !== n) {
        this.workN = n;
        this.workRe = new Array(n).fill(0);
        this.workIm = new Array(n).fill(0);
      }
      const window = this.getWindow(input.length);
      for (let i = 0; i < input.length; i++) {
        this.workRe[i] = input[i] * window[i];
      }
      for (let i = input.length; i < n; i++) {
        this.workRe[i] = 0;
      }
      this.workIm.fill(0);
      this.fft(this.workRe, this.workIm);

      const out = new Array(half);
      const invN = 2 / n;
      for (let i = 0; i < half; i++) {
        const amp = Math.sqrt(this.workRe[i] * this.workRe[i] + this.workIm[i] * this.workIm[i]) * invN;
        out[i] = amp > 1e-12 ? 20 * Math.log10(amp) : -240;
      }
      return out;
    }

    fftSize(inputSize) {
      return this.nextPowerOf2(inputSize);
    }

    getWindow(size) {
      if (this.cachedWindowSize === size) return this.cachedWindow;
      this.cachedWindowSize = size;
      this.cachedWindow = new Array(size);
      if (size <= 1) {
        this.cachedWindow.fill(1);
        return this.cachedWindow;
      }
      for (let i = 0; i < size; i++) {
        this.cachedWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
      }
      return this.cachedWindow;
    }

    nextPowerOf2(n) {
      let v = 1;
      while (v < n) v <<= 1;
      return v;
    }

    fft(re, im) {
      const n = re.length;
      let j = 0;
      for (let i = 1; i < n; i++) {
        let bit = n >> 1;
        while (j & bit) {
          j ^= bit;
          bit >>= 1;
        }
        j ^= bit;
        if (i < j) {
          [re[i], re[j]] = [re[j], re[i]];
          [im[i], im[j]] = [im[j], im[i]];
        }
      }

      for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const angle = (-2 * Math.PI) / len;
        const wRe = Math.cos(angle);
        const wIm = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
          let curRe = 1;
          let curIm = 0;
          for (let k = 0; k < half; k++) {
            const idx = i + k + half;
            const tRe = curRe * re[idx] - curIm * im[idx];
            const tIm = curRe * im[idx] + curIm * re[idx];
            re[idx] = re[i + k] - tRe;
            im[idx] = im[i + k] - tIm;
            re[i + k] += tRe;
            im[i + k] += tIm;
            const newRe = curRe * wRe - curIm * wIm;
            curIm = curRe * wIm + curIm * wRe;
            curRe = newRe;
          }
        }
      }
    }
  }
})();
