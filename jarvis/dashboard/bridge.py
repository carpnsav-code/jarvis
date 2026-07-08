"""DashboardBridge — pushes live assistant state to the HUD (Phase 2).

Serves the HUD page over HTTP and broadcasts JSON events to it over a WebSocket,
so the dashboard shows the *real* assistant instead of the built-in demo:

    conversation.py  --emit(event)-->  DashboardBridge  --ws-->  index.html (JarvisUI.*)

Design notes:
  * One tiny aiohttp server does both jobs: `GET /` returns the page, `GET /ws`
    upgrades to the event stream. Same-origin, so no CSP/cross-host issues.
  * `emit()` is synchronous and non-blocking (called from the loop): it drops the
    event on a queue that a broadcaster task drains. If no page is connected the
    events simply go nowhere — the CLI is never blocked or slowed by the UI.
  * The last `config` event is replayed to a page that connects late, so a
    freshly-opened dashboard isn't blank.
  * The page is authored body-only (so it can also render as an Artifact); when
    served here it's wrapped in a minimal HTML document.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

log = logging.getLogger("jarvis.dashboard")

_DOC_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JARVIS · HUD</title>
<style>html,body{{margin:0;height:100%;background:#03070d;}}</style>
</head>
<body>
{body}
</body>
</html>"""


class DashboardBridge:
    def __init__(
        self,
        static_file: Path,
        host: str = "127.0.0.1",
        port: int = 8765,
    ) -> None:
        self._static_file = Path(static_file)
        self._host = host
        self._port = port
        self._clients: set[web.WebSocketResponse] = set()
        self._queue: asyncio.Queue[dict] = asyncio.Queue()
        self._runner: web.AppRunner | None = None
        self._broadcaster: asyncio.Task | None = None
        self._last_config: dict | None = None

    @property
    def url(self) -> str:
        return f"http://{self._host}:{self._port}/"

    async def start(self) -> None:
        app = web.Application()
        app.router.add_get("/", self._handle_index)
        app.router.add_get("/ws", self._handle_ws)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, self._host, self._port)
        await site.start()
        self._broadcaster = asyncio.create_task(self._run_broadcast())
        log.info("dashboard bridge listening on %s", self.url)

    async def _handle_index(self, _request: web.Request) -> web.Response:
        body = self._static_file.read_text(encoding="utf-8")
        return web.Response(text=_DOC_TEMPLATE.format(body=body), content_type="text/html")

    async def _handle_ws(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        self._clients.add(ws)
        if self._last_config is not None:  # don't leave a late joiner blank
            await ws.send_str(json.dumps(self._last_config))
        try:
            async for msg in ws:  # we don't expect inbound messages; just keep alive
                if msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                    break
        finally:
            self._clients.discard(ws)
        return ws

    def emit(self, event: dict[str, Any]) -> None:
        """Queue an event for broadcast. Safe to call from the event loop; never
        blocks and never raises on a full/absent audience."""
        if event.get("type") == "config":
            self._last_config = event
        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:  # pragma: no cover - unbounded queue
            pass

    async def _run_broadcast(self) -> None:
        while True:
            event = await self._queue.get()
            if not self._clients:
                continue
            data = json.dumps(event)
            dead = []
            for ws in list(self._clients):
                try:
                    await ws.send_str(data)
                except Exception:  # client vanished mid-send
                    dead.append(ws)
            for ws in dead:
                self._clients.discard(ws)

    async def stop(self) -> None:
        if self._broadcaster is not None:
            self._broadcaster.cancel()
        for ws in list(self._clients):
            try:
                await ws.close()
            except Exception:
                pass
        self._clients.clear()
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
