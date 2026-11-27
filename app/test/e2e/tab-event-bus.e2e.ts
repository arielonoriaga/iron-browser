import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { launchElectronSession } from './lib/electron-harness';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  label: string,
  timeoutMs: number,
  check: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await check();
      if (res !== null) return res;
    } catch (err) {
      lastErr = err;
    }
    await sleep(40);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}${lastErr ? `: ${String(lastErr)}` : ''}`,
  );
}

async function runTabEventBusE2E(): Promise<void> {
  let downloadHitCount = 0;
  const csvBody = 'round,multiplier,payout\n101,4.06,40.60\n';
  const openSockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname === '/report.csv') {
      downloadHitCount += 1;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="report.csv"',
        'Cache-Control': 'no-store',
      });
      res.end(csvBody);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Bus E2E Fixture</title></head>
<body>
  <a id="dl-report" href="/report.csv" download="report.csv" style="display:inline-block;padding:18px 28px;background:#10b981;color:#fff;">Download CSV</a>
  <script>
    window.__ssEvents = [];
    window.addEventListener('storage', (ev) => {
      if (ev.storageArea === window.sessionStorage) {
        window.__ssEvents.push({ key: ev.key, newValue: ev.newValue });
      }
    });
  </script>
</body>
</html>`);
  });

  server.on('connection', (sock: Socket) => {
    openSockets.add(sock);
    sock.once('close', () => openSockets.delete(sock));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind E2E HTTP fixture server');
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dl-e2e-'));

  const session = await launchElectronSession({
    smoke: true,
    env: {
      IRON_BROWSER_DOWNLOAD_DIR: downloadDir,
    },
  });

  try {
    const opened = await session.ctl.open(`${baseUrl}/app?token=TOP_SECRET_TOK&lang=EN`, {
      mode: 'dual',
      session: 'shared',
    });
    const sharedTabId = opened.activeTabId!;
    assert.ok(sharedTabId, 'expected active shared tab id');
    await session.ctl.waitForTabReady(sharedTabId);

    // 1. Verify native rust-napi backend + URL token redaction on bus events (including F-17 whitespace tab_id fallback)
    const initialEvents = await session.ctl.events({ tabId: '   ' });
    assert.equal(initialEvents.backend, 'rust-napi');
    assert.equal(initialEvents.tabId, sharedTabId);
    assert.ok(initialEvents.events.length >= 1, 'expected lifecycle/navigation events');
    for (const ev of initialEvents.events) {
      assert.ok(
        !ev.summary.includes('TOP_SECRET_TOK'),
        `bus event leaked secret token: ${ev.summary}`,
      );
    }

    // 2. Live cross-viewport sessionStorage replication (Portrait -> Landscape) + reload hydration
    await session.ctl.evalJs(
      `sessionStorage.setItem('__sp_stk', 'aviator-live-777'); 'ok'`,
      'portrait',
      sharedTabId,
    );

    const replicatedVal = await pollUntil(
      'landscape sessionStorage live sync',
      4_000,
      async () => {
        const r = await session.ctl.evalJs(
          `JSON.stringify({ val: sessionStorage.getItem('__sp_stk'), events: window.__ssEvents.length })`,
          'landscape',
          sharedTabId,
        );
        const parsed = JSON.parse(r.value) as { val: string | null; events: number };
        return parsed.val === 'aviator-live-777' && parsed.events >= 1 ? parsed.val : null;
      },
    );
    assert.equal(replicatedVal, 'aviator-live-777');

    // Navigate shared tab to another path on same origin and verify hydration restores sessionStorage
    await session.ctl.navigate(`${baseUrl}/page2`, sharedTabId);
    await session.ctl.waitForTabReady(sharedTabId, { expectedUrlIncludes: '/page2' });

    const hydratedVal = await pollUntil(
      'post-navigation sessionStorage hydration',
      4_000,
      async () => {
        const p = await session.ctl.evalJs(
          `sessionStorage.getItem('__sp_stk')`,
          'portrait',
          sharedTabId,
        );
        const l = await session.ctl.evalJs(
          `sessionStorage.getItem('__sp_stk')`,
          'landscape',
          sharedTabId,
        );
        return p.value === 'aviator-live-777' && l.value === 'aviator-live-777' ? l.value : null;
      },
    );
    assert.equal(hydratedVal, 'aviator-live-777');

    // 3. Mirrored download deduplication: clicking #dl-report across Portrait + Landscape saves 1 file & cancels duplicate
    await session.ctl.interact({
      tabId: sharedTabId,
      action: 'click',
      selector: '#dl-report',
      mirror: true,
    });

    const dlCheck = await pollUntil('completed single deduplicated download', 6_000, async () => {
      const evs = await session.ctl.events({ tabId: sharedTabId, domain: 'download' });
      const hasClaimed = evs.events.some((e) => e.kind === 'effect_claimed');
      const hasSuppressed = evs.events.some((e) => e.kind === 'dedup_suppressed');
      const hasCompleted = evs.events.some((e) => e.kind === 'completed');
      if (!hasClaimed || !hasSuppressed || !hasCompleted) return null;
      return evs;
    });

    const claimedEv = dlCheck.events.find((e) => e.kind === 'effect_claimed')!;
    const suppressedEv = dlCheck.events.find((e) => e.kind === 'dedup_suppressed')!;
    assert.ok(claimedEv.gestureSeq && claimedEv.gestureSeq > 0, 'expected causal gestureSeq');
    assert.equal(
      suppressedEv.gestureSeq,
      claimedEv.gestureSeq,
      'claimed and suppressed download events must share causal gestureSeq',
    );

    // Give 150ms settle window to prove no second file ever materializes
    await sleep(150);
    const savedFiles = fs.readdirSync(downloadDir).sort();
    assert.deepEqual(
      savedFiles,
      ['report.csv'],
      `expected exactly 1 downloaded file, got: ${JSON.stringify(savedFiles)}`,
    );
    assert.equal(fs.readFileSync(path.join(downloadDir, 'report.csv'), 'utf8'), csvBody);

    const tabsAfterDl = await session.ctl.tabs();
    const sharedSnap = tabsAfterDl.tabs.find((t) => t.id === sharedTabId)!;
    assert.ok(
      (sharedSnap.dedupCount ?? 0) >= 1,
      `expected dedupCount >= 1 after suppressed duplicate download, got ${sharedSnap.dedupCount}`,
    );

    // 4. Isolated session tab MUST NOT inherit or replicate sessionStorage across panes
    const isoOpened = await session.ctl.open(`${baseUrl}/isolated`, {
      mode: 'dual',
      session: 'isolated',
    });
    const isoTabId = isoOpened.activeTabId!;
    await session.ctl.waitForTabReady(isoTabId, { expectedUrlIncludes: '/isolated' });

    const isoInitial = await session.ctl.evalJs(
      `String(sessionStorage.getItem('__sp_stk'))`,
      'portrait',
      isoTabId,
    );
    assert.equal(isoInitial.value, 'null');

    await session.ctl.evalJs(
      `sessionStorage.setItem('__iso_only', 'p-secret'); 'ok'`,
      'portrait',
      isoTabId,
    );
    await sleep(150);
    const isoLandscape = await session.ctl.evalJs(
      `String(sessionStorage.getItem('__iso_only'))`,
      'landscape',
      isoTabId,
    );
    assert.equal(
      isoLandscape.value,
      'null',
      'isolated session mode must never sync sessionStorage across Portrait and Landscape',
    );

    console.log(
      `PASS tab-event-bus.e2e: backend=${dlCheck.backend} gestureSeq=${claimedEv.gestureSeq} savedFiles=${savedFiles.length} downloadHits=${downloadHitCount} dedupCount=${sharedSnap.dedupCount}`,
    );
  } finally {
    await session.close();
    for (const sock of openSockets) sock.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}

await runTabEventBusE2E();
