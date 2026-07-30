import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from database.database import init_db
from service.mqtt_service import mqtt_service
from service import capture_socket_server
from routers import Pis, Commands, Ws, Captures


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    loop = asyncio.get_running_loop()
    mqtt_service.start(loop)
    capture_socket_server.start()
    yield
    capture_socket_server.stop()
    mqtt_service.stop()


app = FastAPI(title="Pi Fleet Controller", lifespan=lifespan)

app.include_router(Pis.router)
app.include_router(Commands.router)
app.include_router(Ws.router)
app.include_router(Captures.router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "pi-fleet-controller"}


@app.get("/server-time")
def server_time():
    """Used by the front-end to mark a capture's start point using the
    backend's clock, avoiding skew against the browser's own clock when
    later querying /pis/{pi_id}/logs?since=..."""
    return {"now": datetime.now(timezone.utc).isoformat()}


FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "front-end"
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")