from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from src.connection_manager import manager

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/live")
async def websocket_live(websocket: WebSocket):
    """Firehose: every message for every device, no server-side filtering."""
    await manager.connect(websocket)
    try:
        while True:
            # Browser isn't expected to send anything; this just keeps
            # the connection open and lets us detect disconnects.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


@router.websocket("/ws/live/{device_id}")
async def websocket_device_live(websocket: WebSocket, device_id: str):
    """Only messages whose pi_id matches device_id."""
    await manager.connect(websocket, device_id=device_id)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, device_id=device_id)