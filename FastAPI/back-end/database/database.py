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
        if "primary_interfaces_json" not in existing:
            conn.execute(text("ALTER TABLE pi ADD COLUMN primary_interfaces_json VARCHAR DEFAULT '[]'"))
            # Best-effort carry over any single interface set under the old
            # (now-unused) single-value column into the new list column.
            conn.execute(text(
                "UPDATE pi SET primary_interfaces_json = '[\"' || primary_interface || '\"]' "
                "WHERE primary_interface IS NOT NULL AND primary_interface != ''"
            ))
            conn.execute(text("UPDATE pi SET primary_interfaces_json = '[]' WHERE primary_interfaces_json IS NULL"))
            conn.commit()
        if "interface_defaults_json" not in existing:
            conn.execute(text("ALTER TABLE pi ADD COLUMN interface_defaults_json VARCHAR DEFAULT '{}'"))
            conn.execute(text("UPDATE pi SET interface_defaults_json = '{}' WHERE interface_defaults_json IS NULL"))
            conn.commit()

        wifi_history_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(wifiscanhistory)"))}
        if wifi_history_cols and "last_result_json" not in wifi_history_cols:
            conn.execute(text("ALTER TABLE wifiscanhistory ADD COLUMN last_result_json VARCHAR DEFAULT '{}'"))
            conn.execute(text("UPDATE wifiscanhistory SET last_result_json = '{}' WHERE last_result_json IS NULL"))
            conn.commit()

        testrun_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(testrun)"))}
        if testrun_cols and "suite_run_id" not in testrun_cols:
            conn.execute(text("ALTER TABLE testrun ADD COLUMN suite_run_id INTEGER"))
            conn.commit()

        # Results tab star/archive/lock flags, on both run tables.
        for table in ("testrun", "testsuiterun"):
            cols = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
            for col in ("starred", "archived", "locked"):
                if cols and col not in cols:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} BOOLEAN NOT NULL DEFAULT 0"))
                    conn.commit()

        iface_status_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(interfacestatus)"))}
        for col, coltype in (
            ("key_mgmt", "VARCHAR"), ("pairwise_cipher", "VARCHAR"), ("group_cipher", "VARCHAR"),
            ("wpa_state", "VARCHAR"), ("address", "VARCHAR"), ("wifi_generation", "VARCHAR"),
            ("noise_dbm", "INTEGER"), ("avg_signal_dbm", "INTEGER"), ("link_speed_mbps", "INTEGER"),
            ("channel_width", "VARCHAR"), ("radio_type", "VARCHAR"), ("wifi7_capable", "BOOLEAN"),
            ("max_standard_capable", "VARCHAR"),
            ("mlo", "BOOLEAN"), ("mld_address", "VARCHAR"), ("ap_mld_address", "VARCHAR"),
            ("mlo_links_json", "VARCHAR"),
        ):
            if iface_status_cols and col not in iface_status_cols:
                conn.execute(text(f"ALTER TABLE interfacestatus ADD COLUMN {col} {coltype}"))
                conn.commit()

        capture_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(capture)"))}
        for col in ("started_at", "stopped_at"):
            if capture_cols and col not in capture_cols:
                conn.execute(text(f"ALTER TABLE capture ADD COLUMN {col} DATETIME"))
                conn.commit()


def get_session():
    with Session(engine) as session:
        yield session


def get_session_direct() -> Session:
    """For use outside FastAPI's Depends system, e.g. inside MQTT callbacks."""
    return Session(engine)