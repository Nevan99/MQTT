import os

from dotenv import load_dotenv
from sqlmodel import SQLModel, Session, create_engine, text

load_dotenv()

DATABASE_URL = os.environ["DATABASE_URL"]

# check_same_thread=False is needed because FastAPI + the MQTT thread
# will both touch the DB from different threads.
engine = create_engine(DATABASE_URL, echo=False, connect_args={"check_same_thread": False})


def init_db():
    SQLModel.metadata.create_all(engine)
    _add_missing_columns()


def _add_missing_columns():
    """create_all() only creates missing tables, not missing columns on
    tables that already exist. There's no migration framework here (SQLite,
    lab-scale rig), so columns added to a model after its table already
    exists on disk need an explicit, idempotent ALTER TABLE like this one."""
    with engine.connect() as conn:
        existing = {row[1] for row in conn.execute(text("PRAGMA table_info(pi)"))}
        if "primary_interface" not in existing:
            conn.execute(text("ALTER TABLE pi ADD COLUMN primary_interface VARCHAR"))
            conn.commit()


def get_session():
    with Session(engine) as session:
        yield session


def get_session_direct() -> Session:
    """For use outside FastAPI's Depends system, e.g. inside MQTT callbacks."""
    return Session(engine)