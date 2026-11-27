import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import {
  AgentDockManager,
  assertAgentSender,
  parseTmuxListPanesOutput,
  writePerWindowMcpConfig,
} from '../src/main/agent-dock';
import { MirrorRelay, type IpcMainLike } from '../src/main/mirror-relay';
import {
  clampAnchoredFloatBoundsUpdate,
  clampFloatBounds,
  computeLayout,
  computeResizedFloatBounds,
  FLOAT_MARGIN_BOTTOM,
  FLOAT_MARGIN_TOP,
  FLOAT_MARGIN_X,
  MIN_AGENT_FLOAT_HEIGHT,
  MIN_AGENT_FLOAT_WIDTH,
  TOP_BAR_HEIGHT,
} from '../src/shared/layout';
import { sanitizePersistedSession } from '../src/shared/session-store';
import { buildWebGlInspectorInitScript } from '../src/shared/webgl-inspector-core';
import type { ElementFingerprint, ViewportRole } from '../src/shared/types';

describe('Full Keyboard Event Listening & Hold/Keyup Mirroring', () => {
  test('MirrorRelay emits onKeyboardEvent even when mirror is off, holds keyDown until keyUp when holdUntilKeyup=true, and supports Home/End/PageUp/F1..F12', async () => {
    const ipc = new EventEmitter();
    const mkWc = (id: number) => {
      const dbg = Object.assign(new EventEmitter(), {
        attached: true,
        commands: [] as Array<{ method: string; params?: Record<string, unknown> }>,
        isAttached() {
          return this.attached;
        },
        attach() {
          this.attached = true;
        },
        detach() {
          this.attached = false;
        },
        async sendCommand(method: string, params?: Record<string, unknown>) {
          this.commands.push({ method, params });
          return {};
        },
      });
      const mf = { origin: 'https://game.example.com' };
      const wc: any = Object.assign(new EventEmitter(), {
        id,
        mainFrame: mf,
        debugger: dbg,
        isDestroyed: () => false,
        getURL: () => 'https://game.example.com/play',
        send: (ch: string, msg: any) => {
          if (ch === 'iron:dom-query') {
            queueMicrotask(() => {
              ipc.emit(
                'iron:dom-query-reply',
                { sender: wc, senderFrame: mf },
                {
                  reqId: msg.reqId,
                  result: { found: true, tier: 3, x: 200, y: 300, isCanvas: true, tag: 'canvas' },
                },
              );
            });
          }
        },
        sendInputEvent: () => {},
      });
      return wc;
    };

    const portrait = mkWc(201);
    const landscape = mkWc(202);
    let mirrorEnabled = false;
    const observedKeys: Array<{ role: ViewportRole; kind: string; key: string; sensitive: boolean }> =
      [];

    const relay = new MirrorRelay(
      {
        findByWebContentsId: (id) =>
          id === landscape.id
            ? {
                tabId: 'tab-k1',
                role: 'landscape',
                mirrorEnabled,
                pairedWebContents: portrait,
                pairedScale: 1,
              }
            : null,
        onKeyboardEvent: (_tabId, role, ev) => {
          observedKeys.push({
            role,
            kind: ev.kind,
            key: ev.key,
            sensitive: ev.sensitive,
          });
        },
      },
      ipc as unknown as IpcMainLike,
    );

    try {
      const canvasFp: ElementFingerprint = {
        tag: 'canvas',
        cssPath: 'canvas:nth-of-type(1)',
        isCanvas: true,
        relViewportX: 0.5,
        relViewportY: 0.5,
      };

      // 1. Even with mirrorEnabled=false, keyboard events are observed for TabEventBus!
      ipc.emit(
        'iron:mirror-capture',
        { sender: landscape, senderFrame: landscape.mainFrame },
        {
          kind: 'keydown',
          fingerprint: canvasFp,
          key: 'w',
          code: 'KeyW',
          modifiers: [],
          holdUntilKeyup: true,
          sensitive: false,
        },
      );
      expect(observedKeys).toEqual([
        { role: 'landscape', kind: 'keydown', key: 'w', sensitive: false },
      ]);
      expect(portrait.debugger.commands.length).toBe(0);

      // 2. iron:key-observe (editable typing) records onKeyboardEvent with sensitive=true and NEVER replays!
      mirrorEnabled = true;
      ipc.emit(
        'iron:key-observe',
        { sender: landscape, senderFrame: landscape.mainFrame },
        {
          kind: 'keydown',
          key: 's',
          code: 'KeyS',
          modifiers: [],
          repeat: false,
          tag: 'input',
          sensitive: true,
        },
      );
      await new Promise((r) => setTimeout(r, 25));
      expect(observedKeys[1]).toEqual({
        role: 'landscape',
        kind: 'keydown',
        key: 's',
        sensitive: true,
      });
      expect(portrait.debugger.commands.length).toBe(0);

      // 3. holdUntilKeyup=true sends ONLY keyDown on keydown, then keyUp when keyup arrives!
      ipc.emit(
        'iron:mirror-capture',
        { sender: landscape, senderFrame: landscape.mainFrame },
        {
          kind: 'keydown',
          fingerprint: canvasFp,
          key: 'PageDown',
          code: 'PageDown',
          modifiers: [],
          holdUntilKeyup: true,
          repeat: false,
        },
      );
      await new Promise((r) => setTimeout(r, 30));
      expect(portrait.debugger.commands.length).toBe(1);
      expect(portrait.debugger.commands[0]!.params).toMatchObject({
        type: 'rawKeyDown',
        key: 'PageDown',
        code: 'PageDown',
        windowsVirtualKeyCode: 34,
      });

      ipc.emit(
        'iron:mirror-capture',
        { sender: landscape, senderFrame: landscape.mainFrame },
        {
          kind: 'keyup',
          fingerprint: canvasFp,
          key: 'PageDown',
          code: 'PageDown',
          modifiers: [],
        },
      );
      await new Promise((r) => setTimeout(r, 30));
      expect(portrait.debugger.commands.length).toBe(2);
      expect(portrait.debugger.commands[1]!.params).toMatchObject({
        type: 'keyUp',
        key: 'PageDown',
        code: 'PageDown',
        windowsVirtualKeyCode: 34,
      });
    } finally {
      relay.dispose();
    }
  });
});

describe('WebGL Draw-Call, Resource & Rendering-Order Inspector', () => {
  test('buildWebGlInspectorInitScript hooks WebGL prototypes, counts drawCalls/triangles/passes/resources, captures 1-frame ordered draw log, and sorts rendering layers', async () => {
    const script = buildWebGlInspectorInitScript();
    expect(script).not.toContain('require(');

    let rafCb: (() => void) | null = null;
    class FakeWebGL2RenderingContext {
      drawingBufferWidth = 1280;
      drawingBufferHeight = 720;
      canvas = { addEventListener: () => {} };
      getExtension(name: string) {
        if (name === 'WEBGL_debug_renderer_info') return {};
        return null;
      }
      getParameter(p: number) {
        if (p === 0x9246) return 'ANGLE (Mock GPU)';
        if (p === 0x9245) return 'IronVendor';
        return null;
      }
      createProgram() {
        return { kind: 'prog' };
      }
      deleteProgram(_p: unknown) {}
      createTexture() {
        return { kind: 'tex' };
      }
      deleteTexture(_t: unknown) {}
      createBuffer() {
        return { kind: 'buf' };
      }
      deleteBuffer(_b: unknown) {}
      createFramebuffer() {
        return { kind: 'fbo' };
      }
      deleteFramebuffer(_f: unknown) {}
      useProgram(_p: unknown) {}
      activeTexture(_u: number) {}
      bindTexture(_target: number, _tex: unknown) {}
      bindFramebuffer(_target: number, _fbo: unknown) {}
      enable(_cap: number) {}
      disable(_cap: number) {}
      viewport(_x: number, _y: number, _w: number, _h: number) {}
      drawArrays(_mode: number, _first: number, _count: number) {}
      drawElements(_mode: number, _count: number, _type: number, _offset: number) {}
      drawElementsInstanced(
        _mode: number,
        _count: number,
        _type: number,
        _offset: number,
        _instances: number,
      ) {}
    }

    const hudEl = {
      tagName: 'DIV',
      className: 'hud-top',
      getAttribute: (k: string) => (k === 'id' ? 'hud' : null),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 60 }),
      style: { position: 'fixed', zIndex: '20', opacity: '1', transform: 'translateZ(0)' },
    };
    const canvasEl: any = {
      tagName: 'CANVAS',
      className: 'stage',
      __ironCanvasKind: 'webgl2',
      getAttribute: (k: string) => (k === 'id' ? 'game-canvas' : null),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
      style: { position: 'relative', zIndex: '1', opacity: '1', transform: 'none' },
    };

    const fakeDoc = {
      body: {
        querySelectorAll: () => [hudEl, canvasEl],
      },
      querySelectorAll: (sel: string) => (sel === 'canvas' ? [canvasEl] : []),
    };
    const fakeWin: any = {
      document: fakeDoc,
      WebGL2RenderingContext: FakeWebGL2RenderingContext,
      WebGLRenderingContext: FakeWebGL2RenderingContext,
      requestAnimationFrame: (cb: () => void) => {
        rafCb = cb;
        return 1;
      },
      getComputedStyle: (el: any) => ({
        display: 'block',
        visibility: 'visible',
        position: el.style.position,
        zIndex: el.style.zIndex,
        opacity: el.style.opacity,
        transform: el.style.transform,
        willChange: 'auto',
        filter: 'none',
        backdropFilter: 'none',
        mixBlendMode: 'normal',
        isolation: 'auto',
      }),
    };
    const sandbox: Record<string, unknown> = {
      window: fakeWin,
      document: fakeDoc,
      WebGL2RenderingContext: FakeWebGL2RenderingContext,
      WebGLRenderingContext: FakeWebGL2RenderingContext,
      performance: { now: () => 100 },
      setTimeout,
      clearTimeout,
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(script, sandbox);

    const gl = new FakeWebGL2RenderingContext();
    const progA = gl.createProgram();
    const progB = gl.createProgram();
    const tex1 = gl.createTexture();
    const fbo1 = gl.createFramebuffer();

    const inspector = fakeWin.__ironWebGlInspector;
    const capturePromise = inspector.captureFrame(64, 500, 32);

    // Pass 0: Offscreen FBO shadow/bloom pass
    gl.bindFramebuffer(0x8d40, fbo1);
    gl.useProgram(progA);
    gl.activeTexture(0x84c0);
    gl.bindTexture(0x0de1, tex1);
    gl.drawElements(0x0004, 36, 0x1403, 0); // 12 triangles

    // Pass 1: Main screen pass with instanced particles
    gl.bindFramebuffer(0x8d40, null);
    gl.enable(0x0be2); // BLEND
    gl.useProgram(progB);
    gl.drawElementsInstanced(0x0004, 6, 0x1403, 0, 50); // 2 * 50 = 100 triangles

    if (rafCb) (rafCb as () => void)();
    const captured = await capturePromise;

    expect(captured.capturedFrames).toBe(1);
    expect(captured.passes.length).toBe(2);
    expect(captured.passes[0]).toMatchObject({
      passIndex: 0,
      fboTarget: 'fbo#4',
      drawCalls: 1,
      triangles: 12,
    });
    expect(captured.passes[1]).toMatchObject({
      passIndex: 1,
      fboTarget: 'screen',
      drawCalls: 1,
      triangles: 100,
    });
    expect(captured.drawCalls.length).toBe(2);
    expect(captured.drawCalls[0]!.mode).toBe('TRIANGLES');
    expect(captured.drawCalls[1]!.api).toBe('drawElementsInstanced');
    expect(captured.drawCalls[1]!.blendEnabled).toBe(true);
    expect(captured.summary.drawCallsPerFrame).toBe(2);
    expect(captured.summary.trianglesPerFrame).toBe(112);
    expect(captured.summary.resources.programs).toBe(2);
    expect(captured.summary.renderer).toBe('ANGLE (Mock GPU)');

    // Rendering order: z-index 1 canvas painted BEFORE z-index 20 HUD regardless of DOM order!
    expect(captured.renderingOrder.map((l: any) => l.selector)).toEqual([
      'canvas#game-canvas',
      'div#hud',
    ]);
  });
});

describe('Embedded Multi-CLI & Running-Instance Agent Chat Dock', () => {
  test('parseTmuxListPanesOutput prioritizes running agent CLIs and computeLayout reserves docked / floating / minimized geometry cleanly', () => {
    const instances = parseTmuxListPanesOutput(
      [
        '0:1.1\tzsh\tzsh\t/home/dev\t1001',
        '0:2.1\tpos-perf\tclaude\t/home/dev/shop\t1002',
        '8:1.1\tcodex-work\tcodex\t/home/dev/game\t1003',
        'bad-target-without-pane\tfoo\tbar\t/tmp\t999',
      ].join('\n'),
    );
    expect(instances.length).toBe(3);
    expect(instances[0]!.isAgentLike).toBe(true);
    expect(instances.map((i) => i.command)).toEqual(['claude', 'codex', 'zsh']);

    const docked = computeLayout({
      windowWidth: 1480,
      windowHeight: 920,
      mode: 'dual',
      railCollapsed: false,
      dockOpen: false,
      dockHeight: 280,
      splitRatio: 0.35,
      agentDockMode: 'docked',
      agentDockWidth: 360,
    });
    expect(docked.agentDock).toEqual({ x: 1120, y: 40, width: 360, height: 880 });
    expect(docked.landscapeView.x + docked.landscapeView.width).toBeLessThanOrEqual(1120);

    const floating = computeLayout({
      windowWidth: 1480,
      windowHeight: 920,
      mode: 'dual',
      railCollapsed: false,
      dockOpen: false,
      dockHeight: 280,
      splitRatio: 0.35,
      agentDockMode: 'floating',
      agentFloatBounds: { x: 900, y: 80, width: 400, height: 500 },
    });
    expect(floating.agentDock).toEqual({ x: 900, y: 80, width: 400, height: 500 });
    expect(floating.landscapeView.x + floating.landscapeView.width).toBe(1480);
  });

  test('AgentDockManager spawns real native Rust PTY CLI with IRON_BROWSER_SOCKET + 0600 mcp.json, streams output, and enforces assertAgentSender', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-agent-dock-'));
    const sockPath = path.join(tmpDir, 'ctl.sock');
    const cfgPath = writePerWindowMcpConfig(sockPath);
    expect(cfgPath).not.toBeNull();
    const stat = fs.statSync(cfgPath!);
    expect(stat.mode & 0o777).toBe(0o600);

    const outputs: string[] = [];
    const fakeAgentWc = Object.assign(new EventEmitter(), {
      id: 777,
      mainFrame: { id: 1 },
      isDestroyed: () => false,
      send: (ch: string, payload: any) => {
        if (ch === 'agent:output' && typeof payload?.chunk === 'string') {
          outputs.push(payload.chunk);
        }
      },
      close: () => {},
    });
    const fakeWin: any = {
      isDestroyed: () => false,
      contentView: { addChildView: () => {}, removeChildView: () => {} },
    };

    const mgr = new AgentDockManager(
      fakeWin,
      '/nonexistent/preload.js',
      '/nonexistent/dock.html',
      {
        getSocketPath: () => sockPath,
        getActiveTabId: () => 'tab-42',
        getBrowserContextSnippet: () => '[IronBrowser tab=tab-42]',
        onLayoutChanged: () => {},
      },
      { initialMode: 'docked' },
    );
    // Attach fake view to verify sender isolation & live output forwarding
    (mgr as any).view = { webContents: fakeAgentWc, setVisible: () => {}, setBounds: () => {} };

    try {
      // Reject spoofed IPC from untrusted viewport WebContents or navigated frame URL (F-27)
      expect(() =>
        assertAgentSender(
          { sender: { id: 999 }, senderFrame: fakeAgentWc.mainFrame } as any,
          (mgr as any).view,
        ),
      ).toThrow('Unauthorized IPC sender');
      const navigatedFrame = { id: 1, url: 'https://evil.example/' };
      expect(() =>
        assertAgentSender(
          {
            sender: fakeAgentWc,
            senderFrame: navigatedFrame,
          } as any,
          {
            webContents: {
              ...fakeAgentWc,
              mainFrame: navigatedFrame,
            },
          } as any,
          'file:///expected/agent-dock.html',
        ),
      ).toThrow('Unauthorized IPC sender');

      const st = mgr.startCliAgent({
        preset: 'custom',
        customCommand:
          'printf "SOCK=%s TAB=%s\\n" "$IRON_BROWSER_SOCKET" "$IRON_BROWSER_DEFAULT_TAB"; IFS= read -r msg; printf "REPLY=%s\\n" "$msg"',
        cwd: tmpDir,
      });
      expect(st.session.active).toBe(true);

      await new Promise((r) => setTimeout(r, 120));
      await mgr.writeInput('ping-from-browser', true);

      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        if (outputs.join('').includes('REPLY=ping-from-browser') && !mgr.getState().session.active) {
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }

      const joined = outputs.join('');
      expect(joined).toContain(`SOCK=${sockPath}`);
      expect(joined).toContain('TAB=tab-42');
      expect(joined).toContain('REPLY=ping-from-browser');
      // F-28: Natural exit cleans up activePtyId automatically
      expect((mgr as any).activePtyId).toBeNull();

      // F-26: >16KB paste into raw-mode PTY while busy never blocks main thread and flushes losslessly
      outputs.length = 0;
      mgr.startCliAgent({
        preset: 'custom',
        customCommand:
          'stty raw -echo; printf "RAW_READY\\n"; sleep 0.12; bytes=$(head -c 12000 | wc -c); stty sane; printf "DRAINED=%s\\n" "$bytes"',
        cwd: tmpDir,
      });
      const readyDl = Date.now() + 2000;
      while (Date.now() < readyDl && !outputs.join('').includes('RAW_READY')) {
        await new Promise((r) => setTimeout(r, 15));
      }
      const tWrite0 = performance.now();
      const okWrite = await mgr.writeInput('X'.repeat(12_000), false);
      const writeMs = performance.now() - tWrite0;
      expect(okWrite).toBe(true);
      expect(writeMs).toBeLessThan(80);

      const drainDl = Date.now() + 3000;
      while (Date.now() < drainDl && !outputs.join('').includes('DRAINED=12000')) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(outputs.join('')).toContain('DRAINED=12000');
    } finally {
      mgr.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('floating Agent Dock supports custom 8-edge/corner resizing with anchored opposite edges, window clamping, and session persistence', () => {
    const winW = 1480;
    const winH = 920;
    const origin = { x: 500, y: 200, width: 400, height: 350 };

    // 1. East & South expand cleanly while anchoring x/y
    expect(computeResizedFloatBounds(origin, 'e', 120, 40, winW, winH)).toEqual({
      x: 500,
      y: 200,
      width: 520,
      height: 350,
    });
    expect(computeResizedFloatBounds(origin, 's', 40, 110, winW, winH)).toEqual({
      x: 500,
      y: 200,
      width: 400,
      height: 460,
    });
    expect(computeResizedFloatBounds(origin, 'se', 150, 90, winW, winH)).toEqual({
      x: 500,
      y: 200,
      width: 550,
      height: 440,
    });

    // 2. West & North anchor right/bottom even when shrunk past minimum dimensions
    const westMin = computeResizedFloatBounds(origin, 'w', 500, 0, winW, winH);
    expect(westMin.width).toBe(MIN_AGENT_FLOAT_WIDTH);
    expect(westMin.x + westMin.width).toBe(origin.x + origin.width);

    const northMin = computeResizedFloatBounds(origin, 'n', 0, 500, winW, winH);
    expect(northMin.height).toBe(MIN_AGENT_FLOAT_HEIGHT);
    expect(northMin.y + northMin.height).toBe(origin.y + origin.height);

    // 3. NW corner expanding past left/top window margins anchors right/bottom without sliding
    const nwPastMargin = computeResizedFloatBounds(origin, 'nw', -900, -500, winW, winH);
    expect(nwPastMargin.x).toBe(FLOAT_MARGIN_X);
    expect(nwPastMargin.y).toBe(TOP_BAR_HEIGHT + FLOAT_MARGIN_TOP);
    expect(nwPastMargin.x + nwPastMargin.width).toBe(origin.x + origin.width);
    expect(nwPastMargin.y + nwPastMargin.height).toBe(origin.y + origin.height);

    // 4. NE and SW corners resize diagonally with exact opposite-corner anchoring
    const neRes = computeResizedFloatBounds(origin, 'ne', 80, -60, winW, winH);
    expect(neRes).toEqual({ x: 500, y: 140, width: 480, height: 410 });
    const swRes = computeResizedFloatBounds(origin, 'sw', -75, 55, winW, winH);
    expect(swRes).toEqual({ x: 425, y: 200, width: 475, height: 405 });

    // 5. SE expanding past right/bottom clamps cleanly to window margins without shifting x/y
    const sePastMargin = computeResizedFloatBounds(origin, 'se', 2000, 2000, winW, winH);
    expect(sePastMargin.x).toBe(500);
    expect(sePastMargin.y).toBe(200);
    expect(sePastMargin.x + sePastMargin.width).toBe(winW - FLOAT_MARGIN_X);
    expect(sePastMargin.y + sePastMargin.height).toBe(winH - FLOAT_MARGIN_BOTTOM);

    // 6. Non-finite deltas are ignored cleanly
    expect(computeResizedFloatBounds(origin, 'se', Number.NaN, Number.POSITIVE_INFINITY)).toEqual(origin);

    // 7. Main-process anchored clamping preserves right/bottom on west/north overflow and preserves size on move-only
    const anchoredWest = clampAnchoredFloatBoundsUpdate(
      origin,
      { x: -100, width: 1000 },
      winW,
      winH,
    );
    expect(anchoredWest.x).toBe(FLOAT_MARGIN_X);
    expect(anchoredWest.x + anchoredWest.width).toBe(900);

    const moveOnly = clampAnchoredFloatBoundsUpdate(origin, { x: -50, y: 0 }, winW, winH);
    expect(moveOnly).toEqual({
      x: FLOAT_MARGIN_X,
      y: TOP_BAR_HEIGHT + FLOAT_MARGIN_TOP,
      width: 400,
      height: 350,
    });

    // 8. AgentDockManager clamps setFloatBounds against window size and syncs applyBounds on window shrink
    const pushedStates: Array<{ floatBounds: { x: number; y: number; width: number; height: number } }> = [];
    const fakeWc = Object.assign(new EventEmitter(), {
      id: 888,
      mainFrame: { id: 1 },
      isDestroyed: () => false,
      send: (ch: string, payload: any) => {
        if (ch === 'agent:state') pushedStates.push(payload);
      },
      close: () => {},
    });
    let currentWinSize: [number, number] = [1480, 920];
    const appliedRects: Array<{ x: number; y: number; width: number; height: number }> = [];
    const fakeWin: any = {
      isDestroyed: () => false,
      getContentSize: () => currentWinSize,
      contentView: { addChildView: () => {}, removeChildView: () => {} },
    };

    const mgr = new AgentDockManager(
      fakeWin,
      '/nonexistent/preload.js',
      '/nonexistent/dock.html',
      {
        getSocketPath: () => '/tmp/fake.sock',
        getActiveTabId: () => 'tab-1',
        getBrowserContextSnippet: () => '',
        onLayoutChanged: () => {
          const rect = clampFloatBounds(mgr.getState().floatBounds, currentWinSize[0], currentWinSize[1]);
          mgr.applyBounds(rect);
        },
      },
      {
        initialMode: 'floating',
        initialFloatBounds: { x: 600, y: 120, width: 520, height: 480 },
        ptyBinding: null,
      },
    );
    (mgr as any).view = {
      webContents: fakeWc,
      setVisible: () => {},
      setBounds: (r: any) => appliedRects.push(r),
    };

    try {
      expect(mgr.getState().floatBounds).toEqual({ x: 600, y: 120, width: 520, height: 480 });
      const resized = mgr.setFloatBounds({ x: 300, y: 90, width: 700, height: 610 });
      expect(resized.floatBounds).toEqual({ x: 300, y: 90, width: 700, height: 610 });
      expect(appliedRects[appliedRects.length - 1]).toEqual({ x: 300, y: 90, width: 700, height: 610 });

      // Shrinking main window clamps floatBounds and pushes updated state to renderer
      pushedStates.length = 0;
      currentWinSize = [800, 500];
      mgr.applyBounds(clampFloatBounds(mgr.getState().floatBounds, 800, 500));
      expect(mgr.getState().floatBounds).toEqual({
        x: 92,
        y: 44,
        width: 700,
        height: 452,
      });
      expect(pushedStates.length).toBe(1);
      expect(pushedStates[0]!.floatBounds).toEqual(mgr.getState().floatBounds);
    } finally {
      mgr.dispose();
    }

    // 9. Persisted session sanitizes custom agentFloatBounds cleanly
    const persisted = sanitizePersistedSession({
      version: 1,
      savedAt: 1000,
      railCollapsed: false,
      dockOpen: false,
      dockHeight: 280,
      splitRatio: 0.35,
      theme: 'dark',
      agentFloatBounds: { x: 320.4, y: 95.6, width: 640, height: 520 },
      activeTabIndex: 0,
      tabs: [],
      history: [],
    });
    expect(persisted?.agentFloatBounds).toEqual({ x: 320, y: 96, width: 640, height: 520 });

    const clampedPersisted = sanitizePersistedSession({
      version: 1,
      savedAt: 1000,
      railCollapsed: false,
      dockOpen: false,
      dockHeight: 280,
      splitRatio: 0.35,
      theme: 'dark',
      agentFloatBounds: { x: -50, y: -10, width: 50, height: 40 },
      activeTabIndex: 0,
      tabs: [],
      history: [],
    });
    expect(clampedPersisted?.agentFloatBounds).toEqual({
      x: 0,
      y: 0,
      width: MIN_AGENT_FLOAT_WIDTH,
      height: MIN_AGENT_FLOAT_HEIGHT,
    });

    // 10. Renderer HTML/CSS expose all 8 floating resize handles gated on .dock-root.floating
    const html = fs.readFileSync(path.resolve(import.meta.dir, '../src/renderer/agent-dock.html'), 'utf8');
    const css = fs.readFileSync(path.resolve(import.meta.dir, '../src/renderer/agent-dock.css'), 'utf8');
    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      expect(html).toContain(`data-resize-edge="${edge}"`);
      expect(css).toContain(`.handle-${edge}`);
    }
    expect(css).toContain('.dock-root.floating .float-resize-handle');
  });
});
