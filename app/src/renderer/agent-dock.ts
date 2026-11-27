import type { IronAgentDockApi } from '../preload/agent-preload';
import {
  parseAgentTranscript,
  parseAnsiTranscript,
  stripAnsiAll,
  tokenizeCodeLine,
  type AnsiSpan,
  type InlineToken,
} from '../shared/agent-markdown';
import { computeResizedFloatBounds, type FloatResizeEdge } from '../shared/layout';
import type {
  AgentCliPreset,
  AgentDockState,
  Rect,
  RunningAgentInstance,
} from '../shared/types';

const RESIZE_CURSORS: Record<FloatResizeEdge, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

const VALID_RESIZE_EDGES = new Set<string>(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

declare global {
  interface Window {
    ironAgent: IronAgentDockApi;
  }
}

export function stripAnsiSequences(input: string): string {
  return stripAnsiAll(input);
}

const EMPTY_PLACEHOLDER =
  'Select a running tmux agent instance above to chat with it live, or start agy / claude / codex / opencode / custom CLI.\n\nEvery spawned agent automatically receives IRON_BROWSER_SOCKET bound to this window.';

function copyTextSafely(text: string): void {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      void navigator.clipboard.writeText(text).catch(() => {});
    }
  } catch {
    // Ignore clipboard unavailability in restricted/headless contexts.
  }
}

function appendInlineTokens(parent: HTMLElement, tokens: InlineToken[]): void {
  for (const tok of tokens) {
    if (tok.type === 'text') {
      parent.appendChild(document.createTextNode(tok.text));
    } else if (tok.type === 'code') {
      const el = document.createElement('code');
      el.className = 'md-inline-code';
      el.textContent = tok.text;
      parent.appendChild(el);
    } else if (tok.type === 'bold') {
      const el = document.createElement('strong');
      el.className = 'md-strong';
      appendInlineTokens(el, tok.children);
      parent.appendChild(el);
    } else if (tok.type === 'italic') {
      const el = document.createElement('em');
      el.className = 'md-em';
      appendInlineTokens(el, tok.children);
      parent.appendChild(el);
    } else if (tok.type === 'strike') {
      const el = document.createElement('del');
      el.className = 'md-del';
      appendInlineTokens(el, tok.children);
      parent.appendChild(el);
    } else if (tok.type === 'link') {
      const el = document.createElement('span');
      el.className = 'md-link';
      el.textContent = tok.label;
      el.title = `${tok.href} (click to copy URL)`;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        copyTextSafely(tok.href);
      });
      parent.appendChild(el);
    }
  }
}

function appendAnsiSpans(parent: HTMLElement, spans: AnsiSpan[]): void {
  if (spans.length === 0) {
    parent.appendChild(document.createTextNode(' '));
    return;
  }
  for (const sp of spans) {
    const s = sp.style;
    const hasStyle = Boolean(s.fg || s.bold || s.dim || s.italic || s.underline || s.strike);
    if (!hasStyle) {
      parent.appendChild(document.createTextNode(sp.text));
      continue;
    }
    const el = document.createElement('span');
    el.textContent = sp.text;
    if (s.fg) el.style.color = s.fg;
    if (s.bold) el.classList.add('ansi-bold');
    if (s.dim) el.classList.add('ansi-dim');
    if (s.italic) el.classList.add('ansi-italic');
    if (s.underline) el.classList.add('ansi-underline');
    if (s.strike) el.classList.add('ansi-strike');
    parent.appendChild(el);
  }
}

function renderFormattedMarkdown(container: HTMLElement, raw: string): void {
  const frag = document.createDocumentFragment();
  const blocks = parseAgentTranscript(raw);

  if (blocks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'md-empty';
    empty.textContent = EMPTY_PLACEHOLDER;
    frag.appendChild(empty);
    container.replaceChildren(frag);
    return;
  }

  for (const block of blocks) {
    if (block.type === 'heading') {
      const el = document.createElement(`h${block.level}`);
      el.className = `md-h${block.level}`;
      appendInlineTokens(el, block.tokens);
      frag.appendChild(el);
    } else if (block.type === 'code') {
      const card = document.createElement('div');
      card.className = 'md-code-block';

      const hdr = document.createElement('div');
      hdr.className = 'md-code-header';
      const langWrap = document.createElement('div');
      const langEl = document.createElement('span');
      langEl.className = 'md-code-lang';
      langEl.textContent = block.lang;
      langWrap.appendChild(langEl);
      if (!block.closed) {
        const streaming = document.createElement('span');
        streaming.className = 'md-code-streaming';
        streaming.textContent = 'streaming…';
        langWrap.appendChild(streaming);
      }

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'md-copy-btn';
      copyBtn.textContent = 'Copy';
      const codeText = block.code;
      copyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        copyTextSafely(codeText);
        copyBtn.textContent = 'Copied';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
          copyBtn.classList.remove('copied');
        }, 1400);
      });

      hdr.append(langWrap, copyBtn);

      const pre = document.createElement('pre');
      pre.className = 'md-code-pre';
      const codeLines = block.code.split('\n');
      for (const line of codeLines) {
        const lineEl = document.createElement('span');
        lineEl.className = 'md-code-line';
        const toks = tokenizeCodeLine(line, block.lang);
        for (const tok of toks) {
          if (tok.kind === 'plain') {
            lineEl.appendChild(document.createTextNode(tok.text));
          } else {
            const span = document.createElement('span');
            span.className = `tok-${tok.kind}`;
            span.textContent = tok.text;
            lineEl.appendChild(span);
          }
        }
        pre.appendChild(lineEl);
      }

      card.append(hdr, pre);
      frag.appendChild(card);
    } else if (block.type === 'blockquote') {
      const bq = document.createElement('blockquote');
      bq.className = 'md-blockquote';
      for (const lineTokens of block.lines) {
        const div = document.createElement('div');
        div.className = 'md-line';
        appendInlineTokens(div, lineTokens);
        bq.appendChild(div);
      }
      frag.appendChild(bq);
    } else if (block.type === 'list') {
      const list = document.createElement('div');
      list.className = 'md-list';
      for (const item of block.items) {
        const row = document.createElement('div');
        row.className = `md-list-item indent-${item.indent}`;
        const marker = document.createElement('span');
        marker.className = `md-list-marker ${item.marker}`;
        if (item.marker === 'ordered') {
          marker.textContent = item.orderLabel ?? '1.';
        } else if (item.marker === 'task-done') {
          marker.textContent = '✓';
        } else if (item.marker === 'task-active') {
          marker.textContent = '◉';
        } else if (item.marker === 'task-open') {
          marker.textContent = '○';
        } else {
          marker.textContent = '•';
        }
        const body = document.createElement('div');
        body.className = 'md-list-body';
        appendInlineTokens(body, item.tokens);
        row.append(marker, body);
        list.appendChild(row);
      }
      frag.appendChild(list);
    } else if (block.type === 'table') {
      const wrap = document.createElement('div');
      wrap.className = 'md-table-wrap';
      const table = document.createElement('table');
      table.className = 'md-table';
      const thead = document.createElement('thead');
      const headTr = document.createElement('tr');
      for (const hTokens of block.headers) {
        const th = document.createElement('th');
        appendInlineTokens(th, hTokens);
        headTr.appendChild(th);
      }
      thead.appendChild(headTr);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      const colCount = block.headers.length;
      for (const rowCells of block.rows) {
        const tr = document.createElement('tr');
        for (let c = 0; c < colCount; c += 1) {
          const td = document.createElement('td');
          const cellTokens = rowCells[c];
          if (cellTokens) {
            appendInlineTokens(td, cellTokens);
          }
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      frag.appendChild(wrap);
    } else if (block.type === 'hr') {
      const hr = document.createElement('hr');
      hr.className = 'md-hr';
      frag.appendChild(hr);
    } else if (block.type === 'diff-line') {
      const div = document.createElement('div');
      div.className = `md-diff-line ${block.kind}`;
      div.textContent = block.text;
      frag.appendChild(div);
    } else if (block.type === 'ansi-line') {
      const div = document.createElement('div');
      div.className = 'ansi-line';
      appendAnsiSpans(div, block.spans);
      frag.appendChild(div);
    } else if (block.type === 'paragraph') {
      const p = document.createElement('div');
      p.className = 'md-para';
      for (const line of block.lines) {
        const div = document.createElement('div');
        div.className = line.status ? `md-line md-line-${line.status}` : 'md-line';
        appendInlineTokens(div, line.tokens);
        p.appendChild(div);
      }
      frag.appendChild(p);
    }
  }

  container.replaceChildren(frag);
}

function renderRawAnsi(container: HTMLElement, raw: string): void {
  const frag = document.createDocumentFragment();
  if (!raw || !stripAnsiAll(raw).trim()) {
    const empty = document.createElement('div');
    empty.className = 'md-empty';
    empty.textContent = EMPTY_PLACEHOLDER;
    frag.appendChild(empty);
    container.replaceChildren(frag);
    return;
  }
  const lines = parseAnsiTranscript(raw);
  for (const spans of lines) {
    const div = document.createElement('div');
    div.className = 'ansi-line';
    appendAnsiSpans(div, spans);
    frag.appendChild(div);
  }
  container.replaceChildren(frag);
}

function mountAgentDock(): void {
  const api = window.ironAgent;
  if (!api) return;

  const dockRoot = (document.getElementById('dock-root') ?? document.querySelector('.dock-root')) as HTMLElement | null;
  const statusDot = document.getElementById('status-dot')!;
  const sessionBadge = document.getElementById('session-badge')!;
  const btnFormatMd = document.getElementById('btn-format-md');
  const btnModeDocked = document.getElementById('btn-mode-docked')!;
  const btnModeFloating = document.getElementById('btn-mode-floating')!;
  const btnModeMin = document.getElementById('btn-mode-min')!;
  const dragBar = document.getElementById('dock-drag-bar')!;

  const tabRunning = document.getElementById('tab-running')!;
  const tabStart = document.getElementById('tab-start')!;
  const paneRunning = document.getElementById('pane-running')!;
  const paneStart = document.getElementById('pane-start')!;
  const btnRefresh = document.getElementById('btn-refresh-instances')!;
  const btnDisconnect = document.getElementById('btn-disconnect')!;
  const instanceList = document.getElementById('instance-list')!;

  const inputCwd = document.getElementById('input-cwd') as HTMLInputElement;
  const customForm = document.getElementById('custom-cli-form') as HTMLFormElement;
  const inputCustomCli = document.getElementById('input-custom-cli') as HTMLInputElement;

  const terminalWrap = document.getElementById('terminal-wrap')!;
  const terminalScreen = document.getElementById('terminal-screen')!;
  const btnInsertContext = document.getElementById('btn-insert-context')!;
  const chatForm = document.getElementById('chat-form') as HTMLFormElement;
  const chatInput = document.getElementById('chat-input') as HTMLTextAreaElement;

  let currentState: AgentDockState | null = null;
  let rawTranscript = '';
  let markdownEnabled = true;
  let transcriptRafId: number | null = null;
  let deferredForSelection = false;

  const hasActiveTerminalSelection = (): boolean => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString()) return false;
    return (
      (sel.anchorNode !== null && terminalScreen.contains(sel.anchorNode)) ||
      (sel.focusNode !== null && terminalScreen.contains(sel.focusNode))
    );
  };

  const renderTranscriptNow = (force = false) => {
    if (transcriptRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(transcriptRafId);
    }
    transcriptRafId = null;
    if (!force && hasActiveTerminalSelection()) {
      deferredForSelection = true;
      return;
    }
    deferredForSelection = false;
    const stickToBottom =
      terminalWrap.scrollHeight - terminalWrap.scrollTop - terminalWrap.clientHeight < 48;
    terminalScreen.classList.toggle('md-mode', markdownEnabled);
    terminalScreen.classList.toggle('raw-mode', !markdownEnabled);
    if (markdownEnabled) {
      renderFormattedMarkdown(terminalScreen, rawTranscript);
    } else {
      renderRawAnsi(terminalScreen, rawTranscript);
    }
    if (stickToBottom) {
      terminalWrap.scrollTop = terminalWrap.scrollHeight;
    }
  };

  const renderTranscript = () => {
    if (transcriptRafId !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      transcriptRafId = requestAnimationFrame(() => renderTranscriptNow(false));
    } else {
      renderTranscriptNow(false);
    }
  };

  document.addEventListener('selectionchange', () => {
    if (deferredForSelection && !hasActiveTerminalSelection()) {
      renderTranscript();
    }
  });

  btnFormatMd?.addEventListener('click', () => {
    markdownEnabled = !markdownEnabled;
    btnFormatMd.classList.toggle('active', markdownEnabled);
    btnFormatMd.textContent = markdownEnabled ? 'MD' : 'Raw';
    renderTranscriptNow(true);
  });

  const renderState = (state: AgentDockState) => {
    currentState = state;
    const live = state.session.active;
    statusDot.classList.toggle('live', live);
    sessionBadge.textContent = live ? state.session.label : 'Idle';
    btnDisconnect.classList.toggle('hidden', !live);
    btnModeDocked.classList.toggle('active', state.mode === 'docked');
    btnModeFloating.classList.toggle('active', state.mode === 'floating');
    dockRoot?.classList.toggle('floating', state.mode === 'floating');
  };

  const renderInstances = (instances: RunningAgentInstance[]) => {
    instanceList.innerHTML = '';
    if (instances.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-note';
      empty.textContent = 'No running tmux panes detected. Switch to "Start CLI Agent" to launch agy, claude, codex, or opencode.';
      instanceList.appendChild(empty);
      return;
    }
    for (const inst of instances) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'instance-item';
      if (currentState?.session.targetPane === inst.target) {
        btn.classList.add('attached');
      }

      const main = document.createElement('div');
      main.className = 'inst-main';
      const title = document.createElement('span');
      title.className = 'inst-title';
      title.textContent = `${inst.target} · ${inst.windowName}`;
      const sub = document.createElement('span');
      sub.className = 'inst-sub';
      sub.textContent = inst.cwd || `pid ${inst.pid}`;
      main.append(title, sub);

      const pill = document.createElement('span');
      pill.className = 'inst-pill';
      pill.textContent = inst.command;

      btn.append(main, pill);
      btn.addEventListener('click', () => {
        void api.attachInstance(inst.target).then((st) => {
          renderState(st);
          void api.listInstances().then(renderInstances);
          chatInput.focus();
        });
      });
      instanceList.appendChild(btn);
    }
  };

  const computeColsRows = () => {
    const cols = Math.max(40, Math.floor((terminalWrap.clientWidth - 16) / 7.2));
    const rows = Math.max(12, Math.floor((terminalWrap.clientHeight - 16) / 16));
    return { cols, rows };
  };

  tabRunning.addEventListener('click', () => {
    tabRunning.classList.add('active');
    tabStart.classList.remove('active');
    paneRunning.classList.remove('hidden');
    paneStart.classList.add('hidden');
    void api.listInstances().then(renderInstances);
  });

  tabStart.addEventListener('click', () => {
    tabStart.classList.add('active');
    tabRunning.classList.remove('active');
    paneStart.classList.remove('hidden');
    paneRunning.classList.add('hidden');
  });

  btnRefresh.addEventListener('click', () => {
    void api.listInstances().then(renderInstances);
  });

  btnDisconnect.addEventListener('click', () => {
    void api.stop().then((st) => {
      renderState(st);
      void api.listInstances().then(renderInstances);
    });
  });

  btnModeDocked.addEventListener('click', () => void api.setMode('docked').then(renderState));
  btnModeFloating.addEventListener('click', () => void api.setMode('floating').then(renderState));
  btnModeMin.addEventListener('click', () => void api.setMode('minimized').then(renderState));

  // Coalesce rapid pointermove updates to 1 in-flight setFloatBounds IPC at a time.
  let pendingBounds: Partial<Rect> | null = null;
  let boundsInFlight = false;
  let boundsRafId: number | null = null;
  let boundsSeq = 0;

  const flushFloatBounds = () => {
    boundsRafId = null;
    if (boundsInFlight || !pendingBounds) return;
    const next = pendingBounds;
    pendingBounds = null;
    boundsInFlight = true;
    const seq = ++boundsSeq;
    void api
      .setFloatBounds(next)
      .then((st) => {
        if (seq === boundsSeq) {
          renderState(st);
        }
      })
      .catch(() => {})
      .finally(() => {
        boundsInFlight = false;
        if (pendingBounds) {
          flushFloatBounds();
        }
      });
  };

  const scheduleFloatBounds = (next: Partial<Rect>, immediate = false) => {
    pendingBounds = next;
    if (immediate) {
      if (boundsRafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(boundsRafId);
        boundsRafId = null;
      }
      flushFloatBounds();
      return;
    }
    if (boundsRafId !== null || boundsInFlight) return;
    if (typeof requestAnimationFrame === 'function') {
      boundsRafId = requestAnimationFrame(flushFloatBounds);
    } else {
      flushFloatBounds();
    }
  };

  // Drag header when floating
  dragBar.addEventListener('pointerdown', (startEv) => {
    if (!currentState || currentState.mode !== 'floating') return;
    if (startEv.button !== 0) return;
    if ((startEv.target as HTMLElement)?.closest('button')) return;
    startEv.preventDefault();
    const startScreenX = startEv.screenX;
    const startScreenY = startEv.screenY;
    const orig = { ...currentState.floatBounds };
    dragBar.setPointerCapture(startEv.pointerId);
    dockRoot?.classList.add('dragging', 'resizing');
    document.body.style.cursor = 'grabbing';

    let ended = false;
    const onMove = (ev: PointerEvent) => {
      const nx = orig.x + (ev.screenX - startScreenX);
      const ny = orig.y + (ev.screenY - startScreenY);
      scheduleFloatBounds({ x: nx, y: ny });
    };
    const onEnd = () => {
      if (ended) return;
      ended = true;
      dragBar.removeEventListener('pointermove', onMove);
      dragBar.removeEventListener('pointerup', onEnd);
      dragBar.removeEventListener('pointercancel', onEnd);
      dragBar.removeEventListener('lostpointercapture', onEnd);
      dockRoot?.classList.remove('dragging', 'resizing');
      document.body.style.cursor = '';
      if (pendingBounds) {
        scheduleFloatBounds(pendingBounds, true);
      }
    };
    dragBar.addEventListener('pointermove', onMove);
    dragBar.addEventListener('pointerup', onEnd);
    dragBar.addEventListener('pointercancel', onEnd);
    dragBar.addEventListener('lostpointercapture', onEnd);
  });

  // Custom edge & corner resizing when floating
  document.querySelectorAll<HTMLElement>('.float-resize-handle[data-resize-edge]').forEach((handle) => {
    const rawEdge = handle.dataset.resizeEdge ?? '';
    if (!VALID_RESIZE_EDGES.has(rawEdge)) return;
    const edge = rawEdge as FloatResizeEdge;

    handle.addEventListener('pointerdown', (startEv) => {
      if (!currentState || currentState.mode !== 'floating') return;
      if (startEv.button !== 0) return;
      startEv.preventDefault();
      startEv.stopPropagation();

      const startScreenX = startEv.screenX;
      const startScreenY = startEv.screenY;
      const orig = { ...currentState.floatBounds };
      handle.setPointerCapture(startEv.pointerId);
      handle.classList.add('active');
      dockRoot?.classList.add('resizing');
      document.body.style.cursor = RESIZE_CURSORS[edge];

      let ended = false;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.screenX - startScreenX;
        const dy = ev.screenY - startScreenY;
        const next = computeResizedFloatBounds(orig, edge, dx, dy);
        scheduleFloatBounds(next);
      };

      const onEnd = () => {
        if (ended) return;
        ended = true;
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
        handle.removeEventListener('lostpointercapture', onEnd);
        handle.classList.remove('active');
        dockRoot?.classList.remove('resizing');
        document.body.style.cursor = '';
        if (pendingBounds) {
          scheduleFloatBounds(pendingBounds, true);
        }
        const { cols, rows } = computeColsRows();
        void api.resize(cols, rows);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
      handle.addEventListener('lostpointercapture', onEnd);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.chip-btn[data-preset]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const preset = chip.dataset.preset as AgentCliPreset;
      const { cols, rows } = computeColsRows();
      void api
        .startCli({
          preset,
          cwd: inputCwd.value.trim() || undefined,
          cols,
          rows,
        })
        .then((st) => {
          renderState(st);
          chatInput.focus();
        })
        .catch((err) => {
          rawTranscript += `\n[Launch error: ${String(err)}]\n`;
          renderTranscript();
        });
    });
  });

  customForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const cmd = inputCustomCli.value.trim();
    if (!cmd) return;
    const { cols, rows } = computeColsRows();
    void api
      .startCli({
        preset: 'custom',
        customCommand: cmd,
        cwd: inputCwd.value.trim() || undefined,
        cols,
        rows,
      })
      .then((st) => {
        renderState(st);
        chatInput.focus();
      })
      .catch((err) => {
        rawTranscript += `\n[Launch error: ${String(err)}]\n`;
        renderTranscript();
      });
  });

  document.querySelectorAll<HTMLButtonElement>('.qkey[data-skey]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const skey = btn.dataset.skey;
      if (skey) void api.sendSpecialKey(skey);
    });
  });

  btnInsertContext.addEventListener('click', () => {
    void api.getContext().then((snippet) => {
      const prefix = chatInput.value && !chatInput.value.endsWith(' ') ? `${chatInput.value} ` : chatInput.value;
      chatInput.value = `${prefix}${snippet} `;
      chatInput.focus();
    });
  });

  const submitPrompt = () => {
    const msg = chatInput.value;
    if (!msg.trim()) return;
    chatInput.value = '';
    void api.write(msg, true);
  };

  chatForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitPrompt();
  });

  chatInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      submitPrompt();
    }
  });

  // Direct keyboard passthrough when user clicks/focuses the terminal output pane
  terminalWrap.addEventListener('keydown', (ev) => {
    if (!currentState?.session.active) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c' && window.getSelection()?.toString()) {
      return; // Allow normal copy when text is selected.
    }
    ev.preventDefault();
    if (ev.ctrlKey && ev.key.toLowerCase() === 'c') {
      void api.sendSpecialKey('Interrupt');
      return;
    }
    if (ev.key === 'Enter') {
      void api.sendSpecialKey('Enter');
      return;
    }
    if (ev.key === 'Escape') {
      void api.sendSpecialKey('Escape');
      return;
    }
    if (ev.key === 'ArrowUp') {
      void api.sendSpecialKey('Up');
      return;
    }
    if (ev.key === 'ArrowDown') {
      void api.sendSpecialKey('Down');
      return;
    }
    if (ev.key === 'Tab') {
      void api.sendSpecialKey('Tab');
      return;
    }
    if (ev.key === 'Backspace') {
      void api.write('\x7f', false);
      return;
    }
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      void api.write(ev.key, false);
    }
  });

  window.addEventListener('resize', () => {
    const { cols, rows } = computeColsRows();
    void api.resize(cols, rows);
  });

  api.onState(renderState);
  api.onOutput(({ chunk, replace }) => {
    rawTranscript = replace ? chunk : rawTranscript + chunk;
    if (rawTranscript.length > 180_000) {
      rawTranscript = rawTranscript.slice(-180_000);
    }
    renderTranscript();
  });
  api.onInjectContext((snippet) => {
    const prefix = chatInput.value && !chatInput.value.endsWith(' ') ? `${chatInput.value} ` : chatInput.value;
    chatInput.value = `${prefix}${snippet} `;
    chatInput.focus();
  });

  void api.getInitial().then((init) => {
    inputCwd.value = init.defaultCwd;
    rawTranscript = init.transcript;
    renderState(init.state);
    renderInstances(init.instances);
    renderTranscript();
    if (init.instances.length === 0) {
      tabStart.click();
    }
  });
}

if (typeof document !== 'undefined') {
  mountAgentDock();
}
