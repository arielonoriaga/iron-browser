import type { IronAgentDockApi } from '../preload/agent-preload';
import type {
  AgentCliPreset,
  AgentDockState,
  RunningAgentInstance,
} from '../shared/types';

declare global {
  interface Window {
    ironAgent: IronAgentDockApi;
  }
}

export function stripAnsiSequences(input: string): string {
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[^\n]*\r(?!\n)/g, '');
}

function mountAgentDock(): void {
  const api = window.ironAgent;
  if (!api) return;

  const statusDot = document.getElementById('status-dot')!;
  const sessionBadge = document.getElementById('session-badge')!;
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

  const renderTranscript = () => {
    const stickToBottom =
      terminalWrap.scrollHeight - terminalWrap.scrollTop - terminalWrap.clientHeight < 48;
    const clean = stripAnsiSequences(rawTranscript);
    terminalScreen.textContent =
      clean ||
      'Select a running tmux agent instance above to chat with it live, or start agy / claude / codex / opencode / custom CLI.\n\nEvery spawned agent automatically receives IRON_BROWSER_SOCKET bound to this window.';
    if (stickToBottom) {
      terminalWrap.scrollTop = terminalWrap.scrollHeight;
    }
  };

  const renderState = (state: AgentDockState) => {
    currentState = state;
    const live = state.session.active;
    statusDot.classList.toggle('live', live);
    sessionBadge.textContent = live ? state.session.label : 'Idle';
    btnDisconnect.classList.toggle('hidden', !live);
    btnModeDocked.classList.toggle('active', state.mode === 'docked');
    btnModeFloating.classList.toggle('active', state.mode === 'floating');
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

  // Drag header when floating
  dragBar.addEventListener('pointerdown', (startEv) => {
    if (!currentState || currentState.mode !== 'floating') return;
    if ((startEv.target as HTMLElement)?.closest('button')) return;
    const startScreenX = startEv.screenX;
    const startScreenY = startEv.screenY;
    const orig = { ...currentState.floatBounds };
    dragBar.setPointerCapture(startEv.pointerId);

    const onMove = (ev: PointerEvent) => {
      const nx = orig.x + (ev.screenX - startScreenX);
      const ny = orig.y + (ev.screenY - startScreenY);
      void api.setFloatBounds({ x: nx, y: ny }).then(renderState);
    };
    const onUp = () => {
      dragBar.removeEventListener('pointermove', onMove);
      dragBar.removeEventListener('pointerup', onUp);
    };
    dragBar.addEventListener('pointermove', onMove);
    dragBar.addEventListener('pointerup', onUp);
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
