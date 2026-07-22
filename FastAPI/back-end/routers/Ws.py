from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from src.connection_manager import manager

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/live")
async def websocket_live(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # Browser isn't expected to send anything; this just keeps
            # the connection open and lets us detect disconnects.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)