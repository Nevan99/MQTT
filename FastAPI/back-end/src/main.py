import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from database.database import init_db
from service.mqtt_service import mqtt_service
from routers import Pis, Commands, Ws


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    loop = asyncio.get_running_loop()
    mqtt_service.start(loop)
    yield
    mqtt_service.stop()


app = FastAPI(title="Pi Fleet Controller", lifespan=lifespan)

app.include_router(Pis.router)
app.include_router(Commands.router)
app.include_router(Ws.router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "pi-fleet-controller"}


FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "front-end"
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")