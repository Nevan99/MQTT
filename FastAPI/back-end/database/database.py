import os

from dotenv import load_dotenv
from sqlmodel import SQLModel, Session, create_engine

load_dotenv()

DATABASE_URL = os.environ["DATABASE_URL"]

# check_same_thread=False is needed because FastAPI + the MQTT thread
# will both touch the DB from different threads.
engine = create_engine(DATABASE_URL, echo=False, connect_args={"check_same_thread": False})


def init_db():
    SQLModel.metadata.create_all(engine)


def get_session():
    with Session(engine) as session:
        yield session


def get_session_direct() -> Session:
    """For use outside FastAPI's Depends system, e.g. inside MQTT callbacks."""
    return Session(engine)