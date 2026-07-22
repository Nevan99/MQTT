from typing import Dict, Set

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        self.subscribers: Dict[str, Set[WebSocket]] = {}
        self.global_subscribers: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket, device_id: str | None = None):
        await websocket.accept()
        if device_id:
            self.subscribers.setdefault(device_id, set()).add(websocket)
        else:
            self.global_subscribers.add(websocket)

    def disconnect(self, websocket: WebSocket, device_id: str | None = None):
        if device_id:
            self.subscribers.get(device_id, set()).discard(websocket)
        else:
            self.global_subscribers.discard(websocket)

    async def broadcast(self, payload: dict):
        device_id = payload.get("pi_id")
        targets = self.subscribers.get(device_id, set()) | self.global_subscribers
        dead = []
        for ws in targets:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.subscribers.get(device_id, set()).discard(ws)
            self.global_subscribers.discard(ws)


manager = ConnectionManager()
